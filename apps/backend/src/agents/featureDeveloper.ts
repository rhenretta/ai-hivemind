/**
 * featureDeveloper.ts — Feature Developer Agent
 *
 * Executes a pre-built TaskGraph by running SWE + QA for each ready node.
 * Receives a FeatureContext bundle from the DialogueAgent containing the
 * task graph, research summary, design spec, and work objective.
 *
 * Key differences from the old ProjectManager:
 *   - No RPIV phases (research/explore/design) — DialogueAgent handles those
 *   - No decompose phase — task graph arrives pre-built
 *   - Checks for 'locked' nodes and skips them (DialogueAgent will unlock)
 *   - Can create subtasks within a node via subGraph decomposition
 *   - Reports progress back to DialogueAgent via events
 */

import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { logger } from '../services/logger.js';
import { eventBus } from '../eventBus.js';
import { credentialStore } from '../services/credentialStore.js';
import { ragStore } from '../services/ragStore.js';
import { ConductorWrapper } from '../services/conductor.js';
import { createFeatureSandbox, getFeatureSandbox, type SandboxHandle } from '../services/sandboxManager.js';
import { saveState, clearState } from '../services/taskStateStore.js';
import { BaseAgent } from './baseAgent.js';
import { SoftwareEngineer } from './softwareEngineer.js';
import { QaEngineer } from './qaEngineer.js';

import type {
    TaskGraph,
    TaskNode,
    TaskStatus,
    UxDesignSpec,
    SweArtifact,
    SystemEvent,
} from '@ai-hivemind/shared';
import {
    dependenciesMet,
    dependencyFailed,
    deriveGraphStatus,
} from '@ai-hivemind/shared';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;

// ── FeatureContext (runtime type — mirrors the shared schema) ─────────────────

export interface FeatureDevContext {
    taskGraph: TaskGraph;
    researchSummary: string;
    designSpec: UxDesignSpec | null;
    workObjective: string;
    /** Pre-created sandbox from DialogueAgent (shared with DataResearcher) */
    sandbox?: SandboxHandle;
}

// ── FeatureDeveloper ──────────────────────────────────────────────────────────

