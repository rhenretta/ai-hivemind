/**
 * contextAgent.ts — Context Enrichment Service
 *
 * A singleton service that gathers relevant system context for the DialogueAgent.
 * Subscribes to key events to maintain a rolling state cache, then uses a
 * low-tier LLM with virtual tools to select only the information relevant
 * to each user message.
 *
 * NOT a BaseAgent subclass — this is a long-lived service, not a spawnable agent.
 * One singleton instance for the entire backend.
 */

import type OpenAI from 'openai';

import type { TaskGraph, UxDesignSpec, SystemEvent, MemoryQueryResult } from '@ai-hivemind/shared';

import { eventBus } from '../eventBus.js';

import { getFeatureSummaries } from './intentRouter.js';
import { generateWithRawTools, extractTextContent, extractToolCalls, type LLMMessage, type LLMToolCall } from './llm.js';
import { logger } from './logger.js';
import { ragStore } from './ragStore.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface QaVerdictSummary {
    subtask: string;
    passed: boolean;
    issues: string[];
    warnings: string[];
    summary: string;
    timestamp: string;
}

interface FeatureContext {
    traceId: string;
    /** Latest task graph snapshot (from TASK_GRAPH_UPDATED) */
    taskGraph: TaskGraph | null;
    /** Latest QA verdicts — newest first, max 5 */
    qaVerdicts: QaVerdictSummary[];
    /** UX design spec (set by PM via setDesignSpec) */
    designSpec: UxDesignSpec | null;
    /** Research summary (set by PM via setResearchSummary) */
    researchSummary: string | null;
    /** Deployed service URLs (from SERVICE_DEPLOYED) */
    deployedServices: { url: string; port: number }[];
    /** Recent errors — newest first, max 5 */
    recentErrors: { message: string; timestamp: string }[];
    /** Current PM phase (from STATE_CHANGED) */
    currentPhase: string | null;
    /** Last meaningful state message */
    lastStateMessage: string | null;
    /** Completed node summaries — max 10 */
    completedNodes: { nodeId: string; result: string }[];
}

export interface ContextSource {
    /** Tool name that was called (e.g. "get_task_status") */
    tool: string;
    /** 1-line summary of what was found */
    summary: string;
}

export interface ContextResult {
    /** Full context note for injection into DialogueAgent prompt */
    contextNote: string;
    /** What tools were called and brief results */
    sources: ContextSource[];
}

// ── System prompt ────────────────────────────────────────────────────────────

const CONTEXT_SYSTEM_PROMPT = `You are a context-gathering assistant for a conversational AI system. Your job is to determine what information is relevant to a user's message and gather it using the available tools.

## Your Task
Given a user message and the current feature ID, decide what context the conversational AI needs to give a good response. Call the appropriate tools to gather that information, then synthesize a concise context summary.

## Guidelines
- ONLY gather information that is relevant to the user's specific question or comment
- For status questions ("how's it going?", "what's the progress?"): use get_task_status and get_execution_log
- For QA/testing questions ("did it pass?", "any bugs?"): use get_qa_results
- For design/UX questions ("what will it look like?", "layout?"): use get_design_spec
- For questions about other features: use get_all_features
- For codebase or technical detail questions: use query_knowledge_base to search research findings and SWE outputs
- Keep your final context summary CONCISE — under 500 words
- Do NOT include information the user didn't ask about
- Always include the current phase and overall status if work is in progress
- If no tools are needed (e.g., casual greeting), respond with just a brief status note

## Response Format
After gathering information, provide a concise context summary as plain text. This will be injected into the conversation as system context — the user won't see it directly.`;

// ── Virtual tool definitions ─────────────────────────────────────────────────

