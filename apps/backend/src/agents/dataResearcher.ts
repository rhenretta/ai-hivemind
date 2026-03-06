/**
 * dataResearcher.ts — Data Researcher Agent (RPIV: Research phase)
 *
 * The DataResearcher gathers context relevant to a coding objective before
 * any implementation work begins. It uses GPT-4o with the full MCP tool set
 * (web_search, http_get, query_rag) to produce a structured ResearchResult
 * that the ProjectManager feeds into the Planner prompt.
 *
 * Tier 2 constraints:
 *  - No spawning of sub-agents
 *  - Read-only tool binding (no file writes, no shell commands)
 *  - ONLY writes to its own context namespace in RAG
 */

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { logger } from '../services/logger.js';
import { mcpRegistry } from '../services/mcpRegistry.js';
import { executeTool } from '../services/mcpExecutor.js';
import { ragStore } from '../services/ragStore.js';

import { BaseAgent } from './baseAgent.js';

import type OpenAI from 'openai';

// ── System prompt ──────────────────────────────────────────────────────────────

const RESEARCHER_SYSTEM_PROMPT = `You are the DataResearcher agent in an autonomous software engineering swarm.

Your role is the RESEARCH phase of an RPIV (Research, Plan, Implement, Validate) loop.

Given a software objective, your job is to:
1. Query the knowledge base (RAG store) for any prior context relevant to the objective
2. If the objective involves external APIs or data sources, search for their documentation
3. Identify which files in the existing project may need to be modified (describe paths you know exist based on the project structure)
4. Identify relevant tech stack details, patterns, and constraints

Output format (always return structured text under these exact headings):
## Prior Context
(what the RAG store returned, if anything)

## Relevant Documentation
(API docs, library docs found via web_search — or "None needed" if purely internal)

## Key Files to Consider
(paths + reason, based on known project structure)

## Constraints & Patterns
(tech stack rules, naming conventions, patterns to follow)

## Summary
(2-3 sentences synthesising the above for a planner)

Guidelines:
- Be concise — this output feeds directly into a planning prompt
- Do not speculate beyond what you found; say "unknown" when unsure
- Do NOT write any code
- Use 'query_rag' before any web_search — prefer cached project knowledge`;

// ── READ-ONLY MCP tool whitelist ───────────────────────────────────────────────
// DataResearcher may only use information-gathering tools.

const READ_ONLY_TOOLS = new Set(['query_rag', 'web_search', 'http_get']);

// ── Coordinator-style virtual tool for RAG ────────────────────────────────────

const RESEARCHER_VIRTUAL_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'query_rag',
            description: 'Query the knowledge base (RAG store) for relevant prior context.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query text' },
                    collection: { type: 'string', description: 'Collection name (default: "default")', default: 'default' },
                },
                required: ['query'],
            },
        },
    },
];

const MAX_TURNS = 6;

// ── ResearchResult ─────────────────────────────────────────────────────────────

export interface ResearchResult {
    summary: string;
    fullReport: string;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class DataResearcher extends BaseAgent {
    static readonly RAG_COLLECTION = 'research-context';

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    async run(objective: string): Promise<ResearchResult> {
        this.spawn('data-researcher');
        this.emit('STATE_CHANGED', {
            message: `Researching: "${objective.slice(0, 120)}"`,
            phase: 'research',
        });

        // Build tool set: virtual RAG tool + whitelisted MCP tools
        const mcpTools = mcpRegistry.getAvailableTools()
            .filter((t) => READ_ONLY_TOOLS.has(t.name))
            .map((t): OpenAI.ChatCompletionTool => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
            }));
        const allTools = [...RESEARCHER_VIRTUAL_TOOLS, ...mcpTools];

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: RESEARCHER_SYSTEM_PROMPT },
            { role: 'user', content: `Objective: ${objective}` },
        ];

        let fullReport = 'No research output produced.';

        try {
            for (let turn = 0; turn < MAX_TURNS; turn++) {
                const completion = await generateWithRawTools(messages, allTools, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                messages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    // Final text response
                    fullReport = extractTextContent(completion);
                    break;
                }

                // Dispatch tool calls
                for (const call of choice.message.tool_calls ?? []) {
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchTool(fnCall.function.name, args);
                    messages.push({ role: 'tool', tool_call_id: call.id, content: result });
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit('ERROR', { message: `DataResearcher error: ${msg}`, agentId: this.agentId });
            logger.error(`[${this.agentId}] Error:`, err);
            fullReport = `Research failed: ${msg}`;
        }

        // Store in RAG for future retrieval
        this.#storeResult(objective, fullReport);

        // Extract the summary section
        const summaryMatch = /## Summary\s*([\s\S]+)$/m.exec(fullReport);
        const summary = summaryMatch?.[1]?.trim() ?? fullReport.slice(0, 400);

        this.emit('STATE_CHANGED', {
            message: `Research complete. Summary: ${summary.slice(0, 200)}`,
            phase: 'research',
            done: true,
        });
        this.terminate('research_complete');

        return { summary, fullReport };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async #dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
        this.emit('TOOL_USED', { toolName: name, input: args });

        if (name === 'query_rag') {
            const query = String(args['query'] ?? '');
            const collection = String(args['collection'] ?? 'default');
            const results = ragStore.queryContext(collection, query);
            if (results.length === 0) return 'No relevant context found.';
            return results.map((r) => `[${r.entry.tags.join(', ')}] ${r.entry.content}`).join('\n---\n');
        }

        if (!READ_ONLY_TOOLS.has(name)) {
            return `Tool '${name}' is not authorized for DataResearcher.`;
        }

        return await executeTool(name, args);
    }

    #storeResult(objective: string, report: string): void {
        const collections = ragStore.getCollections();
        if (!collections.some((c) => c.name === DataResearcher.RAG_COLLECTION)) {
            ragStore.createCollection(DataResearcher.RAG_COLLECTION, 'Research reports produced by the DataResearcher agent');
        }
        ragStore.storeContext(DataResearcher.RAG_COLLECTION, {
            memoryId: crypto.randomUUID(),
            traceId: this.traceId,
            agentId: this.agentId,
            content: `Research for: ${objective}\n\n${report}`,
            tags: ['research', 'data-researcher'],
            timestamp: new Date().toISOString(),
        });
    }
}
