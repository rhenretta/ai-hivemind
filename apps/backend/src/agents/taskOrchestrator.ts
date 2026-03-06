/**
 * taskOrchestrator.ts — Task Graph Orchestration Engine
 *
 * Replaces the flat subtask loop in ProjectManager with a proper DAG engine:
 *
 *   1. DECOMPOSE  — LLM decides: is the request atomic (single Conductor task)
 *                   or composite (needs to be broken into nodes with dependencies)?
 *
 *   2. BUILD GRAPH — Create TaskGraph with nodes + dependsOn edges.
 *                    Emit TASK_GRAPH_UPDATED so the UI shows the plan.
 *
 *   3. EXECUTE    — Process nodes sequentially. For each ready node (all deps done):
 *                   a. isAtomic=true  → run via Claude Code CLI (autonomous task + QA)
 *                   b. isAtomic=false → spawn child TaskOrchestrator to decompose further
 *                   Update status, emit TASK_GRAPH_UPDATED on every change.
 *
 *   4. COMPLETE   — All nodes done → success. Any node failed → mark dependents
 *                   as 'skipped' and report failure.
 *
 * Sequential execution: one node at a time. Tasks with no mutual dependencies
 * are still executed one-after-another (simpler, safer for file conflicts).
 */

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { logger } from '../services/logger.js';
import { eventBus } from '../eventBus.js';
import { credentialStore } from '../services/credentialStore.js';
import { ragStore } from '../services/ragStore.js';
import { ConductorWrapper } from '../services/conductor.js';
import { createFeatureSandbox, type SandboxHandle } from '../services/sandboxManager.js';
import { saveState, clearState } from '../services/taskStateStore.js';
import { BaseAgent } from './baseAgent.js';
import { DataResearcher } from './dataResearcher.js';
import { SoftwareEngineer } from './softwareEngineer.js';
import { QaEngineer } from './qaEngineer.js';

import type {
    TaskGraph,
    TaskNode,
    TaskStatus,
} from '@ai-hivemind/shared';
import {
    dependenciesMet,
    dependencyFailed,
    deriveGraphStatus,
} from '@ai-hivemind/shared';
import type { SweArtifact } from '@ai-hivemind/shared';
import type { SystemEvent } from '@ai-hivemind/shared';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const MAX_NODES = 8; // safety cap on decomposition depth

// ── Decomposer prompt ─────────────────────────────────────────────────────────