export class FeatureDeveloper extends BaseAgent {
    #context: FeatureDevContext | null = null;
    #sandbox: SandboxHandle | null = null;

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId, null);
    }

    async run(context: FeatureDevContext): Promise<string> {
        this.spawn('feature-developer');
        this.#context = context;

        try {
            const result = await this.#executeGraph(
                context.taskGraph,
                context.researchSummary,
                context.designSpec,
            );

            this.terminate(result.success ? 'task_complete' : 'task_failed');
            return result.summary;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] Fatal error: ${msg}`);
            this.emit('ERROR', { message: msg, agentId: this.agentId });
            this.terminate('error');
            return msg;
        }
    }

    // ── Private — execute graph ───────────────────────────────────────────────

    async #executeGraph(
        graph: TaskGraph,
        researchSummary: string,
        designSpec: UxDesignSpec | null = null,
    ): Promise<{ success: boolean; summary: string }> {
        const completedSummaries: string[] = [];

        // Reuse sandbox from DialogueAgent if available, otherwise create a new one
        const existingSandbox = this.#context?.sandbox ?? getFeatureSandbox(this.traceId);
        if (existingSandbox !== null && existingSandbox !== undefined) {
            this.#sandbox = existingSandbox;
            logger.info(`[${this.agentId}] Reusing existing sandbox: ${existingSandbox.containerName}`);
        } else {
            this.#sandbox = await createFeatureSandbox(this.traceId);
            logger.info(`[${this.agentId}] Created new sandbox: ${this.#sandbox.containerName}`);
        }
        const sandbox = this.#sandbox;

        // Sequential loop: keep processing until no more ready nodes can run
        let madeProgress = true;
        while (madeProgress) {
            madeProgress = false;

            // Mark nodes whose dependency failed/skipped as 'skipped'
            for (const node of graph.nodes) {
                if ((node.status === 'pending' || node.status === 'ready') && dependencyFailed(node, graph)) {
                    node.status = 'skipped';
                    this.#emitNodeCompleted(node);
                    madeProgress = true;
                }
            }

            // Find the next ready node (dependencies met, not locked)
            const nextNode = graph.nodes.find(
                (n: TaskNode) => n.status === 'ready' && dependenciesMet(n, graph),
            );

            if (nextNode === undefined) {
                // Check if there are locked or pending nodes — if so, wait briefly
                // (DialogueAgent may be updating them). Otherwise, we're done.
                const hasLockedOrPending = graph.nodes.some(
                    (n) => n.status === 'locked' || n.status === 'pending',
                );
                if (hasLockedOrPending) {
                    // Wait for DialogueAgent to unlock tasks
                    await sleep(2000);
                    madeProgress = true; // retry the loop
                    continue;
                }
                break;
            }

            // Execute this node
            nextNode.status = 'active';
            graph.status = 'active';
            this.#emitGraph(graph, `Executing [${nextNode.id}]: ${nextNode.objective}`);

            const nodeResult = await this.#executeNode(nextNode, researchSummary, sandbox, designSpec, graph);
            madeProgress = true;

            if (nodeResult.success) {
                nextNode.status = 'done';
                nextNode.result = nodeResult.summary;
                completedSummaries.push(`[${nextNode.id}] ✓ ${nodeResult.summary}`);
            } else {
                nextNode.status = 'failed';
                nextNode.error = nodeResult.summary;
            }

            // Promote pending nodes whose dependencies are now met
            for (const node of graph.nodes) {
                if (node.status === 'pending' && dependenciesMet(node, graph)) {
                    node.status = 'ready';
                }
            }

            graph.status = deriveGraphStatus(graph);
            this.#emitNodeCompleted(nextNode);
            this.#emitGraph(graph, `[${nextNode.id}] ${nextNode.status}`);
        }

        const allDoneOrSkipped = graph.nodes.every((n: TaskNode) => n.status === 'done' || n.status === 'skipped');
        const failedNodes = graph.nodes.filter((n: TaskNode) => n.status === 'failed');

        if (allDoneOrSkipped && failedNodes.length === 0) {
            logger.info(`[${this.agentId}] All nodes passed — awaiting user checkout`);
            const summary = [
                `All ${completedSummaries.length.toString()} task(s) completed successfully.`,
                ...completedSummaries,
            ].join('\n');
            this.emit('STATE_CHANGED', { message: summary, phase: 'complete', taskComplete: true });
            return { success: true, summary };
        }

        const failMsg = failedNodes.map((n) => `[${n.id}]: ${n.error ?? 'unknown error'}`).join('; ');
        this.emit('ERROR', { message: `Task graph failed: ${failMsg}`, agentId: this.agentId });
        return { success: false, summary: `Failed tasks: ${failMsg}` };
    }

    // ── Private — execute single node ─────────────────────────────────────────

    async #executeNode(
        node: TaskNode,
        researchSummary: string,
        sandbox: SandboxHandle,
        designSpec: UxDesignSpec | null = null,
        graph?: TaskGraph,
    ): Promise<{ success: boolean; summary: string }> {
        this.emit('STATE_CHANGED', {
            message: `Starting node [${node.id}]: ${node.objective}`,
            phase: 'implement',
            nodeId: node.id,
        });

        let passed = false;
        let priorIssues: string[] = [];
        let lastAttemptCrashed = false;
        let finalSummary = '';

        const sweId = `swe-agent.${uuidv4().slice(0, 8)}`;

        // Emit SWE lifecycle events for the Activity Log
        this.#emitAgentEvent(sweId, 'AGENT_SPAWNED', {
            role: 'swe-agent',
            agentId: sweId,
            parentAgentId: this.agentId,
        });

        const conductorRef = new ConductorWrapper(sweId, this.traceId);

        try {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                node.attempts = attempt + 1;

                const sweObjective = await this.#buildSweObjective(node, researchSummary, priorIssues, attempt, designSpec);

                this.#emitAgentEvent(sweId, 'STATE_CHANGED', {
                    message: attempt === 0
                        ? node.objective
                        : lastAttemptCrashed
                            ? `Retry ${attempt.toString()}: resuming after crash`
                            : `Retry ${attempt.toString()}: fixing ${priorIssues.length.toString()} QA issue(s)`,
                    phase: 'implement',
                    objective: sweObjective,
                    attempt,
                });

                saveState({
                    traceId: this.traceId,
                    nodeId: node.id,
                    sweId,
                    objective: node.objective,
                    acceptanceCriteria: node.acceptanceCriteria,
                    phase: 'conductor',
                    attempt,
                    filesChanged: [],
                    priorIssues,
                    conductorSummary: '',
                    savedAt: new Date().toISOString(),
                });

                // Track SERVICE_DEPLOYED for QA smoke-test URL
                let deployedServiceUrl: string | undefined;
                const unsubDeployed = eventBus.subscribe('SERVICE_DEPLOYED', (event: SystemEvent) => {
                    if (event.sourceId !== sweId) return;
                    const url = typeof event.payload['url'] === 'string' ? event.payload['url'] : undefined;
                    if (url !== undefined) deployedServiceUrl = url;
                });

                // Capture the conductor's final result summary
                let conductorSummaryText = '';
                const unsubStateChanged = eventBus.subscribe('STATE_CHANGED', (event: SystemEvent) => {
                    if (event.sourceId !== sweId) return;
                    if (event.payload['source'] === 'conductor:result' && typeof event.payload['message'] === 'string') {
                        conductorSummaryText = event.payload['message'];
                    }
                });

                // Track files changed by the conductor
                const trackedFiles = new Set<string>();
                const trackedCommands: string[] = [];
                const unsubToolUsed = eventBus.subscribe('TOOL_USED', (event: SystemEvent) => {
                    if (event.sourceId !== sweId) return;
                    const p = event.payload;
                    const source = typeof p['source'] === 'string' ? p['source'] : '';
                    const toolName = typeof p['toolName'] === 'string' ? p['toolName'] : '';

                    if (source === 'conductor:code_change' || toolName === 'code_change') {
                        const filePath = typeof p['filePath'] === 'string' ? p['filePath'] : '';
                        if (filePath) trackedFiles.add(filePath);
                    } else if (source === 'conductor:terminal' || toolName === 'terminal') {
                        const command = typeof p['command'] === 'string' ? p['command'] : '';
                        if (command) trackedCommands.push(command);
                    }
                });

                let artifact: SweArtifact;
                let conductorCrashed = false;
                try {
                    if (attempt === 0) {
                        await conductorRef.runConductorTrack(sweObjective, node.acceptanceCriteria, sandbox);
                    } else if (lastAttemptCrashed) {
                        const crashRetryPrompt = [
                            '## Previous Session Crashed — Continue Your Work',
                            '',
                            'The previous session ended unexpectedly (transient infrastructure issue, NOT a code bug).',
                            'Continue the implementation from where you left off.',
                            ...(priorIssues.length > 0
                                ? ['', '## Outstanding QA Issues (from earlier attempts)', ...priorIssues.map((issue) => `- ${issue}`)]
                                : []),
                            '',
                            'After finishing, run `pnpm build` to verify it compiles.',
                        ].join('\n');
                        lastAttemptCrashed = false;
                        await conductorRef.resumeWithFollowup(crashRetryPrompt, sandbox);
                    } else {
                        const retryPrompt = [
                            `## QA Found ${priorIssues.length.toString()} Issue(s) — Fix Them`,
                            '',
                            ...priorIssues.map((issue) => `- ${issue}`),
                            '',
                            'Fix these issues in your existing code. Do NOT start over.',
                            'After fixing, run `pnpm build` to verify it compiles.',
                        ].join('\n');
                        await conductorRef.resumeWithFollowup(retryPrompt, sandbox);
                    }

                    const ragArtifact = this.#readSweArtifact(node.objective, sweId);
                    artifact = {
                        ...ragArtifact,
                        filesChanged: [...trackedFiles],
                        commandsRun: trackedCommands,
                        success: true,
                        // Prefer the conductor's live result over RAG (which may be empty in sandbox flow)
                        ...(conductorSummaryText ? { summary: conductorSummaryText } : {}),
                    };
                    logger.info(`[${this.agentId}] Artifact: ${trackedFiles.size.toString()} files changed, ${trackedCommands.length.toString()} commands run`);

                    // Store artifact in RAG so it appears in Memory tab
                    try {
                        const collections = ragStore.getCollections();
                        if (!collections.some((c) => c.name === SoftwareEngineer.RAG_COLLECTION)) {
                            ragStore.createCollection(SoftwareEngineer.RAG_COLLECTION, 'Structured SweArtifact outputs from SWE agent Claude Code runs');
                        }
                        ragStore.storeContext(SoftwareEngineer.RAG_COLLECTION, {
                            memoryId: crypto.randomUUID(),
                            traceId: this.traceId,
                            agentId: sweId,
                            content: `[${artifact.success ? 'SUCCESS' : 'FAILED'}] ${sweId}\n${JSON.stringify(artifact)}`,
                            tags: ['swe', 'conductor', artifact.success ? 'success' : 'failed', 'phase:implement'],
                            timestamp: new Date().toISOString(),
                        });
                    } catch (ragErr) {
                        logger.warn(`[${this.agentId}] Failed to store SWE artifact in RAG:`, ragErr);
                    }

                    saveState({
                        traceId: this.traceId,
                        nodeId: node.id,
                        sweId,
                        objective: node.objective,
                        acceptanceCriteria: node.acceptanceCriteria,
                        phase: 'awaiting-qa',
                        attempt,
                        filesChanged: artifact.filesChanged,
                        priorIssues,
                        ...(deployedServiceUrl !== undefined ? { serviceUrl: deployedServiceUrl } : {}),
                        conductorSummary: artifact.summary,
                        savedAt: new Date().toISOString(),
                    });
                } catch (conductorErr) {
                    const errMsg = conductorErr instanceof Error ? conductorErr.message : String(conductorErr);
                    logger.warn(`[${this.agentId}] Conductor crashed on attempt ${(attempt + 1).toString()}: ${errMsg}`);
                    conductorCrashed = true;
                    lastAttemptCrashed = true;

                    artifact = {
                        subtask: node.objective,
                        filesChanged: [...trackedFiles],
                        commandsRun: trackedCommands,
                        errors: [errMsg],
                        success: false,
                        summary: `Conductor failed: ${errMsg}`,
                    };
                } finally {
                    unsubDeployed();
                    unsubToolUsed();
                    unsubStateChanged();
                    conductorRef.abort();
                }

                // Skip QA if the conductor itself crashed
                if (conductorCrashed) {
                    logger.warn(`[${this.agentId}] Skipping QA for crashed attempt ${(attempt + 1).toString()}, will retry`);
                    continue;
                }

                // Restart dev servers before QA
                if (sandbox !== undefined) {
                    await this.#restartSandboxServers(artifact, sandbox);
                }

                // Validate via QA
                const qaId = `qa-engineer.${uuidv4().slice(0, 8)}`;
                const qa = new QaEngineer(qaId, this.traceId, this.agentId);
                const verdict = await qa.run(node.objective, node.acceptanceCriteria, artifact, deployedServiceUrl, sandbox, designSpec, graph, priorIssues.length > 0 ? priorIssues : undefined);

                if (verdict.passed) {
                    passed = true;
                    finalSummary = artifact.summary;
                    clearState();
                    break;
                }

                priorIssues = verdict.issues;
                logger.warn(`[${this.agentId}] Node [${node.id}] QA failed (attempt ${(attempt + 1).toString()}): ${verdict.issues.join('; ')}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            clearState();
            this.#emitAgentEvent(sweId, 'STATE_CHANGED', {
                message: `Failed: ${msg}`,
                phase: 'implement',
            });
            this.#emitAgentEvent(sweId, 'AGENT_TERMINATED', {
                reason: 'error',
                agentId: sweId,
                message: `${sweId} decommissioned. Reason: error.`,
            });
            return { success: false, summary: msg };
        }

        if (!passed) {
            const failSummary = `Failed QA after ${(MAX_RETRIES + 1).toString()} attempt(s). Last issues: ${priorIssues.join('; ').slice(0, 300)}`;
            this.#emitAgentEvent(sweId, 'STATE_CHANGED', {
                message: failSummary,
                phase: 'implement',
            });
            this.#emitAgentEvent(sweId, 'AGENT_TERMINATED', {
                reason: 'qa_failed',
                agentId: sweId,
                message: `${sweId} decommissioned. Reason: qa_failed.`,
            });
            return { success: false, summary: failSummary };
        }

        this.#emitAgentEvent(sweId, 'STATE_CHANGED', {
            message: finalSummary || 'Task completed successfully.',
            phase: 'implement',
        });
        this.#emitAgentEvent(sweId, 'AGENT_TERMINATED', {
            reason: 'task_complete',
            agentId: sweId,
            message: `${sweId} decommissioned. Reason: task_complete.`,
        });
        return { success: true, summary: finalSummary || node.objective };
    }

    // ── Private — build SWE objective ─────────────────────────────────────────

    async #buildSweObjective(
        node: TaskNode,
        researchContext: string,
        priorIssues: string[],
        attempt: number,
        designSpec: UxDesignSpec | null = null,
    ): Promise<string> {
        const contextBlocks: Record<string, string> = {};

        if (designSpec !== null && designSpec.layout !== '') {
            const designParts = [
                `Layout: ${designSpec.layout}`,
                `Components: ${designSpec.componentHierarchy}`,
                `User Flow: ${designSpec.userFlow}`,
                `Styling: ${designSpec.styling}`,
            ];
            if (designSpec.wireframe !== '') designParts.push(`Wireframe:\n\`\`\`\n${designSpec.wireframe}\n\`\`\``);
            if (designSpec.uxAcceptanceCriteria !== '') designParts.push(`UX Acceptance Criteria: ${designSpec.uxAcceptanceCriteria}`);
            contextBlocks['UX_DESIGN_SPEC'] = designParts.join('\n');
        }

        if (researchContext !== '' && researchContext !== 'No prior context found.') {
            contextBlocks['RESEARCH_CONTEXT'] = researchContext;
        }

        try {
            const manifest = credentialStore.getManifest();
            if (manifest.length > 0) {
                contextBlocks['AVAILABLE_SERVICES'] = manifest
                    .map((s) => `- ${s.serviceLabel} (${s.credentialType}): process.env.${s.envVarName}`)
                    .join('\n');
            }
        } catch { /* non-fatal */ }

        const blockList = Object.entries(contextBlocks)
            .map(([key, val]) => `<context_block name="${key}">\n${val}\n</context_block>`)
            .join('\n\n');

        const systemPrompt = `You are a technical project manager briefing a software engineer on their next task.
Your job is to write a focused, actionable briefing that contains ONLY the information
this engineer needs to complete their specific task. Do not include irrelevant context.

Rules:
- Start with the task objective (rewrite it to be clear and self-contained if needed)
- Include the acceptance criteria VERBATIM — the engineer will be tested on every one
- From the available context blocks, include ONLY the ones directly relevant to this task
- If a context block isn't useful for this specific task, omit it entirely
- Keep the briefing concise — every sentence should be actionable
- End with a checklist of the acceptance criteria the engineer must satisfy`;

        const userPrompt = `## Task
Objective: ${node.objective}
Task type: ${node.taskType}
Acceptance criteria: ${node.acceptanceCriteria}
${attempt > 0 && priorIssues.length > 0
    ? `\nQA FAILED (attempt ${attempt.toString()}/${MAX_RETRIES.toString()}) — the engineer MUST fix these issues:\n${priorIssues.map((i) => `- ${i}`).join('\n')}\n`
    : ''}
## Available Context Blocks
${blockList !== '' ? blockList : '(none available)'}

Write the briefing now.`;

        try {
            const completion = await generateWithRawTools(
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                [],
                'low',
            );
            const briefing = extractTextContent(completion).trim();
            if (briefing.length > 50) return briefing;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[${this.agentId}] SWE briefing LLM failed, using fallback: ${msg}`);
        }

        // Fallback: minimal objective + acceptance criteria
        const fallback = [
            node.objective,
            '',
            '## Acceptance Criteria',
            node.acceptanceCriteria,
        ];
        if (attempt > 0 && priorIssues.length > 0) {
            fallback.push(
                '',
                `## QA Failed (attempt ${attempt.toString()}/${MAX_RETRIES.toString()}) — Fix These Issues`,
                ...priorIssues.map((issue) => `- ${issue}`),
            );
        }
        return fallback.join('\n');
    }

    // ── Private — helpers ─────────────────────────────────────────────────────

    #readSweArtifact(subtask: string, sweId: string): SweArtifact {
        const results = ragStore.queryContext(SoftwareEngineer.RAG_COLLECTION, sweId);
        if (results.length > 0) {
            const content = results[0]?.entry.content ?? '';
            try {
                const jsonMatch = /\{[\s\S]+\}/.exec(content);
                if (jsonMatch) return JSON.parse(jsonMatch[0]) as SweArtifact;
            } catch { /* fall through */ }
            return {
                subtask,
                filesChanged: [],
                commandsRun: [],
                errors: content.includes('[FAILED]') ? ['Claude Code reported failure'] : [],
                success: content.includes('[SUCCESS]'),
                summary: content,
            };
        }
        return { subtask, filesChanged: [], commandsRun: [], errors: ['No artifact found'], success: false, summary: '' };
    }

    #emitGraph(graph: TaskGraph, message: string): void {
        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'TASK_GRAPH_UPDATED',
            sourceId: this.agentId,
            targetId: null,
            traceId: this.traceId,
            payload: {
                graph: JSON.parse(JSON.stringify(graph)) as Record<string, unknown>,
                message,
                isRootGraph: true,
            },
        } as unknown as SystemEvent);
    }

    #emitNodeCompleted(node: TaskNode): void {
        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'TASK_NODE_COMPLETED',
            sourceId: this.agentId,
            targetId: null,
            traceId: this.traceId,
            payload: {
                nodeId: node.id,
                status: node.status,
                result: node.result,
                error: node.error,
                attempts: node.attempts,
            },
        } as unknown as SystemEvent);
    }

    #emitAgentEvent(agentId: string, eventType: string, payload: Record<string, unknown>): void {
        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType,
            sourceId: agentId,
            targetId: null,
            traceId: this.traceId,
            payload,
        } as unknown as SystemEvent);
    }

    async #restartSandboxServers(artifact: SweArtifact, sandbox: SandboxHandle): Promise<void> {
        const { containerName, workDir, backendPort, webPort } = sandbox;
        const hasBackendFiles = artifact.filesChanged.some((f) => f.includes('apps/backend'));
        const hasFrontendFiles = artifact.filesChanged.some((f) => f.includes('apps/web'));

        this.emit('STATE_CHANGED', {
            message: 'Restarting dev servers before QA...',
            phase: 'validate',
        });

        // Kill existing node processes
        try {
            execSync(
                `docker exec ${containerName} sh -c "pkill -f 'node|next|tsx' 2>/dev/null; sleep 1; pkill -9 -f 'node|next|tsx' 2>/dev/null; true"`,
                { stdio: 'pipe', timeout: 10_000 },
            );
            logger.info(`[${this.agentId}] Killed existing node processes in ${containerName}`);
        } catch {
            // pkill returns non-zero if no processes found — that's fine
        }

        await sleep(2_000);

        const servers: Array<{ filter: string; label: string; port: number; healthPath: string }> = [];
        if (hasBackendFiles || hasFrontendFiles) {
            servers.push(
                { filter: '@ai-hivemind/backend', label: 'backend', port: backendPort, healthPath: '/health' },
                { filter: '@ai-hivemind/web', label: 'frontend', port: webPort, healthPath: '/' },
            );
        }

        for (const { filter, label, port } of servers) {
            const cmd = `cd ${workDir} && PORT=${port.toString()} pnpm --filter ${filter} dev > /tmp/${label}.log 2>&1 &`;
            try {
                execSync(
                    `docker exec ${containerName} sh -c ${JSON.stringify(cmd)}`,
                    { stdio: 'pipe', timeout: 10_000 },
                );
                logger.info(`[${this.agentId}] Restarted ${label} on port ${port.toString()}`);
            } catch (e) {
                logger.warn(`[${this.agentId}] Failed to restart ${label}:`, e);
            }
        }

        if (servers.length === 0) return;

        // Poll until servers respond (max 60s)
        const ready = new Set<string>();
        const maxWait = 60_000;
        const pollInterval = 3_000;
        let elapsed = 0;

        while (elapsed < maxWait && ready.size < servers.length) {
            await sleep(pollInterval);
            elapsed += pollInterval;

            for (const { label, port, healthPath } of servers) {
                if (ready.has(label)) continue;
                try {
                    execSync(
                        `curl -sf --max-time 3 http://localhost:${port.toString()}${healthPath}`,
                        { stdio: 'pipe' },
                    );
                    ready.add(label);
                    logger.info(`[${this.agentId}] ${label} ready after restart (${elapsed.toString()}ms)`);
                } catch {
                    // Not ready yet
                }
            }
        }

        // Warm up frontend routes
        const warmupUrls: string[] = [];
        for (const f of artifact.filesChanged) {
            const match = /apps\/web\/src\/app\/(.+?)\/page\.tsx$/.exec(f);
            if (match?.[1] !== undefined) {
                warmupUrls.push(`http://localhost:${webPort.toString()}/${match[1]}`);
            }
        }
        if (warmupUrls.length > 0) {
            logger.info(`[${this.agentId}] Warming up ${warmupUrls.length.toString()} route(s) after restart`);
            for (const url of warmupUrls) {
                try {
                    execSync(`curl -sf --max-time 15 "${url}" > /dev/null 2>&1`, { stdio: 'pipe', timeout: 20_000 });
                } catch {
                    // Non-fatal
                }
            }
            await sleep(2_000);
        }

        const missing = servers.filter((s) => !ready.has(s.label)).map((s) => s.label);
        if (missing.length > 0) {
            logger.warn(`[${this.agentId}] Servers not ready after restart: ${missing.join(', ')}`);
        } else {
            logger.info(`[${this.agentId}] All servers restarted successfully`);
        }
    }
}
