/**
 * siteExplorer.ts — Site Explorer Agent (RPIV: Explore phase)
 *
 * The SiteExplorer browses the live frontend with a persistent Playwright
 * browser to understand the current state of the web application before
 * a new feature is designed.
 *
 * It produces:
 *   - Screenshots of key pages (base64 PNG)
 *   - A navigation structure summary (how users move between pages)
 *   - An existing features catalog (what the site currently offers)
 *
 * The output feeds into:
 *   - UxDesigner: visual context (screenshots as vision messages)
 *   - Decomposer: navigation awareness (where to add links)
 *
 * Tier 2 constraints:
 *  - No spawning of sub-agents
 *  - Read-only browser interaction (no form submissions or writes)
 *  - Closes browser session in finally block (no leaks)
 */

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { logger } from '../services/logger.js';
import { QaBrowserSession } from '../services/qaBrowser.js';

import { BaseAgent } from './baseAgent.js';

import type OpenAI from 'openai';

// ── Return type ─────────────────────────────────────────────────────────────

export interface SiteScreenshot {
    url: string;
    title: string;
    screenshotB64: string;
    description: string;
}

export interface SiteExplorationResult {
    /** Screenshots of key pages with metadata */
    pages: SiteScreenshot[];
    /** LLM-generated summary of the navigation layout */
    navigationStructure: string;
    /** LLM-generated catalog of existing features */
    existingFeatures: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_TURNS = 12;
const MAX_SCREENSHOTS = 6;

const BASE_URL = `http://localhost:${process.env['WEB_PORT'] ?? '3000'}`;

// ── System prompt ───────────────────────────────────────────────────────────

function buildExplorerSystemPrompt(objective: string): string {
    return `You are a Site Explorer agent in an autonomous software engineering swarm.

Your job is to understand the CURRENT state of the web application before a new
feature is designed. You have a persistent browser session — use it to navigate
the live frontend and catalog what exists.

## Your Task

A user wants to add this feature:
${objective}

Before any design work begins, you need to understand:
1. What the site currently looks like (take screenshots of key pages)
2. How navigation works (header links, sidebar, footer, homepage cards)
3. What features/pages already exist
4. Where a new feature link should logically go

## Instructions

1. Start by navigating to ${BASE_URL} (the homepage) and take a screenshot
2. Use browser_get_text or browser_evaluate to find all navigation links
3. Visit each major page linked from navigation (up to 5 pages) and screenshot each
4. Note the navigation structure: what nav components exist, what links they contain
5. When done, call submit_exploration with your findings

## Available Tools

- browser_navigate(url) — Go to a page. Waits for network activity to settle.
- browser_screenshot() — Capture current page as PNG. You will see the image.
- browser_get_text(selector?) — Read text content from a specific element or full page.
- browser_click(selector) — Click a navigation link or button.
- browser_evaluate(expression) — Run JavaScript to extract data (e.g., all <a> hrefs).
- submit_exploration(navigationStructure, existingFeatures) — Submit your findings.

## Rules

- Take at most ${MAX_SCREENSHOTS.toString()} screenshots (budget management)
- Focus on pages relevant to the new feature being designed
- Always start with the homepage
- If a page fails to load, skip it and move on
- If the site is not running (connection refused), call submit_exploration immediately
  with empty findings — do NOT retry
- Describe what you see in each screenshot for the UX Designer who will receive them

## Output Format

When calling submit_exploration, provide:
- navigationStructure: A detailed description of how navigation works
  (e.g., "Header nav has: Home (/), Dashboard (/dashboard), Settings (/settings).
   Sidebar has: ... Footer has: ...")
- existingFeatures: A catalog of existing features/pages
  (e.g., "1. Homepage (/) — Landing page with feature cards and hero section.
   2. Dashboard (/dashboard) — Analytics charts and metrics. ...")`;
}

// ── Tool definitions ────────────────────────────────────────────────────────

const EXPLORER_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'browser_navigate',
            description: 'Navigate to a URL. Waits for network activity to settle before returning.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The URL to navigate to' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_screenshot',
            description: 'Take a screenshot of the current page. The image will be shown to you for analysis.',
            parameters: {
                type: 'object',
                properties: {
                    full_page: { type: 'boolean', description: 'Capture the full scrollable page (default: true)', default: true },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_get_text',
            description: 'Read text content from a specific CSS selector or the full page body.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector (omit for full page)' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_click',
            description: 'Click an element by CSS selector. Useful for clicking navigation links.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector of the element to click' },
                },
                required: ['selector'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_evaluate',
            description: 'Execute JavaScript in the page context. Useful for extracting navigation links, counting elements, etc.',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'JavaScript expression to evaluate' },
                },
                required: ['expression'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'submit_exploration',
            description: 'Submit your exploration findings. Call this when you have finished exploring the site.',
            parameters: {
                type: 'object',
                properties: {
                    navigationStructure: {
                        type: 'string',
                        description: 'Detailed description of the site navigation structure — what nav components exist, what links they contain, how pages connect.',
                    },
                    existingFeatures: {
                        type: 'string',
                        description: 'Catalog of existing features and pages found during exploration.',
                    },
                },
                required: ['navigationStructure', 'existingFeatures'],
            },
        },
    },
];

