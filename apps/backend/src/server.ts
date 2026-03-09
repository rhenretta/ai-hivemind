import { execSync } from 'node:child_process';
import http from 'node:http';

import { type SystemEvent, type RepoConfig, type ProjectProfile } from '@ai-hivemind/shared';
import cors from 'cors';
import express, { type Application, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';

import { eventBus } from './eventBus.js';
// Services — import triggers singleton creation + built-in tool seeding
import { credentialStore } from './services/credentialStore.js';
import { getOrCreateDialogueAgent, getMostRecentActiveAgent } from './services/dialogueAgent.js';
import { classifyIntent, getFeatureSummaries, getRecentChatMessages } from './services/intentRouter.js';
import { logger } from './services/logger.js';
import { mcpRegistry } from './services/mcpRegistry.js';
import { ragStore } from './services/ragStore.js';
import { getEventsByTrace } from './services/ledgerStore.js';
import { mergeFeatureSandbox, destroyFeatureSandbox, getFeatureSandbox } from './services/sandboxManager.js';
import { loadPendingState } from './services/taskStateStore.js';
import { sessionStore } from './services/sessionStore.js';

/**
 * Nerve Center HTTP + WebSocket Server
 *
 * Responsibilities:
 *  - Serve a health-check endpoint (GET /health)
 *  - Serve a ledger replay endpoint (GET /api/events)
 *  - Accept Socket.io connections from the Command Center
 *  - Bridge: subscribe to eventBus wildcard topic and push every SystemEvent
 *    to all connected Socket.io clients as 'system:event'
 *
 * What this module does NOT do (policy-free):
 *  - No business logic, no LLM calls, no agent decisions.
 *  - No authentication (Phase 2 concern).
 *  - No rate limiting (Phase 2 concern).
 */

const CORS_ORIGIN = process.env['BACKEND_CORS_ORIGIN'] ?? '*';

// ─── Express app ──────────────────────────────────────────────────────────────

export const app: Application = express();

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

/** Health check — also exposes ledger size so operators can see event throughput. */
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        ledgerSize: eventBus.ledgerSize,
        timestamp: new Date().toISOString(),
    });
});

/**
 * Ledger replay endpoint.
 * Allows a Command Center client that connects after events were emitted to
 * catch up on the full event history for the current process lifetime.
 *
 * Query params:
 *   ?limit=N  — return only the last N events (default: all)
 *   ?type=T    — filter to a specific SystemEventType
 *   ?traceId=X — filter to a specific feature/task trace
 */
app.get('/api/events', (req, res) => {
    let events: readonly SystemEvent[] = eventBus.getLedger();

    const { type, limit, traceId } = req.query;

    if (typeof traceId === 'string' && traceId !== '') {
        events = events.filter((e) => e.traceId === traceId);
    }

    if (typeof type === 'string' && type !== '') {
        events = events.filter((e) => e.eventType === type);
    }

    if (typeof limit === 'string') {
        const n = parseInt(limit, 10);
        if (!isNaN(n) && n > 0) {
            events = events.slice(-n);
        }
    }

    res.json(events);
});

/**
 * Event injection endpoint — used by the simulator process (separate OS process)
 * to push events into THIS server's EventBus instance.
 *
 * The simulator cannot import eventBus directly because Node.js ESM module caching
 * is per-process: two separate `tsx` processes have completely isolated module
 * instances. The singleton pattern only works WITHIN a single process.
 *
 * This endpoint is the correct cross-process bridge.
 */
app.post('/api/events/inject', (req: Request, res: Response) => {
    const event = req.body as SystemEvent | null;

    // Basic structural validation before emitting
    if (
        event === null ||
        typeof event.eventId !== 'string' ||
        typeof event.eventType !== 'string' ||
        typeof event.sourceId !== 'string' ||
        typeof event.timestamp !== 'string'
    ) {
        res.status(400).json({ error: 'Invalid SystemEvent payload' });
        return;
    }

    eventBus.emit(event);
    res.status(204).end();
});

/**
 * Tool Registry endpoint.
 * Returns the full list of tools registered in the MCP registry.
 */
