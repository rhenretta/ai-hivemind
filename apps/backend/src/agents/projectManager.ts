/**
 * projectManager.ts — Project Manager Agent (RPIV Pipeline)
 *
 * @deprecated — The DialogueAgent now owns the task graph directly and spawns
 * FeatureDeveloper for execution. This file is kept for reference but is no
 * longer instantiated by server.ts. See:
 *   - dialogueAgent.ts — task graph ownership, agent orchestration
 *   - featureDeveloper.ts — execution engine (ported from this file)
 *
 * Old pipeline (no longer used):
 *   1. RESEARCH   — DataResearcher gathers codebase context
 *   2. DESIGN     — UxDesigner produces a UX design spec
 *   3. DECOMPOSE  — LLM decides: atomic (single task) or composite (DAG)
 *   4. EXECUTE    — Process nodes sequentially via Claude Code CLI + QA
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
import { createFeatureSandbox, type SandboxHandle } from '../services/sandboxManager.js';
import { saveState, clearState, loadPendingState, type AttemptRecord } from '../services/taskStateStore.js';
import { BaseAgent } from './baseAgent.js';
import { DataResearcher } from './dataResearcher.js';
import { SiteExplorer } from './siteExplorer.js';
import { UxDesigner } from './uxDesigner.js';
import { SoftwareEngineer } from './softwareEngineer.js';
import { QaEngineer } from './qaEngineer.js';

import type { SiteExplorationResult } from './siteExplorer.js';

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
    appendNodes,
    updatePendingNode,
} from '@ai-hivemind/shared';
import type { SweArtifact } from '@ai-hivemind/shared';
import type { SystemEvent } from '@ai-hivemind/shared';
import { QaArbiterDecisionSchema, type QaArbiterDecision } from '@ai-hivemind/shared';

import { contextAgent } from '../services/contextAgent.js';
import { getDialogueAgent } from '../services/dialogueAgent.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ARBITER_ROUNDS = 5; // safety cap — after this many attempts, force ask_user
const MAX_NODES = 8; // safety cap on decomposition depth
const MAX_PM_DEPTH = 3; // cap on recursive PM hierarchy depth

// ── Sub-PM Context ───────────────────────────────────────────────────────────

/** Context passed from a parent PM to a sub-PM for delegated execution. */
export interface SubPmContext {
    /** Research summary inherited from parent — skip re-research */
    researchSummary: string;
    /** UX design spec inherited from parent — skip re-design */
    designSpec: UxDesignSpec | null;
    /** Shared sandbox handle (same Docker container for entire feature) */
    sandbox: SandboxHandle;
    /** Current nesting depth (root = 0) */
    depth: number;
    /** The specific task node this sub-PM is responsible for */
    assignedNode: TaskNode;
    /** Summary of completed sibling tasks and their changes */
    siblingContext: string;
}

// ── Decomposer prompt ─────────────────────────────────────────────────────────

function hasDesignSpec(spec: UxDesignSpec | null): boolean {
    return spec !== null && spec.layout !== '';
}

