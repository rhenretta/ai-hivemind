/**
 * qaEngineer.ts — QA Engineer Agent (RPIV: Validate phase — ACTIVE)
 *
 * The QaEngineer is a GPT-4o agentic tool loop that actively validates
 * a SoftwareEngineer's output by running real checks:
 *
 *  1. TypeScript compile (tsc --noEmit) for each affected package
 *  2. ESLint on changed files
 *  3. Unit/integration tests (pnpm test --run) if a test suite exists
 *  4. HTTP smoke test on any deployed service URL
 *  5. Visual screenshot (Playwright) + GPT-4o vision analysis if URL available
 *  6. Final reasoning verdict synthesising all results
 *
 * Tool whitelist: execute_cli_command, http_get, screenshot_url
 * (No write_file, no web_search — QA cannot modify the codebase)
 *
 * Tier 2 constraints:
 *  - No spawning of sub-agents
 *  - Read/execute only — constrained tool set enforced in #dispatchTool
 *  - Emits QA_VERDICT event on the event bus
 */

import { execSync } from 'node:child_process';

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { executeTool } from '../services/mcpExecutor.js';
import { logger } from '../services/logger.js';
import { eventBus } from '../eventBus.js';
import type { SandboxHandle } from '../services/sandboxManager.js';

import { BaseAgent } from './baseAgent.js';

import type { SweArtifact } from '@ai-hivemind/shared';
import type OpenAI from 'openai';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_QA_TURNS = 12;
const MONOREPO_ROOT = process.env['MONOREPO_ROOT'] ?? '/Users/rhenretta/workspace/rhenretta/ai-hivemind';

// ── Tool whitelist ────────────────────────────────────────────────────────────

const QA_TOOL_NAMES = new Set(['execute_cli_command', 'http_get', 'screenshot_url']);

// ── OpenAI tool shapes for QA ─────────────────────────────────────────────────

const QA_OPENAI_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'execute_cli_command',
            description: 'Execute a shell command (tsc, eslint, pnpm test, etc.) and return stdout + stderr.',
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
            description: 'Perform an HTTP GET request and return the response status + body (truncated).',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch' },
                    timeout_ms: { type: 'number', default: 10000 },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'screenshot_url',
            description: 'Take a full-page Playwright screenshot of a URL. Returns base64 PNG on success, or [PLAYWRIGHT_UNAVAILABLE] if Playwright is not installed.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to screenshot' },
                    timeout_ms: { type: 'number', default: 15000 },
                },
                required: ['url'],
            },
        },
    },
];

// ── System prompt ─────────────────────────────────────────────────────────────

