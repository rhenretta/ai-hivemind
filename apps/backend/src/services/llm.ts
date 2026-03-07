/**
 * llm.ts — Tiered OpenAI LLM Service
 *
 * Provides a thin wrapper around the OpenAI SDK with a two-tier model strategy:
 *   - tier: 'high'  → gpt-4o  (Coordinator / Planner — complex reasoning)
 *   - tier: 'low'   → gpt-4o-mini (simple tool execution, data extraction)
 *
 * Maps McpTool[] to OpenAI's function-calling format automatically.
 *
 * If OPENAI_API_KEY is not set, all calls will fail gracefully with a descriptive
 * error rather than crashing the server at init time.
 */

import { type McpTool } from '@ai-hivemind/shared';
import OpenAI from 'openai';

import { logger } from './logger.js';

// ── Model config (env-overridable) ────────────────────────────────────────────

const HIGH_TIER_MODEL = process.env['OPENAI_HIGH_TIER_MODEL'] ?? 'gpt-4o';
const LOW_TIER_MODEL = process.env['OPENAI_LOW_TIER_MODEL'] ?? 'gpt-4o-mini';

export type IntelligenceTier = 'high' | 'low';

// ── OpenAI client ─────────────────────────────────────────────────────────────

/**
 * The OpenAI client is created lazily on first call — this avoids a hard crash
 * at startup when OPENAI_API_KEY is absent (server still serves WebSocket events).
 */
let _client: OpenAI | null = null;

function getClient(): OpenAI {
    if (_client === null) {
        const apiKey = process.env['OPENAI_API_KEY'];
        if (apiKey === undefined || apiKey === '' || apiKey === 'sk-...') {
            throw new Error(
                '[LLM] OPENAI_API_KEY is not set. ' +
                'Add it via the Settings page (credential store) or .env.local. ' +
                'The server will continue operating without LLM capabilities.',
            );
        }
        _client = new OpenAI({ apiKey });
    }
    return _client;
}

// ── Tool format conversion ─────────────────────────────────────────────────────

/**
 * Convert our internal McpTool[] to the OpenAI function-calling format.
 * Each McpTool's inputSchema becomes the function's `parameters`.
 */
function toOpenAITools(tools: McpTool[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));
}

// ── Main export ───────────────────────────────────────────────────────────────

export type LLMMessage = OpenAI.ChatCompletionMessageParam;
export type LLMResponse = OpenAI.ChatCompletion;
export type LLMToolCall = OpenAI.ChatCompletionMessageToolCall;

/**
 * Generate an agent response using the OpenAI Chat Completions API.
 *
 * @param messages  Conversation history in OpenAI message format
 * @param tools     McpTool[] to expose as callable functions; empty array disables function calling
 * @param tier      'high' → gpt-4o, 'low' → gpt-4o-mini
 * @returns         The full ChatCompletion response
 * @throws          If OPENAI_API_KEY is missing or the API returns an error
 */
export async function generateAgentResponse(
    messages: LLMMessage[],
    tools: McpTool[],
    tier: IntelligenceTier,
): Promise<LLMResponse> {
    const client = getClient();
    const model = tier === 'high' ? HIGH_TIER_MODEL : LOW_TIER_MODEL;

    const openAITools = toOpenAITools(tools);

    logger.info(`[LLM] Calling ${model} (tier:${tier}) | ${messages.length.toString()} messages | ${tools.length.toString()} tools`);

    try {
        const completion = await client.chat.completions.create({
            model,
            messages,
            ...(openAITools.length > 0 ? { tools: openAITools, tool_choice: 'auto' } : {}),
        });

        const choice = completion.choices[0];
        const finishReason = choice?.finish_reason ?? 'unknown';
        logger.info(`[LLM] Response received | finish_reason=${finishReason} | model=${completion.model}`);

        return completion;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[LLM] API error (${model}): ${message}`);
        throw err;
    }
}

/**
 * Variant of generateAgentResponse that accepts pre-built OpenAI tool format.
 * Used by the Coordinator which composes its own tool set from multiple sources.
 */
export async function generateWithRawTools(
    messages: LLMMessage[],
    tools: OpenAI.ChatCompletionTool[],
    tier: IntelligenceTier,
): Promise<LLMResponse> {
    const client = getClient();
    const model = tier === 'high' ? HIGH_TIER_MODEL : LOW_TIER_MODEL;

    logger.info(`[LLM] Calling ${model} (tier:${tier}) | ${messages.length.toString()} messages | ${tools.length.toString()} raw tools`);

    try {
        const completion = await client.chat.completions.create({
            model,
            messages,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        });
        logger.info(`[LLM] Response | finish_reason=${completion.choices[0]?.finish_reason ?? 'unknown'}`);
        return completion;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[LLM] API error (${model}): ${message}`);
        throw err;
    }
}

export function extractToolCalls(completion: LLMResponse): LLMToolCall[] | null {
    const choice = completion.choices[0];
    if (choice?.finish_reason === 'tool_calls' && Array.isArray(choice.message.tool_calls)) {
        return choice.message.tool_calls;
    }
    return null;
}

/**
 * Helper: extract the text content from a non-tool-call completion.
 */
export function extractTextContent(completion: LLMResponse): string {
    return completion.choices[0]?.message.content ?? '';
}
