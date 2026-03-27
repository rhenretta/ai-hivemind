/**
 * dialogueAgent.ts — Conversational Dialogue Agent (Task Graph Owner)
 *
 * A per-feature conversational LLM service that owns the task graph. It:
 *   1. Converses with the user to understand what to build
 *   2. Orchestrates research/UX/explorer agents to gather context
 *   3. Creates and updates the task graph directly (no intermediary)
 *   4. Locks mutable tasks while thinking, unlocks after updating
 *   5. Auto-starts a FeatureDeveloper to execute ready tasks
 *   6. Tracks execution progress and reports back to the user
 *
 * NOT a BaseAgent subclass — this is a long-lived service, not a spawnable agent.
 * One instance per traceId, managed via the module-level `dialogueAgents` map.
 */

import { v4 as uuidv4 } from 'uuid';

import type {
    TaskGraph,
    TaskNode,
    TaskStatus,
    UxDesignSpec,
    SystemEvent,
} from '@ai-hivemind/shared';
import {
    lockMutableTasks,
    unlockTasks,
    appendNodes,
    updateMutableNode,
    removeMutableNode,
    deriveGraphStatus,
    dependenciesMet,
} from '@ai-hivemind/shared';

import { eventBus } from '../eventBus.js';
import { DataResearcher } from '../agents/dataResearcher.js';
import { SiteExplorer, type SiteExplorationResult } from '../agents/siteExplorer.js';
import { UxDesigner } from '../agents/uxDesigner.js';
import { FeatureDeveloper, type FeatureDevContext } from '../agents/featureDeveloper.js';

import { contextAgent, type ContextSource } from './contextAgent.js';
import { type LLMMessage, generateWithRawTools, extractTextContent } from './llm.js';
import { logger } from './logger.js';
import { getFeatureSummaries } from './intentRouter.js';
import { createFeatureSandbox, type SandboxHandle } from './sandboxManager.js';
import { sessionStore } from './sessionStore.js';

// ── Module-level registry ────────────────────────────────────────────────────

const dialogueAgents = new Map<string, DialogueAgent>();

export function getOrCreateDialogueAgent(traceId: string, title?: string): DialogueAgent {
    let agent = dialogueAgents.get(traceId);
    if (agent === undefined) {
        agent = new DialogueAgent(traceId);
        dialogueAgents.set(traceId, agent);

        // Ensure a persistent Session record exists for this traceId
        sessionStore.ensureSession(traceId, title ?? 'New session');
    }
    return agent;
}

export function getDialogueAgent(traceId: string): DialogueAgent | undefined {
    return dialogueAgents.get(traceId);
}

/**
 * Destroy a DialogueAgent instance on session deletion.
 * Cleans up event subscriptions and removes from the registry.
 */
export function destroyDialogueAgent(traceId: string): void {
    const agent = dialogueAgents.get(traceId);
    if (agent !== undefined) {
        agent.destroy();
        dialogueAgents.delete(traceId);
        logger.info(`[DialogueAgent:${traceId}] Destroyed and removed from registry`);
    }
}

/**
 * Find the most recently active DialogueAgent.
 * Used by the message router to detect when a follow-up message belongs
 * to an ongoing conversation rather than being a new feature request.
 * Returns the agent if one was active in the last 5 minutes, otherwise null.
 */
export function getMostRecentActiveAgent(): DialogueAgent | null {
    const STALE_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    let best: DialogueAgent | null = null;
    let bestTime = 0;

    for (const agent of dialogueAgents.values()) {
        if (agent.lastActivityAt > bestTime && (now - agent.lastActivityAt) < STALE_MS) {
            best = agent;
            bestTime = agent.lastActivityAt;
        }
    }
    return best;
}

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a collaborative product partner helping a user build software features. You work alongside an AI engineering team that builds what you define together.

## Your Role
You are the planning brain of the team. You:
1. Help the user think through their feature idea using active listening
2. Create and manage the task list directly — you own it
3. Decide when to gather more information (research, UX exploration, design)
4. The engineering team auto-starts building once tasks are ready

## Active Listening Techniques
1. **Reflect** — Briefly paraphrase what the user said to confirm understanding
2. **Probe** — Ask about edge cases, UX details, or requirements they might not have considered
3. **Summarize** — Periodically restate the full picture of what you're building
4. **Suggest** — Offer considerations or improvements the user might not have thought of