app.get('/api/tools', (_req, res) => {
    res.json(mcpRegistry.getAvailableTools());
});

/**
 * Reddit API endpoints.
 * Mounts /posts at /api/posts
 */

// ─── RAG Store REST API ────────────────────────────────────────────────────────

/** List all collections. */
app.get('/api/rag/collections', (_req, res) => {
    res.json(ragStore.getCollections());
});

/** Create a new collection. Body: { name: string, description?: string } */
app.post('/api/rag/collections', (req: Request, res: Response) => {
    const { name, description } = req.body as { name?: string; description?: string };
    if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'name is required' });
        return;
    }
    const col = ragStore.createCollection(name.trim(), description ?? '');
    res.status(201).json(col);
});

/** Get all entries in a collection. */
app.get('/api/rag/collections/:name/entries', (req: Request, res: Response) => {
    const { name } = req.params as { name: string };
    const traceId = typeof req.query['traceId'] === 'string' ? req.query['traceId'] : '';
    if (traceId !== '') {
        res.json(ragStore.getEntriesByTrace(name, traceId));
    } else {
        res.json(ragStore.getEntries(name));
    }
});

/** Add a memory entry to a collection.
 *  Body: { traceId, agentId, content, tags?, collectionName? }
 */
app.post('/api/rag/collections/:name/entries', (req: Request, res: Response) => {
    const { name } = req.params as { name: string };
    try {
        const body = req.body as Record<string, unknown>;
        const entry = ragStore.storeContext(name, {
            memoryId: (body['memoryId'] as string | undefined) ?? (crypto.randomUUID()),
            traceId: (body['traceId'] as string | undefined) ?? (crypto.randomUUID()),
            agentId: (body['agentId'] as string | undefined) ?? 'operator',
            content: body['content'] as string,
            tags: Array.isArray(body['tags']) ? (body['tags'] as string[]) : [],
            timestamp: new Date().toISOString(),
        });
        res.status(201).json(entry);
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

/** Delete a specific memory entry from a collection. */
app.delete('/api/rag/collections/:name/entries/:memoryId', (req: Request, res: Response) => {
    const { name, memoryId } = req.params as { name: string; memoryId: string };
    ragStore.deleteContext(name, memoryId);
    res.status(204).end();
});

/**
 * Cross-collection query: search or list all memory entries for a session.
 * Query params: ?traceId=<uuid> (required)  ?query=<text> (optional)  ?limit=<n> (optional)
 */
app.get('/api/rag/entries', (req: Request, res: Response) => {
    const traceId = typeof req.query['traceId'] === 'string' ? req.query['traceId'] : '';
    if (traceId === '') {
        res.status(400).json({ error: 'traceId query parameter is required' });
        return;
    }
    const query = typeof req.query['query'] === 'string' ? req.query['query'] : undefined;
    const limit = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : 100;

    if (query !== undefined && query.length > 0) {
        res.json(ragStore.queryAcrossCollections(traceId, query, limit));
    } else {
        res.json(ragStore.getAllEntriesByTrace(traceId, limit));
    }
});

/**
 * Legacy RAG Store query endpoint — queries the 'default' collection.
 * Kept for backward compatibility with the simulator and external callers.
 * Query params: ?query=<text>  ?tags=a,b,c
 */
app.get('/api/memory', (req, res) => {
    const query = typeof req.query['query'] === 'string' ? req.query['query'] : '';
    const tags = typeof req.query['tags'] === 'string' && req.query['tags'] !== ''
        ? req.query['tags'].split(',')
        : undefined;
    void ragStore.queryContextSemantic('default', query, tags).then(
        (results) => res.json(results),
        (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        },
    );
});

// ─── Credential Store REST API ───────────────────────────────────────────────

/** Lightweight manifest for agents (names only, no values). */
app.get('/api/credentials/manifest', (_req, res) => {
    res.json(credentialStore.getManifest());
});

/** List all credentials (masked values). */
app.get('/api/credentials', (_req, res) => {
    try {
        res.json(credentialStore.listCredentials());
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

/** Store or update a credential.
 *  Body: { serviceName, serviceLabel, credentialType?, envVarName, value, metadata? }
 */
app.post('/api/credentials', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const serviceName = typeof body['serviceName'] === 'string' ? body['serviceName'].trim() : '';
    const serviceLabel = typeof body['serviceLabel'] === 'string' ? body['serviceLabel'].trim() : '';
    const envVarName = typeof body['envVarName'] === 'string' ? body['envVarName'].trim() : '';
    const value = typeof body['value'] === 'string' ? body['value'] : '';

    if (!serviceName || !serviceLabel || !envVarName || !value) {
        res.status(400).json({ error: 'serviceName, serviceLabel, envVarName, and value are required' });
        return;
    }

    try {
        const storeInput: Parameters<typeof credentialStore.storeCredential>[0] = {
            serviceName,
            serviceLabel,
            envVarName,
            value,
        };
        if (typeof body['credentialType'] === 'string') {
            storeInput.credentialType = body['credentialType'];
        }
        if (typeof body['metadata'] === 'object' && body['metadata'] !== null) {
            storeInput.metadata = body['metadata'] as Record<string, unknown>;
        }
        const credential = credentialStore.storeCredential(storeInput);
        res.status(201).json(credential);
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

/** Delete a credential. */
app.delete('/api/credentials/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const deleted = credentialStore.deleteCredential(id);
    if (deleted) {
        res.status(204).end();
    } else {
        res.status(404).json({ error: 'Credential not found' });
    }
});


// ─── Session Store REST API ──────────────────────────────────────────────────

/** List all sessions. */
app.get('/api/sessions', (_req, res) => {
    res.json(sessionStore.listSessions());
});

/** Get a single session by ID. */
app.get('/api/sessions/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const session = sessionStore.getSession(id);
    if (session === null) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    res.json(session);
});

/** Create a new session. Body: { title, repoConfig? } */
app.post('/api/sessions', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
    if (title === '') {
        res.status(400).json({ error: 'title is required' });
        return;
    }
    try {
        const repoConfig = body['repoConfig'] as { url: string; defaultBranch: string } | undefined;
        const session = sessionStore.createSession({
            title,
            repoConfig: repoConfig ?? null,
        });
        res.status(201).json(session);
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

/** Update a session. Body: { title?, status?, repoConfig?, projectProfile? } */
app.patch('/api/sessions/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof sessionStore.updateSession>[1] = {};
    if (typeof body['title'] === 'string') patch.title = body['title'];
    if (typeof body['status'] === 'string') patch.status = body['status'] as 'exploring';
    if (body['repoConfig'] !== undefined) patch.repoConfig = body['repoConfig'] as RepoConfig | null;
    if (body['projectProfile'] !== undefined) patch.projectProfile = body['projectProfile'] as ProjectProfile | null;
    const session = sessionStore.updateSession(id, patch);
    if (session === null) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    res.json(session);
});

/** Delete a session. */
app.delete('/api/sessions/:id', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    // Destroy sandbox if one exists
    try {
        destroyFeatureSandbox(id);
    } catch {
        // Sandbox may not exist — that's fine
    }
    // Clean up session-scoped credentials
    credentialStore.deleteSessionCredentials(id);
    const deleted = sessionStore.deleteSession(id);
    if (deleted) {
        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'FEATURE_DELETED',
            sourceId: 'user',
            targetId: null,
            traceId: id,
            payload: {},
        });
        res.status(204).end();
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// ─── Session-Scoped Credentials ──────────────────────────────────────────────

/** List session-scoped credentials (masked). */
app.get('/api/sessions/:id/credentials', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    res.json(credentialStore.listCredentialsBySession(id));
});

/** Store a session-scoped credential. */
app.post('/api/sessions/:id/credentials', (req: Request, res: Response) => {
    const { id: sessionId } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const envVarName = typeof body['envVarName'] === 'string' ? body['envVarName'].trim() : '';
    const value = typeof body['value'] === 'string' ? body['value'] : '';
    const serviceLabel = typeof body['serviceLabel'] === 'string' ? body['serviceLabel'].trim() : envVarName;
    const serviceName = typeof body['serviceName'] === 'string' ? body['serviceName'].trim() : envVarName.toLowerCase();

    if (!envVarName || !value) {
        res.status(400).json({ error: 'envVarName and value are required' });
        return;
    }

    try {
        const credential = credentialStore.storeCredential({
            serviceName,
            serviceLabel,
            envVarName,
            value,
            sessionId,
            credentialType: typeof body['credentialType'] === 'string' ? body['credentialType'] : 'api_key',
        });
        res.status(201).json(credential);
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

/** Delete a session-scoped credential. */
app.delete('/api/sessions/:id/credentials/:credId', (req: Request, res: Response) => {
    const { credId } = req.params as { id: string; credId: string };
    const deleted = credentialStore.deleteCredential(credId);
    if (deleted) {
        res.status(204).end();
    } else {
        res.status(404).json({ error: 'Credential not found' });
    }
});

// ─── Session artifacts aggregation ───────────────────────────────────────────

app.get('/api/sessions/:id/artifacts', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const session = sessionStore.getSession(id);
    if (session === undefined) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }

    // SWE artifacts — parse content as SweArtifact where possible
    const sweEntries = ragStore.getEntriesByTrace('swe-outputs', id);
    const sweArtifacts = sweEntries.map((entry) => {
        let artifact = null;
        try { artifact = JSON.parse(entry.content) as Record<string, unknown>; } catch { /* raw text */ }
        return {
            memoryId: entry.memoryId,
            agentId: entry.agentId,
            timestamp: entry.timestamp,
            artifact,
            rawContent: entry.content,
        };
    });

    // Research findings
    const researchEntries = ragStore.getEntriesByTrace('research-context', id);
    const researchFindings = researchEntries.map((entry) => ({
        memoryId: entry.memoryId,
        agentId: entry.agentId,
        timestamp: entry.timestamp,
        content: entry.content,
        tags: entry.tags,
    }));

    // QA verdicts from ledger
    const traceEvents = getEventsByTrace(id);
    const qaVerdicts = traceEvents
        .filter((e) => e.eventType === 'QA_VERDICT')
        .map((e) => ({
            eventId: e.eventId,
            timestamp: e.timestamp,
            subtask: typeof e.payload['subtask'] === 'string' ? e.payload['subtask'] : '',
            passed: e.payload['passed'] === true,
            issues: Array.isArray(e.payload['issues']) ? e.payload['issues'] as string[] : [],
            warnings: Array.isArray(e.payload['warnings']) ? e.payload['warnings'] as string[] : [],
            summary: typeof e.payload['summary'] === 'string' ? e.payload['summary'] : undefined,
            checksRun: Array.isArray(e.payload['checksRun']) ? e.payload['checksRun'] as string[] : [],
        }));

    // Sandbox status
    let sandbox = null;
    const handle = getFeatureSandbox(id);
    if (handle !== null) {
        let running = false;
        try {
            const out = execSync(
                `docker inspect --format "{{.State.Running}}" ${handle.containerName}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
            ).trim();
            running = out === 'true';
        } catch { /* container may not exist */ }
        sandbox = {
            containerName: handle.containerName,
            running,
            backendPort: handle.backendPort,
            webPort: handle.webPort,
        };
    }

    // Task state snapshot
    let taskState = null;
    const pending = loadPendingState();
    if (pending !== null && pending.traceId === id) {
        taskState = {
            phase: pending.phase,
            objective: pending.objective,
            attempt: pending.attempt,
            filesChanged: pending.filesChanged,
        };
    }

    res.json({ sweArtifacts, researchFindings, qaVerdicts, sandbox, taskState });
});

// ─── HTTP server + Socket.io ──────────────────────────────────────────────────

export const httpServer = http.createServer(app);

export const io = new Server(httpServer, {
    cors: {
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST'],
    },
    // Send a ping every 25s; disconnect if no pong received within 5s.
    // Keeps the connection list clean without manual cleanup.
    pingInterval: 25_000,
    pingTimeout: 5_000,
});

// ─── WebSocket connection handler ─────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
    logger.info(`[Nerve Center] Client connected    id=${socket.id}`);

    // On connect, send the full ledger snapshot so the client can render history.
    socket.emit('system:replay', eventBus.getLedger());

    // ── Socket.io → EventBus bridge ────────────────────────────────────────────
    //
    // The Command Center's CommandPrompt emits 'user:command' on the socket.
    // We bridge it onto the EventBus so the Coordinator subscription fires.
    // Without this, commands are silently dropped.
    socket.on('user:command', (data: {
        objective: string;
        traceId: string;
        eventId: string;
        timestamp: string;
    }) => {
        const { objective, traceId, eventId, timestamp } = data;
        logger.info(`[Nerve Center] user:command from socket=${socket.id} | objective="${objective.slice(0, 80)}…"`);

        eventBus.emit({
            eventId,
            timestamp,
            eventType: 'USER_COMMAND',
            sourceId: 'user',
            targetId: null,
            traceId,
            payload: { objective, traceId },
        });
    });

    // ── Intent-routed messages ────────────────────────────────────────────
    //
    // The ChatInput sends 'user:message' with raw text (no traceId).
    // The intent router classifies it and either creates a new feature,
    // continues an existing one, or provides input to a blocked feature.
    socket.on('user:message', (data: {
        text: string;
        clientEventId: string;
    }) => {
        const { text, clientEventId } = data;
        logger.info(`[Nerve Center] user:message from socket=${socket.id} | text="${text.slice(0, 80)}…"`);

        void (async () => {
            try {
                // Fast path: if there's a recently active DialogueAgent, route there
                // directly. This avoids the LLM intent classification round-trip and
                // ensures conversational continuity (the agent has full history).
                const recentAgent = getMostRecentActiveAgent();
                if (recentAgent !== null) {
                    const traceId = recentAgent.traceId;
                    logger.info(`[Nerve Center] Routing to active DialogueAgent traceId=${traceId}`);

                    socket.emit('intent:resolved', {
                        clientEventId,
                        traceId,
                        intent: 'continue_feature',
                        reasoning: 'Routed to active conversation',
                    });

                    // Persist user message in ledger for replay reconstruction.
                    // sourceId='user' so the PM subscriber ignores it.
                    eventBus.emit({
                        eventId: clientEventId,
                        timestamp: new Date().toISOString(),
                        eventType: 'USER_COMMAND',
                        sourceId: 'user',
                        targetId: null,
                        traceId,
                        payload: { originalText: text, intent: 'continue_feature' },
                    });

                    void recentAgent.handleUserMessage(text);
                    return;
                }

                // No active conversation — use intent router to determine feature routing
                const features = getFeatureSummaries();
                const recentMessages = getRecentChatMessages(10);
                const result = await classifyIntent(text, features, recentMessages);

                const traceId = result.intent === 'new_feature'
                    ? crypto.randomUUID()
                    : result.targetTraceId!;

                // Acknowledge to frontend — links the optimistic message to a feature
                socket.emit('intent:resolved', {
                    clientEventId,
                    traceId,
                    intent: result.intent,
                    reasoning: result.reasoning,
                });

                // Persist user message in ledger for replay reconstruction.
                // sourceId='user' so the PM subscriber ignores it.
                eventBus.emit({
                    eventId: clientEventId,
                    timestamp: new Date().toISOString(),
                    eventType: 'USER_COMMAND',
                    sourceId: 'user',
                    targetId: null,
                    traceId,
                    payload: { originalText: text, intent: result.intent },
                });

                // Route through the Dialogue Agent.
                // Pass user text as initial title for new sessions
                const dialogueAgent = getOrCreateDialogueAgent(traceId, text.slice(0, 120));
                void dialogueAgent.handleUserMessage(text);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`[Nerve Center] user:message classification failed: ${msg}`);

                // Fallback: create a new Dialogue Agent and route message to it
                const traceId = crypto.randomUUID();
                socket.emit('intent:resolved', {
                    clientEventId,
                    traceId,
                    intent: 'new_feature',
                    reasoning: 'Fallback due to classification error',
                });
                eventBus.emit({
                    eventId: clientEventId,
                    timestamp: new Date().toISOString(),
                    eventType: 'USER_COMMAND',
                    sourceId: 'user',
                    targetId: null,
                    traceId,
                    payload: { originalText: text, intent: 'new_feature' },
                });
                const dialogueAgent = getOrCreateDialogueAgent(traceId, text.slice(0, 120));
                void dialogueAgent.handleUserMessage(text);
            }
        })();
    });

    socket.on('user:intervention', (data: {
        text: string;
        targetId: string;
        traceId: string;
    }) => {
        const { text, targetId, traceId } = data;
        logger.info(`[Nerve Center] user:intervention from socket=${socket.id} | target=${targetId} | text="${text.slice(0, 60)}…"`);

        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'USER_INTERVENTION',
            sourceId: 'user',
            targetId,
            traceId,
            payload: { text, targetId },
        });
    });

    // Accept both old and new event names for backwards compatibility
    const handleDeleteSession = (data: { traceId: string }) => {
        const { traceId } = data;
        logger.info(`[Nerve Center] user:delete-session from socket=${socket.id} | traceId=${traceId}`);

        // Destroy sandbox if one exists
        try {
            destroyFeatureSandbox(traceId);
        } catch {
            // Sandbox may not exist — that's fine
        }

        // Delete from session store
        sessionStore.deleteSession(traceId);

        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'FEATURE_DELETED',
            sourceId: 'user',
            targetId: null,
            traceId,
            payload: {},
        });
    };
    socket.on('user:delete-feature', handleDeleteSession);
    socket.on('user:delete-session', handleDeleteSession);

    socket.on('user:checkout', async (data: { traceId: string }) => {
        const { traceId } = data;
        logger.info(`[Nerve Center] user:checkout from socket=${socket.id} | traceId=${traceId}`);

        let mergedFiles: string[] = [];
        try {
            mergedFiles = await mergeFeatureSandbox(traceId);
            destroyFeatureSandbox(traceId);
        } catch (err) {
            logger.warn('[Nerve Center] Sandbox merge on checkout failed (may already be merged):', err);
        }

        // Detect new Next.js routes from merged files
        const routes = mergedFiles
            .filter((f) => /^apps\/web\/src\/app\/[^/]+\/page\.tsx$/.test(f))
            .map((f) => '/' + f.replace(/^apps\/web\/src\/app\//, '').replace(/\/page\.tsx$/, ''));

        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'FEATURE_DEPLOYED',
            sourceId: 'user',
            targetId: null,
            traceId,
            payload: { routes, filesChanged: mergedFiles },
        });
    });

    socket.on('disconnect', (reason) => {
        logger.info(`[Nerve Center] Client disconnected id=${socket.id} reason=${reason}`);
    });
});

// ─── EventBus → Socket.io bridge ─────────────────────────────────────────────

/**
 * Wildcard subscription: every event emitted on the EventBus is immediately
 * broadcast to all connected Socket.io clients on the 'system:event' channel.
 *
 * This is the core observability bridge — the Nerve Center emits, the Command
 * Center receives in real time.
 */
eventBus.subscribeAll((event: SystemEvent) => {
    io.emit('system:event', event);
});

// ─── Agentic Core — USER_COMMAND Ledger Logging ───────────────────────────────

/**
 * Listen for USER_COMMAND events on the EventBus.
 *
 * Previously this spawned a ProjectManager to run the RPIV pipeline.
 * Now the DialogueAgent owns the task graph and spawns FeatureDeveloper
 * directly — USER_COMMAND events are logged for ledger replay only.
 *
 * The event is still emitted by DialogueAgent so the frontend can
 * reconstruct chat history from the ledger on replay.
 */
eventBus.subscribe('USER_COMMAND', (event: SystemEvent) => {
    // USER_COMMAND events are now ledger entries only — no PM spawning.
    // The DialogueAgent handles the full lifecycle internally by:
    //   1. Creating/updating the task graph directly
    //   2. Spawning FeatureDeveloper to execute ready tasks
    const traceId = event.traceId ?? event.eventId;
    const objective = typeof event.payload['objective'] === 'string'
        ? event.payload['objective']
        : typeof event.payload['message'] === 'string'
            ? event.payload['message']
            : 'No objective provided.';

    logger.info(`[Nerve Center] USER_COMMAND logged | traceId=${traceId} | objective="${objective.slice(0, 80)}…"`);
});
