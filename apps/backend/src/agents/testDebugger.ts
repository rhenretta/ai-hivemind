/**
 * testDebugger.ts — Test Debugger Agent
 *
 * Activated when a TestExecutor reports a failure. Investigates whether the
 * failure is a real code bug or a test infrastructure issue (wrong URL,
 * timeout too short, server not ready). Can fix the test and re-run it.
 *
 * Tools: check_server_health, check_server_logs, discover_endpoints,
 *        probe_endpoint, rerun_test, report_verdict
 */

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { executeTool } from '../services/mcpExecutor.js';
import { logger } from '../services/logger.js';
import { BaseAgent } from './baseAgent.js';
import { TestExecutor, type TestResult } from './testExecutor.js';

import type { QaBrowserSession } from '../services/qaBrowser.js';
import type { SandboxHandle } from '../services/sandboxManager.js';
import type OpenAI from 'openai';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_DEBUGGER_TURNS = 10;

// ── Result types ──────────────────────────────────────────────────────────────

export interface DebugResult {
    verdict: 'code_bug' | 'test_fixed';
    /** When 'code_bug': original failure stands */
    originalResult?: TestResult;
    /** When 'test_fixed': corrected test description */
    correctedDescription?: string;
    /** When 'test_fixed': result from re-run with corrected test */
    retestResult?: TestResult;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const DEBUGGER_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'check_server_health',
            description: 'Check if the backend server is running and healthy by probing its health endpoint.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_server_logs',
            description: 'Read recent server logs (stderr/stdout) from the sandbox dev servers. Look for crash messages, uncaught exceptions, or startup errors.',
            parameters: {
                type: 'object',
                properties: {
                    lines: { type: 'number', description: 'Number of recent lines to read (default 50)', default: 50 },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'discover_endpoints',
            description: 'Search the backend source code for registered API endpoints (app.get, app.post, router.get, etc.) to find the actual endpoint paths the SWE created.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'probe_endpoint',
            description: 'Send an HTTP request to an endpoint with a configurable timeout (up to 120s). Use this to test if a slow endpoint works when given more time.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full URL to probe' },
                    method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method (default GET)', default: 'GET' },
                    timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000, max 120000)', default: 60000 },
                    body: { type: 'string', description: 'Optional JSON request body (for POST)' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rerun_test',
            description: 'Rerun the test with a corrected description. Use this after you have identified that the original test was wrong (bad URL, wrong method, timeout too short) and you know the correct way to test.',
            parameters: {
                type: 'object',
                properties: {
                    corrected_description: {
                        type: 'string',
                        description: 'The corrected test description. Must include the correct URL, method, expected status code, and expected response structure.',
                    },
                },
                required: ['corrected_description'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'report_verdict',
            description: 'Report your diagnostic verdict. Call this when you have determined the root cause.',
            parameters: {
                type: 'object',
                properties: {
                    verdict: {
                        type: 'string',
                        enum: ['code_bug', 'test_fixed'],
                        description: '"code_bug" = the SWE code is genuinely broken. "test_fixed" = the test was wrong and has been corrected via rerun_test.',
                    },
                    explanation: { type: 'string', description: 'Brief explanation of what you found.' },
                },
                required: ['verdict', 'explanation'],
            },
        },
    },
];

const DEBUGGER_TOOL_NAMES = new Set(DEBUGGER_TOOLS.map((t) => t.type === 'function' ? t.function.name : ''));

// ── TestDebugger class ────────────────────────────────────────────────────────

export class TestDebugger extends BaseAgent {
    #sandbox: SandboxHandle | undefined;
    #browserSession: QaBrowserSession | null;
    #ports: { backend?: number; web?: number } = {};
    #pendingVerdict: DebugResult | null = null;
    #verdictSubmitted = false;
    #retestResult: TestResult | null = null;
    #correctedDescription: string | null = null;

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
        originalDescription: string,
        failureResult: TestResult,
        sandbox: SandboxHandle | undefined,
        ports: { backend?: number; web?: number },
        artifactSummary: string,
    ): Promise<DebugResult> {
        this.#sandbox = sandbox;
        this.#ports = ports;
        this.#verdictSubmitted = false;
        this.#pendingVerdict = null;
        this.#retestResult = null;
        this.#correctedDescription = null;

        this.spawn('test-debugger');

        const portInfo = [
            ports.backend !== undefined ? `Backend: http://localhost:${ports.backend.toString()}` : null,
            ports.web !== undefined ? `Frontend: http://localhost:${ports.web.toString()}` : null,
        ].filter(Boolean).join('\n');

        const systemPrompt = `You are a test debugger. A test failed. Your job: figure out if the CODE is broken or the TEST was wrong.

ORIGINAL TEST: ${originalDescription}

FAILURE: ${failureResult.result}
${failureResult.evidence ? `EVIDENCE: ${failureResult.evidence}` : ''}

WHAT WAS BUILT: ${artifactSummary}

SERVICES: ${portInfo || 'None specified.'}

Read the failure carefully. Form a hypothesis about the root cause. Use your tools to confirm or reject it. Think about whether the failure is in the code being tested or in the test's own assumptions (wrong URL, wrong timeout, wrong expected behavior).

Compare what the test expected against what was actually built. They may not match — the SWE may have implemented the feature differently than the test assumed.

You MUST call report_verdict when done:
- 'test_fixed' if you used rerun_test to correct and re-run the test
- 'code_bug' if the code is genuinely broken`;

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Diagnose this test failure now.' },
        ];

