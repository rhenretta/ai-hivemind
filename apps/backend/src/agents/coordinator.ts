/**
 * coordinator.ts — High-intelligence Coordinator Agent
 *
 * Uses gpt-4o (tier:'high') to decompose user objectives, query RAG, execute
 * registered tools, and delegate coding tasks to the SoftwareEngineer via
 * the Claude Code CLI.
 *
 * Run loop (max MAX_TURNS turns):
 *  1. LLM call with system prompt + full tool set
 *  2. If tool_calls in response: dispatch each → append results → loop
 *  3. If stop response: emit STATE_CHANGED summary → break
 *  4. Self-terminate in finally block
 */

import { v4 as uuidv4 } from 'uuid';


import { credentialStore } from '../services/credentialStore.js';
import { generateWithRawTools } from '../services/llm.js';
import { logger } from '../services/logger.js';
import { executeTool } from '../services/mcpExecutor.js';
import { mcpRegistry } from '../services/mcpRegistry.js';
import { ragStore } from '../services/ragStore.js';

import { BaseAgent } from './baseAgent.js';
import { ProjectManager } from './projectManager.js';

import type OpenAI from 'openai';

// ── System prompt ─────────────────────────────────────────────────────────────

const COORDINATOR_SYSTEM_PROMPT = `You are the Coordinator agent in an autonomous software engineering swarm. Your job is to GET THINGS DONE — not to explain, ask questions, or seek confirmation.

## Tools

READ-ONLY tools (gather context only):
 - query_rag: look up prior context from the knowledge base
 - web_search: search the internet
 - http_get: fetch a URL
 - read_file: read a file from disk

DELEGATION tool (the primary action for any implementation work):
 - delegate_to_project_manager: runs a full Research → Plan → Implement → Validate loop

## Mandatory Rules

1. **Immediately delegate any implementation request.** If the user wants something BUILT, MODIFIED, or CREATED, your FIRST action must be to call delegate_to_project_manager. Do not explain what you will do. Do not ask for confirmation. Do not ask clarifying questions. Just call the tool.

2. **Research is optional, not required.** Only call query_rag or web_search if you genuinely need external context before you can form a clear objective. Most objectives are self-explanatory — delegate directly.

3. **Never produce a conversational response for an actionable request.** A text reply without a tool call is ONLY acceptable for pure factual questions (e.g. "what is X?"). Any objective that implies building or changing anything must trigger a tool call.

4. **Never ask "would you like me to..." or "shall I...".** You are autonomous. If it needs to be done, do it.

5. **After delegation completes**, emit a brief summary of what was accomplished. This is your only permitted text response. Keep it to 3 sentences max.

## Decision rule (apply in order)
- Does the objective require creating, modifying, or running code? → Call delegate_to_project_manager NOW.
- Is the objective a pure information question? → Answer directly.
- Anything else → Delegate.`;

// ── Coordinator-specific virtual tools (not in MCP registry) ─────────────────
// These are declared as OpenAI tool shapes directly to avoid McpTool typing issues.

const COORDINATOR_OPENAI_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'query_rag',
            description: 'Query the knowledge base (RAG store) for relevant prior context. Returns matching memory entries.',
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
    {
        type: 'function',
        function: {
            name: 'delegate_to_project_manager',
            description: 'Delegate a coding or file-modification task to the ProjectManager, which runs a full Research → Plan → Implement → Validate loop. Use this for any implementation work. Returns a structured summary of what was accomplished.',
            parameters: {
                type: 'object',
                properties: {
                    objective: { type: 'string', description: 'Complete, self-contained objective for the ProjectManager' },
                },
                required: ['objective'],
            },
        },
    },
];

// ── Main class ────────────────────────────────────────────────────────────────

export class Coordinator extends BaseAgent {
    static readonly AGENT_ID = 'coordinator.0';
    /** Max LLM turns before bailing out to avoid infinite loops */
    static readonly MAX_TURNS = 10;

    constructor(traceId: string) {
        super(Coordinator.AGENT_ID, traceId);
    }