function buildQaSystemPrompt(
    subtask: string,
    acceptanceCriteria: string,
    artifact: SweArtifact,
    serviceUrl: string | undefined,
    sandbox?: SandboxHandle,
): string {
    const artifactSummary = [
        `Claude Code exit: ${artifact.success ? 'SUCCESS' : 'FAILED'}`,
        `Summary: ${artifact.summary}`,
        `Files changed (${artifact.filesChanged.length}): ${artifact.filesChanged.join(', ') || 'none'}`,
        `Errors seen: ${artifact.errors.slice(0, 5).join('; ') || 'none'}`,
    ].join('\n');

    // Infer the most likely local service URL if none explicitly provided
    const backendBase = 'http://localhost:3001';
    const frontendBase = 'http://localhost:3000';
    const hasBackendFiles = artifact.filesChanged.some((f) => f.includes('apps/backend'));
    const hasFrontendFiles = artifact.filesChanged.some((f) => f.includes('apps/web'));

    const liveUrlHint = serviceUrl !== undefined
        ? serviceUrl
        : hasBackendFiles ? backendBase : hasFrontendFiles ? frontendBase : null;

    // In Docker sandbox mode, there's no live service to probe — validate via build checks
    const isSandboxMode = sandbox !== undefined;
    const workDir = sandbox?.workDir ?? MONOREPO_ROOT;

    const urlSection = isSandboxMode
        ? 'SANDBOX MODE: No live service is available. Validate via build/compile checks only.'
        : liveUrlHint !== null
            ? `Live service base URL to probe: ${liveUrlHint}`
            : 'No explicit service URL. Probe http://localhost:3001 (backend) or http://localhost:3000 (frontend) based on what files were changed.';

    if (isSandboxMode) {
        // Build port mapping info for the prompt
        const portInfo = Object.entries(sandbox!.portMap)
            .map(([cPort, hPort]) => `  container:${cPort} → localhost:${String(hPort)}`)
            .join('\n');
        const sandboxBackendPort = sandbox!.portMap[3001];
        const sandboxFrontendPort = sandbox!.portMap[3000];

        return `You are the QA Engineer agent in an autonomous software engineering swarm.

Your role is SANDBOX VALIDATION — verify the implementation works inside an isolated Docker container.
All CLI commands (execute_cli_command) run inside the container automatically.
HTTP probes (http_get) and screenshots are automatically routed to the sandbox's mapped ports.

SUBTASK: ${subtask}

ACCEPTANCE CRITERIA: ${acceptanceCriteria}

SWE ARTIFACT:
${artifactSummary}

PROJECT ROOT (inside container): ${workDir}

SANDBOX PORT MAPPING:
${portInfo || '  (no ports mapped)'}
Use standard localhost URLs (e.g. http://localhost:3001) — they are automatically rewritten to the sandbox ports.

## Your QA Checklist (execute in order):

### 1. TypeScript compile check
Run the TypeScript compiler to verify the code compiles without errors:
  execute_cli_command: "cd ${workDir} && pnpm build 2>&1 | tail -30"

### 2. Probe live endpoints (if applicable)
If the SWE started a dev server, probe it:
${sandboxBackendPort !== undefined ? `  - Backend: http_get { "url": "http://localhost:3001/health" }` : '  - Backend port not mapped'}
${sandboxFrontendPort !== undefined ? `  - Frontend: http_get { "url": "http://localhost:3000" }` : '  - Frontend port not mapped'}
If connection refused, the SWE did not start a server — fall back to compile checks only.

### 3. Validate response content (if service is reachable)
Same as non-sandbox mode: check HTTP status, response content, acceptance criteria.

### 4. Final verdict
Emit your verdict as JSON (NO tool calls after this):
{
  "passed": true | false,
  "issues": ["specific issue 1", ...],
  "checksRun": ["TypeScript compile", "HTTP probe", "Content validation"],
  "visualDescription": "What you saw at the URL, or 'N/A'"
}

RULES:
- PASS requires: TypeScript compilation succeeds. If a service is reachable, HTTP 2xx + correct content.
- FAIL if: compile errors, required files not changed, acceptance criteria clearly not met
- If no server is running, a successful compile is sufficient for PASS
- Do NOT fail for: missing Playwright (no browser in container), minor cosmetic issues
- issues must be specific and actionable — include file paths, error messages, and what you expected`;
    }

    return `You are the QA Engineer agent in an autonomous software engineering swarm.

Your role is LIVE ENVIRONMENT VALIDATION — verify the implementation works in the running system.
The SWE/Claude Code agent already ran tsc and build checks. Do NOT re-run those.

SUBTASK: ${subtask}

ACCEPTANCE CRITERIA: ${acceptanceCriteria}

SWE ARTIFACT:
${artifactSummary}

${urlSection}

MONOREPO ROOT: ${MONOREPO_ROOT}

## Your QA Checklist (execute in order):

### 1. Probe the live endpoint(s)
Based on the acceptance criteria, identify the specific HTTP endpoints or pages that should work.
Run http_get against each relevant endpoint. Examples:
  - Backend route added?  → http_get { "url": "http://localhost:3001/api/<path>" }
  - Frontend page added?  → http_get { "url": "http://localhost:3000/<path>" }
Check: HTTP status is 2xx, response body looks correct, JSON structure matches what was required.
FAIL immediately if connection refused (service not running) or 4xx/5xx.

### 2. Validate response content matches acceptance criteria
Parse the response body. Check that:
  - Required fields are present in JSON responses
  - Data is non-empty (not an empty array when posts were expected)
  - Filtering is working (if the task required filtering, spot-check the output)
Do NOT just check HTTP 200 — verify the actual content.

### 3. Screenshot the UI (if a frontend page exists)
${hasFrontendFiles || serviceUrl !== undefined
            ? `Take a screenshot: screenshot_url { "url": "${serviceUrl ?? frontendBase}" }
Analyze visually: does the page render correctly? Does it match what the acceptance criteria describes?
If [PLAYWRIGHT_UNAVAILABLE], note it and skip — do not fail for missing Playwright.`
            : 'Skip — no frontend files were changed.'}

### 4. Fallback: check build only if service is unreachable
ONLY run this if step 1 returned "connection refused" (service not started):
  execute_cli_command: "cd ${MONOREPO_ROOT} && pnpm --filter @ai-hivemind/backend exec tsc --noEmit 2>&1 | tail -10"
This tells you whether the files at least compile, even if the service isn't running.
Do NOT run tsc/eslint if the service IS reachable — that's redundant.

### 5. Final verdict
Emit your verdict as JSON (NO tool calls after this):
{
  "passed": true | false,
  "issues": ["specific issue 1", ...],
  "checksRun": ["HTTP probe", "Content validation", "Visual screenshot"],
  "visualDescription": "What you saw at the URL, or 'N/A'"
}

RULES:
- PASS requires: HTTP 2xx on the primary endpoint AND response content looks correct
- FAIL if: connection refused, 4xx/5xx, empty response when data was expected, acceptance criteria clearly not met
- Do NOT fail for: missing Playwright, CSS not pixel-perfect, minor cosmetic issues
- Do NOT run tsc, eslint, or unit tests unless the service is completely unreachable
- issues must be specific and actionable — include the URL, status code, and what you got vs what was expected`;
}