const CONTEXT_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'get_all_features',
            description: 'Get a summary of ALL features being worked on across the system, with their current statuses.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_task_status',
            description: 'Get the detailed task graph status for a specific feature, including all task nodes and their completion states.',
            parameters: {
                type: 'object',
                properties: {
                    trace_id: { type: 'string', description: 'The feature traceId to look up. Use the current feature ID if asking about "this" feature.' },
                },
                required: ['trace_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_qa_results',
            description: 'Get QA test results and verdicts for a specific feature.',
            parameters: {
                type: 'object',
                properties: {
                    trace_id: { type: 'string', description: 'The feature traceId.' },
                },
                required: ['trace_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_design_spec',
            description: 'Get the UX design specification for a feature, including layout, component hierarchy, user flow, and styling.',
            parameters: {
                type: 'object',
                properties: {
                    trace_id: { type: 'string', description: 'The feature traceId.' },
                },
                required: ['trace_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_execution_log',
            description: 'Get the recent execution log for a feature: phase transitions, completed nodes, errors, deployed services.',
            parameters: {
                type: 'object',
                properties: {
                    trace_id: { type: 'string', description: 'The feature traceId.' },
                },
                required: ['trace_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_knowledge_base',
            description: 'Search the RAG knowledge base for research findings, SWE build outputs, or UX designs. Use "all" to search across all collections for a given feature.',
            parameters: {
                type: 'object',
                properties: {
                    collection: {
                        type: 'string',
                        enum: ['research-context', 'swe-outputs', 'ux-designs', 'all'],
                        description: 'Which knowledge base collection to search. Use "all" for cross-collection search.',
                    },
                    query: { type: 'string', description: 'Search query.' },
                    trace_id: { type: 'string', description: 'The feature traceId. Required when collection is "all".' },
                },
                required: ['collection', 'query'],
            },
        },
    },
];

// ── ContextAgent class ───────────────────────────────────────────────────────

class ContextAgent {
    /** Per-feature rolling context cache */
    readonly #features = new Map<string, FeatureContext>();

    /** Event bus unsubscribe functions for cleanup */
    readonly #unsubscribers: (() => void)[] = [];

    constructor() {
        this.#subscribeToEvents();
        logger.info('[ContextAgent] Initialized — event subscriptions active');
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Set the design spec for a feature. Called by DialogueAgent after design phase.
     */
    setDesignSpec(traceId: string, spec: UxDesignSpec): void {
        this.#ensureFeature(traceId).designSpec = spec;
        logger.info(`[ContextAgent] Design spec set for ${traceId}`);
    }

    /**
     * Set the research summary for a feature. Called by DialogueAgent after research phase.
     */
    setResearchSummary(traceId: string, summary: string): void {
        this.#ensureFeature(traceId).researchSummary = summary;
        logger.info(`[ContextAgent] Research summary set for ${traceId}`);
    }

    /**
     * Build context relevant to a user message. Uses a low-tier LLM with virtual
     * tools to select and format only the information needed.
     *
     * @param userMessage - The raw user message text
     * @param traceId - The current feature's traceId (null if no active feature)
     * @param timeoutMs - Maximum time for context gathering (default: 5000ms)
     * @returns ContextResult with context note and source metadata
     */
    async buildContext(
        userMessage: string,
        traceId: string | null,
        timeoutMs = 5000,
    ): Promise<ContextResult> {
        const startTime = Date.now();
        const sources: ContextSource[] = [];

        try {
            // Build the user prompt with minimal baseline context
            const featureNote = traceId !== null
                ? `Current feature traceId: ${traceId}`
                : 'No active feature — the user may be asking a general question.';

            // Include a quick status snapshot so the LLM can decide if it even needs tools
            let quickStatus = '';
            if (traceId !== null) {
                const ctx = this.#features.get(traceId);
                if (ctx !== undefined) {
                    const parts: string[] = [];
                    if (ctx.currentPhase !== null) parts.push(`Phase: ${ctx.currentPhase}`);
                    if (ctx.taskGraph !== null) {
                        const done = ctx.taskGraph.nodes.filter((n) => n.status === 'done').length;
                        const total = ctx.taskGraph.nodes.length;
                        parts.push(`Tasks: ${done.toString()}/${total.toString()} done`);
                    }
                    quickStatus = parts.length > 0 ? `\nQuick status: ${parts.join(', ')}` : '';
                }
            }

            const messages: LLMMessage[] = [
                { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `${featureNote}${quickStatus}\n\nUser message: "${userMessage}"\n\nGather the relevant context.`,
                },
            ];

            // First LLM call — may produce tool calls or direct text
            const completion = await generateWithRawTools(messages, CONTEXT_TOOLS, 'low');

            const toolCalls = extractToolCalls(completion);

            // If no tool calls, return the text response directly
            if (toolCalls === null) {
                const text = extractTextContent(completion).trim();
                return { contextNote: text, sources };
            }

            // Execute tool calls in parallel
            const toolResults = await Promise.all(
                toolCalls.map(async (tc) => {
                    // Cast to the function-call variant (same pattern as other agents)
                    const fnCall = tc as LLMToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchTool(fnCall.function.name, args);
                    // Record source metadata
                    sources.push({
                        tool: fnCall.function.name,
                        summary: result.slice(0, 80) + (result.length > 80 ? '...' : ''),
                    });
                    return { id: tc.id, name: fnCall.function.name, result };
                }),
            );

            // Check timeout — if we're running long, skip the synthesis LLM call
            const elapsed = Date.now() - startTime;
            if (elapsed > timeoutMs * 0.8) {
                logger.info(`[ContextAgent] Timeout approaching (${elapsed.toString()}ms), returning raw tool results`);
                const rawContext = toolResults.map((r) => `[${r.name}]\n${r.result}`).join('\n\n');
                return { contextNote: rawContext, sources };
            }

            // Second LLM call — synthesize tool results into a context note
            const assistantMessage = completion.choices[0]?.message;
            if (assistantMessage === undefined) {
                const rawContext = toolResults.map((r) => `[${r.name}]\n${r.result}`).join('\n\n');
                return { contextNote: rawContext, sources };
            }

            const followUpMessages: LLMMessage[] = [
                ...messages,
                assistantMessage as LLMMessage,
                ...toolResults.map((r) => ({
                    role: 'tool' as const,
                    tool_call_id: r.id,
                    content: r.result,
                })),
            ];

            const synthesis = await generateWithRawTools(followUpMessages, [], 'low');
            const contextNote = extractTextContent(synthesis).trim();
            return { contextNote, sources };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[ContextAgent] buildContext failed: ${msg}`);
            // Fallback: return whatever cached state we have
            return { contextNote: this.#buildFallbackContext(traceId), sources };
        }
    }

    // ── Event subscriptions ──────────────────────────────────────────────────

    #subscribeToEvents(): void {
        // 1. TASK_GRAPH_UPDATED — full graph snapshot, last-write-wins
        this.#unsubscribers.push(
            eventBus.subscribe('TASK_GRAPH_UPDATED', (event: SystemEvent) => {
                const traceId = event.traceId;
                if (traceId === undefined) return;
                const graph = event.payload['graph'] as unknown as TaskGraph | undefined;
                if (graph !== undefined) {
                    this.#ensureFeature(traceId).taskGraph = graph;
                }
            }),
        );

        // 2. QA_VERDICT — append, cap at 5 per feature (newest first)
        this.#unsubscribers.push(
            eventBus.subscribe('QA_VERDICT', (event: SystemEvent) => {
                const traceId = event.traceId;
                if (traceId === undefined) return;
                const ctx = this.#ensureFeature(traceId);
                ctx.qaVerdicts.unshift({
                    subtask: String(event.payload['subtask'] ?? ''),
                    passed: event.payload['passed'] === true,
                    issues: Array.isArray(event.payload['issues']) ? event.payload['issues'] as string[] : [],
                    warnings: Array.isArray(event.payload['warnings']) ? event.payload['warnings'] as string[] : [],
                    summary: String(event.payload['summary'] ?? ''),
                    timestamp: event.timestamp,
                });
                if (ctx.qaVerdicts.length > 5) ctx.qaVerdicts.length = 5;
            }),
        );

        // 3. STATE_CHANGED — track current phase and last message
        this.#unsubscribers.push(
            eventBus.subscribe('STATE_CHANGED', (event: SystemEvent) => {
                const traceId = event.traceId;
                if (traceId === undefined) return;
                const ctx = this.#ensureFeature(traceId);
                if (typeof event.payload['phase'] === 'string') {
                    ctx.currentPhase = event.payload['phase'];
                }
                if (typeof event.payload['message'] === 'string') {
                    ctx.lastStateMessage = event.payload['message'];
                }
            }),
        );

        // 4. TASK_NODE_COMPLETED — append completed node summaries, cap at 10
        this.#unsubscribers.push(
            eventBus.subscribe('TASK_NODE_COMPLETED', (event: SystemEvent) => {
                const traceId = event.traceId;
                if (traceId === undefined) return;
                const ctx = this.#ensureFeature(traceId);
                if (event.payload['status'] === 'done' && typeof event.payload['result'] === 'string') {
                    ctx.completedNodes.push({
                        nodeId: String(event.payload['nodeId'] ?? ''),
                        result: String(event.payload['result']),
                    });
                    if (ctx.completedNodes.length > 10) ctx.completedNodes.shift();
                }
            }),
        );

        // 5. SERVICE_DEPLOYED — track deployed URLs
        this.#unsubscribers.push(
            eventBus.subscribe('SERVICE_DEPLOYED', (event: SystemEvent) => {
                const traceId = event.traceId;
                if (traceId === undefined) return;
                const ctx = this.#ensureFeature(traceId);
                const url = String(event.payload['url'] ?? '');
                const port = typeof event.payload['port'] === 'number' ? event.payload['port'] : 0;
                if (url !== '' && !ctx.deployedServices.some((s) => s.url === url)) {
                    ctx.deployedServices.push({ url, port });
                }
            }),
        );

        // 6. ERROR — track recent errors, cap at 5
        this.#unsubscribers.push(
            eventBus.subscribe('ERROR', (event: SystemEvent) => {
                const traceId = event.traceId;
                if (traceId === undefined) return;
                const ctx = this.#ensureFeature(traceId);
                ctx.recentErrors.unshift({
                    message: String(event.payload['message'] ?? ''),
                    timestamp: event.timestamp,
                });
                if (ctx.recentErrors.length > 5) ctx.recentErrors.length = 5;
            }),
        );
    }

    #ensureFeature(traceId: string): FeatureContext {
        let ctx = this.#features.get(traceId);
        if (ctx === undefined) {
            ctx = {
                traceId,
                taskGraph: null,
                qaVerdicts: [],
                designSpec: null,
                researchSummary: null,
                deployedServices: [],
                recentErrors: [],
                currentPhase: null,
                lastStateMessage: null,
                completedNodes: [],
            };
            this.#features.set(traceId, ctx);
        }
        return ctx;
    }

    // ── Tool dispatch ────────────────────────────────────────────────────────

    async #dispatchTool(
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        logger.info(`[ContextAgent] Dispatching tool: ${toolName}`);

        switch (toolName) {
            case 'get_all_features': {
                const features = getFeatureSummaries();
                if (features.length === 0) return 'No features are currently being tracked.';
                return features.map((f) =>
                    `[${f.id}] "${f.title}" — status: ${f.status}, last active: ${f.lastActivity}` +
                    (f.blockedQuestion !== undefined ? `\n  BLOCKED: ${f.blockedQuestion}` : ''),
                ).join('\n');
            }

            case 'get_task_status': {
                const traceId = String(args['trace_id'] ?? '');
                const ctx = this.#features.get(traceId);
                if (ctx === undefined || ctx.taskGraph === null) {
                    return `No task graph found for feature ${traceId}. Work may not have started yet.`;
                }
                const graph = ctx.taskGraph;
                const lines = [
                    `Feature: ${graph.rootObjective}`,
                    `Overall status: ${graph.status}`,
                    `Phase: ${ctx.currentPhase ?? 'unknown'}`,
                    '',
                    'Tasks:',
                    ...graph.nodes.map((n) =>
                        `  [${n.id}] (${n.status}) ${n.objective.slice(0, 120)}` +
                        (n.result !== undefined ? `\n    Result: ${n.result.slice(0, 200)}` : '') +
                        (n.error !== undefined ? `\n    Error: ${n.error.slice(0, 200)}` : ''),
                    ),
                ];
                return lines.join('\n');
            }

            case 'get_qa_results': {
                const traceId = String(args['trace_id'] ?? '');
                const ctx = this.#features.get(traceId);
                if (ctx === undefined || ctx.qaVerdicts.length === 0) {
                    return `No QA results found for feature ${traceId}.`;
                }
                return ctx.qaVerdicts.map((v) =>
                    `[${v.passed ? 'PASSED' : 'FAILED'}] ${v.subtask}\n  Summary: ${v.summary}` +
                    (v.issues.length > 0 ? `\n  Issues: ${v.issues.join('; ')}` : '') +
                    (v.warnings.length > 0 ? `\n  Warnings: ${v.warnings.join('; ')}` : ''),
                ).join('\n\n');
            }

            case 'get_design_spec': {
                const traceId = String(args['trace_id'] ?? '');
                const ctx = this.#features.get(traceId);
                if (ctx === undefined || ctx.designSpec === null) {
                    return `No design spec found for feature ${traceId}.`;
                }
                const spec = ctx.designSpec;
                return [
                    `Layout: ${spec.layout}`,
                    `Components: ${spec.componentHierarchy}`,
                    `User Flow: ${spec.userFlow}`,
                    `Styling: ${spec.styling}`,
                    `Wireframe:\n${spec.wireframe}`,
                    `UX Acceptance Criteria: ${spec.uxAcceptanceCriteria}`,
                    ...(spec.navigationIntegration !== undefined
                        ? [`Navigation: ${spec.navigationIntegration}`]
                        : []),
                ].join('\n\n');
            }

            case 'get_execution_log': {
                const traceId = String(args['trace_id'] ?? '');
                const ctx = this.#features.get(traceId);
                if (ctx === undefined) return `No execution data for feature ${traceId}.`;
                const parts: string[] = [];
                if (ctx.currentPhase !== null) parts.push(`Current phase: ${ctx.currentPhase}`);
                if (ctx.lastStateMessage !== null) parts.push(`Latest status: ${ctx.lastStateMessage}`);
                if (ctx.completedNodes.length > 0) {
                    parts.push('Completed nodes:');
                    for (const n of ctx.completedNodes) {
                        parts.push(`  [${n.nodeId}]: ${n.result.slice(0, 150)}`);
                    }
                }
                if (ctx.recentErrors.length > 0) {
                    parts.push('Recent errors:');
                    for (const e of ctx.recentErrors) {
                        parts.push(`  [${e.timestamp}] ${e.message.slice(0, 200)}`);
                    }
                }
                if (ctx.deployedServices.length > 0) {
                    parts.push('Deployed services:');
                    for (const s of ctx.deployedServices) {
                        parts.push(`  ${s.url} (port ${s.port.toString()})`);
                    }
                }
                return parts.length > 0 ? parts.join('\n') : 'No execution activity recorded yet.';
            }

            case 'query_knowledge_base': {
                const collection = String(args['collection'] ?? 'research-context');
                const query = String(args['query'] ?? '');

                let results: MemoryQueryResult[];
                if (collection === 'all') {
                    const traceId = String(args['trace_id'] ?? '');
                    if (traceId === '') return 'ERROR: trace_id is required when collection is "all".';
                    results = await ragStore.queryAcrossCollectionsSemantic(traceId, query);
                } else {
                    results = await ragStore.queryContextSemantic(collection, query);
                }

                if (results.length === 0) return `No results found in "${collection}" for "${query}".`;
                return results
                    .slice(0, 5)
                    .map((r) => `[${r.entry.collectionName} | score=${r.score.toFixed(2)}] ${r.entry.content.slice(0, 300)}`)
                    .join('\n\n');
            }

            default:
                return `Unknown tool: ${toolName}`;
        }
    }

    // ── Fallback context ─────────────────────────────────────────────────────

    #buildFallbackContext(traceId: string | null): string {
        if (traceId === null) return '';

        const ctx = this.#features.get(traceId);
        if (ctx === undefined) return '';

        const parts: string[] = [];
        if (ctx.currentPhase !== null) parts.push(`Current phase: ${ctx.currentPhase}`);
        if (ctx.lastStateMessage !== null) parts.push(`Status: ${ctx.lastStateMessage}`);

        if (ctx.taskGraph !== null) {
            const pending = ctx.taskGraph.nodes.filter((n) => n.status === 'pending').length;
            const active = ctx.taskGraph.nodes.filter((n) => n.status === 'active').length;
            const done = ctx.taskGraph.nodes.filter((n) => n.status === 'done').length;
            parts.push(`Task graph: ${done.toString()} done, ${active.toString()} active, ${pending.toString()} pending.`);
        }

        if (ctx.recentErrors.length > 0) {
            parts.push(`Last error: ${ctx.recentErrors[0]!.message.slice(0, 150)}`);
        }

        return parts.join(' ');
    }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const contextAgent = new ContextAgent();