## Actions You Can Take

### create_tasks (DEFAULT — almost every message should create or update tasks)
Create or update the task list directly. You own it — changes are applied immediately.
- If the user describes ANYTHING concrete, create tasks IMMEDIATELY — even on the first message
- You MUST create tasks within 1-2 turns maximum
- Tasks should have clear objectives and testable acceptance criteria
- Each task should be completable by a single developer in 30-60 minutes
- **UPDATE OVER APPEND:** When the user's message refines, clarifies, or adds detail to work covered by an existing modifiable task, UPDATE that task (via updatedNodes) instead of creating a new one. Only create a new task if the work is genuinely separate from all existing tasks. Check the "Modifiable tasks" list in the system context — if a task already covers the same area of work, update it.
- Creating tasks does NOT end the conversation — you keep chatting about refinements

### gather_info
Spawn research, UX exploration, or design agents when you need more context:
- research: when you need to understand the codebase or external APIs
- explore: when you need to see the current state of the live site
- design: when the feature needs a UX design spec before implementation
Only gather info when genuinely needed — don't delay task creation unnecessarily.

### EXCEPTION: Architectural & Platform Extension Proposals
When the user is proposing to rethink, redesign, or extend EXISTING platform architecture (e.g., "rethink the feature developer", "redesign the agent hierarchy", "change how sandboxes work"), do NOT rush to create_tasks. Instead:
1. Use gather_info with research=true FIRST to understand the current implementation
2. Ground your response in what the research reveals about the current architecture
3. Iterate with the user on the design before creating any tasks
4. Only create_tasks once you and the user have agreed on the approach

Signals this exception applies:
- User references existing platform components by name
- User says "rethink...", "redesign...", "what if we changed..."
- User explicitly asks not to start building yet
- The proposal is about HOW the system works, not WHAT new feature to add

### continue
Only use this if the message is truly so vague you have NO idea what to build (e.g., "I want to make something cool").

## Response Format
You MUST respond with ONLY a JSON object (no markdown fences, no extra text):
{
    "response": "Your conversational message to the user.",
    "action": "continue" | "create_tasks" | "gather_info",
    "taskUpdates": {
        "newNodes": [{ "id": "task-N", "objective": "...", "acceptanceCriteria": "...", "taskType": "frontend|backend|fullstack", "dependsOn": ["existing-task-id"] }],
        "updatedNodes": [{ "nodeId": "existing-task-id", "objective": "...", "acceptanceCriteria": "..." }],
        "removedNodeIds": ["task-id-to-remove"]
    },
    "gatherRequests": {
        "research": true/false,
        "researchObjective": "A detailed, specific research objective that describes WHAT to investigate in the codebase and WHY. Include the user's actual request context. Example: 'The user wants to rethink the feature developer as a generic programming agent that works on their GitHub repos. Investigate: how the current FeatureDeveloper agent works end-to-end (sandbox lifecycle, task graph execution, tool binding), how it integrates with the DialogueAgent and ProjectManager, and what would need to change to support arbitrary GitHub repos instead of just the hivemind monorepo.'",
        "explore": true/false,
        "design": true/false
    },
    "workObjective": "High-level objective for the full feature (set on first create_tasks)"
}