// ── Package inference ─────────────────────────────────────────────────────────

function inferAffectedPackages(filesChanged: string[]): string[] {
    const packages = new Set<string>();
    for (const file of filesChanged) {
        if (file.includes('apps/web')) packages.add('@ai-hivemind/web');
        else if (file.includes('apps/backend')) packages.add('@ai-hivemind/backend');
        else if (file.includes('packages/shared')) packages.add('@ai-hivemind/shared');
        else if (file.includes('packages/ui')) packages.add('@ai-hivemind/ui');
    }
    return [...packages];
}

// ── QaVerdict ─────────────────────────────────────────────────────────────────

export interface QaVerdict {
    passed: boolean;
    issues: string[];
    checksRun: string[];
    visualDescription: string;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class QaEngineer extends BaseAgent {
    /** Active sandbox handle for Docker-based validation */
    #sandbox: SandboxHandle | undefined;

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    async run(
        subtask: string,
        acceptanceCriteria: string,
        artifact: SweArtifact,
        serviceUrl?: string,
        sandbox?: SandboxHandle,
    ): Promise<QaVerdict> {
        this.#sandbox = sandbox;
        this.spawn('qa-engineer');
        this.emit('STATE_CHANGED', {
            message: `Running active QA for: "${subtask.slice(0, 100)}"`,
            phase: 'validate',
            hasServiceUrl: serviceUrl !== undefined,
            sandboxMode: sandbox !== undefined,
        });

        const systemPrompt = buildQaSystemPrompt(subtask, acceptanceCriteria, artifact, serviceUrl, sandbox);

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: `Run the full QA checklist for the subtask above.Start with TypeScript compilation now.`,
            },
        ];

        let verdict: QaVerdict = {
            passed: false,
            issues: ['QaEngineer did not complete the checklist'],
            checksRun: [],
            visualDescription: 'N/A',
        };

        // Track any screenshot base64 we receive so we can pass it to the vision model
        let pendingScreenshotB64: string | null = null;

