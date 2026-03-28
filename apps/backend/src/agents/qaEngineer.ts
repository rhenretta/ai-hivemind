/**
 * qaEngineer.ts — QA Engineer Agent (Planner)
 *
 * Plans and orchestrates testing by:
 *  1. Creating a structured test plan from acceptance criteria
 *  2. Spawning TestExecutor agents to run individual tests
 *  3. Collecting results and submitting a verdict
 *
 * This agent decides WHAT to test. TestExecutors decide HOW.
 *
 * Tool whitelist: update_test_plan, run_test, submit_qa_verdict
 */

import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { QaBrowserSession } from '../services/qaBrowser.js';
import { logger } from '../services/logger.js';
import { eventBus } from '../eventBus.js';
import type { SandboxHandle } from '../services/sandboxManager.js';

import { BaseAgent } from './baseAgent.js';
import { TestExecutor } from './testExecutor.js';
import { TestDebugger } from './testDebugger.js';

import { QaTestPlanSchema } from '@ai-hivemind/shared';
import type { SweArtifact, UxDesignSpec, QaTestPlan, TaskGraph } from '@ai-hivemind/shared';
import type OpenAI from 'openai';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_QA_TURNS = 25;
const MONOREPO_ROOT = process.env['MONOREPO_ROOT'] ?? '/Users/rhenretta/workspace/rhenretta/ai-hivemind';

// ── Planner tool whitelist ────────────────────────────────────────────────────

const QA_TOOL_NAMES = new Set(['update_test_plan', 'run_test', 'submit_qa_verdict']);

// ── OpenAI tool shapes for QA planner ─────────────────────────────────────────

const QA_OPENAI_TOOLS: OpenAI.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'update_test_plan',
            description: 'Create or update the QA testing plan. Call this FIRST to create your plan, then after each test result to update its status. Each call replaces the entire plan.',
            parameters: {
                type: 'object',
                properties: {
                    tests: {
                        type: 'array',
                        description: 'The complete list of tests (replaces previous plan)',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Unique test ID, e.g. "api-health", "visual-homepage"' },
                                name: { type: 'string', description: 'Human-readable test name' },
                                description: { type: 'string', description: 'What this test verifies — be specific about endpoints, expected data, and behavior' },
                                type: { type: 'string', enum: ['api', 'visual', 'build', 'content', 'interaction', 'custom'], description: 'Test category' },
                                status: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'skipped'], description: 'Current status' },
                                result: { type: 'string', description: 'Explanation of pass/fail/skip (required for non-pending tests)' },
                                severity: { type: 'string', enum: ['blocking', 'warning'], description: 'Whether a failure blocks the verdict. "blocking" = core functionality broken. "warning" = imperfect but functional.' },
                            },
                            required: ['id', 'name', 'description', 'type', 'status'],
                        },
                    },
                },
                required: ['tests'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_test',
            description: 'Execute a single test by spawning a test executor agent. The executor will autonomously figure out how to verify the claim and report back with pass/fail and evidence. Write the description as a clear, specific verification claim.',
            parameters: {
                type: 'object',
                properties: {
                    test_id: { type: 'string', description: 'Must match a test ID in the current plan' },
                    description: {
                        type: 'string',
                        description: 'Specific verification claim. Include the exact URL/path, expected status code, expected response structure, and what constitutes pass vs fail. Example: "GET http://localhost:3001/api/reddit/popular should return HTTP 200 with a JSON body containing a non-empty posts array where each item has title, author, and score fields."',
                    },
                },
                required: ['test_id', 'description'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'submit_qa_verdict',
            description: 'Submit the final QA verdict after all tests are complete. All tests must be in a terminal state. The verdict is auto-enforced: only blocking failures cause a fail.',
            parameters: {
                type: 'object',
                properties: {
                    passed: { type: 'boolean', description: 'Overall verdict (auto-corrected based on severity)' },
                    issues: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Specific, actionable issues from BLOCKING test failures (empty if passed)',
                    },
                    warnings: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Non-blocking issues from WARNING test failures',
                    },
                    stepsToReproduce: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Ordered CLI steps to reproduce each blocking issue. Empty if passed.',
                    },
                    summary: { type: 'string', description: 'Comprehensive test report' },
                },
                required: ['passed', 'issues', 'stepsToReproduce', 'summary'],
            },
        },
    },
];

// ── Task graph context builder ────────────────────────────────────────────────