function buildDecomposerPrompt(objective: string, researchSummary: string): string {
    return `You are an expert software project planner for an AI coding swarm.

Given a software objective, you must decide:
  A) Is this atomic? (A single coding session can complete it end-to-end)
  B) Or composite? (Needs to be broken into sequential dependent tasks)

Rules for ATOMIC:
- A single developer working for 30-60 minutes could complete it
- It touches a focused area (one feature, one bug fix, one service)
- It has a clear, testable acceptance criterion

Rules for COMPOSITE:
- Requires multiple distinct features or services
- Has natural sequential phases (e.g. "build backend API" then "build frontend UI")
- Different parts have clear dependency ordering

Research context:
${researchSummary}

Respond in ONLY this JSON format:

ATOMIC case:
{
  "isAtomic": true,
  "nodes": [
    {
      "id": "task-1",
      "objective": "<full, self-contained description of what to build>",
      "acceptanceCriteria": "<specific, verifiable criteria>",
      "dependsOn": []
    }
  ]
}

COMPOSITE case (max ${MAX_NODES.toString()} nodes):
{
  "isAtomic": false,
  "nodes": [
    {
      "id": "task-1",
      "objective": "<self-contained description>",
      "acceptanceCriteria": "<specific criteria>",
      "dependsOn": []
    },
    {
      "id": "task-2",
      "objective": "<self-contained description — include context from task-1>",
      "acceptanceCriteria": "<specific criteria>",
      "dependsOn": ["task-1"]
    }
  ]
}

Rules:
- dependsOn MUST reference only IDs of nodes listed BEFORE this node
- Each node's objective must be fully self-contained (SWE only sees this text + project context)
- acceptanceCriteria must be concrete: mention file paths, function names, or testable behavior
- Order nodes so dependencies flow naturally (earlier nodes don't depend on later ones)
- A COMPOSITE must have at least 2 nodes`;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class TaskOrchestrator extends BaseAgent {
    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    /**
     * Run the full task orchestration loop for an objective.
     * Returns a final summary string.
     */
    async run(objective: string): Promise<string> {
        this.spawn('task-orchestrator');
        this.emit('STATE_CHANGED', { message: `Task orchestrator starting: "${objective.slice(0, 100)}"`, phase: 'start' });

        // ── RESEARCH ──────────────────────────────────────────────────────────
        this.emit('STATE_CHANGED', { message: 'Researching codebase context...', phase: 'research' });
        const researcherId = `data-researcher.${uuidv4().slice(0, 8)}`;
        const researcher = new DataResearcher(researcherId, this.traceId);
        let researchSummary = 'No prior context found.';
        try {
            const result = await researcher.run(objective);
            researchSummary = result.summary;
        } catch (err) {
            logger.warn(`[${this.agentId}] Research failed (non-fatal):`, err);
        }

        // ── DECOMPOSE ─────────────────────────────────────────────────────────
        this.emit('STATE_CHANGED', { message: 'Decomposing objective into task graph...', phase: 'decompose' });
        let graph: TaskGraph;
        try {
            graph = await this.#decompose(objective, researchSummary);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit('ERROR', { message: `Decomposition failed: ${msg}`, agentId: this.agentId });
            this.terminate('decompose_failed');
            return `Failed during decomposition: ${msg}`;
        }

        // Emit the initial graph — UI shows the plan
        this.#emitGraph(graph, 'Task graph created');

        // ── EXECUTE ───────────────────────────────────────────────────────────
        const result = await this.#executeGraph(graph, researchSummary);
        this.terminate(result.success ? 'task_complete' : 'task_failed');
        return result.summary;
    }

    // ── Private — decompose ───────────────────────────────────────────────────

    async #decompose(objective: string, researchSummary: string): Promise<TaskGraph> {
        const prompt = buildDecomposerPrompt(objective, researchSummary);
        const completion = await generateWithRawTools(
            [
                { role: 'system', content: prompt },
                { role: 'user', content: `Objective: ${objective}` },
            ],
            [],
            'high',
        );

        const raw = extractTextContent(completion).trim();
        const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

        type DecomposerResponse = {
            isAtomic: boolean;
            nodes: Array<{ id: string; objective: string; acceptanceCriteria: string; dependsOn: string[] }>;
        };
        const parsed = JSON.parse(json) as DecomposerResponse;

        if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
            throw new Error('Decomposer returned empty node list');
        }

        const nodes: TaskNode[] = parsed.nodes.slice(0, MAX_NODES).map((n, i) => ({
            id: n.id ?? `task-${(i + 1).toString()}`,
            objective: String(n.objective ?? ''),
            acceptanceCriteria: String(n.acceptanceCriteria ?? 'Implementation is complete and functional.'),
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.map(String) : [],
            status: 'pending' as TaskStatus,
            isAtomic: parsed.isAtomic || parsed.nodes.length === 1,
        }));

        return {
            rootObjective: objective,
            nodes,
            createdAt: new Date().toISOString(),
            status: 'pending',
        };
    }

    // ── Private — execute ─────────────────────────────────────────────────────

    async #executeGraph(graph: TaskGraph, researchSummary: string): Promise<{ success: boolean; summary: string }> {
        const completedSummaries: string[] = [];

        // ── Feature sandbox ───────────────────────────────────────────────────
        // Create (or reuse, if this is a coordinator retry) the per-feature
        // sandbox keyed on this.traceId. All Conductor sub-tasks share it.
        // Tracks created during the run stay isolated until the full feature
        // passes QA, then are promoted to the real conductor/ directory.
        const sandbox = createFeatureSandbox(this.traceId);
        logger.info(`[${this.agentId}] Using feature sandbox container: ${sandbox.containerName}`);

        // Sequential loop: keep processing until no more pending nodes can run
        let madeProgress = true;
        while (madeProgress) {
            madeProgress = false;

            // First: mark any node whose dependency failed/skipped as 'skipped'
            for (const node of graph.nodes) {
                if (node.status === 'pending' && dependencyFailed(node, graph)) {
                    node.status = 'skipped';
                    this.#emitNodeCompleted(graph, node);
                    madeProgress = true;
                }
            }

            // Find the next pending node whose dependencies are all done
            const nextNode = graph.nodes.find(
                (n: TaskNode) => n.status === 'pending' && dependenciesMet(n, graph),
            );

            if (nextNode === undefined) break;

            // Execute this node
            nextNode.status = 'active';
            graph.status = 'active';
            this.#emitGraph(graph, `Executing [${nextNode.id}]: ${nextNode.objective.slice(0, 80)}`);

            const nodeResult = await this.#executeNode(nextNode, researchSummary, sandbox);
            madeProgress = true;

            if (nodeResult.success) {
                nextNode.status = 'done';
                nextNode.result = nodeResult.summary;
                completedSummaries.push(`[${nextNode.id}] ✓ ${nodeResult.summary.slice(0, 100)}`);
            } else {
                nextNode.status = 'failed';
                nextNode.error = nodeResult.summary;
            }

            graph.status = deriveGraphStatus(graph);
            this.#emitNodeCompleted(graph, nextNode);
            this.#emitGraph(graph, `[${nextNode.id}] ${nextNode.status}`);
        }

        const allDoneOrSkipped = graph.nodes.every((n: TaskNode) => n.status === 'done' || n.status === 'skipped');
        const failedNodes = graph.nodes.filter((n: TaskNode) => n.status === 'failed');

        if (allDoneOrSkipped && failedNodes.length === 0) {
            // Sandbox stays alive for preview — merge happens when user clicks "Deploy"
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

    async #executeNode(node: TaskNode, researchSummary: string, sandbox: SandboxHandle): Promise<{ success: boolean; summary: string }> {
        this.emit('STATE_CHANGED', {
            message: `Starting node [${node.id}]: ${node.objective.slice(0, 100)}`,
            phase: 'implement',
            nodeId: node.id,
        });

        let passed = false;
        let priorIssues: string[] = [];
        let finalSummary = '';

        const sweId = `swe-agent.${uuidv4().slice(0, 8)}`;

        try {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                node.attempts = attempt + 1;

                // Build the enriched prompt for this attempt
                const sweObjective = this.#buildSweObjective(node, researchSummary, priorIssues, attempt);

                // Persist state so a tsx restart can resume at QA
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

                // Spawn a fresh ConductorWrapper for each attempt.
                // The sandboxDir (per-feature, keyed on traceId) is passed as cwd
                // so all conductor/ artifacts go to the isolated sandbox.
                const conductor = new ConductorWrapper(sweId, this.traceId);

                let artifact: SweArtifact;
                try {
                    await conductor.runConductorTrack(sweObjective, node.acceptanceCriteria, sandbox);

                    artifact = this.#readSweArtifact(node.objective, sweId);

                    // Save awaiting-qa state so a tsx restart can resume QA
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
                } finally {
                    unsubDeployed();
                    conductor.abort();
                }

                // ── VALIDATE ─────────────────────────────────────────────────
                const qaId = `qa-engineer.${uuidv4().slice(0, 8)}`;
                const qa = new QaEngineer(qaId, this.traceId);
                const verdict = await qa.run(node.objective, node.acceptanceCriteria, artifact, deployedServiceUrl, sandbox);

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
            return { success: false, summary: msg };
        }

        if (!passed) {
            return {
                success: false,
                summary: `Failed QA after ${(MAX_RETRIES + 1).toString()} attempts. Last issues: ${priorIssues.join('; ')}`,
            };
        }

        return { success: true, summary: finalSummary || node.objective.slice(0, 100) };
    }

    // ── Private — helpers ─────────────────────────────────────────────────────

    #buildSweObjective(node: TaskNode, researchContext: string, priorIssues: string[], attempt: number): string {
        const parts = [
            node.objective,
            '',
            '## Acceptance Criteria',
            node.acceptanceCriteria,
            '',
            '## Research Context',
            researchContext,
            '',
            '## Project Context',
            `Monorepo root: ${process.env['MONOREPO_ROOT'] ?? '/Users/rhenretta/workspace/rhenretta/ai-hivemind'}`,
            'Tech stack: Next.js 14 (apps/web), Node.js/Express backend (apps/backend), pnpm workspaces, TypeScript throughout.',
            'New standalone apps/pages go in apps/web/src/app/ as Next.js route segments.',
            '',
            '## Rules',
            '- Create a complete, working implementation.',
            '- Start a dev server when done if applicable.',
            '- Run `pnpm build` or `pnpm tsc` to verify TypeScript before finishing.',
        ];

        // Add available external services so the SWE agent knows what APIs it can use
        try {
            const manifest = credentialStore.getManifest();
            if (manifest.length > 0) {
                parts.push(
                    '',
                    '## Available External Services',
                    'The following API keys are pre-configured and available as environment variables in your execution environment.',
                    'You can use them directly in code without asking the user for keys.',
                    ...manifest.map((s) => `- **${s.serviceLabel}** (${s.credentialType}): available as \`process.env.${s.envVarName}\` or \`$${s.envVarName}\``),
                );
            }
        } catch {
            // Non-fatal — credential store may not be initialized
        }

        if (attempt > 0 && priorIssues.length > 0) {
            parts.push(
                '',
                `## ⚠️  QA Failed (attempt ${attempt.toString()}/${MAX_RETRIES.toString()}) — Fix These Issues`,
                ...priorIssues.map((issue) => `- ${issue}`),
            );
        }

        return parts.join('\n');
    }

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
        return { subtask, filesChanged: [], commandsRun: [], errors: ['No artifact found'], success: false, summary: 'No artifact' };
    }

    #emitGraph(graph: TaskGraph, message: string): void {
        // Use 'STATE_CHANGED' as the event type since BaseAgent.emit() is typed
        // to the currently known event types. TASK_GRAPH_UPDATED is emitted via
        // raw eventBus to carry the full graph payload.
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
            },
        } as unknown as import('@ai-hivemind/shared').SystemEvent);
    }

    #emitNodeCompleted(graph: TaskGraph, node: TaskNode): void {
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
        } as unknown as import('@ai-hivemind/shared').SystemEvent);
        void graph; // suppress unused var
    }
}
