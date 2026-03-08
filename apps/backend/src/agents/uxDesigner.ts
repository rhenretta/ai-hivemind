/**
 * uxDesigner.ts — UX Designer Agent (RDIV: Design phase)
 *
 * The UxDesigner produces a structured design specification before any
 * implementation work begins. It uses GPT-4o to translate a user's feature
 * request into concrete layout, component, interaction, and styling
 * decisions.
 *
 * The design spec feeds into:
 *   - Decomposer: influences how the task graph is structured
 *   - SWE objective: guides implementation (layout, components, styling)
 *   - QA prompt: visual validation benchmark
 *
 * Enhanced capabilities:
 *   - Receives screenshots from SiteExplorer (vision messages)
 *   - ask_engineer tool: queries codebase via inner LLM with read_file access
 *   - Navigation integration: ensures new features are reachable from existing nav
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

import type { UxDesignSpec } from '@ai-hivemind/shared';
import { UxDesignSpecSchema } from '@ai-hivemind/shared';
import type OpenAI from 'openai';

import type { SiteExplorationResult } from './siteExplorer.js';

// ── System prompt ──────────────────────────────────────────────────────────────

function buildDesignerSystemPrompt(objective: string, researchContext: string): string {
    return `You are a senior UX/UI designer in an autonomous software engineering swarm.

Your role is the DESIGN phase — given a feature request, design the optimal user experience.
Your design spec will be handed to a Software Engineer (who implements it) and a QA Engineer
(who validates the visual output against your design). Be specific and opinionated.

## Design Principles
- **Information hierarchy**: What's most important? Make it prominent.
- **Modern UI patterns**: Cards, grids, full-bleed layouts, floating actions, bottom sheets.
- **Interaction design**: How does the user navigate, filter, scroll, interact?
- **Discoverability & Navigation**: Every new feature MUST be reachable from existing navigation. Specify exactly where the link should go (header nav, sidebar, homepage card, etc.) and what it should look like. A page with no entry point is a deployment blocker.
- **Contextual Integration**: New features should feel like a natural extension of the existing site — match existing navigation patterns, visual style, and layout conventions. If you have screenshots of the current site, reference them.
- **Mobile-first**: Design for mobile viewports, scale up for desktop.
- **Visual polish**: Professional typography, deliberate spacing, subtle shadows, smooth transitions.
- **Accessibility**: Readable contrast, keyboard navigation, semantic HTML.

## Tech Stack
- Next.js 15 (App Router) + React 19
- Tailwind CSS for styling
- shadcn/ui component library (based on Radix UI primitives)
- Lucide icons

Available shadcn/ui components: Button, Card, Badge, Input, Select, Tabs, Dialog, Sheet,
DropdownMenu, ScrollArea, Separator, Skeleton, Tooltip, Avatar, Switch, Toggle.

## Research Context
${researchContext}

## Instructions

1. Use your tools if helpful (web_search for design inspiration, query_rag for project patterns, ask_engineer for codebase questions)
2. If screenshots of the current site are provided, study them carefully to understand existing patterns
3. Design the complete user experience for the feature, including how it connects to existing navigation
4. Output ONLY a JSON object — no preamble, no explanation, no markdown. Just the raw JSON:

{
  "layout": "Detailed description of the page/feature layout. Be specific about positioning, sizing, and responsive behavior.",
  "componentHierarchy": "Component tree showing nesting. E.g.: Page > Header + ContentArea > PostCard > (Title + Meta + Body + Actions)",
  "userFlow": "Numbered step-by-step description of how the user interacts with the feature from start to finish. MUST start with how the user discovers/navigates to this feature.",
  "styling": "Specific styling decisions: color scheme, typography (font sizes, weights), spacing scale, shadow levels, border radius, animations/transitions.",
  "wireframe": "ASCII wireframe of the primary screen. Use box-drawing characters for structure.",
  "uxAcceptanceCriteria": "Bullet-pointed list of specific, verifiable UX requirements. Each must be testable by looking at the rendered page.",
  "navigationIntegration": "How the user reaches this feature from the existing site. Specify: which nav component gets the link (header, sidebar, homepage), the link text, any icon, and whether it fits in an existing nav section or needs a new one."
}

## CRITICAL OUTPUT FORMAT
Your ENTIRE response must be valid JSON. Do NOT include any text before or after the JSON object.
Do NOT wrap it in markdown code fences. Just output the raw JSON object starting with { and ending with }.

## Rules
- Be SPECIFIC, not vague. "Nice typography" is bad. "text-2xl font-semibold text-foreground for titles, text-sm text-muted-foreground for metadata" is good.
- The wireframe should show real content areas, not placeholders.
- Design for the actual user request — understand what they really want and design the best experience for it.
- Consider edge cases: empty states, loading states, error states.
- The SWE will follow your design literally — if you don't specify it, they won't build it.`;
}

// ── Tool config ────────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set(['query_rag', 'web_search', 'http_get']);

const DESIGNER_VIRTUAL_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'query_rag',
            description: 'Query the knowledge base for existing project patterns and prior context.',
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
            name: 'ask_engineer',
            description: 'Ask a technical question about the current codebase implementation. '
                + 'Use to understand: existing components, routing patterns, navigation structure, '
                + 'data flow, page layouts. Examples: "What components does the homepage render?", '
                + '"How does the sidebar navigation work?", "What API endpoints exist?"',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'Technical question about the codebase' },
                },
                required: ['question'],
            },
        },
    },
];

const MAX_TURNS = 6;

// ── Main class ────────────────────────────────────────────────────────────────

export class UxDesigner extends BaseAgent {
    static readonly RAG_COLLECTION = 'ux-designs';

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    async run(
        objective: string,
        researchContext: string,
        siteExploration?: SiteExplorationResult,
    ): Promise<UxDesignSpec> {
        this.spawn('ux-designer');
        this.emit('STATE_CHANGED', {
            message: `Designing UX for: "${objective}"`,
            phase: 'design',
        });

        // Build tool set: virtual RAG tool + whitelisted MCP tools
        const mcpTools = mcpRegistry.getAvailableTools()
            .filter((t) => READ_ONLY_TOOLS.has(t.name))
            .map((t): OpenAI.ChatCompletionTool => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
            }));
        const allTools = [...DESIGNER_VIRTUAL_TOOLS, ...mcpTools];

        const systemPrompt = buildDesignerSystemPrompt(objective, researchContext);
        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
        ];

        // Build user message — include site screenshots as vision messages if available
        const hasSiteContext = siteExploration !== undefined
            && siteExploration.pages.length > 0;

        if (hasSiteContext) {
            const userContent: OpenAI.ChatCompletionContentPart[] = [
                {
                    type: 'text',
                    text: `Design the UX for this feature:\n\n${objective}\n\n`
                        + `## Current Site State\n${siteExploration!.navigationStructure}\n\n`
                        + `## Existing Features\n${siteExploration!.existingFeatures}`,
                },
            ];

            // Attach up to 4 screenshots for vision analysis
            for (const page of siteExploration!.pages.slice(0, 4)) {
                userContent.push(
                    { type: 'text', text: `Screenshot of ${page.url} ("${page.title}"):` },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${page.screenshotB64}`, detail: 'high' } },
                );
            }

            messages.push({ role: 'user', content: userContent });
            logger.info(`[${this.agentId}] Injected ${Math.min(siteExploration!.pages.length, 4).toString()} site screenshots as vision context`);
        } else {
            // Text-only context (no site exploration or no screenshots captured)
            let textContent = `Design the UX for this feature:\n\n${objective}`;
            if (siteExploration !== undefined) {
                textContent += `\n\n## Current Site State\n${siteExploration.navigationStructure}`
                    + `\n\n## Existing Features\n${siteExploration.existingFeatures}`;
            }
            messages.push({ role: 'user', content: textContent });
        }

        let designText = '';

        try {
            for (let turn = 0; turn < MAX_TURNS; turn++) {
                const completion = await generateWithRawTools(messages, allTools, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                messages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    designText = extractTextContent(completion);
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
            this.emit('ERROR', { message: `UxDesigner error: ${msg}`, agentId: this.agentId });
            logger.error(`[${this.agentId}] Error:`, err);
        }

        // Parse the design spec
        let spec = this.#parseDesignSpec(designText);

        // If parsing failed, retry with JSON mode — OpenAI guarantees valid JSON
        if (spec.layout === '' && designText.trim() !== '') {
            logger.warn(`[${this.agentId}] Design spec parse failed — retrying with JSON mode`);
            spec = await this.#retryWithJsonMode(messages);
        }

        // Store in RAG
        this.#storeResult(objective, spec);

        this.emit('STATE_CHANGED', {
            message: 'UX design complete',
            phase: 'design',
            done: true,
            designSpec: {
                layout: spec.layout,
                componentHierarchy: spec.componentHierarchy,
                userFlow: spec.userFlow,
                styling: spec.styling,
                wireframe: spec.wireframe,
                uxAcceptanceCriteria: spec.uxAcceptanceCriteria,
                navigationIntegration: spec.navigationIntegration,
            },
        });
        this.terminate('design_complete');

        return spec;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async #dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
        this.emit('TOOL_USED', { toolName: name, input: args, phase: 'design' });

        if (name === 'query_rag') {
            const query = String(args['query'] ?? '');
            const collection = String(args['collection'] ?? 'default');
            const results = ragStore.queryContext(collection, query);
            if (results.length === 0) return 'No relevant context found.';
            return results.map((r) => `[${r.entry.tags.join(', ')}] ${r.entry.content}`).join('\n---\n');
        }

        if (name === 'ask_engineer') {
            const question = String(args['question'] ?? '');
            return await this.#askEngineer(question);
        }

        if (!READ_ONLY_TOOLS.has(name)) {
            return `Tool '${name}' is not authorized for UxDesigner.`;
        }

        return await executeTool(name, args);
    }

    /**
     * Inner LLM call that answers codebase questions for the UX Designer.
     * Has access to read_file and query_rag tools so it can look up actual
     * source code to answer questions about navigation, components, etc.
     */
    async #askEngineer(question: string): Promise<string> {
        logger.info(`[${this.agentId}] ask_engineer: "${question.slice(0, 100)}"`);

        // 1. Gather context from multiple RAG collections
        const ragContext: string[] = [];
        for (const collection of ['default', 'research-context', 'ux-designs']) {
            try {
                const results = ragStore.queryContext(collection, question);
                for (const r of results) {
                    ragContext.push(`[${collection}] ${r.entry.content.slice(0, 500)}`);
                }
            } catch {
                // Collection may not exist yet — skip
            }
        }

        // 2. Build tools for the inner LLM (read_file + query_rag)
        const innerTools: OpenAI.ChatCompletionTool[] = [
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file from the project. Use to examine source code, component structure, routing config.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path relative to monorepo root or absolute path' },
                        },
                        required: ['path'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'query_rag',
                    description: 'Query the knowledge base for project context.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query' },
                            collection: { type: 'string', description: 'Collection name', default: 'default' },
                        },
                        required: ['query'],
                    },
                },
            },
        ];

        const contextSection = ragContext.length > 0
            ? `\n\nRelevant context from knowledge base:\n${ragContext.join('\n---\n')}`
            : '';

        const innerMessages: OpenAI.ChatCompletionMessageParam[] = [
            {
                role: 'system',
                content: 'You are a software engineer answering questions about the codebase for a UX designer. '
                    + 'Use read_file to look up source code when needed. Be concise and factual. '
                    + 'Focus on: component structure, routing, navigation, page layouts, data flow.',
            },
            {
                role: 'user',
                content: `Question: ${question}${contextSection}`,
            },
        ];

        // 3. Multi-turn inner LLM call (max 3 turns)
        try {
            for (let turn = 0; turn < 3; turn++) {
                const completion = await generateWithRawTools(innerMessages, innerTools, 'low');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                innerMessages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    return extractTextContent(completion);
                }

                // Dispatch inner tool calls
                for (const call of choice.message.tool_calls ?? []) {
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const innerArgs = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    let result: string;

                    if (fnCall.function.name === 'read_file') {
                        result = await executeTool('read_file', innerArgs);
                    } else if (fnCall.function.name === 'query_rag') {
                        const q = String(innerArgs['query'] ?? '');
                        const c = String(innerArgs['collection'] ?? 'default');
                        const results = ragStore.queryContext(c, q);
                        result = results.length === 0
                            ? 'No relevant context found.'
                            : results.map((r) => r.entry.content.slice(0, 500)).join('\n---\n');
                    } else {
                        result = `Unknown tool: ${fnCall.function.name}`;
                    }

                    innerMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[${this.agentId}] ask_engineer failed: ${msg}`);
            return `Could not answer: ${msg}`;
        }

        return 'Could not determine an answer within the turn limit.';
    }

    /** Try to validate a JSON string as a UxDesignSpec, returning the parsed result or null */
    #tryParseSpec(jsonStr: string, label: string): UxDesignSpec | null {
        // Attempt 1: Try raw JSON
        const result1 = this.#parseAndValidate(jsonStr, label);
        if (result1 !== null) return result1;

        // Attempt 2: Full JSON repair — fix control chars, trailing commas, etc.
        const repaired = UxDesigner.#repairJson(jsonStr);
        if (repaired !== jsonStr) {
            const result2 = this.#parseAndValidate(repaired, `${label}+repair`);
            if (result2 !== null) return result2;
        }

        return null;
    }

    #parseAndValidate(jsonStr: string, label: string): UxDesignSpec | null {
        try {
            const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
            const result = UxDesignSpecSchema.safeParse(parsed);
            if (result.success) return result.data;
            logger.warn(`[${this.agentId}] ${label} Zod validation failed:`, result.error.issues);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`[${this.agentId}] ${label} JSON parse failed: ${msg}`);
        }
        return null;
    }

    /**
     * Comprehensive JSON repair for LLM output.
     *
     * Fixes common issues:
     *  1. Literal newlines, tabs, and ALL control chars (U+0000–U+001F) inside strings
     *  2. Unicode line/paragraph separators (U+2028, U+2029) inside strings
     *  3. Trailing commas before } or ]
     *  4. JavaScript-style single-line comments (// ...)
     *
     * Uses a state machine to track whether we're inside a quoted string.
     */
    static #repairJson(input: string): string {
        // Phase 1: Fix control characters and Unicode separators inside strings
        let result = '';
        let inString = false;
        let escaped = false;

        for (let i = 0; i < input.length; i++) {
            const ch = input[i] as string;
            const code = ch.charCodeAt(0);

            if (escaped) {
                result += ch;
                escaped = false;
                continue;
            }

            if (ch === '\\' && inString) {
                result += ch;
                escaped = true;
                continue;
            }

            if (ch === '"') {
                inString = !inString;
                result += ch;
                continue;
            }

            if (inString) {
                // Escape ALL control characters (U+0000–U+001F)
                if (code <= 0x1F) {
                    if (ch === '\n') { result += '\\n'; continue; }
                    if (ch === '\r') { result += '\\r'; continue; }
                    if (ch === '\t') { result += '\\t'; continue; }
                    // Other control chars → \uXXXX
                    result += '\\u' + code.toString(16).padStart(4, '0');
                    continue;
                }
                // Unicode line/paragraph separators (valid Unicode but invalid in JSON strings)
                if (code === 0x2028) { result += '\\u2028'; continue; }
                if (code === 0x2029) { result += '\\u2029'; continue; }
            }

            result += ch;
        }

        // Phase 2: Remove trailing commas (e.g. `"key": "value",}`)
        result = result.replace(/,\s*([}\]])/g, '$1');

        // Phase 3: Remove single-line comments outside strings (rare but possible)
        // Only safe to do outside strings — re-scan with string tracking
        // Skip this for now as it's uncommon and the regex is fragile with strings

        return result;
    }

    #parseDesignSpec(raw: string): UxDesignSpec {
        if (raw.trim() === '') {
            logger.warn(`[${this.agentId}] Design text is empty — LLM returned no content`);
            return UxDesigner.#emptySpec();
        }

        logger.info(`[${this.agentId}] Parsing design spec (${raw.length.toString()} chars)`);

        // Strategy 1: Extract content between markdown code fences
        // Find ```json ... ``` or ``` ... ``` and extract EVERYTHING between the fences
        const fenceOpenIdx = raw.search(/```(?:json)?\s*\n/);
        if (fenceOpenIdx !== -1) {
            const contentStart = raw.indexOf('\n', fenceOpenIdx) + 1;
            const fenceCloseIdx = raw.indexOf('\n```', contentStart);
            if (fenceCloseIdx !== -1) {
                const fencedContent = raw.slice(contentStart, fenceCloseIdx).trim();
                const spec = this.#tryParseSpec(fencedContent, 'Fenced');
                if (spec !== null) return spec;
            }
        }

        // Strategy 2: Find first '{' and last '}' — try JSON.parse on that span
        // This is the most robust approach for LLM output where JSON is surrounded by text
        const firstBrace = raw.indexOf('{');
        const lastBrace = raw.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const candidate = raw.slice(firstBrace, lastBrace + 1);
            const spec = this.#tryParseSpec(candidate, 'First-last brace');
            if (spec !== null) return spec;
        }

        // Strategy 3: Try the entire response as JSON (LLM returned pure JSON)
        {
            const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            const spec = this.#tryParseSpec(cleaned, 'Pure JSON');
            if (spec !== null) return spec;
        }

        // Strategy 4: Progressively search for JSON objects starting from each '{'
        // Handles cases where there are stray braces before the actual JSON
        {
            let searchFrom = 0;
            while (searchFrom < raw.length) {
                const openIdx = raw.indexOf('{', searchFrom);
                if (openIdx === -1) break;
                // Try from this opening brace to the last '}' in the string
                const candidate = raw.slice(openIdx, lastBrace + 1);
                const spec = this.#tryParseSpec(candidate, `Progressive-${openIdx}`);
                if (spec !== null) return spec;
                searchFrom = openIdx + 1;
            }
        }

        // All strategies failed
        logger.error(`[${this.agentId}] All JSON extraction strategies failed. Raw text (${raw.length.toString()} chars, first 800): ${raw.slice(0, 800)}`);
        return UxDesigner.#emptySpec();
    }

    static #emptySpec(): UxDesignSpec {
        return {
            layout: '',
            componentHierarchy: '',
            userFlow: '',
            styling: '',
            wireframe: '',
            uxAcceptanceCriteria: '',
        };
    }

    /**
     * Retry the design spec generation with OpenAI JSON mode enabled.
     * When response_format is { type: 'json_object' }, the API guarantees
     * the output is valid JSON — no parsing ambiguity.
     *
     * Uses the full conversation history so the model has all tool results
     * and context from prior turns.
     */
    async #retryWithJsonMode(messages: OpenAI.ChatCompletionMessageParam[]): Promise<UxDesignSpec> {
        try {
            const client = (await import('../services/llm.js'));
            const retryMessages: OpenAI.ChatCompletionMessageParam[] = [
                ...messages,
                {
                    role: 'user',
                    content: 'Your previous response could not be parsed as JSON. Please output the UX design spec as a SINGLE valid JSON object with these exact keys: layout, componentHierarchy, userFlow, styling, wireframe, uxAcceptanceCriteria, navigationIntegration. All values must be strings. Output ONLY the JSON.',
                },
            ];

            // Use OpenAI directly with json_object response format
            const OpenAI = (await import('openai')).default;
            const apiKey = process.env['OPENAI_API_KEY'];
            if (!apiKey) return UxDesigner.#emptySpec();

            const openai = new OpenAI({ apiKey });
            const model = process.env['OPENAI_HIGH_TIER_MODEL'] ?? 'gpt-4o';

            const completion = await openai.chat.completions.create({
                model,
                messages: retryMessages,
                response_format: { type: 'json_object' },
            });

            const content = completion.choices[0]?.message.content ?? '';
            logger.info(`[${this.agentId}] JSON-mode retry returned ${content.length.toString()} chars`);

            if (content.trim() === '') return UxDesigner.#emptySpec();

            const parsed = JSON.parse(content) as Record<string, unknown>;
            const result = UxDesignSpecSchema.safeParse(parsed);
            if (result.success) {
                logger.info(`[${this.agentId}] JSON-mode retry succeeded`);
                return result.data;
            }

            logger.warn(`[${this.agentId}] JSON-mode retry Zod validation failed:`, result.error.issues);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] JSON-mode retry failed: ${msg}`);
        }
        return UxDesigner.#emptySpec();
    }

    #storeResult(objective: string, spec: UxDesignSpec): void {
        const collections = ragStore.getCollections();
        if (!collections.some((c) => c.name === UxDesigner.RAG_COLLECTION)) {
            ragStore.createCollection(UxDesigner.RAG_COLLECTION, 'UX design specifications produced by the UxDesigner agent');
        }
        ragStore.storeContext(UxDesigner.RAG_COLLECTION, {
            memoryId: crypto.randomUUID(),
            traceId: this.traceId,
            agentId: this.agentId,
            content: `UX Design for: ${objective}\n\n${JSON.stringify(spec, null, 2)}`,
            tags: ['ux-design', 'design-spec'],
            timestamp: new Date().toISOString(),
        });
    }
}