function buildTaskGraphSection(graph: TaskGraph | undefined, currentSubtask: string): string {
    if (graph === undefined || graph.nodes.length <= 1) return '';

    const lines: string[] = ['', 'TASK GRAPH CONTEXT — understand the full plan before creating your test plan:'];

    const STATUS_LABEL: Record<string, string> = {
        done: '✅ DONE',
        active: '🔨 ACTIVE (you are testing THIS)',
        pending: '⏳ PLANNED (not yet implemented — do NOT test)',
        failed: '❌ FAILED',
        skipped: '⏭️ SKIPPED',
    };

    for (const node of graph.nodes) {
        const label = STATUS_LABEL[node.status] ?? node.status;
        const type = node.taskType !== undefined ? ` [${node.taskType}]` : '';
        const result = node.status === 'done' && node.result !== undefined
            ? ` → ${node.result.slice(0, 120)}`
            : '';
        lines.push(`  ${node.id}${type}: ${label} — ${node.objective.slice(0, 150)}${result}`);
    }

    lines.push('');
    lines.push('CRITICAL: Only test what belongs to the ACTIVE task. Tasks marked PLANNED have NOT been');
    lines.push('implemented yet — their code does not exist. Do NOT test services from PLANNED tasks.');
    lines.push('Tasks marked DONE are already validated — you may rely on their endpoints being available.');

    return lines.join('\n');
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildQaSystemPrompt(
    subtask: string,
    acceptanceCriteria: string,
    artifact: SweArtifact,
    serviceUrl: string | undefined,
    sandbox?: SandboxHandle,
    serversStarted: string[] = [],
    designSpec?: UxDesignSpec,
    taskGraph?: TaskGraph,
    priorIssues?: string[],
    arbiterGuidance?: string,
): string {
    // Extract endpoint lines from the SWE summary so they stand out clearly
    const endpointLines = (artifact.summary ?? '').split('\n')
        .filter((line) => /^\s*-\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/.test(line));

    const artifactSummary = [
        `Claude Code exit: ${artifact.success ? 'SUCCESS' : 'FAILED'}`,
        `Summary: ${artifact.summary}`,
        `Files changed (${artifact.filesChanged.length}): ${artifact.filesChanged.join(', ') || 'none'}`,
        `Errors seen: ${artifact.errors.slice(0, 5).join('; ') || 'none'}`,
        ...(endpointLines.length > 0 ? [
            '',
            '⚠️  ENDPOINTS/PAGES CREATED BY THE SWE (use these EXACT paths — do NOT invent your own):',
            ...endpointLines,
        ] : []),
    ].join('\n');

    const hasBackendFiles = artifact.filesChanged.some((f) => f.includes('apps/backend'));
    const hasFrontendFiles = artifact.filesChanged.some((f) => f.includes('apps/web'));

    const designSection = designSpec !== undefined
        ? `
UX DESIGN SPEC:
  Layout: ${designSpec.layout}
  Components: ${designSpec.componentHierarchy}
  Styling: ${designSpec.styling}${sandbox !== undefined ? `
  Wireframe:
${designSpec.wireframe}` : ''}
  UX Acceptance Criteria:
${designSpec.uxAcceptanceCriteria}`
        : '';

    const taskGraphSection = buildTaskGraphSection(taskGraph, subtask);

    const isRetry = priorIssues !== undefined && priorIssues.length > 0;
    const priorIssuesSection = isRetry
        ? `
PRIOR QA ISSUES (from previous run — the SWE attempted to fix these):
${priorIssues.map((issue) => `  - ${issue}`).join('\n')}

YOUR PRIORITY: Include a specific test for EACH prior issue to verify the fix. If the fix works,
mark it passed. If not, report the SAME issue again. Do NOT invent new test categories that
weren't in the previous run.
`
        : '';

    const arbiterGuidanceSection = arbiterGuidance !== undefined && arbiterGuidance !== ''
        ? `
ARBITER GUIDANCE (follow this carefully):
${arbiterGuidance}
`
        : '';

    // ── Judgment rules (the only procedural content in this prompt) ──────────
    const judgmentRules = `
## Rules

- **ACCEPTANCE CRITERIA RULE:** Every test MUST trace back to a specific acceptance criterion.
  Do NOT invent requirements that aren't stated or clearly implied.

- **SCOPE RULE:** ONLY test what THIS TASK changed. If no frontend files were changed, do NOT
  test frontend rendering. If no backend files were changed, do NOT probe backend endpoints.
  The "files changed" list tells you what was implemented. Stick to that scope.

- **STABILITY RULE:** On retries, test the same things as the previous run plus verify prior
  fixes. NEVER introduce new test categories on a retry.

- **SEVERITY RULE:** Each test MUST have a severity — "blocking" or "warning".
  BLOCKING: feature is fundamentally broken (500s, page won't render, core criterion unmet).
  WARNING: imperfect but functional (edge cases, minor styling, performance).
  When in doubt, prefer "warning".

- **VERDICT RULE:** Only BLOCKING test failures cause a fail verdict. WARNING failures are
  noted but the verdict can still pass. The system auto-enforces this.

- **FUNCTIONAL OVER META RULE:** If an endpoint returns HTTP 200 with correct data, it passes.
  Never fail a working endpoint based on source code inspection, grep commands, or static
  analysis. A successful runtime probe is the strongest evidence.

- **SEMANTIC VALIDATION RULE:** When testing content quality or filtering, use your own reasoning
  to evaluate the content — NOT keyword matching, regex patterns, or word lists. You are an AI;
  use comprehension, not crude string matching.

- **ISSUE FORMAT:** Every issue string MUST contain: (1) exact HTTP method + URL tested,
  (2) HTTP status code or error, (3) response body snippet, (4) what you expected.

- **STEPS TO REPRODUCE:** Provide ordered CLI commands the SWE can copy-paste to reproduce
  each blocking failure.`;

    // ── Compose final prompt ────────────────────────────────────────────────
    const isSandboxMode = sandbox !== undefined;

    if (isSandboxMode) {
        const { backendPort, webPort } = sandbox;

        return `You are the QA Engineer — a test planner in an autonomous software engineering swarm.

Your job is to decide WHAT to test, then use run_test to spawn test executors that figure out HOW.

SUBTASK: ${subtask}

ACCEPTANCE CRITERIA: ${acceptanceCriteria}
${priorIssuesSection}${arbiterGuidanceSection}${designSection}
${taskGraphSection}
SWE ARTIFACT:
${artifactSummary}

SANDBOX PORTS:
${hasBackendFiles ? `  Backend: http://localhost:${backendPort.toString()}` : '  Backend: (no backend files changed — do NOT test backend)'}
${hasFrontendFiles ? `  Frontend: http://localhost:${webPort.toString()}` : '  Frontend: (no frontend files changed — do NOT test frontend)'}

DEV SERVERS:
${serversStarted.length > 0 ? `Pre-started and running:\n${serversStarted.map((s) => `  ✓ ${s}`).join('\n')}\nDo NOT start them again.` : 'No dev servers were pre-started. The test executor can start them if needed.'}

## Workflow
1. Read the SWE ARTIFACT above to find the exact endpoints/pages that were built. The artifact is
   the source of truth — use ONLY the URLs listed there. NEVER invent or guess endpoint paths from
   the task description. If the artifact says "GET /api/reddit/popular/filtered", that is what you test.
2. Create your test plan with update_test_plan — one test per acceptance criterion or key behavior.
   Each test description MUST include an exact URL copied from the SWE artifact.
3. Call run_test for each test. The executor will figure out the verification approach.
4. After each run_test returns, update your test plan with the result.
5. When all tests are complete, call submit_qa_verdict.
${judgmentRules}`;
    }

    // ── Live mode ────────────────────────────────────────────────────────────
    const urlSection = serviceUrl !== undefined
        ? `Live service base URL: ${serviceUrl}`
        : `Probe http://localhost:3001 (backend) or http://localhost:3000 (frontend) based on files changed.`;

    return `You are the QA Engineer — a test planner in an autonomous software engineering swarm.

Your job is to decide WHAT to test, then use run_test to spawn test executors that figure out HOW.

SUBTASK: ${subtask}

ACCEPTANCE CRITERIA: ${acceptanceCriteria}
${priorIssuesSection}${arbiterGuidanceSection}${designSection}
${taskGraphSection}
SWE ARTIFACT:
${artifactSummary}

${urlSection}

## Workflow
1. Read the SWE ARTIFACT above to find the exact endpoints/pages that were built. The artifact is
   the source of truth — use ONLY the URLs listed there. NEVER invent or guess endpoint paths from
   the task description. If the artifact says "GET /api/reddit/popular/filtered", that is what you test.
2. Create your test plan with update_test_plan — one test per acceptance criterion or key behavior.
   Each test description MUST include an exact URL copied from the SWE artifact.
3. Call run_test for each test. The executor will figure out the verification approach.
4. After each run_test returns, update your test plan with the result.
5. When all tests are complete, call submit_qa_verdict.
${judgmentRules}`;
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
    warnings: string[];
    checksRun: string[];
    visualDescription: string;
    summary?: string;
    stepsToReproduce?: string[];
    testPlan?: QaTestPlan;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class QaEngineer extends BaseAgent {
    #sandbox: SandboxHandle | undefined;
    #browserSession: QaBrowserSession | null = null;
    #testPlan: QaTestPlan | null = null;
    #verdictSubmitted = false;
    #pendingVerdict: { passed: boolean; issues: string[]; warnings: string[]; stepsToReproduce: string[]; summary: string } | null = null;
    #artifactSummary = '';

    constructor(agentId: string, traceId: string, parentAgentId: string | null = null) {
        super(agentId, traceId, parentAgentId);
    }

    async run(
        subtask: string,
        acceptanceCriteria: string,
        artifact: SweArtifact,
        serviceUrl?: string,
        sandbox?: SandboxHandle,
        designSpec?: UxDesignSpec | null,
        taskGraph?: TaskGraph,
        priorIssues?: string[],
        arbiterGuidance?: string,
    ): Promise<QaVerdict> {
        this.#sandbox = sandbox;
        this.#testPlan = null;
        this.#verdictSubmitted = false;
        this.#pendingVerdict = null;

        this.spawn('qa-engineer');
        this.emit('STATE_CHANGED', {
            message: `Running QA validation for: "${subtask}"`,
            phase: 'validate',
            hasServiceUrl: serviceUrl !== undefined,
            sandboxMode: sandbox !== undefined,
            hasDesignSpec: designSpec !== undefined && designSpec !== null,
        });

        // Pre-start dev servers in sandbox so they're ready for probing
        let serversStarted: string[] = [];
        if (sandbox !== undefined) {
            serversStarted = await this.#startSandboxServers(artifact, sandbox);
        }

        // Launch persistent Playwright browser session (shared with executors)
        const allowedPorts = sandbox !== undefined
            ? Object.keys(sandbox.portMap).map(Number)
            : undefined;
        this.#browserSession = new QaBrowserSession(allowedPorts);
        await this.#browserSession.launch();

        // Store artifact summary for test debugger
        this.#artifactSummary = `${artifact.success ? 'SUCCESS' : 'FAILED'}: ${artifact.summary}\nFiles: ${artifact.filesChanged.join(', ') || 'none'}`;

        const systemPrompt = buildQaSystemPrompt(
            subtask, acceptanceCriteria, artifact, serviceUrl,
            sandbox, serversStarted,
            designSpec ?? undefined,
            taskGraph,
            priorIssues,
            arbiterGuidance,
        );

        const isRetry = priorIssues !== undefined && priorIssues.length > 0;

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: isRetry
                    ? 'Begin your QA validation. This is a RETRY — the SWE has attempted to fix the prior issues. '
                      + 'Create your testing plan with update_test_plan, including a specific test for EACH prior issue. '
                      + 'Then run_test for each test.'
                    : 'Begin your QA validation. Create your testing plan with update_test_plan, then run_test for each test.',
            },
        ];

        let verdict: QaVerdict = {
            passed: false,
            issues: ['QaEngineer did not complete testing'],
            warnings: [],
            checksRun: [],
            visualDescription: 'N/A',
        };

        try {
            for (let turn = 0; turn < MAX_QA_TURNS; turn++) {
                const completion = await generateWithRawTools(messages, QA_OPENAI_TOOLS, 'high');
                const choice = completion.choices[0];
                if (choice === undefined) break;

                messages.push(choice.message);

                if (choice.finish_reason !== 'tool_calls') {
                    if (!this.#verdictSubmitted) {
                        const raw = extractTextContent(completion).trim();
                        verdict = this.#parseVerdict(raw);
                    }
                    break;
                }

                const toolResults: Array<{ callId: string; result: string }> = [];

                for (const call of choice.message.tool_calls ?? []) {
                    const fnCall = call as OpenAI.ChatCompletionMessageToolCall & {
                        function: { name: string; arguments: string };
                    };
                    const args = JSON.parse(fnCall.function.arguments) as Record<string, unknown>;
                    const result = await this.#dispatchTool(fnCall.function.name, args);
                    toolResults.push({ callId: call.id, result });
                }

                for (const tr of toolResults) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: tr.callId,
                        content: tr.result,
                    });
                }

                if (this.#verdictSubmitted) break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] QA loop error: `, err);
            verdict = { passed: false, issues: [`QaEngineer error: ${msg}`], warnings: [], checksRun: [], visualDescription: 'N/A' };
        }

        // Build final verdict
        const pv = this.#pendingVerdict as { passed: boolean; issues: string[]; warnings: string[]; stepsToReproduce: string[]; summary: string } | null;
        if ((this.#verdictSubmitted as boolean) && pv !== null) {
            const plan = this.#testPlan as QaTestPlan | null;
            verdict = {
                passed: pv.passed,
                issues: pv.issues,
                warnings: pv.warnings ?? [],
                checksRun: plan !== null ? plan.tests.map((t) => t.name) : [],
                visualDescription: plan !== null
                    ? plan.tests
                        .filter((t) => t.type === 'visual')
                        .map((t) => t.result ?? '')
                        .filter((r) => r !== '')
                        .join('; ') || 'N/A'
                    : 'N/A',
                summary: pv.summary,
                ...(pv.stepsToReproduce.length > 0 ? { stepsToReproduce: pv.stepsToReproduce } : {}),
                ...(plan !== null ? { testPlan: plan } : {}),
            };
        }

        // Emit verdict event
        this.emit('QA_VERDICT', {
            subtask,
            passed: verdict.passed,
            issues: verdict.issues,
            warnings: verdict.warnings,
            checksRun: verdict.checksRun,
            visualDescription: verdict.visualDescription,
            summary: verdict.summary,
            stepsToReproduce: verdict.stepsToReproduce,
            testPlan: verdict.testPlan,
            artifactSuccess: artifact.success,
            filesChanged: artifact.filesChanged.length,
        });

        const warningNote = verdict.warnings.length > 0
            ? ` (${verdict.warnings.length.toString()} warning(s))`
            : '';
        this.emit('STATE_CHANGED', {
            message: verdict.passed
                ? `QA PASSED ✓ — ${verdict.checksRun.length.toString()} tests run${warningNote}`
                : `QA FAILED ✗ — ${verdict.issues.length.toString()} issue(s): ${verdict.issues[0] ?? ''}`,
            phase: 'validate',
            passed: verdict.passed,
        });

        // Close the persistent browser session
        await this.#browserSession?.close();
        this.#browserSession = null;

        this.terminate('qa_complete');
        return verdict;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Pre-start dev servers inside the sandbox container.
     */
    async #startSandboxServers(artifact: SweArtifact, sandbox: SandboxHandle): Promise<string[]> {
        const workDir = sandbox.workDir;
        const { backendPort, webPort } = sandbox;
        const servers: Array<{ filter: string; label: string; port: number; healthPath: string }> = [
            { filter: '@ai-hivemind/backend', label: 'backend', port: backendPort, healthPath: '/health' },
            { filter: '@ai-hivemind/web', label: 'frontend', port: webPort, healthPath: '/' },
        ];

        const portsToCheck: Array<{ label: string; port: number; healthPath: string }> = [];
        const ready = new Set<string>();
        for (const { filter, label, port, healthPath } of servers) {
            portsToCheck.push({ label, port, healthPath });

            try {
                execSync(`curl -sf --max-time 2 http://localhost:${port.toString()}${healthPath}`, { stdio: 'pipe' });
                logger.info(`[${this.agentId}] ${label} already running on port ${port.toString()}`);
                ready.add(label);
                continue;
            } catch {
                // Not running yet
            }

            const cmd = `cd ${workDir} && pnpm --filter ${filter} dev > /tmp/${label}.log 2>&1 &`;
            const dockerCmd = `docker exec ${sandbox.containerName} sh -c ${JSON.stringify(cmd)}`;
            try {
                execSync(dockerCmd, { stdio: 'pipe', timeout: 10_000 });
                logger.info(`[${this.agentId}] Started ${label} on port ${port.toString()}`);
            } catch (e) {
                logger.warn(`[${this.agentId}] Failed to start ${label} (may already be running):`, e);
            }
        }

        if (portsToCheck.length === 0) return [];

        if (ready.size >= portsToCheck.length) {
            logger.info(`[${this.agentId}] All servers already running — skipping warmup poll`);
        } else {
            this.emit('STATE_CHANGED', {
                message: 'Waiting for dev server(s) to become ready...',
                phase: 'validate',
            });
        }

        const maxWait = 60_000;
        const pollInterval = 3_000;
        const elapsed = { ms: 0 };
        const logOffsets: Record<string, number> = {};

        while (elapsed.ms < maxWait && ready.size < portsToCheck.length) {
            await sleep(pollInterval);
            elapsed.ms += pollInterval;

            this.#emitSandboxLogs(sandbox, logOffsets);

            for (const { label, port, healthPath } of portsToCheck) {
                if (ready.has(label)) continue;
                try {
                    execSync(`curl -sf --max-time 2 http://localhost:${port.toString()}${healthPath}`, { stdio: 'pipe' });
                    ready.add(label);
                    logger.info(`[${this.agentId}] ${label} ready after ${elapsed.ms.toString()}ms`);
                } catch {
                    // Not ready yet
                }
            }
        }

        this.#emitSandboxLogs(sandbox, logOffsets);

        const started: string[] = [];
        for (const { label, port } of portsToCheck) {
            if (ready.has(label)) {
                started.push(`${label} (localhost:${port.toString()})`);
                if (label === 'frontend') {
                    this.emit('SERVICE_DEPLOYED', {
                        serviceName: `sandbox-${label}`,
                        url: `http://localhost:${port.toString()}`,
                        port,
                    });
                }
            } else {
                logger.warn(`[${this.agentId}] ${label} not ready after ${maxWait.toString()}ms`);
            }
        }

        if (started.length > 0) {
            logger.info(`[${this.agentId}] Dev servers ready: ${started.join(', ')}`);
        }

        // Warm up frontend pages so Next.js compiles them before testing
        const pageFiles = artifact.filesChanged.filter((f) =>
            f.includes('apps/web/src/app/') && f.endsWith('page.tsx'),
        );
        const warmupUrls: string[] = [];
        for (const f of pageFiles) {
            const match = /apps\/web\/src\/app\/(.+?)\/page\.tsx$/.exec(f);
            if (match?.[1] !== undefined) {
                warmupUrls.push(`http://localhost:${webPort.toString()}/${match[1]}`);
            }
        }
        if (warmupUrls.length > 0) {
            logger.info(`[${this.agentId}] Warming up ${warmupUrls.length.toString()} route(s): ${warmupUrls.join(', ')}`);
            for (const url of warmupUrls) {
                try {
                    execSync(`curl -sf --max-time 15 "${url}" > /dev/null 2>&1`, { stdio: 'pipe', timeout: 20_000 });
                } catch {
                    // Non-fatal
                }
            }
            await sleep(2_000);
        }

        return started;
    }

    // ── Tool dispatch (planner tools only) ───────────────────────────────────

    async #dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (!QA_TOOL_NAMES.has(name)) {
            return `Tool '${name}' is not authorized for QA planner. Available: update_test_plan, run_test, submit_qa_verdict.`;
        }

        if (name === 'update_test_plan') {
            return this.#handleUpdateTestPlan(args);
        }
        if (name === 'submit_qa_verdict') {
            return this.#handleSubmitVerdict(args);
        }
        if (name === 'run_test') {
            return this.#handleRunTest(args);
        }

        return `Unknown tool: ${name}`;
    }

    // ── run_test — spawn a TestExecutor ──────────────────────────────────────

    async #handleRunTest(args: Record<string, unknown>): Promise<string> {
        const testId = typeof args['test_id'] === 'string' ? args['test_id'] : '';
        const description = typeof args['description'] === 'string' ? args['description'] : '';

        if (testId === '' || description === '') {
            return 'Error: test_id and description are required.';
        }

        // Verify the test exists in the plan
        if (this.#testPlan !== null) {
            const test = this.#testPlan.tests.find((t) => t.id === testId);
            if (test === undefined) {
                return `Error: test_id "${testId}" not found in the current test plan.`;
            }
            // Mark as running
            test.status = 'running';
            this.emit('STATE_CHANGED', {
                message: this.#formatPlanSummary(this.#testPlan),
                phase: 'validate',
                testPlan: this.#testPlan,
            });
        }

        this.emit('TOOL_USED', { toolName: 'run_test', input: { testId, description: description.slice(0, 200) }, phase: 'qa' });

        // Determine available ports
        const hasBackendPort = this.#sandbox?.backendPort !== undefined;
        const hasWebPort = this.#sandbox?.webPort !== undefined;
        const ports: { backend?: number; web?: number } = {};
        if (hasBackendPort) ports.backend = this.#sandbox!.backendPort;
        if (hasWebPort) ports.web = this.#sandbox!.webPort;

        // Spawn executor
        const executorId = `test-executor.${uuidv4().slice(0, 8)}`;
        const executor = new TestExecutor(executorId, this.traceId, this.agentId, this.#browserSession);

        try {
            let result = await executor.run(description, this.#sandbox, ports);
            let finalDescription = description;

            // If test failed, invoke debugger to diagnose before accepting the failure
            if (!result.passed) {
                const debuggerId = `test-debugger.${uuidv4().slice(0, 8)}`;
                const debugAgent = new TestDebugger(debuggerId, this.traceId, this.agentId, this.#browserSession);

                try {
                    const debugResult = await debugAgent.run(
                        description, result, this.#sandbox, ports, this.#artifactSummary,
                    );

                    if (debugResult.verdict === 'test_fixed' && debugResult.retestResult !== undefined) {
                        // Test was wrong — use the corrected result
                        result = debugResult.retestResult;
                        if (debugResult.correctedDescription !== undefined) {
                            finalDescription = debugResult.correctedDescription;
                        }
                        logger.info(`[${this.agentId}] Test debugger fixed test ${testId}: now ${result.passed ? 'passed' : 'failed'}`);
                    } else {
                        logger.info(`[${this.agentId}] Test debugger confirmed code_bug for test ${testId}`);
                    }
                } catch (debugErr) {
                    const debugMsg = debugErr instanceof Error ? debugErr.message : String(debugErr);
                    logger.warn(`[${this.agentId}] Test debugger failed for ${testId}: ${debugMsg} — using original failure`);
                }
            }

            // Update test plan with result
            if (this.#testPlan !== null) {
                const test = this.#testPlan.tests.find((t) => t.id === testId);
                if (test !== undefined) {
                    test.status = result.passed ? 'passed' : 'failed';
                    test.result = result.result;
                    // Update description if debugger corrected it
                    if (finalDescription !== description) {
                        test.description = finalDescription;
                    }
                }
                this.emit('STATE_CHANGED', {
                    message: this.#formatPlanSummary(this.#testPlan),
                    phase: 'validate',
                    testPlan: this.#testPlan,
                });
            }

            return JSON.stringify({
                test_id: testId,
                passed: result.passed,
                result: result.result,
                evidence: result.evidence ?? null,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] Test executor ${executorId} failed: `, err);

            if (this.#testPlan !== null) {
                const test = this.#testPlan.tests.find((t) => t.id === testId);
                if (test !== undefined) {
                    test.status = 'failed';
                    test.result = `Executor error: ${msg}`;
                }
            }

            return JSON.stringify({ test_id: testId, passed: false, result: `Executor error: ${msg}` });
        }
    }

    // ── Test plan management ──────────────────────────────────────────────────

    #handleUpdateTestPlan(args: Record<string, unknown>): string {
        const tests = args['tests'];
        if (!Array.isArray(tests)) {
            return 'Error: tests must be an array';
        }

        const parsed = QaTestPlanSchema.safeParse({ tests });
        if (!parsed.success) {
            return `Error: Invalid test plan: ${parsed.error.message}`;
        }

        this.#testPlan = parsed.data;
        const summary = this.#formatPlanSummary(parsed.data);

        this.emit('STATE_CHANGED', {
            message: summary,
            phase: 'validate',
            testPlan: parsed.data,
        });

        this.emit('TOOL_USED', {
            toolName: 'update_test_plan',
            input: { testCount: parsed.data.tests.length, tests: parsed.data.tests },
            phase: 'qa',
        });

        return summary;
    }

    #handleSubmitVerdict(args: Record<string, unknown>): string {
        const issues = Array.isArray(args['issues']) ? (args['issues'] as unknown[]).map(String) : [];
        const warnings = Array.isArray(args['warnings']) ? (args['warnings'] as unknown[]).map(String) : [];
        const stepsToReproduce = Array.isArray(args['stepsToReproduce']) ? (args['stepsToReproduce'] as unknown[]).map(String) : [];
        const summary = typeof args['summary'] === 'string' ? args['summary'] : '';

        // Validate: no tests should be pending or running
        if (this.#testPlan !== null) {
            const incomplete = this.#testPlan.tests.filter(
                (t) => t.status === 'pending' || t.status === 'running',
            );
            if (incomplete.length > 0) {
                return `Error: ${incomplete.length.toString()} test(s) still pending/running: ${incomplete.map((t) => t.id).join(', ')}. Complete or skip them first.`;
            }
        }

        // Auto-enforce severity model
        let hasBlockingFailure = false;
        if (this.#testPlan !== null) {
            for (const t of this.#testPlan.tests) {
                if (t.status === 'failed' && (t.severity === 'blocking' || t.severity === undefined)) {
                    hasBlockingFailure = true;
                    break;
                }
            }
        }
        const enforced = !hasBlockingFailure;
        const llmPassed = args['passed'] === true;
        if (enforced !== llmPassed) {
            logger.info(`[${this.agentId}] Verdict auto-corrected: LLM said passed=${String(llmPassed)}, enforced passed=${String(enforced)}`);
        }

        this.#verdictSubmitted = true;
        this.#pendingVerdict = { passed: enforced, issues, warnings, stepsToReproduce, summary };

        this.emit('TOOL_USED', {
            toolName: 'submit_qa_verdict',
            input: { passed: enforced, issueCount: issues.length, warningCount: warnings.length },
            phase: 'qa',
        });

        return JSON.stringify({ accepted: true, passed: enforced, issueCount: issues.length, warningCount: warnings.length });
    }

    #formatPlanSummary(plan: QaTestPlan): string {
        const counts = { pending: 0, running: 0, passed: 0, failed: 0, skipped: 0 };
        for (const t of plan.tests) counts[t.status]++;
        const parts: string[] = [];
        if (counts.pending > 0) parts.push(`${counts.pending.toString()} pending`);
        if (counts.running > 0) parts.push(`${counts.running.toString()} running`);
        if (counts.passed > 0) parts.push(`${counts.passed.toString()} passed`);
        if (counts.failed > 0) parts.push(`${counts.failed.toString()} failed`);
        if (counts.skipped > 0) parts.push(`${counts.skipped.toString()} skipped`);
        return `Test plan: ${plan.tests.length.toString()} tests (${parts.join(', ')})`;
    }

    // ── Sandbox log streaming ────────────────────────────────────────────────

    #emitSandboxLogs(sandbox: SandboxHandle, offsets: Record<string, number>): void {
        const logFiles: Array<{ file: string; source: string }> = [
            { file: '/tmp/backend.log', source: 'backend' },
            { file: '/tmp/frontend.log', source: 'frontend' },
        ];

        for (const { file, source } of logFiles) {
            try {
                const skip = offsets[source] ?? 0;
                const cmd = `docker exec ${sandbox.containerName} tail -c +${(skip + 1).toString()} ${file} 2>/dev/null`;
                const chunk = execSync(cmd, { encoding: 'utf8', timeout: 5_000 });
                if (chunk.length > 0) {
                    offsets[source] = skip + chunk.length;
                    for (const line of chunk.split('\n')) {
                        if (line.trim().length > 0) {
                            this.emit('SANDBOX_LOG', { text: line.trimEnd(), source });
                        }
                    }
                }
            } catch {
                // File doesn't exist yet or container gone
            }
        }
    }

    // ── Verdict parsing (fallback) ──────────────────────────────────────────

    #parseVerdict(raw: string): QaVerdict {
        try {
            const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
            const match = /\{[\s\S]+\}/m.exec(json);
            if (match) {
                type RawV = { passed: unknown; issues: unknown; checksRun: unknown; visualDescription: unknown; summary: unknown };
                const parsed = JSON.parse(match[0]) as RawV;
                const plan: QaTestPlan | null = this.#testPlan;
                return {
                    passed: parsed.passed === true,
                    issues: Array.isArray(parsed.issues) ? (parsed.issues as unknown[]).map(String) : [],
                    warnings: [],
                    checksRun: Array.isArray(parsed.checksRun) ? (parsed.checksRun as unknown[]).map(String) : [],
                    visualDescription: typeof parsed.visualDescription === 'string' ? parsed.visualDescription : 'N/A',
                    ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
                    ...(plan !== null ? { testPlan: plan } : {}),
                };
            }
        } catch (e) {
            logger.warn(`[${this.agentId}] Failed to parse verdict JSON: `, e);
        }

        const lower = raw.toLowerCase();
        const failSignals = ['fail', 'error', 'issue', 'broke', 'missing', 'refused', 'timeout', '404', '500'];
        const passSignals = ['pass', 'success', 'all checks passed', 'no issues'];
        const hasFail = failSignals.some((s) => lower.includes(s));
        const hasPass = passSignals.some((s) => lower.includes(s));
        const inferredPass = hasPass && !hasFail;

        logger.warn(`[${this.agentId}] No JSON verdict found — inferred ${inferredPass ? 'PASS' : 'FAIL'} from prose`);
        const fallbackPlan: QaTestPlan | null = this.#testPlan;
        return {
            passed: inferredPass,
            issues: inferredPass ? [] : [`QA wrote prose instead of JSON (inferred FAIL): ${raw.slice(0, 300)}`],
            warnings: [],
            checksRun: ['inferred-from-prose'],
            visualDescription: raw.slice(0, 200),
            ...(fallbackPlan !== null ? { testPlan: fallbackPlan } : {}),
        };
    }
}