// ── Main class ──────────────────────────────────────────────────────────────

export class SiteExplorer extends BaseAgent {
    #browserSession: QaBrowserSession | null = null;

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    async run(objective: string): Promise<SiteExplorationResult> {
        this.spawn('site-explorer');
        this.emit('STATE_CHANGED', {
            message: `Exploring current site at ${BASE_URL}...`,
            phase: 'explore',
        });

        // Collected pages with screenshots
        const pages: SiteScreenshot[] = [];
        let navigationStructure = 'Site not explored (exploration failed or frontend not running).';
        let existingFeatures = 'No features cataloged.';

        // Launch browser session (no port restrictions — exploring the live site)
        this.#browserSession = new QaBrowserSession();

        try {
            await this.#browserSession.launch();
            logger.info(`[${this.agentId}] Browser session launched for site exploration`);

            // Quick connectivity check — if homepage fails, return empty immediately
            const healthCheck = await this.#browserSession.navigate(BASE_URL, 'load');
            if (healthCheck.startsWith('[BROWSER_ERROR]')) {
                logger.warn(`[${this.agentId}] Frontend not available at ${BASE_URL}: ${healthCheck}`);
                this.emit('STATE_CHANGED', {
                    message: `Frontend not running at ${BASE_URL} — skipping site exploration`,
                    phase: 'explore',
                    done: true,
                });
                this.terminate('site_unavailable');
                return { pages, navigationStructure: `Frontend not running at ${BASE_URL}.`, existingFeatures };
            }

            // Run the LLM-driven exploration loop
            const result = await this.#explore(objective, pages);
            navigationStructure = result.navigationStructure;
            existingFeatures = result.existingFeatures;

            this.emit('STATE_CHANGED', {
                message: `Site exploration complete — ${pages.length} pages captured`,
                phase: 'explore',
                done: true,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit('ERROR', { message: `SiteExplorer error: ${msg}`, agentId: this.agentId });
            logger.error(`[${this.agentId}] Error:`, err);
        } finally {
            await this.#browserSession?.close();
            this.#browserSession = null;
        }

        this.terminate('exploration_complete');
        return { pages, navigationStructure, existingFeatures };
    }

    // ── Private — LLM exploration loop ─────────────────────────────────────

    async #explore(
        objective: string,
        pages: SiteScreenshot[],
    ): Promise<{ navigationStructure: string; existingFeatures: string }> {
        const systemPrompt = buildExplorerSystemPrompt(objective);
        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Begin exploring the site. Start by navigating to the homepage.' },
        ];

        let pendingScreenshotB64: string | null = null;
        let navigationStructure = 'No navigation structure cataloged.';
        let existingFeatures = 'No features cataloged.';
        let explorationDone = false;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (explorationDone) break;

            // Inject pending screenshot as vision message
            if (pendingScreenshotB64 !== null) {
                const b64 = pendingScreenshotB64;
                pendingScreenshotB64 = null;
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Here is the screenshot you just captured. Describe what you see and decide what to explore next.' },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } },
                    ],
                });
            }

            const completion = await generateWithRawTools(messages, EXPLORER_TOOLS, 'high');
            const choice = completion.choices[0];
            if (choice === undefined) break;

            messages.push(choice.message);

            if (choice.finish_reason !== 'tool_calls') {
                // LLM finished without calling submit_exploration — extract what we can
                break;
            }

            // Dispatch tool calls
            for (const call of choice.message.tool_calls ?? []) {
                const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                    function: { name: string; arguments: string };
                };
                const name = fnCall.function.name;
                const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;

                this.emit('TOOL_USED', { toolName: name, input: args, phase: 'explore' });

                let result: string;

                if (name === 'submit_exploration') {
                    navigationStructure = typeof args['navigationStructure'] === 'string'
                        ? args['navigationStructure']
                        : 'Not provided';
                    existingFeatures = typeof args['existingFeatures'] === 'string'
                        ? args['existingFeatures']
                        : 'Not provided';
                    result = 'Exploration submitted successfully.';
                    explorationDone = true;
                } else if (name === 'browser_screenshot') {
                    result = await this.#dispatchBrowserTool(name, args);

                    // Store screenshot if successful
                    if (!result.startsWith('[BROWSER_ERROR]') && this.#browserSession !== null) {
                        pendingScreenshotB64 = result;
                        const currentUrl = this.#browserSession.getUrl();

                        // Emit screenshot event for Command Center visibility
                        this.emit('STATE_CHANGED', {
                            message: `Screenshot captured: ${currentUrl}`,
                            screenshotB64: `data:image/png;base64,${result}`,
                            screenshotUrl: currentUrl,
                            phase: 'explore',
                        });

                        // Don't add more screenshots if we've reached the limit
                        // (but still allow the LLM to see them for analysis)
                        if (pages.length < MAX_SCREENSHOTS) {
                            pages.push({
                                url: currentUrl,
                                title: '', // Will be set by LLM description
                                screenshotB64: result,
                                description: '', // Will be enriched later
                            });
                        }

                        // Replace the tool result with a placeholder (image comes in next message)
                        result = '[Screenshot captured — image provided in next message for visual analysis]';
                    }
                } else {
                    result = await this.#dispatchBrowserTool(name, args);
                }

                messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
        }

        // If the LLM never called submit_exploration, extract from final text
        if (!explorationDone) {
            const lastText = extractTextContent(
                { choices: [{ message: messages[messages.length - 1] as OpenAI.ChatCompletionMessage, finish_reason: 'stop', index: 0, logprobs: null }] } as OpenAI.ChatCompletion,
            );
            if (lastText.length > 50) {
                navigationStructure = lastText;
            }
        }

        return { navigationStructure, existingFeatures };
    }

    // ── Private — browser tool dispatch ────────────────────────────────────

    async #dispatchBrowserTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (this.#browserSession === null) return '[BROWSER_ERROR] Browser session not available.';

        const self = this;

        switch (name) {
            case 'browser_navigate': {
                const url = typeof args['url'] === 'string' ? args['url'] : '';
                return await self.#browserSession!.navigate(url);
            }

            case 'browser_screenshot': {
                const fullPage = args['full_page'] !== false;
                return await self.#browserSession!.screenshot(fullPage);
            }

            case 'browser_get_text': {
                const selector = typeof args['selector'] === 'string' ? args['selector'] : undefined;
                return await self.#browserSession!.getText(selector);
            }

            case 'browser_click': {
                const selector = typeof args['selector'] === 'string' ? args['selector'] : '';
                return await self.#browserSession!.click(selector);
            }

            case 'browser_evaluate': {
                const expression = typeof args['expression'] === 'string' ? args['expression'] : '';
                return await self.#browserSession!.evaluate(expression);
            }

            default:
                return `[BROWSER_ERROR] Unknown browser tool: ${name}`;
        }
    }
}
