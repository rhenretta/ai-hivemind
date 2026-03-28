/**
 * testExecutor.ts — Single-test executor agent
 *
 * Spawned by QaEngineer (planner) to verify one specific claim.
 * Given a test description and sandbox access, the executor autonomously
 * figures out HOW to verify the claim, runs the verification, and returns
 * a structured pass/fail result with evidence.
 *
 * Tool set: http_get, execute_cli_command, browser_*, inspect_page
 * No test plan management — that's the planner's job.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { executeTool } from '../services/mcpExecutor.js';
import { logger } from '../services/logger.js';
import { BaseAgent } from './baseAgent.js';

import type { QaBrowserSession } from '../services/qaBrowser.js';
import type { SandboxHandle } from '../services/sandboxManager.js';
import type OpenAI from 'openai';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_EXECUTOR_TURNS = 15;

// ── Test result ───────────────────────────────────────────────────────────────

export interface TestResult {
    passed: boolean;
    result: string;
    evidence?: string | undefined;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const EXECUTOR_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'execute_cli_command',
            description: 'Execute a shell command and return stdout + stderr.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to run' },
                    timeout_ms: { type: 'number', default: 60000 },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'http_get',
            description: 'Perform an HTTP GET request and return the response status + body.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch' },
                    timeout_ms: { type: 'number', default: 30000 },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_navigate',
            description: 'Navigate the browser to a URL. Waits for network idle by default.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to navigate to' },
                    wait_until: { type: 'string', enum: ['networkidle', 'load', 'domcontentloaded'], default: 'networkidle' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_screenshot',
            description: 'Take a screenshot of the current page. Returns base64 PNG.',
            parameters: {
                type: 'object',
                properties: {
                    full_page: { type: 'boolean', default: true },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_click',
            description: 'Click an element by CSS selector. Waits for network activity to settle after click.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector for the element to click' },
                    timeout_ms: { type: 'number' },
                },
                required: ['selector'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_fill',
            description: 'Fill a form input with text. Waits for network activity to settle after filling.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector for the input element' },
                    value: { type: 'string', description: 'Text to type into the field' },
                },
                required: ['selector', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_wait_for',
            description: 'Wait for a DOM element to reach a specific state.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector to wait for' },
                    state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'], default: 'visible' },
                    timeout_ms: { type: 'number', description: 'Max wait time in ms.' },
                },
                required: ['selector', 'timeout_ms'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_get_text',
            description: 'Read text content from an element or the entire page.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector. Omit for full page text.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_evaluate',
            description: 'Execute JavaScript in the page context. Returns JSON-stringified result.',
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
            name: 'inspect_page',
            description: 'Navigate to a URL and return a structural summary: visible text, interactive elements (buttons, links, inputs) with their CSS selectors, container elements with classes, and loading state. Use this to discover page structure before writing targeted checks.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to inspect' },
                    wait_until: { type: 'string', enum: ['networkidle', 'load', 'domcontentloaded'], default: 'networkidle' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'report_result',
            description: 'Submit your test result. Call this when you have determined pass or fail.',
            parameters: {
                type: 'object',
                properties: {
                    passed: { type: 'boolean', description: 'Whether the test passed' },
                    result: { type: 'string', description: 'Specific description: what you tested, what happened, what you expected. Include URLs, status codes, and response data.' },
                    evidence: { type: 'string', description: 'Raw evidence (response body snippet, error message, etc.)' },
                },
                required: ['passed', 'result'],
            },
        },
    },
];

const EXECUTOR_TOOL_NAMES = new Set(EXECUTOR_TOOLS.map((t) => {
    if (t.type === 'function') return t.function.name;
    return '';
}).filter(Boolean));

// ── TestExecutor class ────────────────────────────────────────────────────────

export class TestExecutor extends BaseAgent {
    #sandbox: SandboxHandle | undefined;
    #browserSession: QaBrowserSession | null;
    #resultSubmitted = false;
    #pendingResult: TestResult | null = null;

    constructor(
        agentId: string,
        traceId: string,
        parentAgentId: string,
        browserSession: QaBrowserSession | null,
    ) {
        super(agentId, traceId, parentAgentId);
        this.#browserSession = browserSession;
    }

    async run(
        testDescription: string,
        sandbox: SandboxHandle | undefined,
        ports: { backend?: number; web?: number },
    ): Promise<TestResult> {
        this.#sandbox = sandbox;
        this.#resultSubmitted = false;
        this.#pendingResult = null;

        this.spawn('test-executor');

        const portInfo = [
            ports.backend !== undefined ? `Backend: http://localhost:${ports.backend.toString()}` : null,
            ports.web !== undefined ? `Frontend: http://localhost:${ports.web.toString()}` : null,
        ].filter(Boolean).join('\n');

        const systemPrompt = `You are a test executor. Verify one specific claim, then call report_result.

CLAIM TO VERIFY:
${testDescription}

AVAILABLE SERVICES:
${portInfo || 'No services specified.'}
${sandbox !== undefined ? `CLI commands run inside a Docker sandbox at ${sandbox.workDir}.` : ''}

When something fails, think about WHY before retrying. Adapt your approach based on what you observe — if an operation is slow, consider what it's doing under the hood and adjust timeouts accordingly. If a response looks different than expected, check whether the implementation is valid but structured differently than you assumed.

Always call report_result when done.`;

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Execute this test now.' },
        ];

        let pendingScreenshotB64: string | null = null;

        try {
            for (let turn = 0; turn < MAX_EXECUTOR_TURNS; turn++) {
                const completion = await generateWithRawTools(messages, EXECUTOR_TOOLS, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                messages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    // LLM stopped without calling report_result — try to parse from text
                    if (!this.#resultSubmitted) {
                        const text = extractTextContent(completion).trim();
                        this.#pendingResult = this.#inferResult(text);
                        this.#resultSubmitted = true;
                    }
                    break;
                }

                const toolResults: Array<{ callId: string; result: string; isScreenshot: boolean }> = [];

                for (const call of choice.message.tool_calls ?? []) {
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchTool(fnCall.function.name, args);
                    const isScreenshot = fnCall.function.name === 'browser_screenshot'
                        && !result.startsWith('[BROWSER_ERROR]');

                    if (isScreenshot) pendingScreenshotB64 = result;

                    toolResults.push({ callId: call.id, result, isScreenshot });
                }

                for (const tr of toolResults) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: tr.callId,
                        content: tr.isScreenshot
                            ? '[Screenshot captured — image provided in next message for visual analysis]'
                            : tr.result,
                    });
                }

                // Inject screenshot as vision message
                if (pendingScreenshotB64 !== null) {
                    const b64 = pendingScreenshotB64;
                    pendingScreenshotB64 = null;
                    messages.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Here is the browser screenshot. Analyze it and continue your test.' },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } },
                        ],
                    });
                }

                if (this.#resultSubmitted) break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] Test executor error: `, err);
            this.#pendingResult = { passed: false, result: `Executor error: ${msg}` };
        }

        const result = this.#pendingResult ?? { passed: false, result: 'Test executor did not produce a result.' };

        this.terminate('test_complete');
        return result;
    }

    // ── Tool dispatch ─────────────────────────────────────────────────────────

    async #dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (!EXECUTOR_TOOL_NAMES.has(name)) {
            return `Tool '${name}' is not authorized.`;
        }

        // report_result — store result and signal completion
        if (name === 'report_result') {
            this.#resultSubmitted = true;
            const passed = args['passed'] === true;
            const result = typeof args['result'] === 'string' ? args['result'] : '';
            const evidence = typeof args['evidence'] === 'string' ? args['evidence'] : undefined;
            this.#pendingResult = evidence !== undefined
                ? { passed, result, evidence }
                : { passed, result };
            this.emit('TOOL_USED', { toolName: name, input: { passed }, phase: 'qa' });
            return JSON.stringify({ accepted: true, passed });
        }

        // Browser tools
        if (name.startsWith('browser_') || name === 'inspect_page') {
            return this.#dispatchBrowserTool(name, args);
        }

        // Sandbox-aware execution tools
        if (this.#sandbox !== undefined) {
            if (name === 'execute_cli_command') {
                const command = String(args['command'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 60_000;
                const dockerCmd = `docker exec ${this.#sandbox.containerName} sh -c ${JSON.stringify(command)}`;
                this.emit('TOOL_USED', { toolName: name, input: { command: dockerCmd }, phase: 'qa' });
                const result = await executeTool('execute_cli_command', { command: dockerCmd, timeout_ms: timeout });
                this.#emitToolResult(name, result);
                return result;
            }

            if (name === 'http_get') {
                const url = String(args['url'] ?? '');
                const knownPorts = Object.keys(this.#sandbox.portMap).map(Number);
                try {
                    const parsed = new URL(url);
                    const port = parseInt(parsed.port, 10);
                    if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && !knownPorts.includes(port)) {
                        const blockedMsg = `[BLOCKED] Port ${port.toString()} is not a sandbox port. Available: ${knownPorts.join(', ')}`;
                        this.#emitToolResult(name, blockedMsg);
                        return blockedMsg;
                    }
                } catch {
                    // Malformed URL — let executeTool handle
                }

                this.emit('TOOL_USED', { toolName: name, input: args, phase: 'qa' });

                // Retry on connection refused — dev server may be restarting
                let lastResult = '';
                for (let retry = 0; retry < 3; retry++) {
                    lastResult = await executeTool(name, args);
                    const isConnectionError = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|socket hang up/i.test(lastResult);
                    if (!isConnectionError) {
                        this.#emitToolResult(name, lastResult);
                        return lastResult;
                    }
                    logger.warn(`[${this.agentId}] ${name} to ${url} failed (attempt ${(retry + 1).toString()}/3): connection error — retrying in 3s`);
                    if (retry < 2) await sleep(3_000);
                }
                this.#emitToolResult(name, lastResult);
                return lastResult;
            }
        }

        // Non-sandbox fallback
        this.emit('TOOL_USED', { toolName: name, input: args, phase: 'qa' });
        const result = await executeTool(name, args);
        this.#emitToolResult(name, result);
        return result;
    }

    // ── Browser tool dispatch ─────────────────────────────────────────────────

    async #dispatchBrowserTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (this.#browserSession === null) {
            return '[BROWSER_ERROR] Browser session not available.';
        }

        const session = this.#browserSession;

        switch (name) {
            case 'inspect_page': {
                const url = String(args['url'] ?? '');
                const waitUntil = (args['wait_until'] as 'load' | 'networkidle' | 'domcontentloaded') ?? 'networkidle';
                this.emit('TOOL_USED', { toolName: name, input: { url }, phase: 'qa' });
                const result = await session.inspectPage(url, waitUntil);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_navigate': {
                const url = String(args['url'] ?? '');
                const waitUntil = (args['wait_until'] as 'load' | 'networkidle' | 'domcontentloaded') ?? 'networkidle';
                this.emit('TOOL_USED', { toolName: name, input: { url, waitUntil }, phase: 'qa' });
                const result = await session.navigate(url, waitUntil);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_screenshot': {
                const fullPage = args['full_page'] !== false;
                this.emit('TOOL_USED', { toolName: name, input: { fullPage }, phase: 'qa' });
                const result = await session.screenshot(fullPage);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_click': {
                const selector = String(args['selector'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : undefined;
                this.emit('TOOL_USED', { toolName: name, input: { selector }, phase: 'qa' });
                const result = await session.click(selector, timeout);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_fill': {
                const selector = String(args['selector'] ?? '');
                const value = String(args['value'] ?? '');
                this.emit('TOOL_USED', { toolName: name, input: { selector, value: value.slice(0, 100) }, phase: 'qa' });
                const result = await session.fill(selector, value);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_wait_for': {
                const selector = String(args['selector'] ?? '');
                const state = (args['state'] as 'visible' | 'hidden' | 'attached' | 'detached') ?? 'visible';
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : undefined;
                this.emit('TOOL_USED', { toolName: name, input: { selector, state }, phase: 'qa' });
                const result = await session.waitFor(selector, state, timeout);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_get_text': {
                const selector = typeof args['selector'] === 'string' ? args['selector'] : undefined;
                this.emit('TOOL_USED', { toolName: name, input: { selector: selector ?? '(full page)' }, phase: 'qa' });
                const result = await session.getText(selector);
                this.#emitToolResult(name, result);
                return result;
            }
            case 'browser_evaluate': {
                const expression = String(args['expression'] ?? '');
                this.emit('TOOL_USED', { toolName: name, input: { expression: expression.slice(0, 120) }, phase: 'qa' });
                const result = await session.evaluate(expression);
                this.#emitToolResult(name, result);
                return result;
            }
            default:
                return `[BROWSER_ERROR] Unknown browser tool: ${name}`;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    #emitToolResult(toolName: string, result: string): void {
        const isScreenshot = toolName === 'browser_screenshot'
            && result.length > 1000 && !result.startsWith('[');

        let isError = false;
        if (!isScreenshot) {
            const httpMatch = /^HTTP\s+(\d{3})\b/.exec(result);
            if (httpMatch) {
                const code = parseInt(httpMatch[1] ?? '0', 10);
                isError = code >= 400;
            } else {
                isError = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|BLOCKED|refused|connection refused/i.test(result.slice(0, 200));
            }
        }

        this.emit('TOOL_USED', {
            source: 'qa:tool_result',
            toolName,
            output: isScreenshot ? '[screenshot]' : result.slice(0, 4000),
            status: isError ? 'error' : 'ok',
            phase: 'qa',
        });
    }

    #inferResult(text: string): TestResult {
        const lower = text.toLowerCase();
        const hasFail = ['fail', 'error', 'issue', 'broke', 'missing', 'refused', '404', '500'].some((s) => lower.includes(s));
        const hasPass = ['pass', 'success', 'verified', 'confirmed', 'correct'].some((s) => lower.includes(s));
        const passed = hasPass && !hasFail;
        return { passed, result: text.slice(0, 500) };
    }
}
