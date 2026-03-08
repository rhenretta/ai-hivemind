/**
 * dialogueAgent.ts — Conversational Dialogue Agent
 *
 * A per-feature conversational LLM service that uses active listening techniques
 * to help the user develop their feature idea. It decides when to start work,
 * continues conversing while work runs, and can update pending tasks with new
 * requirements the user provides mid-execution.
 *
 * NOT a BaseAgent subclass — this is a long-lived service, not a spawnable agent.
 * One instance per traceId, managed via the module-level `dialogueAgents` map.
 */

import { type TaskGraph } from '@ai-hivemind/shared';

import { eventBus } from '../eventBus.js';

import { type LLMMessage, generateWithRawTools, extractTextContent } from './llm.js';
import { logger } from './logger.js';
import { getFeatureSummaries } from './intentRouter.js';

// ── Module-level registry ────────────────────────────────────────────────────

const dialogueAgents = new Map<string, DialogueAgent>();

export function getOrCreateDialogueAgent(traceId: string): DialogueAgent {
    let agent = dialogueAgents.get(traceId);
    if (agent === undefined) {
        agent = new DialogueAgent(traceId);
        dialogueAgents.set(traceId, agent);
    }
    return agent;
}

export function getDialogueAgent(traceId: string): DialogueAgent | undefined {
    return dialogueAgents.get(traceId);
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
You help the user think through their feature idea using active listening techniques, then decide when to start building. You can start building AND continue the conversation — these are not mutually exclusive.

## Active Listening Techniques
1. **Reflect** — Briefly paraphrase what the user said to confirm understanding
2. **Probe** — Ask about edge cases, UX details, or requirements they might not have considered
3. **Summarize** — Periodically restate the full picture of what you're building
4. **Suggest** — Offer considerations or improvements the user might not have thought of

## CRITICAL: When to Start Work
- DEFAULT ACTION IS start_work. Almost every message should trigger work.
- If the user describes ANYTHING concrete (a page, a feature, a component), start work IMMEDIATELY — even on the very first message.
- Only use "continue" if the message is truly so vague you have NO idea what to build (e.g. "I want to make something cool").
- You MUST start work within 1-2 turns maximum. If you've asked one question, START WORK on the next turn regardless.
- Starting work does NOT end the conversation. You keep chatting about refinements while the team builds.
- Err aggressively on the side of starting early. The user can always refine.
- In your response, acknowledge what you're building and mention ONE thing you'd like to refine. Don't ask a barrage of questions.

## When to Update the Plan
- When the user provides NEW requirements after work has started
- Only update pending tasks (not in-progress or completed ones)
- Create new tasks for requirements that don't fit existing pending tasks
- When updating, explain what you're changing and why

## Response Format
You MUST respond with ONLY a JSON object (no markdown fences, no extra text):
{
    "response": "Your conversational message to the user. Use active listening. Be warm, collaborative, and concise.",
    "action": "continue" | "start_work" | "update_plan",
    "workObjective": "Full feature objective for the engineering team. Include all known requirements.",
    "planUpdates": {
        "newNodes": [{ "id": "task-N", "objective": "...", "acceptanceCriteria": "...", "taskType": "frontend|backend|fullstack", "dependsOn": ["existing-task-id"] }],
        "updatedNodes": [{ "nodeId": "existing-task-id", "objective": "...", "acceptanceCriteria": "..." }]
    },
}

Rules:
- "workObjective" is REQUIRED when action is "start_work", ignored otherwise
- "planUpdates" is REQUIRED when action is "update_plan", ignored otherwise
- Keep "response" concise (2-4 sentences typically). Ask at most ONE question per response.
- Never expose JSON structure or technical details to the user in "response"`;

// ── Structured response type ─────────────────────────────────────────────────

interface DialogueAction {
    response: string;
    action: 'continue' | 'start_work' | 'update_plan';
    workObjective?: string;
    planUpdates?: {
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
    };
    suggestedFollowups?: string[];
    // Legacy field name — accept both for robustness
    suggestedQuestions?: string[];
}

// ── DialogueAgent class ──────────────────────────────────────────────────────

export class DialogueAgent {
    readonly traceId: string;
    lastActivityAt: number;
    private history: LLMMessage[];
    private workStarted: boolean;
    private taskGraph: TaskGraph | null;
    private processing: boolean;

    constructor(traceId: string) {
        this.traceId = traceId;
        this.lastActivityAt = Date.now();
        this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
        this.workStarted = false;
        this.taskGraph = null;
        this.processing = false;
    }

    /**
     * Process a new user message. Calls the LLM and emits appropriate events.
     * Safe to call concurrently — serializes via the `processing` flag.
     */
    async handleUserMessage(text: string): Promise<void> {
        if (this.processing) {
            logger.warn(`[DialogueAgent:${this.traceId}] Already processing a message, queuing`);
            // Simple serialization: wait until current processing is done
            while (this.processing) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        this.processing = true;
        this.lastActivityAt = Date.now();
        try {
            // Add context about current state
            const contextNote = this.#buildContextNote();
            const userContent = contextNote !== ''
                ? `${text}\n\n[SYSTEM CONTEXT — not from user: ${contextNote}]`
                : text;

            this.history.push({ role: 'user', content: userContent });

            const action = await this.#callLLM();
            if (action === null) {
                this.#emitResponse('I ran into a problem processing that. Could you try rephrasing?');
                return;
            }

            // Always emit the conversational response
            // Accept both field names (suggestedFollowups preferred, suggestedQuestions legacy)
            const followups = action.suggestedFollowups ?? action.suggestedQuestions;
            this.#emitResponse(action.response, followups);

            // Handle the action
            switch (action.action) {
                case 'start_work': {
                    if (this.workStarted) {
                        logger.info(`[DialogueAgent:${this.traceId}] Work already started, treating as conversation`);
                        break;
                    }
                    if (action.workObjective === undefined || action.workObjective === '') {
                        logger.warn(`[DialogueAgent:${this.traceId}] start_work without workObjective, skipping`);
                        break;
                    }
                    this.workStarted = true;
                    logger.info(`[DialogueAgent:${this.traceId}] Starting work: "${action.workObjective.slice(0, 80)}…"`);

                    // Emit USER_COMMAND to trigger ProjectManager
                    eventBus.emit({
                        eventId: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        eventType: 'USER_COMMAND',
                        sourceId: 'dialogue-agent',
                        targetId: null,
                        traceId: this.traceId,
                        payload: {
                            objective: action.workObjective,
                            traceId: this.traceId,
                            originalText: action.workObjective,
                            intent: 'new_feature',
                        },
                    });
                    break;
                }

                case 'update_plan': {
                    if (action.planUpdates === undefined) {
                        logger.warn(`[DialogueAgent:${this.traceId}] update_plan without planUpdates`);
                        break;
                    }
                    logger.info(`[DialogueAgent:${this.traceId}] Emitting plan update`);

                    eventBus.emit({
                        eventId: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        eventType: 'DIALOGUE_UPDATE_PLAN',
                        sourceId: 'dialogue-agent',
                        targetId: null,
                        traceId: this.traceId,
                        payload: {
                            newNodes: action.planUpdates.newNodes ?? [],
                            updatedNodes: action.planUpdates.updatedNodes ?? [],
                        },
                    });
                    break;
                }

                case 'continue':
                default:
                    // Just the conversational response — already emitted above
                    break;
            }

            // Store assistant response in history
            this.history.push({ role: 'assistant', content: JSON.stringify(action) });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[DialogueAgent:${this.traceId}] Error: ${msg}`);
            this.#emitResponse('I had trouble processing that. Could you try again?');
        } finally {
            this.processing = false;
        }
    }

    /**
     * Called by ProjectManager when a task graph is created.
     * Stores the reference so the dialogue agent knows what tasks exist.
     */
    setTaskGraph(graph: TaskGraph): void {
        this.taskGraph = graph;
        logger.info(`[DialogueAgent:${this.traceId}] Task graph set with ${graph.nodes.length.toString()} nodes`);
    }

    /**
     * Called by ProjectManager when execution completes.
     * Sends a summary message to the user.
     */
    onExecutionComplete(result: { success: boolean; summary: string }): void {
        const statusWord = result.success ? 'finished' : 'ran into some issues';
        this.#emitResponse(
            `The engineering team has ${statusWord} building your feature. ${result.summary}`,
            result.success ? ['Can you show me what was built?', 'I\'d like to make some changes'] : ['Can you try again?', 'What went wrong?'],
        );
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    #buildContextNote(): string {
        const parts: string[] = [];

        if (this.workStarted) {
            parts.push('Work has already been started on this feature.');
        }

        if (this.taskGraph !== null) {
            const pending = this.taskGraph.nodes.filter((n) => n.status === 'pending');
            const active = this.taskGraph.nodes.filter((n) => n.status === 'active');
            const done = this.taskGraph.nodes.filter((n) => n.status === 'done');

            parts.push(
                `Task graph: ${done.length.toString()} done, ${active.length.toString()} active, ${pending.length.toString()} pending.`,
            );

            if (active.length > 0) {
                parts.push(`Currently working on: "${active[0]!.objective.slice(0, 100)}"`);
            }
            if (pending.length > 0) {
                const pendingList = pending.map((n) => `${n.id}: "${n.objective.slice(0, 60)}"`).join('; ');
                parts.push(`Pending tasks that can be updated: ${pendingList}`);
            }
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

            const validActions = ['continue', 'start_work', 'update_plan'];
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
        const phase = this.workStarted
            ? (this.taskGraph !== null ? 'work_in_progress' : 'starting')
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
            },
        });
    }
}
