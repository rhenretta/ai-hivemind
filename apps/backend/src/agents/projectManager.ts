/**
 * projectManager.ts — Project Manager Agent (RPIV Pipeline)
 *
 * The single entry point for all feature work. Runs the full pipeline:
 *
 *   1. RESEARCH   — DataResearcher gathers codebase context
 *   2. DESIGN     — UxDesigner produces a UX design spec
 *   3. DECOMPOSE  — LLM decides: atomic (single task) or composite (DAG)
 *   4. EXECUTE    — Process nodes sequentially via Claude Code CLI + QA
 *
 * Previously this was split across three agents (Coordinator → ProjectManager
 * → TaskOrchestrator). Now it's a single agent that owns the full lifecycle.
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
import { UxDesigner } from './uxDesigner.js';
import { SoftwareEngineer } from './softwareEngineer.js';
import { QaEngineer } from './qaEngineer.js';

import type {
    TaskGraph,
    TaskNode,
    TaskStatus,
    UxDesignSpec,
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

function hasDesignSpec(spec: UxDesignSpec | null): boolean {
    return spec !== null && spec.layout !== '';
}

function buildDecomposerPrompt(objective: string, researchSummary: string, designSpec: UxDesignSpec | null): string {
    const hasDesign = hasDesignSpec(designSpec);
    const designSection = hasDesign
        ? `
## UX Design Spec
A UX Designer has produced a design for this feature. When decomposing into tasks:
- Tag frontend nodes with "taskType": "frontend" — they'll receive the full design spec
- Tag backend nodes with "taskType": "backend" — they won't receive the design spec
- Tag fullstack nodes with "taskType": "fullstack" — they'll receive the design spec
- Include ONLY the relevant design details in each node's objective (don't dump the whole spec)

Design summary:
  Layout: ${designSpec!.layout.slice(0, 300)}
  Components: ${designSpec!.componentHierarchy.slice(0, 200)}
  User Flow: ${designSpec!.userFlow.slice(0, 200)}`
        : '';

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
${designSection}

Respond in ONLY this JSON format:

ATOMIC case:
{
  "isAtomic": true,
  "nodes": [
    {
      "id": "task-1",
      "objective": "<full, self-contained description of what to build>",
      "acceptanceCriteria": "<specific, verifiable criteria>",
      "taskType": "frontend" | "backend" | "fullstack",
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
      "taskType": "backend",
      "dependsOn": []
    },
    {
      "id": "task-2",
      "objective": "<self-contained description — include context from task-1>",
      "acceptanceCriteria": "<specific criteria>",
      "taskType": "frontend",
      "dependsOn": ["task-1"]
    }
  ]
}

Rules:
- dependsOn MUST reference only IDs of nodes listed BEFORE this node
- Each node's objective must be fully self-contained (the SWE only sees this text + project context)
- Each node's objective should describe ONLY what that node does — don't repeat full-feature context
- taskType MUST be one of: "frontend", "backend", "fullstack"
  - "backend": API routes, services, data fetching, database work
  - "frontend": React components, pages, styling, UI interactions
  - "fullstack": tasks that touch both layers
- acceptanceCriteria must be concrete: mention file paths, function names, or testable behavior
- For backend tasks: acceptance criteria MUST include the exact API endpoint path(s) that should exist
  (e.g., "GET /api/reddit/posts returns JSON array of posts", "POST /api/users creates a user")
- For frontend tasks: acceptance criteria MUST include the exact page route(s) that should render
  (e.g., "/reddit page renders a list of posts", "/dashboard shows analytics charts")
- When a task involves content analysis, classification, filtering by meaning, or semantic understanding:
  acceptance criteria MUST specify using an appropriate available service (e.g., LLM-based analysis)
  rather than keyword lists, regex patterns, or hardcoded rules. Crude heuristics are not acceptable
  when a proper tool is available.
- Reference specific available services in acceptance criteria where relevant
  (e.g., "Use OpenAI to classify post sentiment" not just "filter negative posts")
- Order nodes so dependencies flow naturally (earlier nodes don't depend on later ones)
- A COMPOSITE must have at least 2 nodes`;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class ProjectManager extends BaseAgent {
    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    /**
     * Run the full RPIV pipeline for an objective.
     * Returns a final summary string.
     */
    async run(objective: string): Promise<string> {
        this.spawn('project-manager');
        this.emit('STATE_CHANGED', { message: `Starting: "${objective}"`, phase: 'start' });

        // ── Enrich objective with monorepo context ────────────────────────────
        // (Previously done by Coordinator's delegate_to_project_manager handler)
        const enrichedObjective = this.#enrichObjective(objective);

        // ── RESEARCH ──────────────────────────────────────────────────────────
        this.emit('STATE_CHANGED', { message: 'Researching codebase context...', phase: 'research' });
        const researcherId = `data-researcher.${uuidv4().slice(0, 8)}`;
        const researcher = new DataResearcher(researcherId, this.traceId);
        let researchSummary = 'No prior context found.';
        try {
            const result = await researcher.run(enrichedObjective);
            researchSummary = result.summary;
        } catch (err) {
            logger.warn(`[${this.agentId}] Research failed (non-fatal):`, err);
        }

        // ── DESIGN ────────────────────────────────────────────────────────────
        // UX Designer produces a design spec that feeds into decomposition,
        // SWE objectives, and QA visual validation.
        this.emit('STATE_CHANGED', { message: 'Designing user experience...', phase: 'design' });
        const designerId = `ux-designer.${uuidv4().slice(0, 8)}`;
        const designer = new UxDesigner(designerId, this.traceId);
        let designSpec: UxDesignSpec | null = null;
        try {
            designSpec = await designer.run(enrichedObjective, researchSummary);
            logger.info(`[${this.agentId}] UX design complete: ${designSpec.layout.slice(0, 100)}`);
        } catch (err) {
            logger.warn(`[${this.agentId}] Design phase failed (non-fatal):`, err);
        }

        // ── DECOMPOSE ─────────────────────────────────────────────────────────
        this.emit('STATE_CHANGED', { message: 'Decomposing objective into task graph...', phase: 'decompose' });
        let graph: TaskGraph;
        try {
            graph = await this.#decompose(enrichedObjective, researchSummary, designSpec);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit('ERROR', { message: `Decomposition failed: ${msg}`, agentId: this.agentId });
            this.terminate('decompose_failed');
            return `Failed during decomposition: ${msg}`;
        }

        // Emit the initial graph — UI shows the plan
        this.#emitGraph(graph, 'Task graph created');

        // ── EXECUTE ───────────────────────────────────────────────────────────
        const result = await this.#executeGraph(graph, researchSummary, designSpec);
        this.terminate(result.success ? 'task_complete' : 'task_failed');
        return result.summary;
    }

    // ── Private — objective enrichment ─────────────────────────────────────────

    /**
     * Enrich a raw objective with monorepo context and available external
     * services so downstream agents (DataResearcher, decomposer LLM) have
     * the stack information they need without having to discover it.
     *
     * Previously this was done inside Coordinator's delegate_to_project_manager
     * tool handler.
     */
    #enrichObjective(objective: string): string {
        const parts = [
            objective,
            '',
            '## Project Context',
            `Monorepo root: ${process.env['MONOREPO_ROOT'] ?? '/Users/rhenretta/workspace/rhenretta/ai-hivemind'}`,
            'Tech stack: Next.js 14 (App Router), Node.js/Express backend (apps/backend), pnpm workspaces, TypeScript throughout.',
            'New standalone apps/pages go in apps/web/src/app/ as Next.js route segments.',
        ];

        // Append available external services (API keys, etc.)
        try {
            const manifest = credentialStore.getManifest();
            if (manifest.length > 0) {
                parts.push(
                    '',
                    '## Available External Services',
                    'These services have API keys configured and available to agents:',
                    ...manifest.map((s) => `- ${s.serviceLabel} (env: ${s.envVarName})`),
                );
            }
        } catch {
            // Non-fatal — credential store may not be initialized
        }

        return parts.join('\n');
    }

    // ── Private — decompose ───────────────────────────────────────────────────

    async #decompose(objective: string, researchSummary: string, designSpec: UxDesignSpec | null = null): Promise<TaskGraph> {
        const prompt = buildDecomposerPrompt(objective, researchSummary, designSpec);
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
            nodes: Array<{ id: string; objective: string; acceptanceCriteria: string; taskType?: string; dependsOn: string[] }>;
        };
        const parsed = JSON.parse(json) as DecomposerResponse;

        if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
            throw new Error('Decomposer returned empty node list');
        }

        const validTypes = new Set(['frontend', 'backend', 'fullstack']);
        const nodes: TaskNode[] = parsed.nodes.slice(0, MAX_NODES).map((n, i) => ({
            id: n.id ?? `task-${(i + 1).toString()}`,
            objective: String(n.objective ?? ''),
            acceptanceCriteria: String(n.acceptanceCriteria ?? 'Implementation is complete and functional.'),
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.map(String) : [],
            status: 'pending' as TaskStatus,
            isAtomic: parsed.isAtomic || parsed.nodes.length === 1,
            taskType: (typeof n.taskType === 'string' && validTypes.has(n.taskType)
                ? n.taskType
                : 'fullstack') as TaskNode['taskType'],
        }));

        return {
            rootObjective: objective,
            nodes,
            createdAt: new Date().toISOString(),
            status: 'pending',
        };
    }

    // ── Private — execute ─────────────────────────────────────────────────────

    async #executeGraph(graph: TaskGraph, researchSummary: string, designSpec: UxDesignSpec | null = null): Promise<{ success: boolean; summary: string }> {
        const completedSummaries: string[] = [];

        // ── Feature sandbox ───────────────────────────────────────────────────
        // Create (or reuse) the per-feature sandbox keyed on this.traceId.
        // All Conductor sub-tasks share it.
        const sandbox = await createFeatureSandbox(this.traceId);
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

    async #executeNode(node: TaskNode, researchSummary: string, sandbox: SandboxHandle, designSpec: UxDesignSpec | null = null, graph?: TaskGraph): Promise<{ success: boolean; summary: string }> {
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

        // Emit SWE lifecycle events so the agent appears in the Activity Log.
        // The conductor's internal events (CONDUCTOR_STREAM, tool calls) stay
        // hidden in the Terminal tab — these are the high-level summary events.
        this.#emitSweEvent(sweId, 'AGENT_SPAWNED', {
            role: 'swe-agent',
            agentId: sweId,
        });

        // Single ConductorWrapper across all attempts — retries use --resume
        // so Claude Code keeps its full context (files read, changes made).
        const conductorRef = new ConductorWrapper(sweId, this.traceId);

        try {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                node.attempts = attempt + 1;

                // Build the enriched prompt for this attempt
                const sweObjective = this.#buildSweObjective(node, researchSummary, priorIssues, attempt, designSpec);

                // Emit with the FULL objective — this is what Claude Code actually receives.
                // The activity log shows the short message; raw JSON reveals the full prompt.
                this.#emitSweEvent(sweId, 'STATE_CHANGED', {
                    message: attempt === 0
                        ? node.objective
                        : lastAttemptCrashed
                            ? `Retry ${attempt.toString()}: resuming after crash`
                            : `Retry ${attempt.toString()}: fixing ${priorIssues.length.toString()} QA issue(s)`,
                    phase: 'implement',
                    objective: sweObjective,
                    attempt,
                });

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

                // Track files changed by the conductor via code_change events
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

                const conductor = conductorRef;

                let artifact: SweArtifact;
                let conductorCrashed = false;
                try {
                    if (attempt === 0) {
                        // First attempt: fresh session
                        await conductor.runConductorTrack(sweObjective, node.acceptanceCriteria, sandbox);
                    } else if (lastAttemptCrashed) {
                        // Last attempt crashed (transient infra issue, not a code bug).
                        // Tell the SWE to continue the work, not "fix issues".
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
                        await conductor.resumeWithFollowup(crashRetryPrompt, sandbox);
                    } else {
                        // Retry after QA failure: resume with QA feedback.
                        const retryPrompt = [
                            `## QA Found ${priorIssues.length.toString()} Issue(s) — Fix Them`,
                            '',
                            ...priorIssues.map((issue) => `- ${issue}`),
                            '',
                            'Fix these issues in your existing code. Do NOT start over.',
                            'After fixing, run `pnpm build` to verify it compiles.',
                        ].join('\n');
                        await conductor.resumeWithFollowup(retryPrompt, sandbox);
                    }

                    // Build artifact from tracked events + RAG fallback for summary
                    const ragArtifact = this.#readSweArtifact(node.objective, sweId);
                    artifact = {
                        ...ragArtifact,
                        filesChanged: [...trackedFiles],
                        commandsRun: trackedCommands,
                        success: true,
                    };
                    logger.info(`[${this.agentId}] Artifact: ${trackedFiles.size.toString()} files changed, ${trackedCommands.length.toString()} commands run`);

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
                } catch (conductorErr) {
                    // Conductor crash (e.g. Claude Code exited code 1) — treat as
                    // a failed attempt, not an abort of the entire retry sequence.
                    // DO NOT add crash to priorIssues — those are for real QA findings.
                    // The SWE should just continue the work, not debug a transient crash.
                    const errMsg = conductorErr instanceof Error ? conductorErr.message : String(conductorErr);
                    logger.warn(`[${this.agentId}] Conductor crashed on attempt ${(attempt + 1).toString()}: ${errMsg}`);
                    conductorCrashed = true;
                    lastAttemptCrashed = true;

                    // Build a minimal artifact so the loop can continue
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
                    conductor.abort();
                }

                // Skip QA if the conductor itself crashed — go straight to retry
                if (conductorCrashed) {
                    logger.warn(`[${this.agentId}] Skipping QA for crashed attempt ${(attempt + 1).toString()}, will retry`);
                    continue;
                }

                // ── VALIDATE ─────────────────────────────────────────────────
                const qaId = `qa-engineer.${uuidv4().slice(0, 8)}`;
                const qa = new QaEngineer(qaId, this.traceId);
                const verdict = await qa.run(node.objective, node.acceptanceCriteria, artifact, deployedServiceUrl, sandbox, designSpec, graph);

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
            this.#emitSweEvent(sweId, 'STATE_CHANGED', {
                message: `Failed: ${msg}`,
                phase: 'implement',
                taskComplete: true,
            });
            this.#emitSweEvent(sweId, 'AGENT_TERMINATED', {
                reason: 'error',
                agentId: sweId,
                message: `${sweId} decommissioned. Reason: error.`,
            });
            return { success: false, summary: msg };
        }

        if (!passed) {
            const failSummary = `Failed QA after ${(MAX_RETRIES + 1).toString()} attempts. Last issues: ${priorIssues.join('; ')}`;
            this.#emitSweEvent(sweId, 'STATE_CHANGED', {
                message: failSummary,
                phase: 'implement',
            });
            this.#emitSweEvent(sweId, 'AGENT_TERMINATED', {
                reason: 'qa_failed',
                agentId: sweId,
                message: `${sweId} decommissioned. Reason: qa_failed.`,
            });
            return { success: false, summary: failSummary };
        }

        // Success — emit summary with file count
        this.#emitSweEvent(sweId, 'STATE_CHANGED', {
            message: finalSummary || 'Task completed successfully.',
            phase: 'implement',
            taskComplete: true,
        });
        this.#emitSweEvent(sweId, 'AGENT_TERMINATED', {
            reason: 'task_complete',
            agentId: sweId,
            message: `${sweId} decommissioned. Reason: task_complete.`,
        });
        return { success: true, summary: finalSummary || node.objective };
    }

    // ── Private — helpers ─────────────────────────────────────────────────────

    /**
     * Build a clean, focused prompt for the SWE agent.
     *
     * Context filtering rules:
     *   - "backend" tasks get NO design spec — it's irrelevant noise
     *   - "frontend"/"fullstack" tasks get the full design spec
     *   - Project root + sandbox info is handled by runConductorTrack (not here)
     *   - Acceptance criteria appear exactly ONCE
     */
    #buildSweObjective(node: TaskNode, researchContext: string, priorIssues: string[], attempt: number, designSpec: UxDesignSpec | null = null): string {
        const isFrontend = node.taskType === 'frontend' || node.taskType === 'fullstack';
        const includeDesign = isFrontend && hasDesignSpec(designSpec);

        const parts: string[] = [
            node.objective,
            '',
            '## Acceptance Criteria',
            node.acceptanceCriteria,
        ];

        // UX Design Spec — only for frontend/fullstack tasks, and only if the spec is real
        if (includeDesign && designSpec !== null) {
            parts.push(
                '',
                '## UX Design Spec',
                'The UX Designer has specified this design. Follow it faithfully.',
                '',
                `**Layout:** ${designSpec.layout}`,
                '',
                `**Components:** ${designSpec.componentHierarchy}`,
                '',
                `**User Flow:** ${designSpec.userFlow}`,
                '',
                `**Styling:** ${designSpec.styling}`,
            );
            if (designSpec.wireframe !== '') {
                parts.push(
                    '',
                    '**Wireframe:**',
                    '```',
                    designSpec.wireframe,
                    '```',
                );
            }
            if (designSpec.uxAcceptanceCriteria !== '') {
                parts.push(
                    '',
                    '**UX Acceptance Criteria:**',
                    designSpec.uxAcceptanceCriteria,
                );
            }
        }

        // Research context — brief and relevant
        if (researchContext !== '' && researchContext !== 'No prior context found.') {
            parts.push(
                '',
                '## Research Context',
                researchContext,
            );
        }

        // Tech stack (version-correct, minimal)
        parts.push(
            '',
            '## Tech Stack',
            'Next.js 15 (App Router) + React 19, Tailwind CSS, shadcn/ui, TypeScript, pnpm workspaces.',
            'Backend: Node.js + Express (apps/backend). Frontend pages: apps/web/src/app/ as route segments.',
        );

        // Available external services (API keys, etc.)
        try {
            const manifest = credentialStore.getManifest();
            if (manifest.length > 0) {
                parts.push(
                    '',
                    '## Available Services',
                    ...manifest.map((s) => `- **${s.serviceLabel}** (${s.credentialType}): \`process.env.${s.envVarName}\``),
                );
            }
        } catch {
            // Non-fatal — credential store may not be initialized
        }

        // QA retry context
        if (attempt > 0 && priorIssues.length > 0) {
            parts.push(
                '',
                `## QA Failed (attempt ${attempt.toString()}/${MAX_RETRIES.toString()}) — Fix These Issues`,
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

    /**
     * Emit an event on behalf of the SWE agent (sourceId = sweId).
     *
     * The SWE agent is managed entirely by ProjectManager — there's no
     * separate SoftwareEngineer.run() call. We emit lifecycle events
     * (AGENT_SPAWNED, STATE_CHANGED, AGENT_TERMINATED) so the SWE
     * appears in the Activity Log with the objective, summary, and status.
     *
     * Conductor-internal events (CONDUCTOR_STREAM, tool calls) remain
     * hidden — those live in the Terminal tab.
     */
    #emitSweEvent(sweId: string, eventType: string, payload: Record<string, unknown>): void {
        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType,
            sourceId: sweId,
            targetId: null,
            traceId: this.traceId,
            payload,
        } as unknown as import('@ai-hivemind/shared').SystemEvent);
    }
}