    async run(objective: string): Promise<void> {
        this.spawn('coordinator');
        this.sendMessage('broadcast', `Starting analysis: "${objective}"`, { objective });

        // Build the full tool set: MCP registry tools + coordinator virtual tools
        const mcpTools = mcpRegistry.getAvailableTools();
        const mcpOpenAITools: OpenAI.ChatCompletionTool[] = mcpTools.map((tool) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }));
        const allOpenAITools = [...mcpOpenAITools, ...COORDINATOR_OPENAI_TOOLS];

        // Append available external services to system prompt so the coordinator
        // knows what APIs are available when delegating tasks
        let systemPrompt = COORDINATOR_SYSTEM_PROMPT;
        try {
            const manifest = credentialStore.getManifest();
            if (manifest.length > 0) {
                systemPrompt += '\n\n## Available External Services\n'
                    + 'These services have API keys configured and available to agents:\n'
                    + manifest.map((s) => `- ${s.serviceLabel} (env: ${s.envVarName})`).join('\n');
            }
        } catch {
            // Non-fatal — credential store may not be initialized
        }

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: objective },
        ];

        try {
            for (let turn = 0; turn < Coordinator.MAX_TURNS; turn++) {
                // Use generateAgentResponse with empty tools and manually add our full tool set
                // by calling OpenAI directly through the llm service's client
                const completion = await generateWithRawTools(messages, allOpenAITools, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                // Append assistant message for conversation continuity
                messages.push(choice.message);

                const toolCalls = choice.finish_reason === 'tool_calls'
                    ? (choice.message.tool_calls ?? null)
                    : null;

                if (toolCalls === null) {
                    // Final response — no more tool calls
                    const summary = choice.message.content ?? '';
                    this.emit('STATE_CHANGED', {
                        message: summary,
                        taskComplete: true,
                    });
                    break;
                }

                // Dispatch each tool call and collect results
                for (const call of toolCalls) {
                    // Cast to the concrete function tool call type
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchToolCall(fnCall.function.name, args);
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: result,
                    });
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit('ERROR', {
                message: `Coordinator error: ${msg}`,
                agentId: this.agentId,
            });
            logger.error(`[Coordinator] Error:`, err);
        } finally {
            this.terminate('task_complete');
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async #dispatchToolCall(name: string, args: Record<string, unknown>): Promise<string> {
        this.emit('TOOL_USED', { toolName: name, input: args });

        switch (name) {
            case 'query_rag': {
                const query = String(args['query'] ?? '');
                const collection = String(args['collection'] ?? 'default');
                const results = ragStore.queryContext(collection, query);
                if (results.length === 0) return 'No relevant context found.';
                return results
                    .map((r) => `[${r.entry.tags.join(', ')}] ${r.entry.content}`)
                    .join('\n---\n');
            }

            case 'delegate_to_project_manager': {
                const pmObjective = String(args['objective'] ?? '');
                const pmId = `project-manager.${uuidv4().slice(0, 8)}`;

                // Enrich with monorepo context so the PM's planner and DataResearcher
                // have the stack information they need without having to discover it.
                const enrichedObjective = [
                    pmObjective,
                    '',
                    '## Project Context',
                    `Monorepo root: ${process.env['MONOREPO_ROOT'] ?? '/Users/rhenretta/workspace/rhenretta/ai-hivemind'}`,
                    'Tech stack: Next.js 14 (apps/web), Node.js/Express backend (apps/backend), pnpm workspaces, TypeScript throughout.',
                    'New standalone apps/pages go in apps/web/src/app/ as Next.js route segments.',
                ].join('\n');

                this.sendMessage(pmId, `Delegating to ProjectManager: ${pmObjective}`, { objective: pmObjective });
                const pm = new ProjectManager(pmId, this.traceId);
                const result = await pm.run(enrichedObjective);
                return result;
            }

            default:
                // Research/read-only tools (web_search, http_get, read_file, etc.) go directly
                // to the MCP executor. write_file, execute_cli_command, screenshot_url are
                // intentionally omitted from COORDINATOR_OPENAI_TOOLS, so GPT-4o should never
                // call them here — but if it somehow does, we block it.
                if (['write_file', 'execute_cli_command', 'screenshot_url'].includes(name)) {
                    return `Tool '${name}' is not available to the Coordinator. Use delegate_to_project_manager for implementation work.`;
                }
                return await executeTool(name, args);
        }
    }
}