        try {
            for (let turn = 0; turn < MAX_DEBUGGER_TURNS; turn++) {
                const completion = await generateWithRawTools(messages, DEBUGGER_TOOLS, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                messages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    // LLM stopped without verdict — default to code_bug
                    if (!this.#verdictSubmitted) {
                        const text = extractTextContent(completion).trim();
                        logger.warn(`[${this.agentId}] No verdict submitted, defaulting to code_bug: ${text.slice(0, 200)}`);
                        this.#pendingVerdict = { verdict: 'code_bug', originalResult: failureResult };
                    }
                    break;
                }

                for (const call of choice.message.tool_calls ?? []) {
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchTool(fnCall.function.name, args, failureResult);
                    messages.push({ role: 'tool', tool_call_id: call.id, content: result });
                }

                if (this.#verdictSubmitted) break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] Debugger error: ${msg}`);
        }

        const result = this.#pendingVerdict ?? { verdict: 'code_bug' as const, originalResult: failureResult };
        this.terminate('debug_complete');
        return result;
    }

    // ── Tool dispatch ─────────────────────────────────────────────────────────

    async #dispatchTool(name: string, args: Record<string, unknown>, originalFailure: TestResult): Promise<string> {
        if (!DEBUGGER_TOOL_NAMES.has(name)) {
            return `Tool '${name}' is not authorized.`;
        }

        this.emit('TOOL_USED', { toolName: name, input: args, phase: 'qa-debug' });

        if (name === 'check_server_health') {
            return this.#checkServerHealth();
        }

        if (name === 'check_server_logs') {
            const lines = typeof args['lines'] === 'number' ? args['lines'] : 50;
            return this.#checkServerLogs(lines);
        }

        if (name === 'discover_endpoints') {
            return this.#discoverEndpoints();
        }

        if (name === 'probe_endpoint') {
            return this.#probeEndpoint(args);
        }

        if (name === 'rerun_test') {
            const corrected = typeof args['corrected_description'] === 'string' ? args['corrected_description'] : '';
            if (corrected === '') return 'Error: corrected_description is required.';
            return this.#rerunTest(corrected);
        }

        if (name === 'report_verdict') {
            return this.#reportVerdict(args, originalFailure);
        }

        return `Unknown tool: ${name}`;
    }

    // ── Tool implementations ──────────────────────────────────────────────────

    async #checkServerHealth(): Promise<string> {
        const port = this.#ports.backend;
        if (port === undefined) return 'No backend port configured.';