function buildDecomposerPrompt(objective: string, researchSummary: string, designSpec: UxDesignSpec | null, depth = 0, siblingContext = ''): string {
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
  User Flow: ${designSpec!.userFlow.slice(0, 200)}
  Navigation: ${designSpec!.navigationIntegration?.slice(0, 300) ?? 'Not specified — ensure new pages are linked from existing navigation'}`
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
      "dependsOn": [],
      "delegatable": false
    },
    {
      "id": "task-2",
      "objective": "<self-contained description — include context from task-1>",
      "acceptanceCriteria": "<specific criteria>",
      "taskType": "frontend",
      "dependsOn": ["task-1"],
      "delegatable": true
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
- A COMPOSITE must have at least 2 nodes
- NAVIGATION RULE: When a task creates a new page or route, there MUST be a task (or acceptance
  criterion within a task) that adds a navigation link from existing pages to the new page.
  Users must be able to discover and reach the new feature from the main site. Check the design
  spec's Navigation field for where the link should go. A new page with no entry point is a blocker.
- "delegatable": set to true if the node is complex enough to warrant its own sub-project-manager.
  A node is delegatable when:
  - It involves multiple distinct sub-phases (e.g. "build auth system" = schema + middleware + routes + UI)
  - It touches 3+ files across different areas of the codebase
  - It could reasonably be decomposed into 2+ sequential sub-tasks
  Set to false for focused changes (one component, one API route, one config).${depth >= MAX_PM_DEPTH - 1 ? '\n  NOTE: Maximum delegation depth reached — set ALL nodes to "delegatable": false.' : ''}${siblingContext !== '' ? `

SIBLING TASK CONTEXT — These tasks are being handled by OTHER project managers in the same hierarchy.
Do NOT duplicate any work described below. Your decomposition must ONLY cover the objective above.
If a sibling already handles frontend, do NOT add frontend tasks. If a sibling handles backend, do NOT add backend tasks.
${siblingContext}` : ''}`;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class ProjectManager extends BaseAgent {
    /** If non-null, this PM is a sub-PM spawned for a specific node. */
    readonly #subPmContext: SubPmContext | null;

    constructor(
        agentId: string,
        traceId: string,
        parentAgentId: string | null = null,
        subPmContext: SubPmContext | null = null,
    ) {
        super(agentId, traceId, parentAgentId);
        this.#subPmContext = subPmContext;
    }

    /**
     * Run the full RPIV pipeline for an objective.
     * If this is a sub-PM (has SubPmContext), skips Research/Explore/Design
     * and goes straight to Decompose+Execute.
     * Returns a final summary string.
     */
    async run(objective: string): Promise<string> {
        this.spawn('project-manager');

        // Sub-PM path: skip Research/Explore/Design, go to Decompose+Execute
        if (this.#subPmContext !== null) {
            return this._runAsSubPm(objective);
        }

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
        // Share research summary with Context Agent for dialogue enrichment
        contextAgent.setResearchSummary(this.traceId, researchSummary);

        // ── EXPLORE ───────────────────────────────────────────────────────────
        // Site Explorer browses the live frontend to understand current state.
        // Provides visual context (screenshots) for the UX Designer.
        this.emit('STATE_CHANGED', { message: 'Exploring current site...', phase: 'explore' });
        const explorerId = `site-explorer.${uuidv4().slice(0, 8)}`;
        const explorer = new SiteExplorer(explorerId, this.traceId);
        let siteExploration: SiteExplorationResult | undefined;
        try {
            siteExploration = await explorer.run(enrichedObjective);
            logger.info(`[${this.agentId}] Site exploration complete: ${siteExploration.pages.length.toString()} pages captured`);
        } catch (err) {
            logger.warn(`[${this.agentId}] Site exploration failed (non-fatal):`, err);
        }

        // ── DESIGN ────────────────────────────────────────────────────────────
        // UX Designer produces a design spec that feeds into decomposition,
        // SWE objectives, and QA visual validation. Now receives site screenshots.
        this.emit('STATE_CHANGED', { message: 'Designing user experience...', phase: 'design' });
        const designerId = `ux-designer.${uuidv4().slice(0, 8)}`;
        const designer = new UxDesigner(designerId, this.traceId);
        let designSpec: UxDesignSpec | null = null;
        try {
            designSpec = await designer.run(enrichedObjective, researchSummary, siteExploration);
            logger.info(`[${this.agentId}] UX design complete: ${designSpec.layout.slice(0, 100)}`);
            // Share design spec with Context Agent for dialogue enrichment
            contextAgent.setDesignSpec(this.traceId, designSpec);
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

        // Register graph with Dialogue Agent so it has context for conversation.
        // Pass our agentId so mutations are targeted back to us (not sub-PMs).
        const dialogueAgent = getDialogueAgent(this.traceId);
        if (dialogueAgent !== undefined) {
            dialogueAgent.setTaskGraph(graph, this.agentId);
        }

        // ── EXECUTE ───────────────────────────────────────────────────────────
        const result = await this.#executeGraph(graph, researchSummary, designSpec);
        this.terminate(result.success ? 'task_complete' : 'task_failed');

        // Notify Dialogue Agent of completion so it can send a summary to the user
        if (dialogueAgent !== undefined) {
            dialogueAgent.onExecutionComplete(result);
        }

        return result.summary;
    }

    // ── Sub-PM execution ─────────────────────────────────────────────────────

    /**
     * Sub-PM path: inherits research and design from parent, goes straight to
     * Decompose+Execute for the assigned node's objective.
     */
    private async _runAsSubPm(objective: string): Promise<string> {
        const ctx = this.#subPmContext!;
        const depth = ctx.depth;

        this.emit('STATE_CHANGED', {
            message: `Sub-PM starting: "${objective}"`,
            phase: 'start',
            depth,
            parentNodeId: ctx.assignedNode.id,
        });

        // At max depth, force atomic execution — no further decomposition
        if (depth >= MAX_PM_DEPTH) {
            logger.info(`[${this.agentId}] At max depth (${depth.toString()}), executing directly`);
            const nodeResult = await this.#executeNode(
                ctx.assignedNode, ctx.researchSummary, ctx.sandbox, ctx.designSpec,
            );
            this.terminate(nodeResult.success ? 'task_complete' : 'task_failed');
            return nodeResult.summary;
        }

        // Decompose: does this node need further breakdown?
        const enrichedObjective = this.#enrichObjective(objective);
        let graph: TaskGraph;
        try {
            graph = await this.#decompose(enrichedObjective, ctx.researchSummary, ctx.designSpec, depth, ctx.siblingContext);
            graph.ownerAgentId = this.agentId;
            graph.depth = depth;
            graph.parentNodeId = ctx.assignedNode.id;
        } catch (err) {
            // Decomposition failed — fall back to direct execution
            logger.warn(`[${this.agentId}] Sub-PM decomposition failed, executing directly:`, err);
            const nodeResult = await this.#executeNode(
                ctx.assignedNode, ctx.researchSummary, ctx.sandbox, ctx.designSpec,
            );
            this.terminate(nodeResult.success ? 'task_complete' : 'task_failed');
            return nodeResult.summary;
        }

        // If decomposer says atomic (single node), execute directly
        if (graph.nodes.length <= 1) {
            logger.info(`[${this.agentId}] Sub-PM decomposed to single node, executing directly`);
            const singleNode = graph.nodes[0] ?? ctx.assignedNode;
            const nodeResult = await this.#executeNode(
                singleNode, ctx.researchSummary, ctx.sandbox, ctx.designSpec,
            );
            this.terminate(nodeResult.success ? 'task_complete' : 'task_failed');
            return nodeResult.summary;
        }

        // Composite — emit sub-graph and execute via sub-PMs or direct
        this.#emitGraph(graph, `Sub-PM decomposed into ${graph.nodes.length.toString()} tasks`);

        // Attach sub-graph to the assigned node (parent graph picks this up)
        ctx.assignedNode.subGraph = graph;

        const result = await this.#executeGraph(graph, ctx.researchSummary, ctx.designSpec, ctx.sandbox, depth);
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

    async #decompose(objective: string, researchSummary: string, designSpec: UxDesignSpec | null = null, depth = 0, siblingContext = ''): Promise<TaskGraph> {
        const prompt = buildDecomposerPrompt(objective, researchSummary, designSpec, depth, siblingContext);
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
            nodes: Array<{
                id: string;
                objective: string;
                acceptanceCriteria: string;
                taskType?: string;
                dependsOn: string[];
                delegatable?: boolean;
            }>;
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
            // Only mark delegatable if we haven't hit max depth
            delegatable: depth < MAX_PM_DEPTH - 1 && n.delegatable === true,
        }));

        return {
            rootObjective: objective,
            nodes,
            createdAt: new Date().toISOString(),
            status: 'pending',
        };
    }

    // ── Private — execute ─────────────────────────────────────────────────────

    async #executeGraph(
        graph: TaskGraph,
        researchSummary: string,
        initialDesignSpec: UxDesignSpec | null = null,
        existingSandbox?: SandboxHandle,
        depth = 0,
    ): Promise<{ success: boolean; summary: string }> {
        let designSpec = initialDesignSpec;
        const completedSummaries: string[] = [];

        // ── Feature sandbox ───────────────────────────────────────────────────
        // Root PMs create a sandbox; sub-PMs reuse the parent's sandbox.
        const sandbox = existingSandbox ?? await createFeatureSandbox(this.traceId);
        logger.info(`[${this.agentId}] Using feature sandbox container: ${sandbox.containerName}`);

        // ── Subscribe to plan mutations from the Dialogue Agent ──────────────
        // Mutations are queued and applied between node executions (never mid-node).
        interface PlanMutation {
            newNodes: Array<{ id: string; objective: string; acceptanceCriteria: string; taskType: string; dependsOn: string[] }>;
            updatedNodes: Array<{ nodeId: string; objective?: string; acceptanceCriteria?: string }>;
        }
        const pendingMutations: PlanMutation[] = [];
        const unsubMutations = eventBus.subscribe('DIALOGUE_UPDATE_PLAN', (event: SystemEvent) => {
            if (event.traceId !== this.traceId) return;

            // Only accept mutations targeted at this PM (or untargeted for backward compat).
            // This prevents sub-PMs from consuming mutations intended for the root PM's graph.
            const targetAgent = event.payload['targetAgentId'] as string | undefined;
            if (targetAgent !== undefined && targetAgent !== this.agentId) {
                logger.info(`[${this.agentId}] Ignoring plan mutation targeted at ${targetAgent}`);
                return;
            }

            pendingMutations.push({
                newNodes: (event.payload['newNodes'] as PlanMutation['newNodes']) ?? [],
                updatedNodes: (event.payload['updatedNodes'] as PlanMutation['updatedNodes']) ?? [],
            });
            logger.info(`[${this.agentId}] Queued plan mutation (${pendingMutations.length.toString()} pending)`);
        });

        // Sequential loop: keep processing until no more pending nodes can run
        let madeProgress = true;
        let mutationsApplied = false;
        while (madeProgress) {
            madeProgress = false;

            // ── Apply queued plan mutations ──────────────────────────────────
            // Coalesce first: if multiple mutations target the same node, keep
            // only the latest version. This prevents redundant/conflicting
            // updates when the user sends several messages in quick succession.
            if (pendingMutations.length > 0) {
                const coalescedNewNodes = new Map<string, PlanMutation['newNodes'][number]>();
                const coalescedUpdates = new Map<string, PlanMutation['updatedNodes'][number]>();

                while (pendingMutations.length > 0) {
                    const mutation = pendingMutations.shift()!;
                    for (const n of mutation.newNodes) {
                        coalescedNewNodes.set(n.id, n); // last-write-wins
                    }
                    for (const u of mutation.updatedNodes) {
                        coalescedUpdates.set(u.nodeId, u); // last-write-wins
                    }
                }

                const mergedNewNodes = [...coalescedNewNodes.values()];
                const mergedUpdates = [...coalescedUpdates.values()];
                logger.info(`[${this.agentId}] Coalesced mutations: ${mergedNewNodes.length.toString()} new, ${mergedUpdates.length.toString()} updates`);

                try {
                    // Add new nodes
                    if (mergedNewNodes.length > 0) {
                        const newTaskNodes: TaskNode[] = mergedNewNodes.map((n) => ({
                            id: n.id,
                            objective: n.objective,
                            acceptanceCriteria: n.acceptanceCriteria,
                            taskType: (n.taskType as TaskNode['taskType']) ?? 'fullstack',
                            dependsOn: n.dependsOn,
                            status: 'pending' as const,
                            isAtomic: true,
                        }));
                        appendNodes(graph, newTaskNodes);
                        logger.info(`[${this.agentId}] Appended ${newTaskNodes.length.toString()} new nodes`);
                    }
                    // Update pending nodes
                    for (const update of mergedUpdates) {
                        const patch: { objective?: string; acceptanceCriteria?: string } = {};
                        if (update.objective !== undefined) patch.objective = update.objective;
                        if (update.acceptanceCriteria !== undefined) patch.acceptanceCriteria = update.acceptanceCriteria;
                        updatePendingNode(graph, update.nodeId, patch);
                        logger.info(`[${this.agentId}] Updated pending node ${update.nodeId}`);
                    }
                    this.#emitGraph(graph, 'Plan updated with new requirements');
                    mutationsApplied = true;
                    madeProgress = true;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`[${this.agentId}] Plan mutation failed: ${msg}`);
                }
            }

            // ── Reason about what the mutations require ──────────────────────
            // When the user provides new requirements mid-execution, the PM
            // reasons about what agents need to re-run (research, UX, neither)
            // rather than blindly re-invoking anything.
            if (mutationsApplied) {
                mutationsApplied = false;
                try {
                    await this._handleMutationEffects(graph, researchSummary, designSpec, (spec) => { designSpec = spec; });
                } catch (err) {
                    logger.warn(`[${this.agentId}] Mutation effect handling failed (non-fatal):`, err);
                }
            }

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

            if (nextNode === undefined) {
                // Check for blocked nodes waiting on user input
                const blockedNode = graph.nodes.find(
                    (n: TaskNode) => n.status === 'blocked',
                );
                if (blockedNode === undefined) break;

                // Wait for user response before resuming
                const userResponse = await this.#waitForUserInput(blockedNode.id);
                if (userResponse === null) break; // timeout or cancelled

                logger.info(`[${this.agentId}] Resuming blocked node [${blockedNode.id}] with user response`);
                blockedNode.status = 'active';
                delete blockedNode.error;
                graph.status = 'active';
                this.#emitGraph(graph, `Resuming [${blockedNode.id}] with your input`);

                const resumeResult = await this.#executeNode(blockedNode, researchSummary, sandbox, designSpec, graph, userResponse);

                madeProgress = true;
                if (resumeResult.success) {
                    blockedNode.status = 'done';
                    blockedNode.result = resumeResult.summary;
                    completedSummaries.push(`[${blockedNode.id}] ✓ ${resumeResult.summary}`);
                } else if ('blocked' in resumeResult && resumeResult['blocked'] === true) {
                    blockedNode.status = 'blocked';
                    blockedNode.error = resumeResult.summary;
                } else {
                    blockedNode.status = 'failed';
                    blockedNode.error = resumeResult.summary;
                }

                graph.status = deriveGraphStatus(graph);
                this.#emitNodeCompleted(graph, blockedNode);
                this.#emitGraph(graph, `[${blockedNode.id}] ${blockedNode.status}`);
                continue;
            }

            // Execute this node — delegate to sub-PM if complex, otherwise run directly
            nextNode.status = 'active';
            graph.status = 'active';

            let nodeResult: { success: boolean; summary: string };

            if (nextNode.delegatable === true && depth < MAX_PM_DEPTH) {
                // ── Delegate to sub-PM ────────────────────────────────────────
                const childPmId = `project-manager.${uuidv4().slice(0, 8)}`;
                nextNode.delegatedTo = childPmId;
                this.#emitGraph(graph, `Delegating [${nextNode.id}] to sub-PM ${childPmId}`);

                const childContext: SubPmContext = {
                    researchSummary,
                    designSpec,
                    sandbox,
                    depth: depth + 1,
                    assignedNode: nextNode,
                    siblingContext: this._buildSiblingContext(graph, completedSummaries),
                };

                const childPm = new ProjectManager(
                    childPmId, this.traceId, this.agentId, childContext,
                );

                // Subscribe to sub-PM graph updates so we re-emit the full hierarchy.
                // The sub-PM writes to nextNode.subGraph by reference, so our graph
                // object always has the latest nested state — we just re-emit it.
                const unsubChildGraph = eventBus.subscribe('TASK_GRAPH_UPDATED', (evt: SystemEvent) => {
                    if (evt.sourceId === childPmId) {
                        this.#emitGraph(graph, `[${nextNode.id}] sub-PM progress`);
                    }
                });

                try {
                    const summary = await childPm.run(nextNode.objective);
                    nodeResult = { success: true, summary };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    nodeResult = { success: false, summary: msg };
                } finally {
                    unsubChildGraph();
                }
            } else {
                // ── Execute directly via SWE+QA ──────────────────────────────
                this.#emitGraph(graph, `Executing [${nextNode.id}]: ${nextNode.objective}`);
                nodeResult = await this.#executeNode(nextNode, researchSummary, sandbox, designSpec, graph);
            }

            madeProgress = true;

            if (nodeResult.success) {
                nextNode.status = 'done';
                nextNode.result = nodeResult.summary;
                completedSummaries.push(`[${nextNode.id}] ✓ ${nodeResult.summary}`);
            } else if ('blocked' in nodeResult && nodeResult['blocked'] === true) {
                // Arbiter escalated to user — keep blocked status (already set inside #executeNode)
                nextNode.status = 'blocked';
                nextNode.error = nodeResult.summary;
            } else {
                nextNode.status = 'failed';
                nextNode.error = nodeResult.summary;
            }

            graph.status = deriveGraphStatus(graph);
            this.#emitNodeCompleted(graph, nextNode);
            this.#emitGraph(graph, `[${nextNode.id}] ${nextNode.status}`);

            // Send proactive progress update via DialogueAgent (root PM only)
            if (this.parentAgentId === null) {
                const da = getDialogueAgent(this.traceId);
                if (da !== undefined) {
                    const done = graph.nodes.filter((n: TaskNode) => n.status === 'done' || n.status === 'skipped').length;
                    da.onNodeCompleted(
                        { id: nextNode.id, objective: nextNode.objective, status: nextNode.status },
                        { done, total: graph.nodes.length },
                    );
                }
            }
        }

        // Clean up mutation subscription
        unsubMutations();

        const blockedNodes = graph.nodes.filter((n: TaskNode) => n.status === 'blocked');
        const allDoneOrSkipped = graph.nodes.every((n: TaskNode) => n.status === 'done' || n.status === 'skipped');
        const failedNodes = graph.nodes.filter((n: TaskNode) => n.status === 'failed');

        // If any nodes are blocked, report that status (not failure)
        if (blockedNodes.length > 0 && failedNodes.length === 0) {
            const blockedMsg = blockedNodes.map((n) => `[${n.id}]: ${n.error ?? 'waiting for input'}`).join('; ');
            this.emit('STATE_CHANGED', { message: `Blocked: ${blockedMsg}`, phase: 'implement' });
            return { success: false, summary: `Blocked tasks: ${blockedMsg}` };
        }

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

    /**
     * Reason about what a set of plan mutations requires and selectively
     * re-invoke agents (research, UX design, or nothing) as needed.
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    async _handleMutationEffects(
        graph: TaskGraph,
        researchSummary: string,
        designSpec: UxDesignSpec | null,
        setDesignSpec: (spec: UxDesignSpec) => void,
    ): Promise<void> {
        const pendingNodes = graph.nodes.filter((n) => n.status === 'pending');
        if (pendingNodes.length === 0) return;

        const pendingSummary = pendingNodes
            .map((n) => `- [${n.id}] (${n.taskType}): ${n.objective}`)
            .join('\n');

        const currentDesign = designSpec !== null
            ? `Layout: ${designSpec.layout}\nUser flow: ${designSpec.userFlow}\nNavigation: ${designSpec.navigationIntegration ?? 'N/A'}`
            : 'No design spec exists yet.';

        const prompt = `You are a project manager. The user just provided new requirements that changed the plan for a feature being built.

## Current Feature
${graph.rootObjective}

## Current Design Spec
${currentDesign}

## Pending Tasks (updated with new requirements)
${pendingSummary}

## What to decide
Given the updated pending tasks, decide what preparation is needed before the next task executes. Respond with ONLY a JSON object:

{
    "reasoning": "Brief explanation of what changed and what's needed",
    "actions": {
        "rerunUxDesign": true/false,
        "rerunResearch": true/false
    }
}

Guidelines:
- rerunUxDesign=true if the changes affect layout, navigation, interaction patterns, visual design, or user flow (e.g., switching from buttons to infinite scroll)
- rerunResearch=true if the changes require new technical knowledge the team doesn't have yet (e.g., a new API, unfamiliar library, or technology)
- Both can be false if the changes are minor refinements that don't need new input (e.g., changing a label, adjusting a threshold)
- Both can be true if the changes are significant enough to warrant fresh input from both agents`;

        this.emit('STATE_CHANGED', { message: 'Evaluating new requirements...', phase: 'reasoning' });

        const completion = await generateWithRawTools(
            [{ role: 'system', content: prompt }],
            [],
            'low',
        );
        const raw = extractTextContent(completion).trim();
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

        let decision: { reasoning: string; actions: { rerunUxDesign: boolean; rerunResearch: boolean } };
        try {
            decision = JSON.parse(cleaned) as typeof decision;
        } catch {
            logger.warn(`[${this.agentId}] Mutation reasoning parse failed, skipping agent re-runs`);
            return;
        }

        logger.info(`[${this.agentId}] Mutation reasoning: ${decision.reasoning}`);

        // Re-run research if needed
        if (decision.actions.rerunResearch) {
            try {
                this.emit('STATE_CHANGED', { message: 'Researching new requirements...', phase: 'research' });
                const researcherId = `data-researcher.${uuidv4().slice(0, 8)}`;
                const researcher = new DataResearcher(researcherId, this.traceId);
                const result = await researcher.run(`${graph.rootObjective}\n\nFocus on: ${pendingSummary}`);
                logger.info(`[${this.agentId}] Research refreshed after mutation: ${result.summary.slice(0, 100)}`);
            } catch (err) {
                logger.warn(`[${this.agentId}] Research refresh failed (non-fatal):`, err);
            }
        }

        // Re-run UX design if needed
        if (decision.actions.rerunUxDesign) {
            try {
                this.emit('STATE_CHANGED', { message: 'Updating UX design for new requirements...', phase: 'design' });
                const refreshId = `ux-designer.${uuidv4().slice(0, 8)}`;
                const refreshDesigner = new UxDesigner(refreshId, this.traceId);
                const updatedObjective = `${graph.rootObjective}\n\nUpdated pending tasks:\n${pendingSummary}`;
                const newSpec = await refreshDesigner.run(updatedObjective, researchSummary);
                setDesignSpec(newSpec);
                // Update context agent with refreshed design
                contextAgent.setDesignSpec(this.traceId, newSpec);
                logger.info(`[${this.agentId}] UX design refreshed after mutation`);
            } catch (err) {
                logger.warn(`[${this.agentId}] UX design refresh failed (non-fatal):`, err);
            }
        }

        if (!decision.actions.rerunResearch && !decision.actions.rerunUxDesign) {
            logger.info(`[${this.agentId}] No agent re-runs needed for this mutation`);
        }
    }

    async #executeNode(node: TaskNode, researchSummary: string, sandbox: SandboxHandle, designSpec: UxDesignSpec | null = null, graph?: TaskGraph, userResponse?: string): Promise<{ success: boolean; summary: string; blocked?: boolean; userQuestion?: string }> {
        this.emit('STATE_CHANGED', {
            message: userResponse !== undefined
                ? `Resuming node [${node.id}] with your input`
                : `Starting node [${node.id}]: ${node.objective}`,
            phase: 'implement',
            nodeId: node.id,
        });

        let passed = false;
        let lastAttemptCrashed = false;
        let finalSummary = '';

        // Restore state from persisted checkpoint when resuming a blocked node
        const resumeState = userResponse !== undefined ? loadPendingState() : null;
        let priorIssues: string[] = resumeState?.priorIssues ?? [];
        let arbiterSweFeedback: string | undefined = userResponse !== undefined
            ? `The user responded to your question with the following guidance:\n\n${userResponse}\n\nIncorporate this feedback and fix the remaining issues.`
            : undefined;
        let arbiterQaGuidance: string | undefined = resumeState?.arbiterGuidance?.qaGuidance;
        let activeCriteria = resumeState?.arbiterGuidance?.updatedAcceptanceCriteria ?? node.acceptanceCriteria;
        const attemptHistory: AttemptRecord[] = resumeState?.attemptHistory ?? [];
        let attempt = resumeState?.attempt ?? 0;

        // Clear the persisted blocked state now that we're resuming
        if (resumeState !== null) {
            clearState();
            logger.info(`[${this.agentId}] Resuming node [${node.id}] from attempt ${attempt.toString()} with ${attemptHistory.length.toString()} prior attempts`);
        }

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
            while (!passed && attempt < MAX_ARBITER_ROUNDS) {
                node.attempts = attempt + 1;

                // Build the enriched prompt for this attempt (LLM selects relevant context)
                // On retries, use arbiter's refined feedback instead of raw QA issues
                const retryIssues = arbiterSweFeedback !== undefined
                    ? [arbiterSweFeedback]
                    : priorIssues;
                const sweObjective = await this.#buildSweObjective(node, researchSummary, retryIssues, attempt, designSpec);

                // Emit with the FULL objective — this is what Claude Code actually receives.
                // The activity log shows the short message; raw JSON reveals the full prompt.
                this.#emitSweEvent(sweId, 'STATE_CHANGED', {
                    message: attempt === 0
                        ? node.objective
                        : lastAttemptCrashed
                            ? `Retry ${attempt.toString()}: resuming after crash`
                            : `Retry ${attempt.toString()}: fixing QA issue(s)`,
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
                    acceptanceCriteria: activeCriteria,
                    phase: 'conductor',
                    attempt,
                    filesChanged: [],
                    priorIssues,
                    attemptHistory,
                    ...(arbiterQaGuidance !== undefined ? {
                        arbiterGuidance: {
                            qaGuidance: arbiterQaGuidance,
                            ...(activeCriteria !== node.acceptanceCriteria ? { updatedAcceptanceCriteria: activeCriteria } : {}),
                        },
                    } : {}),
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
                        // Retry after QA failure: use arbiter-refined feedback if available.
                        const feedback = arbiterSweFeedback ?? priorIssues.join('\n- ');
                        const retryPrompt = [
                            '## QA Feedback — Action Required',
                            '',
                            feedback,
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
                        acceptanceCriteria: activeCriteria,
                        phase: 'awaiting-qa',
                        attempt,
                        filesChanged: artifact.filesChanged,
                        priorIssues,
                        attemptHistory,
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
                    attempt++;
                    continue;
                }

                // ── RESTART DEV SERVERS ──────────────────────────────────────
                if (sandbox !== undefined) {
                    await this.#restartSandboxServers(artifact, sandbox);
                }

                // ── VALIDATE ─────────────────────────────────────────────────
                const qaId = `qa-engineer.${uuidv4().slice(0, 8)}`;
                const qa = new QaEngineer(qaId, this.traceId);
                const verdict = await qa.run(
                    node.objective, activeCriteria, artifact,
                    deployedServiceUrl, sandbox, designSpec, graph,
                    priorIssues.length > 0 ? priorIssues : undefined,
                    arbiterQaGuidance,
                );

                // Record this attempt for the arbiter's history
                attemptHistory.push({
                    attempt,
                    sweSummary: artifact.summary,
                    qaVerdict: {
                        passed: verdict.passed,
                        issues: verdict.issues,
                        warnings: verdict.warnings,
                        ...(verdict.summary !== undefined ? { summary: verdict.summary } : {}),
                    },
                });

                if (verdict.passed) {
                    passed = true;
                    finalSummary = artifact.summary;
                    clearState();
                    break;
                }

                // ── ARBITER ──────────────────────────────────────────────────
                // Instead of blindly retrying, ask the arbiter to analyze the
                // full history and decide: retry with refined feedback, escalate
                // to user, or accept the implementation as-is.
                const arbiterDecision = await this.#runArbiter(node, activeCriteria, attemptHistory);

                // Log the decision to the ledger
                eventBus.emit({
                    eventId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                    eventType: 'QA_ARBITER_DECISION',
                    sourceId: this.agentId,
                    targetId: null,
                    traceId: this.traceId,
                    payload: {
                        nodeId: node.id,
                        attempt,
                        ...arbiterDecision,
                    },
                } as unknown as SystemEvent);

                switch (arbiterDecision.decision) {
                    case 'retry':
                        arbiterSweFeedback = arbiterDecision.sweFeedback;
                        arbiterQaGuidance = arbiterDecision.qaGuidance;
                        if (arbiterDecision.updatedAcceptanceCriteria !== undefined) {
                            activeCriteria = arbiterDecision.updatedAcceptanceCriteria;
                        }
                        priorIssues = verdict.issues;
                        logger.info(`[${this.agentId}] Arbiter: retry (attempt ${(attempt + 1).toString()}). Reasoning: ${arbiterDecision.reasoning.slice(0, 200)}`);
                        attempt++;
                        continue;

                    case 'ask_user': {
                        // Save state so PM can resume when user responds
                        saveState({
                            traceId: this.traceId,
                            nodeId: node.id,
                            sweId,
                            objective: node.objective,
                            acceptanceCriteria: activeCriteria,
                            phase: 'blocked',
                            attempt,
                            filesChanged: artifact.filesChanged,
                            priorIssues: verdict.issues,
                            attemptHistory,
                            arbiterGuidance: {
                                ...(arbiterQaGuidance !== undefined ? { qaGuidance: arbiterQaGuidance } : {}),
                                ...(activeCriteria !== node.acceptanceCriteria ? { updatedAcceptanceCriteria: activeCriteria } : {}),
                            },
                            conductorSummary: artifact.summary,
                            savedAt: new Date().toISOString(),
                        });
                        node.status = 'blocked';

                        const question = arbiterDecision.userQuestion ?? arbiterDecision.reasoning;
                        logger.info(`[${this.agentId}] Arbiter: ask_user for node [${node.id}]: ${question.slice(0, 200)}`);

                        // Notify user via AGENT_INPUT_REQUIRED event
                        this.emit('AGENT_INPUT_REQUIRED', {
                            question,
                            nodeId: node.id,
                            attempt,
                        });

                        return { success: false, summary: `Blocked: ${question}`, blocked: true, userQuestion: question };
                    }

                    case 'accept':
                        if (arbiterDecision.updatedAcceptanceCriteria !== undefined) {
                            activeCriteria = arbiterDecision.updatedAcceptanceCriteria;
                        }
                        passed = true;
                        finalSummary = artifact.summary;
                        clearState();
                        logger.info(`[${this.agentId}] Arbiter: accept (overriding QA). Reasoning: ${arbiterDecision.reasoning.slice(0, 200)}`);
                        break;
                }
            }

            // Safety cap hit
            if (!passed && attempt >= MAX_ARBITER_ROUNDS) {
                const summary = attemptHistory.map((a) =>
                    `Attempt ${(a.attempt + 1).toString()}: ${a.qaVerdict.issues.join('; ')}`,
                ).join('\n');
                logger.warn(`[${this.agentId}] Safety cap hit (${MAX_ARBITER_ROUNDS.toString()} attempts). Forcing ask_user.`);

                const question = `After ${MAX_ARBITER_ROUNDS.toString()} attempts, QA is still failing. Here's the history:\n${summary}\n\nHow would you like to proceed?`;

                saveState({
                    traceId: this.traceId,
                    nodeId: node.id,
                    sweId,
                    objective: node.objective,
                    acceptanceCriteria: activeCriteria,
                    phase: 'blocked',
                    attempt,
                    filesChanged: [],
                    priorIssues,
                    attemptHistory,
                    conductorSummary: '',
                    savedAt: new Date().toISOString(),
                });
                node.status = 'blocked';

                // Notify user via AGENT_INPUT_REQUIRED event
                this.emit('AGENT_INPUT_REQUIRED', {
                    question,
                    nodeId: node.id,
                    attempt,
                });

                this.#emitSweEvent(sweId, 'STATE_CHANGED', {
                    message: `Blocked after ${MAX_ARBITER_ROUNDS.toString()} attempts — waiting for user input`,
                    phase: 'implement',
                });

                return { success: false, summary: `Blocked: ${question}`, blocked: true, userQuestion: question };
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            clearState();
            this.#emitSweEvent(sweId, 'STATE_CHANGED', {
                message: `Failed: ${msg}`,
                phase: 'implement',
            });
            this.#emitSweEvent(sweId, 'AGENT_TERMINATED', {
                reason: 'error',
                agentId: sweId,
                message: `${sweId} decommissioned. Reason: error.`,
            });
            return { success: false, summary: msg };
        }

        if (!passed) {
            const failSummary = `Failed QA after ${attemptHistory.length.toString()} attempt(s). Last issues: ${priorIssues.join('; ').slice(0, 300)}`;
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

        // Success — emit summary for this node (not the whole feature)
        this.#emitSweEvent(sweId, 'STATE_CHANGED', {
            message: finalSummary || 'Task completed successfully.',
            phase: 'implement',
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
     * Wait for user input to resume a blocked node.
     *
     * Listens for USER_INTERVENTION events (user messages sent via the chat)
     * targeting this trace. Returns the user's text, or null on timeout (24h).
     */
    async #waitForUserInput(blockedNodeId: string): Promise<string | null> {
        logger.info(`[${this.agentId}] Waiting for user input to resume blocked node [${blockedNodeId}]`);

        return new Promise<string | null>((resolve) => {
            const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
            const timeout = setTimeout(() => {
                unsub();
                logger.warn(`[${this.agentId}] Timed out waiting for user input on blocked node [${blockedNodeId}]`);
                resolve(null);
            }, TIMEOUT_MS);

            // Listen for user messages (USER_INTERVENTION) on this trace
            const unsub = eventBus.subscribe('USER_INTERVENTION', (event: SystemEvent) => {
                if (event.traceId !== this.traceId) return;
                const text = typeof event.payload['text'] === 'string' ? event.payload['text'] : '';
                if (text === '') return;

                clearTimeout(timeout);
                unsub();
                logger.info(`[${this.agentId}] Received user input for blocked node [${blockedNodeId}]: ${text.slice(0, 200)}`);
                resolve(text);
            });
        });
    }

    /**
     * QA arbiter: analyze the full attempt history and decide what to do next.
     *
     * The arbiter replaces the old hardcoded retry limit with intelligent routing.
     * It compares QA issues against actual acceptance criteria, detects test-plan
     * drift, identifies unfixable issues, and can refine acceptance criteria.
     */
    async #runArbiter(
        node: TaskNode,
        activeCriteria: string,
        history: AttemptRecord[],
    ): Promise<QaArbiterDecision> {
        const historyText = history.map((h) => {
            const verdictLabel = h.qaVerdict.passed ? 'PASSED' : 'FAILED';
            const issuesList = h.qaVerdict.issues.length > 0
                ? h.qaVerdict.issues.map((i) => `    - ${i}`).join('\n')
                : '    (none)';
            const warningsList = h.qaVerdict.warnings.length > 0
                ? h.qaVerdict.warnings.map((w) => `    - ${w}`).join('\n')
                : '    (none)';
            return [
                `### Attempt ${(h.attempt + 1).toString()}`,
                `SWE Summary: ${h.sweSummary.slice(0, 500)}`,
                `QA Verdict: ${verdictLabel}`,
                `Issues:\n${issuesList}`,
                `Warnings:\n${warningsList}`,
                h.qaVerdict.summary !== undefined ? `QA Summary: ${h.qaVerdict.summary.slice(0, 300)}` : '',
            ].filter(Boolean).join('\n');
        }).join('\n\n');

        const systemPrompt = `You are a QA arbiter. A software engineer built a feature and QA tested it.
QA found issues. Your job is to analyze the full attempt history and decide what happens next.

You MUST respond with a single JSON object matching this schema:
{
  "decision": "retry" | "ask_user" | "accept",
  "reasoning": "...",
  "sweFeedback": "..." (only if retry),
  "qaGuidance": "..." (only if retry),
  "updatedAcceptanceCriteria": "..." (if criteria need refining),
  "userQuestion": "..." (only if ask_user)
}

Decision guide:
- "retry" — The issues are REAL and FIXABLE by the SWE. Provide refined, actionable feedback
  in sweFeedback (filter out test-plan-drift). Provide qaGuidance to prevent QA from repeating
  mistakes (e.g., testing wrong endpoints, inventing requirements).
- "ask_user" — The requirements are ambiguous, conflicting, or need clarification that only
  the user can provide. Provide a specific userQuestion. Also use this if the SWE has failed
  the same issue 3+ times — it may need human guidance.
- "accept" — QA is being unreasonable: testing things NOT in the acceptance criteria,
  applying over-strict judgment, or inventing requirements. The implementation satisfies the
  actual criteria. You may update acceptanceCriteria to clarify what was actually required.

Key anti-patterns to watch for:
- Test plan drift: QA fails for different reasons each attempt (score field, sentiment field, etc.)
  that aren't in the original acceptance criteria
- Wrong endpoint: QA tests /api/reddit when the SWE built /api/reddit/posts
- Over-strict content judgment: QA flags benign content as violating filters
- Repeated identical failures: SWE can't fix the issue — may need user input
- Port confusion: QA tests on wrong port`;

        const userPrompt = `## Original Objective
${node.objective}

## Acceptance Criteria
${activeCriteria}

## Attempt History
${historyText}

Analyze the history and respond with your JSON decision.`;

        try {
            const completion = await generateWithRawTools(
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                [],
                'low',
            );
            const raw = extractTextContent(completion).trim();

            // Extract JSON from the response (may be wrapped in markdown code fences)
            const jsonMatch = /\{[\s\S]*\}/.exec(raw);
            if (jsonMatch !== null) {
                const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
                const result = QaArbiterDecisionSchema.safeParse(parsed);
                if (result.success) return result.data;
                logger.warn(`[${this.agentId}] Arbiter output failed schema validation: ${result.error.message}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[${this.agentId}] Arbiter LLM call failed: ${msg}`);
        }

        // Fallback: retry with raw issues (behaves like old loop)
        const lastAttempt = history[history.length - 1];
        return {
            decision: 'retry',
            reasoning: 'Arbiter fallback — LLM call failed, retrying with raw QA issues.',
            sweFeedback: lastAttempt?.qaVerdict.issues.join('\n') ?? 'Fix the QA issues.',
        };
    }

    /**
     * Use a low-tier LLM to build a focused, task-specific briefing for the
     * SWE agent. The LLM selects only the context blocks relevant to this
     * specific task, keeping the prompt lean and focused.
     *
     * Non-negotiable sections (acceptance criteria, QA retry context) are
     * always included — the LLM only controls the supporting context.
     *
     * Falls back to a minimal objective + acceptance criteria if the LLM
     * call fails.
     */
    async #buildSweObjective(node: TaskNode, researchContext: string, priorIssues: string[], attempt: number, designSpec: UxDesignSpec | null = null): Promise<string> {
        // ── Gather all available context blocks ──────────────────────────────
        const contextBlocks: Record<string, string> = {};

        if (hasDesignSpec(designSpec) && designSpec !== null) {
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

        // ── Ask LLM to build the briefing ────────────────────────────────────
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
    ? `\nQA FAILED (attempt ${attempt.toString()}/${MAX_ARBITER_ROUNDS.toString()}) — the engineer MUST fix these issues:\n${priorIssues.map((i) => `- ${i}`).join('\n')}\n`
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

        // ── Fallback: minimal objective + acceptance criteria ────────────────
        const fallback = [
            node.objective,
            '',
            '## Acceptance Criteria',
            node.acceptanceCriteria,
        ];
        if (attempt > 0 && priorIssues.length > 0) {
            fallback.push(
                '',
                `## QA Failed (attempt ${attempt.toString()}/${MAX_ARBITER_ROUNDS.toString()}) — Fix These Issues`,
                ...priorIssues.map((issue) => `- ${issue}`),
            );
        }
        return fallback.join('\n');
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
        return { subtask, filesChanged: [], commandsRun: [], errors: ['No artifact found'], success: false, summary: '' };
    }

    /**
     * Build a context string describing completed sibling tasks and their results.
     * Passed to sub-PMs so they know what work has already been done.
     */
    private _buildSiblingContext(graph: TaskGraph, completedSummaries: string[]): string {
        const parts = [`Feature: ${graph.rootObjective}`, ''];

        if (completedSummaries.length > 0) {
            parts.push('## Completed Sibling Tasks', ...completedSummaries, '');
        }

        const pending = graph.nodes.filter((n) => n.status === 'pending');
        if (pending.length > 0) {
            parts.push(
                '## Upcoming Tasks',
                ...pending.map((n) => `- [${n.id}]: ${n.objective}`),
            );
        }

        return parts.join('\n');
    }

    #emitGraph(graph: TaskGraph, message: string): void {
        const isRootGraph = this.#subPmContext === null;
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
                isRootGraph,
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
     * Kill and restart dev servers inside the sandbox container.
     *
     * After the SWE modifies code, Next.js/backend hot-reload can leave servers
     * in a bad state (500 errors, crash loops). This method:
     *  1. Kills all node processes inside the container
     *  2. Restarts backend + frontend dev servers
     *  3. Polls until they respond to health checks (max 60s)
     *
     * Non-fatal — if restart fails, QA will detect the issue and report it.
     */
    async #restartSandboxServers(artifact: SweArtifact, sandbox: SandboxHandle): Promise<void> {
        const { containerName, workDir, backendPort, webPort } = sandbox;
        const hasBackendFiles = artifact.filesChanged.some((f) => f.includes('apps/backend'));
        const hasFrontendFiles = artifact.filesChanged.some((f) => f.includes('apps/web'));

        this.emit('STATE_CHANGED', {
            message: 'Restarting dev servers before QA...',
            phase: 'validate',
        });

        // Kill existing node processes (dev servers, watchers)
        try {
            execSync(
                `docker exec ${containerName} sh -c "pkill -f 'node|next|tsx' 2>/dev/null; sleep 1; pkill -9 -f 'node|next|tsx' 2>/dev/null; true"`,
                { stdio: 'pipe', timeout: 10_000 },
            );
            logger.info(`[${this.agentId}] Killed existing node processes in ${containerName}`);
        } catch {
            // pkill returns non-zero if no processes found — that's fine
        }

        // Brief pause to let ports free up
        await sleep(2_000);

        // Restart servers
        const servers: Array<{ filter: string; label: string; port: number; healthPath: string }> = [];
        if (hasBackendFiles || hasFrontendFiles) {
            // Always restart both if either changed — they may depend on each other
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

        // Warm up frontend routes so Next.js compiles them before QA
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
                    // Non-fatal — QA will handle compilation
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