Rules:
- "taskUpdates" is used when action is "create_tasks"
- "gatherRequests" is used when action is "gather_info". When research=true, you MUST include "researchObjective" with a detailed description of what to investigate
- "workObjective" is set on the FIRST create_tasks action to describe the full feature
- Keep "response" concise (2-4 sentences typically). Ask at most ONE question per response.
- Never expose JSON structure or technical details to the user in "response"
- Default to create_tasks. Err aggressively on the side of creating tasks early.
- EXCEPTION: For architectural/extension proposals about the platform itself, default to gather_info with research=true first.
- Task IDs should be "task-1", "task-2", etc. for new tasks.
- NEVER create a task that duplicates or overlaps with an existing task (including done or active tasks). Check the "Completed tasks", "Currently working on", and "Modifiable tasks" context before creating new ones. If the user's refinement relates to an existing modifiable task, use updatedNodes to update it — do NOT append a new task.
- For backend tasks, acceptance criteria should specify exact API endpoint paths
- For frontend tasks, acceptance criteria should specify exact page routes
- For semantic tasks, reference available services (LLM-based analysis) not regex/keyword lists`;

// ── Structured response type ─────────────────────────────────────────────────

interface DialogueAction {
    response: string;
    action: 'continue' | 'create_tasks' | 'gather_info';
    taskUpdates?: {
        newNodes?: Array<{
            id: string;
            objective: string;
            acceptanceCriteria: string;
            taskType: string;
            dependsOn: string[];
        }>;
        updatedNodes?: Array<{
            nodeId: string;
            objective?: string;
            acceptanceCriteria?: string;
        }>;
        removedNodeIds?: string[];
    };
    gatherRequests?: {
        research?: boolean;
        researchObjective?: string;
        explore?: boolean;
        design?: boolean;
    };
    workObjective?: string;
    suggestedFollowups?: string[];
    suggestedQuestions?: string[];
}

// ── DialogueAgent class ──────────────────────────────────────────────────────

export class DialogueAgent {
    readonly traceId: string;
    lastActivityAt: number;
    private history: LLMMessage[];
    private taskGraph: TaskGraph | null;
    private processing: boolean;
    private lastContextSources: ContextSource[];

    // Gathered context from sub-agents
    private researchSummary: string | null;
    private designSpec: UxDesignSpec | null;
    private siteExploration: SiteExplorationResult | null;
    private workObjective: string | null;

    // Sandbox — shared across research and development phases
    private sandbox: SandboxHandle | null;

    // FeatureDeveloper tracking
    private featureDeveloperId: string | null;
    private featureDeveloperDone: boolean;
    /** Unsubscribe function for TASK_NODE_COMPLETED listener */
    private unsubNodeCompleted: (() => void) | null;
    /** Unsubscribe function for STATE_CHANGED (taskComplete) listener */
    private unsubFeatureComplete: (() => void) | null;

    constructor(traceId: string) {
        this.traceId = traceId;
        this.lastActivityAt = Date.now();
        this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
        this.taskGraph = null;
        this.processing = false;
        this.lastContextSources = [];
        this.researchSummary = null;
        this.designSpec = null;
        this.siteExploration = null;
        this.workObjective = null;
        this.sandbox = null;
        this.featureDeveloperId = null;
        this.featureDeveloperDone = false;
        this.unsubNodeCompleted = null;
        this.unsubFeatureComplete = null;

        // Restore persisted task graph (survives backend restarts)
        const savedGraph = sessionStore.getTaskGraph(traceId);
        if (savedGraph !== null) {
            this.taskGraph = savedGraph;
            this.workObjective = savedGraph.rootObjective;
            logger.info(`[DialogueAgent:${traceId}] Restored task graph (${savedGraph.nodes.length.toString()} nodes) from session store`);

            // Re-populate context agent cache so it can answer status queries
            eventBus.emit({
                eventId: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                eventType: 'TASK_GRAPH_UPDATED',
                sourceId: 'dialogue-agent',
                targetId: null,
                traceId,
                payload: {
                    graph: JSON.parse(JSON.stringify(savedGraph)) as Record<string, unknown>,
                    message: 'Restored from session store',
                    isRootGraph: true,
                },
            } as unknown as SystemEvent);
        }
    }

    /**
     * Process a new user message. Calls the LLM and emits appropriate events.
     * Safe to call concurrently — serializes via the `processing` flag.
     */
    async handleUserMessage(text: string): Promise<void> {
        if (this.processing) {
            logger.warn(`[DialogueAgent:${this.traceId}] Already processing a message, queuing`);
            while (this.processing) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        this.processing = true;
        this.lastActivityAt = Date.now();
        try {
            // Lock mutable tasks while we think
            const hasTasksToLock = this.taskGraph !== null &&
                this.taskGraph.nodes.some((n) => n.status === 'ready' || n.status === 'pending');
            if (hasTasksToLock) {
                lockMutableTasks(this.taskGraph!);
                this.#emitGraph('Tasks locked while processing your message');
            }

            // Get enriched context
            const contextNote = await this.#getEnrichedContext(text);
            const userContent = contextNote !== ''
                ? `${text}\n\n[SYSTEM CONTEXT — not from user: ${contextNote}]`
                : text;

            this.history.push({ role: 'user', content: userContent });

            const action = await this.#callLLM();
            if (action === null) {
                this.#unlockAndEmit();
                this.#emitResponse('I ran into a problem processing that. Could you try rephrasing?');
                return;
            }

            // Always emit the conversational response
            const followups = action.suggestedFollowups ?? action.suggestedQuestions;
            this.#emitResponse(action.response, followups);

            // Handle the action
            switch (action.action) {
                case 'create_tasks': {
                    await this.#handleCreateTasks(action);
                    break;
                }

                case 'gather_info': {
                    await this.#handleGatherInfo(action);
                    break;
                }

                case 'continue':
                default:
                    break;
            }

            // Unlock tasks and emit updated graph
            this.#unlockAndEmit();

            // Auto-start FeatureDeveloper if we have ready tasks and none running
            this.#maybeStartFeatureDeveloper();

            // Store assistant response in history
            this.history.push({ role: 'assistant', content: JSON.stringify(action) });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[DialogueAgent:${this.traceId}] Error: ${msg}`);
            this.#unlockAndEmit();
            this.#emitResponse('I had trouble processing that. Could you try again?');
        } finally {
            this.processing = false;
        }
    }

    /**
     * Called by ProjectManager (legacy) when a task graph is created.
     * @deprecated — DialogueAgent now owns the task graph directly.
     */
    setTaskGraph(graph: TaskGraph, _ownerAgentId: string): void {
        this.taskGraph = graph;
        logger.info(`[DialogueAgent:${this.traceId}] Task graph set (legacy) with ${graph.nodes.length.toString()} nodes`);
    }

    /**
     * Called by ProjectManager (legacy) when a task node completes.
     * @deprecated — DialogueAgent now listens to events directly.
     */
    onNodeCompleted(
        node: { id: string; objective: string; status: string },
        progress: { done: number; total: number },
    ): void {
        this.lastActivityAt = Date.now();
        if (node.status !== 'done') return;
        const remaining = progress.total - progress.done;
        const progressText = remaining > 0
            ? `Moving on to the next step (${progress.done.toString()} of ${progress.total.toString()} done).`
            : '';
        this.#emitResponse(`✓ Finished: ${node.objective}. ${progressText}`.trim());
    }

    /**
     * Called by ProjectManager (legacy) when execution completes.
     * @deprecated — DialogueAgent now listens to events directly.
     */
    onExecutionComplete(result: { success: boolean; summary: string }): void {
        const statusWord = result.success ? 'finished' : 'ran into some issues';
        this.#emitResponse(
            `The engineering team has ${statusWord} building your feature. ${result.summary}`,
            result.success ? ['Can you show me what was built?', 'I\'d like to make some changes'] : ['Can you try again?', 'What went wrong?'],
        );
    }

    // ── Action handlers ──────────────────────────────────────────────────────

    async #handleCreateTasks(action: DialogueAction): Promise<void> {
        if (action.taskUpdates === undefined) {
            logger.warn(`[DialogueAgent:${this.traceId}] create_tasks without taskUpdates`);
            return;
        }

        // Set work objective on first creation
        if (this.workObjective === null && action.workObjective !== undefined) {
            this.workObjective = action.workObjective;
            // Sync session: set title + status to planning
            sessionStore.updateSession(this.traceId, {
                title: action.workObjective,
                status: 'planning',
            });
        }

        // Create graph if it doesn't exist yet
        if (this.taskGraph === null) {
            this.taskGraph = {
                rootObjective: this.workObjective ?? action.workObjective ?? 'Feature',
                nodes: [],
                createdAt: new Date().toISOString(),
                status: 'pending',
            };
        }

        const updates = action.taskUpdates;

        // Remove nodes first (so IDs can be reused if needed)
        if (updates.removedNodeIds !== undefined && updates.removedNodeIds.length > 0) {
            for (const nodeId of updates.removedNodeIds) {
                try {
                    removeMutableNode(this.taskGraph, nodeId);
                    logger.info(`[DialogueAgent:${this.traceId}] Removed node ${nodeId}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`[DialogueAgent:${this.traceId}] Remove node failed: ${msg}`);
                }
            }
        }

        // Add new nodes
        if (updates.newNodes !== undefined && updates.newNodes.length > 0) {
            const validTypes = new Set(['frontend', 'backend', 'fullstack']);
            const newTaskNodes: TaskNode[] = updates.newNodes.map((n) => ({
                id: n.id,
                objective: n.objective,
                acceptanceCriteria: n.acceptanceCriteria,
                taskType: (typeof n.taskType === 'string' && validTypes.has(n.taskType)
                    ? n.taskType
                    : 'fullstack') as TaskNode['taskType'],
                dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : [],
                status: 'locked' as TaskStatus, // appendNodes sets this
                isAtomic: true,
            }));

            // Filter out near-duplicates of existing tasks (especially done/active)
            const existingObjectives = this.taskGraph.nodes.map((n) => n.objective.toLowerCase());
            const dedupedNodes = newTaskNodes.filter((n) => {
                const newObj = n.objective.toLowerCase();
                const isDuplicate = existingObjectives.some((existing) =>
                    existing.includes(newObj) || newObj.includes(existing),
                );
                if (isDuplicate) {
                    logger.warn(`[DialogueAgent:${this.traceId}] Rejected duplicate task: "${n.objective}"`);
                }
                return !isDuplicate;
            });

            if (dedupedNodes.length > 0) {
                try {
                    appendNodes(this.taskGraph, dedupedNodes);
                    logger.info(`[DialogueAgent:${this.traceId}] Added ${dedupedNodes.length.toString()} new nodes`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`[DialogueAgent:${this.traceId}] Append nodes failed: ${msg}`);
                }
            }
        }

        // Update existing nodes
        if (updates.updatedNodes !== undefined && updates.updatedNodes.length > 0) {
            for (const update of updates.updatedNodes) {
                const patch: { objective?: string; acceptanceCriteria?: string } = {};
                if (update.objective !== undefined) patch.objective = update.objective;
                if (update.acceptanceCriteria !== undefined) patch.acceptanceCriteria = update.acceptanceCriteria;
                try {
                    updateMutableNode(this.taskGraph, update.nodeId, patch);
                    logger.info(`[DialogueAgent:${this.traceId}] Updated node ${update.nodeId}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`[DialogueAgent:${this.traceId}] Update node failed: ${msg}`);
                }
            }
        }

        // Emit USER_COMMAND for the ledger (so replay reconstructs the chat)
        if (this.workObjective !== null) {
            eventBus.emit({
                eventId: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                eventType: 'USER_COMMAND',
                sourceId: 'dialogue-agent',
                targetId: null,
                traceId: this.traceId,
                payload: {
                    objective: this.workObjective,
                    traceId: this.traceId,
                    originalText: this.workObjective,
                    intent: 'new_feature',
                },
            });
        }
    }

    /**
     * Ensure a sandbox exists for this feature. Creates one on first call,
     * reuses after. The same sandbox is shared across research (DataResearcher)
     * and development (FeatureDeveloper) phases.
     */
    async #ensureSandbox(): Promise<SandboxHandle> {
        if (this.sandbox !== null) return this.sandbox;

        logger.info(`[DialogueAgent:${this.traceId}] Creating feature sandbox...`);
        this.#emitResponse('Preparing the development environment...');
        this.sandbox = await createFeatureSandbox(this.traceId);
        logger.info(`[DialogueAgent:${this.traceId}] Sandbox ready: ${this.sandbox.containerName}`);
        return this.sandbox;
    }

    async #handleGatherInfo(action: DialogueAction): Promise<void> {
        const requests = action.gatherRequests;
        if (requests === undefined) {
            logger.warn(`[DialogueAgent:${this.traceId}] gather_info without gatherRequests`);
            return;
        }

        const objective = requests.researchObjective
            ?? this.workObjective
            ?? this.taskGraph?.rootObjective
            ?? 'feature exploration';

        // Track what we gathered so we can do a follow-up LLM call
        const gathered: string[] = [];

        if (requests.research === true) {
            try {
                // Create sandbox so DataResearcher can use ask_codebase
                const sandbox = await this.#ensureSandbox();

                this.#emitResponse('Researching the codebase for relevant context...');
                const researcherId = `data-researcher.${uuidv4().slice(0, 8)}`;
                const researcher = new DataResearcher(researcherId, this.traceId);
                const result = await researcher.run(objective, sandbox);
                this.researchSummary = result.summary;
                contextAgent.setResearchSummary(this.traceId, result.summary);
                logger.info(`[DialogueAgent:${this.traceId}] Research completed: ${result.summary.slice(0, 100)}`);
                gathered.push(`## Codebase Research Results\n${result.fullReport}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[DialogueAgent:${this.traceId}] Research failed: ${msg}`);
                gathered.push(`## Codebase Research\nResearch failed: ${msg}`);
            }
        }

        if (requests.explore === true) {
            try {
                this.#emitResponse('Exploring the current site to understand the existing UI...');
                const explorerId = `site-explorer.${uuidv4().slice(0, 8)}`;
                const explorer = new SiteExplorer(explorerId, this.traceId);
                this.siteExploration = await explorer.run(objective);
                logger.info(`[DialogueAgent:${this.traceId}] Site exploration completed`);
                gathered.push(`## Site Exploration Results\n${this.siteExploration}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[DialogueAgent:${this.traceId}] Site exploration failed: ${msg}`);
            }
        }

        if (requests.design === true) {
            try {
                this.#emitResponse('Creating a UX design spec for this feature...');
                const designerId = `ux-designer.${uuidv4().slice(0, 8)}`;
                const designer = new UxDesigner(designerId, this.traceId);
                this.designSpec = await designer.run(
                    objective,
                    this.researchSummary ?? 'No research context.',
                    this.siteExploration ?? undefined,
                );
                contextAgent.setDesignSpec(this.traceId, this.designSpec);
                logger.info(`[DialogueAgent:${this.traceId}] Design spec created`);
                gathered.push(`## UX Design Spec\n${this.designSpec}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[DialogueAgent:${this.traceId}] Design failed: ${msg}`);
            }
        }

        // ── Follow-up: feed research results back to LLM for active listening ──
        // The initial response ("Let me research...") was already emitted. Now that
        // gathering is done, inject the findings and call the LLM again so it can
        // engage the user with informed follow-up questions.
        if (gathered.length > 0) {
            const contextMsg = [
                '[SYSTEM — Research results are now available. Use these findings to engage the user.',
                'Ground your response in specific details from the research.',
                'Ask targeted follow-up questions to clarify their vision based on what you now know about the current implementation.',
                'Do NOT create tasks yet — help the user think through the design first.]',
                '',
                ...gathered,
            ].join('\n');

            // Inject as a "user" message (system context) so the LLM sees the findings
            this.history.push({ role: 'user', content: contextMsg });

            const followUp = await this.#callLLM();
            if (followUp !== null) {
                const followups = followUp.suggestedFollowups ?? followUp.suggestedQuestions;
                this.#emitResponse(followUp.response, followups);
                this.history.push({ role: 'assistant', content: JSON.stringify(followUp) });

                // If the LLM decided to create tasks in the follow-up, handle that too
                if (followUp.action === 'create_tasks') {
                    await this.#handleCreateTasks(followUp);
                }
            }
        }
    }

    // ── FeatureDeveloper lifecycle ────────────────────────────────────────────

    #maybeStartFeatureDeveloper(): void {
        if (this.taskGraph === null) return;
        if (this.featureDeveloperId !== null) return; // already running

        // Check if there are any ready tasks
        const hasReady = this.taskGraph.nodes.some((n) => n.status === 'ready');
        if (!hasReady) return;

        const devId = `feature-developer.${uuidv4().slice(0, 8)}`;
        this.featureDeveloperId = devId;
        this.featureDeveloperDone = false;

        const context: FeatureDevContext = {
            taskGraph: this.taskGraph,
            researchSummary: this.researchSummary ?? '',
            designSpec: this.designSpec,
            workObjective: this.workObjective ?? this.taskGraph.rootObjective,
            ...(this.sandbox !== null ? { sandbox: this.sandbox } : {}),
        };

        logger.info(`[DialogueAgent:${this.traceId}] Auto-starting FeatureDeveloper ${devId}`);

        // Sync session status to active
        sessionStore.updateSession(this.traceId, { status: 'active' });

        // Subscribe to progress events from the FeatureDeveloper
        this.#subscribeToFeatureDeveloper(devId);

        // Fire-and-forget — FeatureDeveloper manages its own errors
        const dev = new FeatureDeveloper(devId, this.traceId);
        void dev.run(context).then(() => {
            sessionStore.updateSession(this.traceId, { status: 'completed' });
        }).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[DialogueAgent:${this.traceId}] FeatureDeveloper failed: ${msg}`);
            sessionStore.updateSession(this.traceId, { status: 'failed' });
        }).finally(() => {
            this.featureDeveloperDone = true;
            this.featureDeveloperId = null;
            this.#cleanupFeatureDeveloperSubscriptions();
        });
    }

    #subscribeToFeatureDeveloper(devId: string): void {
        // Track node completions for progress updates
        this.unsubNodeCompleted = eventBus.subscribe('TASK_NODE_COMPLETED', (event: SystemEvent) => {
            if (event.traceId !== this.traceId) return;
            if (event.sourceId !== devId) return;

            this.lastActivityAt = Date.now();
            const nodeId = String(event.payload['nodeId'] ?? '');
            const status = String(event.payload['status'] ?? '');

            if (status !== 'done') return;

            // Find the node to get its objective
            const node = this.taskGraph?.nodes.find((n) => n.id === nodeId);
            if (node === undefined) return;

            const done = this.taskGraph!.nodes.filter((n) => n.status === 'done' || n.status === 'skipped').length;
            const total = this.taskGraph!.nodes.length;
            const remaining = total - done;
            const progressText = remaining > 0
                ? `Moving on to the next step (${done.toString()} of ${total.toString()} done).`
                : '';
            this.#emitResponse(`✓ Finished: ${node.objective}. ${progressText}`.trim());
        });

        // Track feature completion
        this.unsubFeatureComplete = eventBus.subscribe('STATE_CHANGED', (event: SystemEvent) => {
            if (event.traceId !== this.traceId) return;
            if (event.sourceId !== devId) return;
            if (event.payload['taskComplete'] !== true) return;

            const summary = typeof event.payload['message'] === 'string' ? event.payload['message'] : '';
            this.#emitResponse(
                `The engineering team has finished building your feature. ${summary}`,
                ['Can you show me what was built?', 'I\'d like to make some changes'],
            );
        });
    }

    #cleanupFeatureDeveloperSubscriptions(): void {
        if (this.unsubNodeCompleted !== null) {
            this.unsubNodeCompleted();
            this.unsubNodeCompleted = null;
        }
        if (this.unsubFeatureComplete !== null) {
            this.unsubFeatureComplete();
            this.unsubFeatureComplete = null;
        }
    }

    /**
     * Clean up all resources on session deletion.
     * Removes event subscriptions and clears internal state so the
     * FeatureDeveloper (if still running) won't pick up new tasks.
     */
    destroy(): void {
        this.#cleanupFeatureDeveloperSubscriptions();
        // Clear the task graph so a still-running FeatureDeveloper's
        // while-loop exits (no ready nodes left to find)
        if (this.taskGraph !== null) {
            this.taskGraph.nodes = [];
            this.taskGraph.status = 'failed';
        }
        this.featureDeveloperId = null;
        this.featureDeveloperDone = true;
        logger.info(`[DialogueAgent:${this.traceId}] Cleaned up resources`);
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    #unlockAndEmit(): void {
        if (this.taskGraph !== null && this.taskGraph.nodes.length > 0) {
            unlockTasks(this.taskGraph);

            // Promote pending nodes whose dependencies are now met
            // (unlockTasks only handles locked→ready/pending, not pending→ready)
            for (const node of this.taskGraph.nodes) {
                if (node.status === 'pending' && dependenciesMet(node, this.taskGraph)) {
                    node.status = 'ready';
                }
            }

            this.taskGraph.status = deriveGraphStatus(this.taskGraph);
            this.#emitGraph('Tasks updated');
        }
    }

    #emitGraph(message: string): void {
        if (this.taskGraph === null) return;

        // Persist to SQLite so the graph survives backend restarts
        sessionStore.saveTaskGraph(this.traceId, this.taskGraph);

        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'TASK_GRAPH_UPDATED',
            sourceId: 'dialogue-agent',
            targetId: null,
            traceId: this.traceId,
            payload: {
                graph: JSON.parse(JSON.stringify(this.taskGraph)) as Record<string, unknown>,
                message,
                isRootGraph: true,
            },
        } as unknown as SystemEvent);
    }

    /**
     * Get enriched context via the Context Agent (LLM-powered).
     * Falls back to the simple #buildContextNote() if the context agent fails.
     */
    async #getEnrichedContext(userMessage: string): Promise<string> {
        try {
            // Allow more time for the first message of a new feature, which may
            // need codebase exploration to understand architectural proposals
            const isFirstMessage = this.taskGraph === null && this.researchSummary === null;
            const timeoutMs = isFirstMessage ? 12000 : 5000;

            const result = await contextAgent.buildContext(
                userMessage,
                this.traceId,
                timeoutMs,
            );
            if (result.contextNote !== '') {
                this.lastContextSources = result.sources;
                return result.contextNote;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[DialogueAgent:${this.traceId}] Context agent failed, using fallback: ${msg}`);
        }
        this.lastContextSources = [];
        return this.#buildContextNote();
    }

    #buildContextNote(): string {
        const parts: string[] = [];

        if (this.taskGraph !== null) {
            const locked = this.taskGraph.nodes.filter((n) => n.status === 'locked');
            const ready = this.taskGraph.nodes.filter((n) => n.status === 'ready');
            const pending = this.taskGraph.nodes.filter((n) => n.status === 'pending');
            const active = this.taskGraph.nodes.filter((n) => n.status === 'active');
            const done = this.taskGraph.nodes.filter((n) => n.status === 'done');

            parts.push(
                `Task graph: ${done.length.toString()} done, ${active.length.toString()} active, ${ready.length.toString()} ready, ${pending.length.toString()} pending, ${locked.length.toString()} locked.`,
            );

            if (active.length > 0) {
                parts.push(`Currently working on: "${active[0]!.objective.slice(0, 100)}"`);
            }

            // Show completed tasks so the LLM doesn't create duplicates
            if (done.length > 0) {
                const doneList = done.map((n) => `${n.id}: "${n.objective.slice(0, 60)}"`).join('; ');
                parts.push(`Completed tasks: ${doneList}`);
            }

            // Show mutable tasks so the LLM knows what can be updated
            const mutable = [...ready, ...pending, ...locked];
            if (mutable.length > 0) {
                const mutableList = mutable.map((n) => `${n.id}: "${n.objective.slice(0, 60)}"`).join('; ');
                parts.push(`Modifiable tasks: ${mutableList}`);
            }
        }

        if (this.featureDeveloperId !== null && !this.featureDeveloperDone) {
            parts.push('FeatureDeveloper is currently executing tasks.');
        }

        if (this.researchSummary !== null) {
            parts.push('Research has been completed.');
        }
        if (this.designSpec !== null) {
            parts.push('UX design spec has been created.');
        }

        return parts.join(' ');
    }

    async #callLLM(): Promise<DialogueAction | null> {
        try {
            const completion = await generateWithRawTools(
                this.history,
                [],   // no tools — pure text completion
                'high', // gpt-4o for complex reasoning
            );

            const raw = extractTextContent(completion).trim();
            logger.info(`[DialogueAgent:${this.traceId}] LLM response: ${raw.slice(0, 200)}`);

            // Strip markdown fences if present
            const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
            const parsed = JSON.parse(cleaned) as DialogueAction;

            // Validate required fields
            if (typeof parsed.response !== 'string' || parsed.response === '') {
                logger.warn(`[DialogueAgent:${this.traceId}] Missing response in LLM output`);
                return null;
            }

            const validActions = ['continue', 'create_tasks', 'gather_info'];
            if (!validActions.includes(parsed.action)) {
                parsed.action = 'continue';
            }

            return parsed;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[DialogueAgent:${this.traceId}] LLM call failed: ${msg}`);
            return null;
        }
    }

    #emitResponse(text: string, suggestedFollowups?: string[]): void {
        const hasWork = this.taskGraph !== null && this.taskGraph.nodes.length > 0;
        const phase = hasWork
            ? (this.featureDeveloperId !== null ? 'building' : 'exploring')
            : 'exploring';

        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: 'DIALOGUE_RESPONSE',
            sourceId: 'dialogue-agent',
            targetId: null,
            traceId: this.traceId,
            payload: {
                text,
                conversationPhase: phase,
                ...(suggestedFollowups !== undefined && suggestedFollowups.length > 0
                    ? { suggestedFollowups }
                    : {}),
                ...(this.lastContextSources.length > 0
                    ? { contextSources: this.lastContextSources }
                    : {}),
            },
        });

        // Clear after emitting so next message starts fresh
        this.lastContextSources = [];
    }
}