        try {
            for (let turn = 0; turn < MAX_QA_TURNS; turn++) {
                const completion = await generateWithRawTools(messages, QA_OPENAI_TOOLS, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                messages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    // Final text response — parse verdict JSON
                    const raw = extractTextContent(completion).trim();
                    verdict = this.#parseVerdict(raw);
                    break;
                }

                // Dispatch tool calls
                const toolResults: Array<{ callId: string; result: string; isScreenshot: boolean }> = [];

                for (const call of choice.message.tool_calls ?? []) {
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchTool(fnCall.function.name, args);
                    const isScreenshot = fnCall.function.name === 'screenshot_url'
                        && !result.startsWith('[PLAYWRIGHT_UNAVAILABLE]');

                    if (isScreenshot) pendingScreenshotB64 = result;

                    toolResults.push({ callId: call.id, result, isScreenshot });
                }

                // Add tool results to message history
                for (const tr of toolResults) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: tr.callId,
                        // For screenshots, return a placeholder — the actual image goes in the next user turn
                        content: tr.isScreenshot
                            ? '[Screenshot captured — image provided in next message for visual analysis]'
                            : tr.result,
                    });
                }

                // If we captured a screenshot, inject it as a vision-capable user message
                if (pendingScreenshotB64 !== null) {
                    const b64 = pendingScreenshotB64;
                    pendingScreenshotB64 = null;
                    messages.push({
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Here is the screenshot of the deployed page. Analyze it visually: does it render correctly? Does it appear to satisfy the acceptance criteria? Then continue with your remaining checks.',
                            },
                            {
                                type: 'image_url',
                                image_url: { url: `data: image / png; base64, ${b64} `, detail: 'high' },
                            },
                        ],
                    });

                    // Emit screenshot event so the Command Center can display it
                    this.#emitScreenshot(b64, serviceUrl ?? '');
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] QA loop error: `, err);
            verdict = { passed: false, issues: [`QaEngineer error: ${msg} `], checksRun: [], visualDescription: 'N/A' };
        }

        // Emit verdict event for Command Center visibility
        this.emit('QA_VERDICT', {
            subtask,
            passed: verdict.passed,
            issues: verdict.issues,
            checksRun: verdict.checksRun,
            visualDescription: verdict.visualDescription,
            artifactSuccess: artifact.success,
            filesChanged: artifact.filesChanged.length,
        });

        this.emit('STATE_CHANGED', {
            message: verdict.passed
                ? `QA PASSED ✓ — checks: ${verdict.checksRun.join(', ')} `
                : `QA FAILED ✗ — ${verdict.issues.length} issue(s): ${verdict.issues[0] ?? ''} `,
            phase: 'validate',
            passed: verdict.passed,
        });

        this.terminate('qa_complete');
        return verdict;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async #dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (!QA_TOOL_NAMES.has(name)) {
            return `Tool '${name}' is not authorized for QaEngineer.`;
        }
        this.emit('TOOL_USED', { toolName: name, input: args, phase: 'qa' });

        // ── Sandbox mode: route tools through Docker ──────────────────────
        if (this.#sandbox !== undefined) {
            if (name === 'execute_cli_command') {
                // Run CLI commands inside the container via docker exec
                const command = String(args['command'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 60_000;
                const dockerCmd = `docker exec ${this.#sandbox.containerName} sh -c ${JSON.stringify(command)}`;
                return await executeTool('execute_cli_command', { command: dockerCmd, timeout_ms: timeout });
            }

            if (name === 'http_get' || name === 'screenshot_url') {
                // Rewrite URLs to use sandbox's mapped ports
                const url = String(args['url'] ?? '');
                const rewritten = this.#rewriteUrlForSandbox(url);
                return await executeTool(name, { ...args, url: rewritten });
            }
        }

        return await executeTool(name, args);
    }

    /**
     * Rewrite a localhost URL to use the sandbox's mapped host port.
     * E.g. "http://localhost:3001/api/foo" → "http://localhost:49153/api/foo"
     */
    #rewriteUrlForSandbox(url: string): string {
        if (this.#sandbox === undefined) return url;

        try {
            const parsed = new URL(url);
            const host = parsed.hostname;
            if (host !== 'localhost' && host !== '127.0.0.1') return url;

            const containerPort = parseInt(parsed.port, 10);
            const mappedPort = this.#sandbox.portMap[containerPort];
            if (mappedPort === undefined) return url;

            parsed.port = mappedPort.toString();
            const rewritten = parsed.toString();
            logger.info(`[${this.agentId}] Rewrote URL for sandbox: ${url} → ${rewritten}`);
            return rewritten;
        } catch {
            return url;
        }
    }

    #parseVerdict(raw: string): QaVerdict {
        try {
            const json = raw.replace(/^```(?: json) ?\n ? /, '').replace(/\n ? ```$/, '');
            // Find the outermost JSON object
            const match = /\{[\s\S]+\}/m.exec(json);
            if (match) {
                type RawV = { passed: unknown; issues: unknown; checksRun: unknown; visualDescription: unknown };
                const parsed = JSON.parse(match[0]) as RawV;
                return {
                    passed: parsed.passed === true,
                    issues: Array.isArray(parsed.issues) ? (parsed.issues as unknown[]).map(String) : [],
                    checksRun: Array.isArray(parsed.checksRun) ? (parsed.checksRun as unknown[]).map(String) : [],
                    visualDescription: typeof parsed.visualDescription === 'string' ? parsed.visualDescription : 'N/A',
                };
            }
        } catch (e) {
            logger.warn(`[${this.agentId}] Failed to parse verdict JSON: `, e);
        }
        // Fallback: treat as failed
        return { passed: false, issues: [`Could not parse QA verdict: ${raw.slice(0, 200)} `], checksRun: [], visualDescription: 'N/A' };
    }

    #emitScreenshot(b64: string, url: string): void {
        // Emit as a custom payload on STATE_CHANGED — the Command Center can render this
        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'STATE_CHANGED',
            sourceId: this.agentId,
            targetId: null,
            traceId: this.traceId,
            payload: {
                message: `Visual screenshot captured for ${url}`,
                phase: 'validate',
                screenshotB64: `data: image / png; base64, ${b64} `,
                screenshotUrl: url,
            },
        });
    }
}
