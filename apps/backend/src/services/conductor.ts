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
import { execInSandbox, type SandboxHandle } from './sandboxManager.js';

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
        // Ensure OAuth token is fresh before spawning (no-op if using API key)
        authManager.ensureFreshToken();

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
            if (process.env['ANTHROPIC_API_KEY']) {
                childEnv['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
            }
            childEnv['DISABLE_AUTOUPDATER'] = '1';
            childEnv['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'] = '1';

            // Inject user-configured service credentials
            try {
                Object.assign(childEnv, credentialStore.getDecryptedEnvVars());
            } catch {
                // Non-fatal — credentials may not be configured
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
        const envContext = [
            objective,
            '',
            '## Environment',
            `Project root: ${projectRoot}`,
            'Use ABSOLUTE paths starting with the project root.',
            ...(sandbox !== undefined ? [
                `You are inside an isolated Docker sandbox. Source at ${sandbox.workDir}.`,
                'Dependencies are pre-installed. Changes merge back after QA.',
                'IMPORTANT: Clear stale Next.js cache before building: rm -rf apps/web/.next',
                '',
                '## Sandbox Port Configuration',
                `The backend (Express) listens on port ${sandbox.backendPort.toString()} (env var PORT=${sandbox.backendPort.toString()}).`,
                `The frontend (Next.js) reads WEB_PORT from env and starts on port ${sandbox.webPort.toString()}: just run \`pnpm --filter @ai-hivemind/web dev\` (no -p flag needed).`,
                `The Next.js rewrites proxy is configured via BACKEND_PORT env var to forward /api/* to the backend on port ${sandbox.backendPort.toString()}.`,
                'These are the ONLY ports available — do NOT use 3000 or 3001.',
            ] : []),
            '',
            '## API Architecture',
            'The Next.js frontend proxies /api/* requests to the Express backend via rewrites in next.config.ts.',
            'In frontend code, ALWAYS use relative paths for API calls: `fetch("/api/posts")`, `fetch("/api/weather")`.',
            'NEVER hardcode any port number in frontend code — the proxy handles routing to the backend.',
            '',
            '## Using Available Services',
            'When your task involves content analysis, classification, semantic filtering,',
            'data enrichment, or any task that requires understanding meaning:',
            '- Use the available external services listed in your objective (e.g., OpenAI for classification, Brave for search)',
            '- Do NOT build keyword lists, regex patterns, or hardcoded rules as a substitute',
            '  for proper API-based solutions when an appropriate service is available',
            '- A 10-line API call to a classification service is better than a 100-line',
            '  hardcoded heuristic — it is more accurate, more maintainable, and handles edge cases',
            '',
            '## MANDATORY: Debug properly — never guess',
            'When something does not work (API calls fail, endpoints return errors, data is missing):',
            '1. **Read the actual response** — `curl -v <url>` to see status code, headers, and body',
            '2. **Check logs** — look at terminal output, stderr, and server logs for error messages',
            '3. **Test in isolation** — run a minimal reproduction to confirm the root cause',
            '4. **Fix the root cause** — do NOT just adjust timeouts, retries, or error handling to mask the problem',
            '',
            'Common pitfalls to avoid:',
            '- If an API returns 403/429, read the error body — it usually tells you exactly what is wrong (missing User-Agent, auth, rate limit)',
            '- If a fetch times out, that is a symptom, not the cause — find out WHY it times out before changing timeout values',
            '- If data is empty, verify the request URL, headers, and query params are correct before adding fallback logic',
            '- Graceful degradation is good, but only AFTER you have tried to make the happy path actually work',
            '',
            '## MANDATORY: Test your work end-to-end',
            'Before finishing, you MUST verify the feature actually works:',
            '- Start the dev server if not already running',
            '- `curl` your API endpoints and confirm they return real data (not empty arrays or fallback responses)',
            '- If the endpoint depends on an external API, verify the external call works (correct URL, headers, auth)',
            '- If the feature has a frontend page, curl the page URL to ensure it compiles and serves',
            '',
            '## MANDATORY: Verify build before finishing',
            'You MUST run `pnpm build` and confirm it succeeds BEFORE you consider your task done.',
            'If the build fails, fix the errors and rebuild until it passes.',
            'Do NOT finish with a broken build — QA will reject it.',
        ].join('\n');

        return this.runTask(envContext, sandbox);
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
        authManager.ensureFreshToken();

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
            if (process.env['ANTHROPIC_API_KEY']) {
                childEnv['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
            }
            childEnv['DISABLE_AUTOUPDATER'] = '1';
            childEnv['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'] = '1';
            try {
                Object.assign(childEnv, credentialStore.getDecryptedEnvVars());
            } catch { /* Non-fatal */ }

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
