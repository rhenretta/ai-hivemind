import http from 'node:http';

import { type SystemEvent } from '@ai-hivemind/shared';
import cors from 'cors';
import express, { type Application, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';

import { ProjectManager } from './agents/projectManager.js';
import { eventBus } from './eventBus.js';
// Services — import triggers singleton creation + built-in tool seeding
import { credentialStore } from './services/credentialStore.js';
import { classifyIntent, getFeatureSummaries, getRecentChatMessages } from './services/intentRouter.js';
import { logger } from './services/logger.js';
import { mcpRegistry } from './services/mcpRegistry.js';
import { ragStore } from './services/ragStore.js';
import { mergeFeatureSandbox, destroyFeatureSandbox } from './services/sandboxManager.js';
// Agent roster — ProjectManager bootstraps on USER_COMMAND events

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
    res.json(ragStore.getEntries(name));
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
 * Legacy RAG Store query endpoint — queries the 'default' collection.
 * Kept for backward compatibility with the simulator and external callers.
 * Query params: ?query=<text>  ?tags=a,b,c
 */
app.get('/api/memory', (req, res) => {
    const query = typeof req.query['query'] === 'string' ? req.query['query'] : '';
    const tags = typeof req.query['tags'] === 'string' && req.query['tags'] !== ''
        ? req.query['tags'].split(',')
        : undefined;
    res.json(ragStore.queryContext('default', query, tags));
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

                if (result.intent === 'provide_input') {
                    eventBus.emit({
                        eventId: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        eventType: 'USER_INTERVENTION',
                        sourceId: 'user',
                        targetId: 'conductor',
                        traceId,
                        payload: { text, targetId: 'conductor' },
                    });
                } else {
                    // new_feature or continue_feature
                    eventBus.emit({
                        eventId: clientEventId,
                        timestamp: new Date().toISOString(),
                        eventType: 'USER_COMMAND',
                        sourceId: 'user',
                        targetId: null,
                        traceId,
                        payload: {
                            objective: result.enrichedObjective,
                            traceId,
                            originalText: text,
                            intent: result.intent,
                        },
                    });
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`[Nerve Center] user:message classification failed: ${msg}`);

                // Fallback: treat as new feature
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
                    payload: { objective: text, traceId, originalText: text, intent: 'new_feature' },
                });
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

    socket.on('user:delete-feature', (data: { traceId: string }) => {
        const { traceId } = data;
        logger.info(`[Nerve Center] user:delete-feature from socket=${socket.id} | traceId=${traceId}`);

        // Destroy sandbox if one exists
        try {
            destroyFeatureSandbox(traceId);
        } catch {
            // Sandbox may not exist — that's fine
        }

        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'FEATURE_DELETED',
            sourceId: 'user',
            targetId: null,
            traceId,
            payload: {},
        });
    });

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

// ─── Agentic Core — USER_COMMAND → ProjectManager ─────────────────────────────

/**
 * Listen for USER_COMMAND events on the EventBus.
 *
 * When a command arrives (injected via /api/events/inject or a future Socket.io
 * message from the Command Center), instantiate the ProjectManager and kick off
 * the RPIV pipeline (Research → Design → Decompose → Execute).
 *
 * Execution is non-blocking — the HTTP/WebSocket server continues serving
 * requests while the ProjectManager works asynchronously.
 *
 * Errors in the run loop are caught here; a crash in one run never takes down
 * the server or prevents future commands from being processed.
 */
eventBus.subscribe('USER_COMMAND', (event: SystemEvent) => {
    const traceId = event.traceId ?? event.eventId;
    const objective = typeof event.payload['objective'] === 'string'
        ? event.payload['objective']
        : typeof event.payload['message'] === 'string'
            ? event.payload['message']
            : 'No objective provided.';

    logger.info(`[Nerve Center] USER_COMMAND received | traceId=${traceId} | objective="${objective.slice(0, 80)}…"`);

    // Fire-and-forget — ProjectManager manages its own error handling
    const pmId = `project-manager.${crypto.randomUUID().slice(0, 8)}`;
    void new ProjectManager(pmId, traceId).run(objective).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Nerve Center] ProjectManager run failed for traceId=${traceId}: ${msg}`);
    });
});