        try {
            const result = await executeTool('http_get', {
                url: `http://localhost:${port.toString()}/health`,
                timeout_ms: 5000,
            });
            return result;
        } catch (err) {
            return `Health check failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    async #checkServerLogs(lines: number): Promise<string> {
        if (this.#sandbox === undefined) return 'No sandbox available.';

        try {
            const cmd = `docker logs --tail ${lines.toString()} ${this.#sandbox.containerName} 2>&1`;
            const result = await executeTool('execute_cli_command', { command: cmd, timeout_ms: 10000 });
            // Truncate if too long
            return result.length > 4000 ? `${result.slice(-4000)}\n[...truncated to last 4000 chars]` : result;
        } catch (err) {
            return `Failed to read logs: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    async #discoverEndpoints(): Promise<string> {
        if (this.#sandbox === undefined) return 'No sandbox available.';

        try {
            const cmd = `docker exec ${this.#sandbox.containerName} grep -rn "app\\.get\\|app\\.post\\|app\\.put\\|app\\.delete\\|app\\.patch\\|router\\.get\\|router\\.post\\|router\\.put\\|router\\.delete" /workspace/apps/backend/src/ --include="*.ts" --exclude-dir=node_modules 2>/dev/null | head -50`;
            const result = await executeTool('execute_cli_command', { command: cmd, timeout_ms: 15000 });
            return result.length > 0 ? result : 'No endpoint registrations found.';
        } catch (err) {
            return `Failed to discover endpoints: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    async #probeEndpoint(args: Record<string, unknown>): Promise<string> {
        const url = typeof args['url'] === 'string' ? args['url'] : '';
        if (url === '') return 'Error: url is required.';

        const method = typeof args['method'] === 'string' ? args['method'] : 'GET';
        const timeoutMs = typeof args['timeout_ms'] === 'number' ? Math.min(args['timeout_ms'], 120_000) : 60_000;
        const body = typeof args['body'] === 'string' ? args['body'] : undefined;

        try {
            const headers: Record<string, string> = { 'User-Agent': 'ai-hivemind-test-debugger/1.0' };
            if (body !== undefined) headers['Content-Type'] = 'application/json';

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const startTime = Date.now();
            const fetchOpts: RequestInit = {
                method,
                headers,
                signal: controller.signal,
            };
            if (method === 'POST' && body !== undefined) {
                fetchOpts.body = body;
            }
            const res = await fetch(url, fetchOpts);
            const elapsed = Date.now() - startTime;
            clearTimeout(timer);

            const resBody = await res.text();
            const truncated = resBody.length > 4000 ? `${resBody.slice(0, 4000)}\n[...truncated]` : resBody;

            return `HTTP ${res.status.toString()} ${res.statusText} (${elapsed.toString()}ms)\n\n${truncated}`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('abort')) {
                return `Request timed out after ${timeoutMs.toString()}ms. The endpoint may exist but is very slow.`;
            }
            return `Request failed: ${msg}`;
        }
    }

    async #rerunTest(correctedDescription: string): Promise<string> {
        this.#correctedDescription = correctedDescription;

        const executorId = `test-executor.${uuidv4().slice(0, 8)}`;
        const executor = new TestExecutor(executorId, this.traceId, this.agentId, this.#browserSession);

        try {
            this.emit('STATE_CHANGED', {
                message: `Re-running test with corrected description`,
                phase: 'qa-debug',
            });

            const result = await executor.run(correctedDescription, this.#sandbox, this.#ports);
            this.#retestResult = result;

            return JSON.stringify({
                passed: result.passed,
                result: result.result,
                evidence: result.evidence ?? null,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Rerun failed: ${msg}`;
        }
    }

    #reportVerdict(args: Record<string, unknown>, originalFailure: TestResult): string {
        const verdict = typeof args['verdict'] === 'string' ? args['verdict'] : '';
        const explanation = typeof args['explanation'] === 'string' ? args['explanation'] : '';

        this.#verdictSubmitted = true;

        if (verdict === 'test_fixed' && this.#retestResult !== null) {
            this.#pendingVerdict = {
                verdict: 'test_fixed',
                ...(this.#correctedDescription !== null ? { correctedDescription: this.#correctedDescription } : {}),
                retestResult: this.#retestResult,
            };
            logger.info(`[${this.agentId}] Verdict: test_fixed — ${explanation}`);
        } else {
            this.#pendingVerdict = {
                verdict: 'code_bug',
                originalResult: originalFailure,
            };
            logger.info(`[${this.agentId}] Verdict: code_bug — ${explanation}`);
        }

        this.emit('STATE_CHANGED', {
            message: `Debug verdict: ${verdict} — ${explanation}`,
            phase: 'qa-debug',
            verdict,
        });

        return JSON.stringify({ accepted: true, verdict });
    }
}
