/**
 * conductor.ts — Claude Code CLI Subprocess Wrapper
 *
 * Spawns `claude -p <prompt>` with `--output-format stream-json` and piped stdout.
 * Parses Claude Code's JSONL streaming events and bridges them to the EventBus
 * for real-time visibility in the Command Center terminal.
 *
 * Key implementation details:
 *   - stdin is 'ignore' (mapped to /dev/null). When stdin is a pipe, the CLI
 *     enters interactive mode internally and blocks, never emitting output.
 *   - Environment is whitelisted to strip Claude Desktop vars that interfere.
 *   - Plugin auto-updates are disabled to avoid init hangs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SystemEvent } from '@ai-hivemind/shared';

import { eventBus } from '../eventBus.js';
import { authManager } from './authManager.js';
import { credentialStore } from './credentialStore.js';
import { execInSandbox, injectClaudeCredentials, type SandboxHandle } from './sandboxManager.js';

// ── Monorepo root ─────────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MONOREPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

// ── Dev server URL detection ──────────────────────────────────────────────────
const DEV_SERVER_RE = /https?:\/\/(localhost|127\.0\.0\.1):(\d+)/g;

// ── Per-task timeout (env-configurable) ──────────────────────────────────────
const MAX_TASK_MS = Number(process.env['MAX_CONDUCTOR_MS'] ?? 5 * 60 * 1000);

// ── Claude Code CLI binary ───────────────────────────────────────────────────
const CLAUDE_BIN = process.env['CLAUDE_CLI_BIN'] ?? 'claude';

// ── Max agentic turns per task (env-configurable) ────────────────────────────
const MAX_TURNS = Number(process.env['CLAUDE_MAX_TURNS'] ?? 50);

// ── Claude Code stream-json shapes ───────────────────────────────────────────
//
// Claude Code with `--output-format stream-json` emits JSONL where each line
// is a JSON object with a `type` discriminant. The main event types are:
//
//   system    — initialization event (session info, model, tools)
//   assistant — an assistant turn with content blocks (text, thinking, tool_use)
//   user      — tool results fed back to the model
//   result    — final result with summary, cost, and duration
//

interface ClaudeContentBlockText { type: 'text'; text: string }
interface ClaudeContentBlockThinking { type: 'thinking'; thinking: string }
interface ClaudeContentBlockToolUse { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ClaudeContentBlockToolResult { type: 'tool_result'; tool_use_id: string; content: string | unknown; is_error?: boolean }

type ClaudeContentBlock =
    | ClaudeContentBlockText
    | ClaudeContentBlockThinking
    | ClaudeContentBlockToolUse
    | ClaudeContentBlockToolResult;

interface ClaudeSystemEvent {
    type: 'system';
    subtype?: string;
    session_id?: string;
    tools?: unknown[];
    model?: string;
    [k: string]: unknown;
}

interface ClaudeAssistantEvent {
    type: 'assistant';
    message: {
        id?: string;
        role: 'assistant';
        content: ClaudeContentBlock[];
        model?: string;
        stop_reason?: string;
    };
    session_id?: string;
}

interface ClaudeUserEvent {
    type: 'user';
    message: {
        role: 'user';
        content: ClaudeContentBlock[];
    };
    session_id?: string;
}

interface ClaudeResultEvent {
    type: 'result';
    result: string;
    session_id?: string;
    cost_usd?: number;
    is_error?: boolean;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
}

type ClaudeEvent = ClaudeSystemEvent | ClaudeAssistantEvent | ClaudeUserEvent | ClaudeResultEvent;

// ── EventBus emit helper ──────────────────────────────────────────────────────
type EventPayload = Record<string, unknown>;

export class ConductorWrapper {
    readonly agentId: string;
    readonly traceId: string;

    /** Current running process */
    process_: ChildProcess | null = null;

    /** Writable stdin — kept open for USER_INTERVENTION from Command Center */
    processStdin_: import('node:stream').Writable | null = null;

    /** Streaming text buffer for delta messages */
    messageBuffer = '';
    lastThought = '';
    objective = '';

    /** Ports that have already had SERVICE_DEPLOYED emitted */
    seenPorts = new Set<number>();

    /** Whether the startup banner has been shown (suppress duplicates from multiple system events) */
    #bannerShown = false;

    /** Session ID from Claude Code — used for `--resume` on retries */
    sessionId: string | null = null;

    /** Active sandbox handle (when running in Docker isolation) */
    #sandbox: SandboxHandle | undefined;

    /** stdin bridge cleanup handle */
    unsubscribeIntervention: (() => void) | null = null;

    /**
     * Per-task promise callbacks.
     * Set by runTask(), resolved/rejected by handleLine() on result/error events.
     */
    #taskResolve: (() => void) | null = null;
    #taskReject: ((e: Error) => void) | null = null;
    #sawResult = false;

    constructor(agentId: string, traceId: string) {
        this.agentId = agentId;
        this.traceId = traceId;
    }

    /** Emit a CONDUCTOR_STREAM event for real-time text in the Command Center terminal */
    private stream(text: string, direction: 'in' | 'out', kind: 'thought' | 'message' | 'tool' | 'result' | 'input' | 'error'): void {
        if (text.trim() === '') return;
        this.emit('CONDUCTOR_STREAM', { text, direction, kind });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Run a single-turn task via a fresh Claude Code CLI process.
     * Uses `-p` for non-interactive execution.
     */
    async runTask(prompt: string, sandbox?: SandboxHandle): Promise<void> {
        this.objective = prompt;
        this.#sawResult = false;
        this.#bannerShown = false;
        this.messageBuffer = '';
        this.#sandbox = sandbox;

        return new Promise<void>((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.#taskResolve = null;
                this.#taskReject = null;
                this.process_?.kill('SIGTERM');
                reject(new Error(`Conductor task timed out after ${(MAX_TASK_MS / 1000).toFixed(0)}s`));
            }, MAX_TASK_MS);

            this.#taskResolve = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.#taskResolve = null;
                this.#taskReject = null;
                resolve();
            };

            this.#taskReject = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.#taskResolve = null;
                this.#taskReject = null;
                reject(err);
            };

            this.stream(prompt, 'in', 'input');
            this.#spawnClaude(prompt, sandbox);
        });
    }

    /**
     * Spawn Claude Code CLI in non-interactive `-p` (print) mode.
     *
     * Uses `--output-format stream-json` for JSONL streaming output.
     * The prompt is passed directly via `-p`.
     *
     * IMPORTANT: stdin must be 'ignore' (mapped to /dev/null), NOT 'pipe'.
     * When stdin is a pipe, the CLI detects it and enters interactive mode
     * internally, blocking on stdin reads before emitting the system event.
     * With stdin as /dev/null, `-p` mode works correctly and the
     * `allow_remote_control` policy does NOT block it (that policy only
     * gates the `--remote` flag and Remote Control subcommands).
     */
    #spawnClaude(prompt: string, sandbox?: SandboxHandle): void {
        // Ensure OAuth token is fresh before spawning (no-op if using API key).
        // Returns false if auth is broken and the user needs to re-login.
        const authOk = authManager.ensureFreshToken();
        if (!authOk) {
            this.emit('ERROR', {
                message: 'OAuth token expired and could not be refreshed. Please run "claude auth login" in a terminal to re-authenticate.',
                phase: 'auth',
            });
            // Still attempt to spawn — the Keychain might have been refreshed by another
            // process between our check and the spawn. The 401 detection below will catch it.
        }

        const self = this;
        const claudeArgs = [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--max-turns', MAX_TURNS.toString(),
            '--dangerously-skip-permissions',
        ];

        let proc: ChildProcess;

        if (sandbox !== undefined) {
            // ── Docker sandbox mode ──────────────────────────────────────────
            // Run Claude Code inside the isolated container. Environment and
            // working directory are already configured in the container image.
            //
            // Re-inject OAuth credentials from Keychain into the container.
            // ensureFreshToken() above may have refreshed the host Keychain,
            // but the container still has the token from when it was created.
            // On long-running tasks with retries, the original token expires.
            injectClaudeCredentials(sandbox.containerName);
            console.log(`[Conductor:${self.agentId}] Spawning Claude Code in container=${sandbox.containerName} prompt="${prompt.slice(0, 60)}"`);
            proc = execInSandbox(sandbox, CLAUDE_BIN, claudeArgs);
        } else {
            // ── Direct spawn mode (fallback, no sandbox) ─────────────────────
            console.log(`[Conductor:${self.agentId}] Spawning Claude Code directly cwd=${MONOREPO_ROOT} prompt="${prompt.slice(0, 60)}"`);

            // Build a clean env from scratch. The parent process inherits dozens
            // of Claude Desktop vars that cause the child CLI to malfunction.
            const childEnv: Record<string, string> = {};
            const KEEP = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
                'SSH_AUTH_SOCK', 'XPC_FLAGS', 'XPC_SERVICE_NAME',
                'COMMAND_MODE', 'LOGNAME', 'SHLVL', 'OLDPWD', 'PWD',
                'NODE_ENV', 'NODE_OPTIONS', 'NVM_DIR', 'NVM_BIN'];
            for (const key of KEEP) {
                if (process.env[key] !== undefined) childEnv[key] = process.env[key]!;
            }
            childEnv['DISABLE_AUTOUPDATER'] = '1';
            childEnv['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'] = '1';

            // Inject ALL user-configured service credentials (ANTHROPIC_API_KEY,
            // OPENAI_API_KEY, etc.) from the credential store. Falls back to
            // process.env for ANTHROPIC_API_KEY if not in the store.
            // Passes traceId to include session-scoped env vars.
            try {
                Object.assign(childEnv, credentialStore.getDecryptedEnvVars(this.traceId));
            } catch {
                // Non-fatal — credentials may not be configured
            }
            if (childEnv['ANTHROPIC_API_KEY'] === undefined && process.env['ANTHROPIC_API_KEY']) {
                childEnv['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
            }

            proc = spawn(CLAUDE_BIN, claudeArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: childEnv,
                cwd: MONOREPO_ROOT,
            });
        }

        self.process_ = proc;
        self.processStdin_ = null; // no stdin in -p mode
        let lineBuffer = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
            lineBuffer += chunk.toString('utf8');
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                self.handleLine(trimmed);
            }
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            if (text.trim().length > 0) {
                console.warn(`[Conductor:${self.agentId}] stderr: ${text.trim().slice(0, 200)}`);

                // Detect authentication failures and surface them clearly
                if (text.includes('authentication_error') || text.includes('Failed to authenticate') || text.includes('API Error: 401')) {
                    self.emit('ERROR', {
                        message: 'Claude Code authentication failed (401). Run "claude auth login" in a terminal to refresh your OAuth token.',
                        phase: 'auth',
                    });
                }

                // Emit server log lines to the activity feed
                for (const line of text.split('\n')) {
                    if (line.trim().length > 0) {
                        self.emit('SANDBOX_LOG', { text: line.trimEnd(), source: 'stderr' });
                    }
                }
            }
            self.detectDevServer(text);
        });

        proc.on('exit', (code: number | null) => {
            self.processStdin_ = null;
            self.process_ = null;
            if (lineBuffer.trim().length > 0) self.handleLine(lineBuffer.trim());
            if (self.messageBuffer.length > 0) self.flushMessageBuffer();
            console.log(`[Conductor:${self.agentId}] Process exited code=${String(code)}`);
            if (self.#sawResult || code === 0) {
                self.#taskResolve?.();
            } else {
                self.#taskReject?.(new Error(`Claude Code exited (code ${String(code ?? 'null')}) before emitting a result`));
            }
        });
    }

    /**
     * Ask a question about the codebase via Claude Code running in a sandbox.
     *
     * Unlike runTask/runConductorTrack (which are full SWE sessions), this is a
     * lightweight read-only query. Claude Code explores the codebase using
     * Read/Glob/Grep tools and returns a text answer. Used by DataResearcher
     * to gather codebase context during the research phase.
     *
     * - 15-minute timeout (deep architectural questions need time)
     * - --max-turns 15 (enough to explore, not enough to rewrite)
     * - Read-only constraint in the prompt wrapper
     * - Returns accumulated assistant text (not void like runTask)
     */
    async askQuestion(question: string, sandbox: SandboxHandle): Promise<string> {
        const wrappedPrompt = [
            'You are answering a question about this codebase. Use Read, Glob, and Grep tools to explore.',
            'Do NOT modify any files. Do NOT use Write, Edit, or Bash tools for writes.',
            'Do NOT use the Agent tool — answer the question yourself directly.',
            'Be concise but thorough — your answer will be fed into another LLM for planning.',
            '',
            `Question: ${question}`,
        ].join('\n');

        const ASK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — deep architectural questions need time
        const ASK_MAX_TURNS = 15;
        const MAX_ANSWER_LENGTH = 3072; // 3KB — keeps DataResearcher context manageable

        return new Promise<string>((resolve, reject) => {
            let settled = false;
            let answerText = '';
            let bannerShown = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                proc.kill('SIGTERM');
                // Return whatever we have so far rather than failing
                resolve(answerText || `Question timed out after 15 minutes: "${question}"`);
            }, ASK_TIMEOUT_MS);

            const settle = (text: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(text.length > MAX_ANSWER_LENGTH
                    ? `${text.slice(0, MAX_ANSWER_LENGTH)}\n[...truncated]`
                    : text);
            };

            // Re-inject credentials (may have been refreshed since container creation)
            injectClaudeCredentials(sandbox.containerName);

            const claudeArgs = [
                '-p', wrappedPrompt,
                '--output-format', 'stream-json',
                '--verbose',
                '--max-turns', ASK_MAX_TURNS.toString(),
                '--dangerously-skip-permissions',
                '--disallowedTools', 'Agent,Write,Edit,NotebookEdit',
            ];

            // Show the question prompt in the Terminal tab
            this.stream(`\n── ask_codebase ──────────────────────────────`, 'in', 'input');
            this.stream(question, 'in', 'input');

            console.log(`[Conductor:${this.agentId}] askQuestion in container=${sandbox.containerName} q="${question.slice(0, 60)}"`);
            const proc = execInSandbox(sandbox, CLAUDE_BIN, claudeArgs);

            let lineBuffer = '';

            proc.stdout?.on('data', (chunk: Buffer) => {
                lineBuffer += chunk.toString('utf8');
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;

                    let ev: ClaudeEvent;
                    try {
                        ev = JSON.parse(trimmed) as ClaudeEvent;
                    } catch {
                        continue; // skip non-JSON lines
                    }

                    if (ev.type === 'system') {
                        // Only show the banner once per askQuestion call
                        if (!bannerShown) {
                            bannerShown = true;
                            this.stream(`[ask_codebase] Session started (model: ${String((ev as ClaudeSystemEvent).model ?? 'Claude')})`, 'out', 'message');
                        }
                    } else if (ev.type === 'assistant') {
                        const content = ev.message?.content;
                        if (!Array.isArray(content)) continue;
                        for (const block of content) {
                            if (block.type === 'text' && block.text) {
                                answerText += block.text;
                                this.stream(block.text, 'out', 'message');
                            }
                            if (block.type === 'thinking' && block.thinking) {
                                this.stream(block.thinking, 'out', 'thought');
                            }
                            if (block.type === 'tool_use') {
                                const inputSummary = JSON.stringify(block.input).slice(0, 120);
                                this.stream(`[tool: ${block.name}] ${inputSummary}`, 'out', 'tool');
                                this.emit('TOOL_USED', {
                                    toolName: block.name,
                                    input: block.input,
                                    source: 'conductor:ask_codebase',
                                });
                            }
                        }
                    } else if (ev.type === 'user') {
                        const content = ev.message?.content;
                        if (Array.isArray(content)) {
                            for (const block of content) {
                                if (block.type === 'tool_result') {
                                    const toolOutput = typeof block.content === 'string'
                                        ? block.content.slice(0, 200)
                                        : JSON.stringify(block.content).slice(0, 200);
                                    this.stream(`  → ${toolOutput.replace(/\n/g, ' ').trim().slice(0, 150)}`, 'out', 'tool');
                                }
                            }
                        }
                    } else if (ev.type === 'result') {
                        // Use accumulated text, or fall back to result text
                        const finalText = answerText.trim() || ev.result || 'No answer produced.';
                        this.stream(`[ask_codebase] Complete (${String(ev.num_turns ?? '?')} turns)`, 'out', 'result');
                        settle(finalText);
                    }
                }
            });

            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8').trim();
                if (text.length > 0) {
                    console.warn(`[Conductor:${this.agentId}] askQuestion stderr: ${text.slice(0, 200)}`);
                }
            });

            proc.on('exit', (code: number | null) => {
                // Flush remaining buffer
                if (lineBuffer.trim().length > 0) {
                    try {
                        const ev = JSON.parse(lineBuffer.trim()) as ClaudeEvent;
                        if (ev.type === 'result') {
                            settle(answerText.trim() || ev.result || 'No answer produced.');
                            return;
                        }
                    } catch { /* ignore */ }
                }

                if (!settled) {
                    settle(answerText.trim() || `Claude Code exited (code ${String(code ?? 'null')}) without a result.`);
                }
            });

            proc.on('error', (err: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Legacy compatibility shim.
     */
    async run(objective: string): Promise<void> {
        return this.runTask(objective);
    }

    /**
     * Run a full coding task. The `objective` from the orchestrator already
     * contains acceptance criteria, design spec, and tech stack info.
     * This method only adds execution-environment context (project root,
     * sandbox info) — never duplicates what the orchestrator included.
     */
    async runConductorTrack(objective: string, _acceptanceCriteria: string, sandbox?: SandboxHandle): Promise<void> {
        const projectRoot = sandbox?.workDir ?? MONOREPO_ROOT;

        // The `objective` already contains a focused, LLM-generated task
        // briefing with only the relevant context. This method only appends
        // execution-environment facts (paths, ports, mandatory checks).
        const envParts: string[] = [
            objective,
            '',
            '## Environment',
            `Project root: ${projectRoot}`,
            'Use ABSOLUTE paths starting with the project root.',
        ];

        if (sandbox !== undefined) {
            envParts.push(
                `You are inside an isolated Docker sandbox. Source at ${sandbox.workDir}.`,
                'Dependencies are pre-installed. Changes merge back after QA.',
                'IMPORTANT: Clear stale Next.js cache before building: rm -rf apps/web/.next',
                '',
                '## Sandbox Port Configuration',
                `The backend (Express) listens on port ${sandbox.backendPort.toString()} (env var PORT=${sandbox.backendPort.toString()}).`,
                `The frontend (Next.js) reads WEB_PORT from env and starts on port ${sandbox.webPort.toString()}: just run \`pnpm --filter @ai-hivemind/web dev\` (no -p flag needed).`,
                `The Next.js rewrites proxy is configured via BACKEND_PORT env var to forward /api/* to the backend on port ${sandbox.backendPort.toString()}.`,
                'These are the ONLY ports available — do NOT use 3000 or 3001.',
            );
        }

        envParts.push(
            '',
            '## API Architecture',
            'The Next.js frontend proxies /api/* requests to the Express backend via rewrites in next.config.ts.',
            'In frontend code, ALWAYS use relative paths for API calls: `fetch("/api/posts")`, `fetch("/api/weather")`.',
            'NEVER hardcode any port number in frontend code — the proxy handles routing to the backend.',
            '',
            '## MANDATORY: Verify your work',
            '1. Test end-to-end: start the dev server, curl endpoints or load pages to confirm they work with real data.',
            '2. Debug properly: when something fails, read the actual error — do not guess or mask with retries.',
            '3. Run `pnpm build` and confirm it succeeds BEFORE you finish. QA will reject a broken build.',
            '',
            '## MANDATORY: Document your API surface',
            'At the END of your work (after build passes), print a section exactly like this so QA knows what to test:',
            '```',
            '## Endpoints Created/Modified',
            '- METHOD /path — description (request body: {...}, response: {...})',
            '- METHOD /path — description (request body: {...}, response: {...})',
            '```',
            'List EVERY endpoint you created or modified with its HTTP method, path, and request/response shape.',
            'QA will test exactly these endpoints — if you omit one, it won\'t be tested. If you list a wrong path, QA will fail.',
        );

        return this.runTask(envParts.join('\n'), sandbox);
    }

    /**
     * Resume an existing Claude Code session with a follow-up prompt.
     * Uses `--resume <sessionId> -p <prompt>` so Claude Code continues
     * with its full previous context (files read, changes made) instead
     * of starting from scratch.
     *
     * Falls back to a fresh runConductorTrack if no session ID is available.
     */
    async resumeWithFollowup(followup: string, sandbox?: SandboxHandle): Promise<void> {
        if (this.sessionId === null) {
            // No previous session — fall back to fresh run
            return this.runConductorTrack(followup, '', sandbox);
        }

        const resumePrompt = [
            followup,
            '',
            '## MANDATORY: Verify build before finishing',
            'You MUST run `pnpm build` and confirm it succeeds BEFORE you consider your task done.',
            'If the build fails, fix the errors and rebuild until it passes.',
            'Do NOT finish with a broken build — QA will reject it.',
        ].join('\n');

        return this.runTaskWithResume(this.sessionId, resumePrompt, sandbox);
    }

    /**
     * Run a task that resumes an existing Claude Code session.
     * Claude Code keeps the full conversation context (files read,
     * changes made) and appends the new prompt as a follow-up.
     */
    async runTaskWithResume(sessionId: string, prompt: string, sandbox?: SandboxHandle): Promise<void> {
        this.objective = prompt;
        this.#sawResult = false;
        this.#bannerShown = false;
        this.messageBuffer = '';
        this.#sandbox = sandbox;

        return new Promise<void>((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.#taskResolve = null;
                this.#taskReject = null;
                this.process_?.kill('SIGTERM');
                reject(new Error(`Conductor task timed out after ${(MAX_TASK_MS / 1000).toFixed(0)}s`));
            }, MAX_TASK_MS);

            this.#taskResolve = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.#taskResolve = null;
                this.#taskReject = null;
                resolve();
            };

            this.#taskReject = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.#taskResolve = null;
                this.#taskReject = null;
                reject(err);
            };

            this.stream(prompt, 'in', 'input');
            this.#spawnClaudeResume(sessionId, prompt, sandbox);
        });
    }

    /**
     * Spawn Claude Code with --resume to continue an existing session.
     */
    #spawnClaudeResume(sessionId: string, prompt: string, sandbox?: SandboxHandle): void {
        const authOk = authManager.ensureFreshToken();
        if (!authOk) {
            this.emit('ERROR', {
                message: 'OAuth token expired and could not be refreshed. Please run "claude auth login" in a terminal to re-authenticate.',
                phase: 'auth',
            });
        }

        const self = this;
        const claudeArgs = [
            '--resume', sessionId,
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--max-turns', MAX_TURNS.toString(),
            '--dangerously-skip-permissions',
        ];

        let proc: ChildProcess;

        if (sandbox !== undefined) {
            // Re-inject OAuth credentials (token may have been refreshed since container creation)
            injectClaudeCredentials(sandbox.containerName);
            console.log(`[Conductor:${self.agentId}] Resuming session=${sessionId} in container=${sandbox.containerName}`);
            proc = execInSandbox(sandbox, CLAUDE_BIN, claudeArgs);
        } else {
            console.log(`[Conductor:${self.agentId}] Resuming session=${sessionId} directly`);
            const childEnv: Record<string, string> = {};
            const KEEP = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
                'SSH_AUTH_SOCK', 'XPC_FLAGS', 'XPC_SERVICE_NAME',
                'COMMAND_MODE', 'LOGNAME', 'SHLVL', 'OLDPWD', 'PWD',
                'NODE_ENV', 'NODE_OPTIONS', 'NVM_DIR', 'NVM_BIN'];
            for (const key of KEEP) {
                if (process.env[key] !== undefined) childEnv[key] = process.env[key]!;
            }
            childEnv['DISABLE_AUTOUPDATER'] = '1';
            childEnv['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'] = '1';
            try {
                Object.assign(childEnv, credentialStore.getDecryptedEnvVars(this.traceId));
            } catch { /* Non-fatal */ }
            if (childEnv['ANTHROPIC_API_KEY'] === undefined && process.env['ANTHROPIC_API_KEY']) {
                childEnv['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
            }

            proc = spawn(CLAUDE_BIN, claudeArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: childEnv,
                cwd: MONOREPO_ROOT,
            });
        }

        self.process_ = proc;
        self.processStdin_ = null;
        let lineBuffer = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
            lineBuffer += chunk.toString('utf8');
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                self.handleLine(trimmed);
            }
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            if (text.trim().length > 0) {
                console.warn(`[Conductor:${self.agentId}] stderr: ${text.trim().slice(0, 200)}`);

                // Detect authentication failures and surface them clearly
                if (text.includes('authentication_error') || text.includes('Failed to authenticate') || text.includes('API Error: 401')) {
                    self.emit('ERROR', {
                        message: 'Claude Code authentication failed (401). Run "claude auth login" in a terminal to refresh your OAuth token.',
                        phase: 'auth',
                    });
                }

                // Emit server log lines to the activity feed
                for (const line of text.split('\n')) {
                    if (line.trim().length > 0) {
                        self.emit('SANDBOX_LOG', { text: line.trimEnd(), source: 'stderr' });
                    }
                }
            }
            self.detectDevServer(text);
        });

        proc.on('exit', (code: number | null) => {
            self.processStdin_ = null;
            self.process_ = null;
            if (lineBuffer.trim().length > 0) self.handleLine(lineBuffer.trim());
            if (self.messageBuffer.length > 0) self.flushMessageBuffer();
            console.log(`[Conductor:${self.agentId}] Resume process exited code=${String(code)}`);
            if (self.#sawResult || code === 0) {
                self.#taskResolve?.();
            } else {
                self.#taskReject?.(new Error(`Claude Code exited (code ${String(code ?? 'null')}) before emitting a result`));
            }
        });
    }


    /**
     * Abort: kill the currently running process if any.
     * Safe to call at any time.
     */
    abort(): void {
        this.unsubscribeIntervention?.();
        this.unsubscribeIntervention = null;
        this.#taskResolve = null;
        this.#taskReject = null;
        this.processStdin_ = null;
        if (this.process_ !== null) {
            try { this.process_.kill('SIGTERM'); } catch { /* already dead */ }
        }
        this.process_ = null;
    }

    // ── Private — event routing ───────────────────────────────────────────────

    private emit(eventType: string, payload: EventPayload): void {
        eventBus.emit({
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            eventType: eventType as SystemEvent['eventType'],
            sourceId: this.agentId,
            targetId: null,
            payload,
            traceId: this.traceId,
        } as unknown as SystemEvent);
    }

    handleLine(line: string): void {
        let ev: ClaudeEvent;
        try {
            ev = JSON.parse(line) as ClaudeEvent;
        } catch {
            // Non-JSON line (startup banner, raw text) — stream it so the UI sees it
            if (line.trim().length > 0) {
                this.stream(line.trim(), 'out', 'message');
            }
            return;
        }

        switch (ev.type) {
            case 'system': {
                // Capture session ID for potential --resume on retries
                if (ev.session_id !== undefined && typeof ev.session_id === 'string') {
                    this.sessionId = ev.session_id;
                }

                // Claude Code emits multiple system events per session (init,
                // api_key_source, etc.). Only show the banner once.
                if (this.#bannerShown) break;
                this.#bannerShown = true;

                const model = ev.model ?? 'Claude';
                const banner = [
                    '\n',
                    ' ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗',
                    '██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝',
                    '██║     ██║     ███████║██║   ██║██║  ██║█████╗  ',
                    '██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ',
                    '╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗',
                    ' ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝',
                    '',
                    `Model: ${String(model)}`,
                    `Session: ${ev.session_id ?? 'unknown'}`,
                    '------------------------------------------------',
                    'Session started. Executing task autonomously...',
                    ''
                ].join('\n');
                this.stream(banner, 'out', 'message');
                break;
            }

            case 'assistant': {
                const content = ev.message?.content;
                if (!Array.isArray(content)) break;

                for (const block of content) {
                    switch (block.type) {
                        case 'thinking':
                            this.lastThought = block.thinking ?? '';
                            this.stream(block.thinking ?? '', 'out', 'thought');
                            this.emit('STATE_CHANGED', { message: block.thinking, source: 'conductor:thought' });
                            break;

                        case 'text': {
                            const text = block.text ?? '';
                            if (text.length > 0) {
                                this.messageBuffer += text;
                                this.stream(text, 'out', 'message');
                            }
                            break;
                        }

                        case 'tool_use': {
                            const toolName = block.name ?? 'unknown';
                            const toolInput = block.input ?? {};
                            const inputSummary = JSON.stringify(toolInput).slice(0, 120);

                            this.stream(`[tool: ${toolName}] ${inputSummary}`, 'out', 'tool');
                            this.emit('TOOL_USED', { toolName, input: toolInput, source: 'conductor:tool_use' });

                            // Detect code changes from Edit/Write tool calls
                            if (toolName === 'Edit' || toolName === 'Write') {
                                const filePath = typeof toolInput['file_path'] === 'string'
                                    ? toolInput['file_path']
                                    : typeof toolInput['filePath'] === 'string'
                                        ? toolInput['filePath']
                                        : '';
                                if (filePath) {
                                    this.emit('TOOL_USED', {
                                        toolName: 'code_change',
                                        filePath,
                                        description: toolName === 'Edit' ? 'File edited' : 'File written',
                                        source: 'conductor:code_change',
                                    });
                                }
                            }

                            // Detect terminal commands from Bash tool calls
                            if (toolName === 'Bash') {
                                const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
                                if (command) {
                                    this.stream(`$ ${command}`, 'out', 'tool');
                                    this.emit('TOOL_USED', {
                                        toolName: 'terminal',
                                        command,
                                        source: 'conductor:terminal',
                                    });
                                }
                            }
                            break;
                        }

                        default:
                            break;
                    }
                }

                // Flush any accumulated message text at end of assistant turn
                if (this.messageBuffer.length > 0) this.flushMessageBuffer();
                break;
            }

            case 'user': {
                const content = ev.message?.content;
                if (!Array.isArray(content)) break;

                for (const block of content) {
                    if (block.type === 'tool_result') {
                        const toolOutput = typeof block.content === 'string'
                            ? block.content.slice(0, 300)
                            : JSON.stringify(block.content).slice(0, 300);
                        const isError = block.is_error === true;

                        if (isError) {
                            this.stream(`  → error: ${toolOutput.slice(0, 200)}`, 'out', 'tool');
                        } else if (toolOutput.trim().length > 0) {
                            this.stream(`  → ${toolOutput.replace(/\n/g, ' ').trim().slice(0, 200)}`, 'out', 'tool');
                        } else {
                            this.stream(`  → [ok]`, 'out', 'tool');
                        }

                        this.emit('TOOL_USED', {
                            toolResultId: block.tool_use_id,
                            output: toolOutput,
                            status: isError ? 'error' : 'ok',
                            source: 'conductor:tool_result',
                        });
                    }
                }
                break;
            }

            case 'result': {
                this.#sawResult = true;
                const resultText = ev.result ?? 'Task complete';
                const isError = ev.is_error === true;

                // The result event's `result` field often duplicates the last
                // assistant text block. Only stream if it's genuinely new content
                // to avoid showing the same text twice in the terminal panel.
                const alreadyStreamed = this.messageBuffer.length === 0
                    && resultText.length > 0
                    && !isError;

                if (isError) {
                    this.stream(resultText, 'out', 'error');
                    this.emit('STATE_CHANGED', {
                        message: `Error: ${resultText}`,
                        success: false,
                        source: 'conductor:error',
                        cost_usd: ev.cost_usd,
                        num_turns: ev.num_turns,
                        duration_ms: ev.duration_ms,
                    });
                    console.error(`[Conductor:${this.agentId}] Claude Code error: ${resultText.slice(0, 200)}`);
                    this.#taskReject?.(new Error(`Claude Code error: ${resultText.slice(0, 200)}`));
                } else {
                    // Skip streaming if the text was already sent as an assistant message
                    // (messageBuffer is empty after flush, meaning all text was already streamed)
                    if (!alreadyStreamed) {
                        this.stream(resultText, 'out', 'result');
                    }
                    this.emit('STATE_CHANGED', {
                        message: resultText,
                        success: true,
                        source: 'conductor:result',
                        cost_usd: ev.cost_usd,
                        num_turns: ev.num_turns,
                        duration_ms: ev.duration_ms,
                    });
                    this.#taskResolve?.();
                }
                break;
            }

            default: {
                // Unknown event type — log to console for debugging, keep out of UI
                const rawType = (ev as Record<string, unknown>)['type'] ?? 'none';
                console.debug(`[Conductor:${this.agentId}] Unknown event type: ${String(rawType)}`);
            }
        }
    }

    // ── Private — helpers ─────────────────────────────────────────────────────

    flushMessageBuffer(): void {
        if (this.messageBuffer.length === 0) return;
        this.emit('MESSAGE_SENT', { content: this.messageBuffer, role: 'assistant', source: 'conductor:message' });
        this.messageBuffer = '';
    }

    detectDevServer(stderr: string): void {
        const re = /https?:\/\/(localhost|127\.0\.0\.1):(\d+)/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(stderr)) !== null) {
            const port = parseInt(match[2] ?? '0', 10);
            if (port > 0 && !this.seenPorts.has(port)) {
                this.seenPorts.add(port);
                // No port rewriting needed — sandbox uses 1:1 port mapping
                const url = match[0];
                const serviceName = `dev-server-${port.toString()}`;
                this.emit('SERVICE_DEPLOYED', { serviceName, url, port });
            }
        }
        // Also scan stdout lines for dev server URLs
        const stdoutMatch = DEV_SERVER_RE.exec(stderr);
        if (stdoutMatch) {
            const port = parseInt(stdoutMatch[2] ?? '0', 10);
            if (port > 0 && !this.seenPorts.has(port)) {
                this.seenPorts.add(port);
                this.emit('SERVICE_DEPLOYED', { serviceName: `dev-server-${port.toString()}`, url: stdoutMatch[0], port });
            }
        }
    }
}
