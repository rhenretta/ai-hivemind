/**
 * qaEngineer.ts — QA Engineer Agent (RPIV: Validate phase — ACTIVE)
 *
 * Self-directed testing agent that:
 *  1. Creates a structured testing plan (via update_test_plan tool)
 *  2. Executes tests iteratively, updating status as it goes
 *  3. Revises the plan when discoveries warrant new tests
 *  4. Submits a comprehensive verdict (via submit_qa_verdict tool)
 *
 * Tool whitelist: execute_cli_command, http_get, browser_navigate,
 *                 browser_screenshot, browser_click, browser_fill,
 *                 browser_wait_for, browser_get_text, browser_evaluate,
 *                 update_test_plan, submit_qa_verdict
 *
 * Tier 2 constraints:
 *  - No spawning of sub-agents
 *  - Read/execute only — constrained tool set enforced in #dispatchTool
 *  - Emits QA_VERDICT event on the event bus
 */

import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { v4 as uuidv4 } from 'uuid';

import { generateWithRawTools, extractTextContent } from '../services/llm.js';
import { executeTool } from '../services/mcpExecutor.js';
import { QaBrowserSession } from '../services/qaBrowser.js';
import { logger } from '../services/logger.js';
import { eventBus } from '../eventBus.js';
import type { SandboxHandle } from '../services/sandboxManager.js';

import { BaseAgent } from './baseAgent.js';

import { QaTestPlanSchema } from '@ai-hivemind/shared';
import type { SweArtifact, UxDesignSpec, QaTestPlan, TaskGraph } from '@ai-hivemind/shared';
import type OpenAI from 'openai';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_QA_TURNS = 25;
const MONOREPO_ROOT = process.env['MONOREPO_ROOT'] ?? '/Users/rhenretta/workspace/rhenretta/ai-hivemind';

// ── Tool whitelist ────────────────────────────────────────────────────────────

const QA_TOOL_NAMES = new Set([
    'execute_cli_command', 'http_get',
    'browser_navigate', 'browser_screenshot', 'browser_click',
    'browser_fill', 'browser_wait_for', 'browser_get_text', 'browser_evaluate',
    'update_test_plan', 'submit_qa_verdict',
]);

// ── Endpoint extraction from SWE summary ────────────────────────────────────
// The SWE artifact summary often mentions the actual endpoints that were built
// (e.g., "/api/reddit/posts", "http://localhost:3001/api/foo"). These are MORE
// reliable than inferred endpoints from file paths, so they take precedence.

function extractEndpointsFromSummary(summary: string): { urls: string[]; paths: string[] } {
    const urls: string[] = [];
    const paths: string[] = [];

    // Match full URL patterns like http://localhost:3001/api/foo/bar
    for (const m of summary.matchAll(/https?:\/\/localhost:\d+\/[\w/.%-]+/g)) {
        if (!urls.includes(m[0])) urls.push(m[0]);
    }

    // Match API path patterns like /api/foo/bar (not preceded by filesystem chars)
    for (const m of summary.matchAll(/(?:^|[\s"'`(])(\/?api\/[\w/.%-]+)/gm)) {
        const path = m[1]!.startsWith('/') ? m[1]! : `/${m[1]!}`;
        // Don't duplicate if already captured as a full URL
        if (!paths.includes(path) && !urls.some((u) => u.includes(path))) {
            paths.push(path);
        }
    }

    // Match route/endpoint mentions like "endpoint at /foo", "route /bar", "registered /baz"
    for (const m of summary.matchAll(/(?:route|endpoint|path|registered|mounted|serves?)\s+(?:at\s+)?["'`]?(\/[\w/.%-]+)["'`]?/gi)) {
        const path = m[1]!;
        if (!paths.includes(path) && !urls.some((u) => u.includes(path)) && path !== '/') {
            paths.push(path);
        }
    }

    return { urls, paths };
}

// ── Endpoint inference ────────────────────────────────────────────────────────
// Derive probable API routes and frontend pages from filesystem paths.
// This prevents the LLM from using raw file paths (e.g., apps/backend/src/routes/redditPosts.ts)
// as HTTP endpoints (which produces nonsense URLs).

function inferEndpoints(filesChanged: string[], hasBackend: boolean, hasFrontend: boolean): string {
    const lines: string[] = [];

    // Infer backend API routes from backend route files
    if (hasBackend) {
        const routeFiles = filesChanged.filter((f) =>
            f.includes('apps/backend') && (f.includes('/routes/') || f.includes('/api/')),
        );
        if (routeFiles.length > 0) {
            lines.push('Probable backend API endpoints (derived from changed route files):');
            for (const f of routeFiles) {
                // Extract the route name from the file path
                // e.g., apps/backend/src/routes/redditPosts.ts → /api/redditPosts
                const match = /(?:routes|api)\/([^/]+?)(?:\.ts|\.js)?$/.exec(f);
                if (match?.[1]) {
                    const routeName = match[1];
                    lines.push(`  - http://localhost:3001/api/${routeName} (from ${f})`);
                }
            }
            lines.push('  Note: Check the actual route registration in server.ts to confirm exact paths.');
        }
    }

    // Infer frontend pages from Next.js app router file paths
    if (hasFrontend) {
        const pageFiles = filesChanged.filter((f) =>
            f.includes('apps/web/src/app/') && f.endsWith('page.tsx'),
        );
        if (pageFiles.length > 0) {
            lines.push('Probable frontend pages (derived from Next.js app router):');
            for (const f of pageFiles) {
                // e.g., apps/web/src/app/reddit/page.tsx → /reddit
                const match = /apps\/web\/src\/app\/(.+?)\/page\.tsx$/.exec(f);
                if (match?.[1]) {
                    lines.push(`  - http://localhost:3000/${match[1]}`);
                }
            }
        }
    }

    if (lines.length === 0) {
        return '';
    }

    return lines.join('\n');
}

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
            name: 'browser_navigate',
            description: 'Navigate the browser to a URL. By default waits for network idle (no pending requests for 500ms) — dynamically detects when async data fetches complete. No need to guess wait times.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to navigate to' },
                    wait_until: { type: 'string', enum: ['networkidle', 'load', 'domcontentloaded'], description: 'When to consider navigation done. Default: networkidle (waits for all fetch() calls to finish).', default: 'networkidle' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_screenshot',
            description: 'Take a screenshot of the current page. Call this AFTER navigating and verifying content is loaded. Returns base64 PNG for visual analysis.',
            parameters: {
                type: 'object',
                properties: {
                    full_page: { type: 'boolean', description: 'Capture full scrollable page (true) or just the viewport (false). Default: true.', default: true },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_click',
            description: 'Click an element by CSS selector. Use for buttons, links, tabs, toggles.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector for the element to click (e.g., "button.submit", "#login-btn", "a[href=\'/about\']")' },
                    timeout_ms: { type: 'number', description: 'Max time to wait for element to be clickable (ms). Choose based on context: 10000 for static elements, 30000 for dynamically loaded content.' },
                },
                required: ['selector'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_fill',
            description: 'Fill a form input with text. Works with <input>, <textarea>, and [contenteditable] elements.',
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
            description: 'Wait for a DOM element to reach a specific state. Use to wait for loading spinners to disappear, content to appear, or modals to show/hide. You MUST specify timeout_ms — think about the data flow: static content (10s), local DB (15-20s), external API like Reddit/Twitter (45-60s), AI/LLM chain (60s).',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector to wait for' },
                    state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'], description: 'Desired state. "visible" = element exists and is visible. "hidden" = element is gone or invisible. Default: visible.', default: 'visible' },
                    timeout_ms: { type: 'number', description: 'REQUIRED. Max wait time in ms. Choose based on data source: 10000 for static/pre-rendered content, 15000-20000 for local DB queries, 30000 for simple API calls, 45000-60000 for external APIs (Reddit, Twitter, etc.), 60000 for AI/LLM processing chains.' },
                },
                required: ['selector', 'timeout_ms'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_get_text',
            description: 'Read text content from an element or the entire page. Useful for verifying rendered content without taking a screenshot.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector to read text from. If omitted, returns full page body text.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'browser_evaluate',
            description: 'Execute JavaScript in the page context. Returns the JSON-stringified result. Use for advanced checks like counting elements, reading computed styles, or checking React state.',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'JavaScript expression to evaluate (e.g., "document.querySelectorAll(\'.post-card\').length")' },
                },
                required: ['expression'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_test_plan',
            description: 'Create or update the QA testing plan. Call this FIRST to create your plan, then after each test to update its status and results. You may add new tests or modify existing ones at any time. Each call replaces the entire plan.',
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
                                description: { type: 'string', description: 'What this test verifies' },
                                type: { type: 'string', enum: ['api', 'visual', 'build', 'content', 'interaction', 'custom'], description: 'Test category' },
                                status: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'skipped'], description: 'Current status' },
                                result: { type: 'string', description: 'Explanation of pass/fail/skip (required for non-pending tests)' },
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
            name: 'submit_qa_verdict',
            description: 'Submit the final QA verdict after completing all tests. This terminates the QA session. All tests in the plan must be in a terminal state (passed, failed, or skipped) before calling this.',
            parameters: {
                type: 'object',
                properties: {
                    passed: { type: 'boolean', description: 'Overall pass/fail verdict' },
                    issues: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Specific, actionable issues found (empty array if passed)',
                    },
                    stepsToReproduce: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Ordered steps the SWE can follow to reproduce each issue (e.g., "1. Start backend: pnpm --filter @ai-hivemind/backend dev", "2. GET http://localhost:3001/api/posts", "3. Observe: response is empty array []"). Empty array if passed.',
                    },
                    summary: { type: 'string', description: 'Comprehensive test report summarizing all findings' },
                },
                required: ['passed', 'issues', 'stepsToReproduce', 'summary'],
            },
        },
    },
];

// ── Task graph context builder ────────────────────────────────────────────────
// Tells QA what has been built (done), what it's testing now (active), and
// what hasn't been implemented yet (pending/planned). This prevents QA from
// testing things that belong to future tasks.

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
    lines.push('implemented yet — their code does not exist. Do NOT test, screenshot, or probe services');
    lines.push('from PLANNED tasks. Tasks marked DONE are already validated — you may rely on their');
    lines.push('endpoints being available if the current task depends on them.');

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

    // Derive probable API routes and frontend pages from file paths
    const inferredEndpoints = inferEndpoints(artifact.filesChanged, hasBackendFiles, hasFrontendFiles);

    // Extract ACTUAL endpoints mentioned in the SWE's output summary.
    const extracted = extractEndpointsFromSummary(artifact.summary);
    const hasExtracted = extracted.urls.length > 0 || extracted.paths.length > 0;
    const extractedSection = hasExtracted
        ? [
            'ACTUAL ENDPOINTS from SWE output (USE THESE — they are more reliable than inferred ones):',
            ...extracted.urls.map((u) => `  - ${u}`),
            ...extracted.paths.map((p) => `  - http://localhost:${hasBackendFiles ? '3001' : '3000'}${p}`),
        ].join('\n')
        : '';

    const liveUrlHint = serviceUrl !== undefined
        ? serviceUrl
        : hasBackendFiles ? backendBase : hasFrontendFiles ? frontendBase : null;

    const isSandboxMode = sandbox !== undefined;
    const workDir = sandbox?.workDir ?? MONOREPO_ROOT;

    // Design spec section
    const designSection = designSpec !== undefined
        ? `
UX DESIGN SPEC (benchmark for visual validation):
  Layout: ${designSpec.layout}
  Components: ${designSpec.componentHierarchy}
  Styling: ${designSpec.styling}${isSandboxMode ? `
  Wireframe:
${designSpec.wireframe}` : ''}
  UX Acceptance Criteria:
${designSpec.uxAcceptanceCriteria}`
        : '';

    const hasDesign = designSpec !== undefined;

    // Build task graph context so QA knows what's done, active, and planned
    const taskGraphSection = buildTaskGraphSection(taskGraph, subtask);

    // Build prior issues section for retry runs
    const isRetry = priorIssues !== undefined && priorIssues.length > 0;
    const priorIssuesSection = isRetry
        ? `
PRIOR QA ISSUES (from previous run — the SWE attempted to fix these):
${priorIssues.map((issue) => `  - ${issue}`).join('\n')}

YOUR PRIORITY: Re-test each prior issue above to verify the fix. Your test plan MUST include
a specific test for EACH prior issue. If the fix works, mark it passed. If not, report the
SAME issue again (not a different variation). Do NOT invent new test categories that weren't
in the previous run — the SWE can only fix what was reported.
`
        : '';

    // Common three-phase instructions (used in both sandbox and live modes)
    const testingProcess = `
## Your Testing Process

You have a **persistent browser session** and these tools:

### Test Management
- **update_test_plan** — Create or update your structured testing plan (call this FIRST, then after each test)
- **submit_qa_verdict** — Submit your final verdict when all tests are complete (call this LAST)

### API Testing
- **http_get** — Probe HTTP endpoints and inspect responses. Supports \`timeout_ms\` parameter (default: 10s).
- **execute_cli_command** — Run shell commands (curl, jq, etc.)

### Browser Testing (persistent session — state carries across calls)
- **browser_navigate** — Navigate to a URL. Waits for \`networkidle\` by default (all fetch() calls complete — no guessing wait times!)
- **browser_screenshot** — Capture the current page as a screenshot for visual analysis
- **browser_click** — Click an element by CSS selector (buttons, links, tabs, toggles)
- **browser_fill** — Fill a form input by CSS selector
- **browser_wait_for** — Wait for an element to appear, disappear, or change visibility
- **browser_get_text** — Read text content from the page or a specific element
- **browser_evaluate** — Execute JavaScript in the page context (count elements, check styles, etc.)

### Timeout Strategy — THINK BEFORE YOU WAIT
You MUST choose timeout_ms values intelligently for every call. There are NO good defaults —
the right timeout depends entirely on the data flow behind what you're testing.

**Before choosing a timeout, ask yourself:** What has to happen before this element/response appears?
Trace the FULL data flow: browser → frontend → backend → data source → back through each layer.

**http_get timeout_ms:**
| Data flow | timeout_ms | Reasoning |
|---|---|---|
| Health check, static routes | 10000 | No processing needed |
| Local DB read/write | 15000 | Single DB round-trip |
| External API (Reddit, Twitter, etc.) | 30000-45000 | Network hop to third-party + their processing |
| AI/LLM call (OpenAI, sentiment analysis) | 45000-60000 | LLM inference is inherently slow |
| Chained: external API → AI filter → transform | 60000 | Multiple slow hops compound |

**browser_wait_for timeout_ms (REQUIRED — you must always specify this):**
| What's happening behind the element | timeout_ms | Reasoning |
|---|---|---|
| Static/pre-rendered content, simple DOM | 10000 | Already available, just mounting |
| Content from local database | 15000-20000 | DB query + render |
| Content from your own backend API | 20000-30000 | Backend processing + render |
| Content from external APIs (Reddit, Twitter) | 45000-60000 | Browser → backend → external API → parse → render |
| Content requiring AI/LLM processing | 60000 | Slowest possible path |

**Example reasoning for a Reddit doomscroll page:**
  The page fetches Reddit posts: browser → Next.js → backend → Reddit API → filter → return → render.
  Reddit's API can take 5-15s alone, plus backend processing and frontend rendering.
  Correct timeout: 60000ms for browser_wait_for('.post-card', { timeout_ms: 60000 })
  WRONG: Using 10000ms and then reporting "timed out" as a bug — that's YOUR timeout being too short!

### Browser Testing Workflow
NOTE: A screenshot is automatically captured after every browser action (navigate, click, fill,
wait_for) — you do NOT need to call browser_screenshot manually unless you want an extra capture
at a specific moment. The auto-screenshots are emitted to the Command Center for visual debugging.

**CRITICAL — DISCOVER SELECTORS, NEVER GUESS THEM:**
You do NOT know what CSS classes the SWE used. Never invent selectors like \`.post-card\`, \`.arrow-nav\`,
\`.results-list\` — those are GUESSES and will fail if the SWE used different class names.

**ALWAYS discover the actual DOM structure FIRST** by using browser_evaluate after navigation:
\`\`\`
browser_evaluate({ expression: "document.querySelector('main')?.innerHTML.slice(0, 1000) || document.body.innerHTML.slice(0, 1000)" })
\`\`\`
This reveals the REAL class names, element structure, and content. Then use those actual selectors.

For frontend/visual tests, use this pattern:
1. **browser_navigate**(url) — waits for all network activity to settle (auto-screenshot taken)
2. **browser_evaluate** — inspect the DOM to discover actual selectors: what classes, IDs, data attributes exist?
3. **browser_wait_for**(REAL_selector, { timeout_ms: ??? }) — use the selectors you DISCOVERED, not guessed
4. **browser_get_text**(selector) — verify text content matches expectations
5. **browser_screenshot** — take a screenshot to SEE the page (auto-screenshots go to Command Center, not to you)

For interactive/form tests:
1. **browser_navigate**(url) — go to the page (auto-screenshot taken)
2. **browser_evaluate** — discover form selectors (input names, button text, form structure)
3. **browser_fill**(REAL_selector, 'test query') — use discovered selector (auto-screenshot taken)
4. **browser_click**(REAL_selector) — use discovered selector (auto-screenshot taken)
5. **browser_wait_for**(REAL_selector, { state: 'visible', timeout_ms: ??? }) — use discovered selector

If a page shows a loading spinner after navigation:
1. **browser_wait_for**('.loading-spinner, [class*="loading"], [class*="spinner"]', { state: 'hidden', timeout_ms: ??? }) — use broad selector
2. **browser_evaluate** — discover what content selectors actually exist now that loading is done
3. **browser_wait_for**(REAL_selector, { state: 'visible', timeout_ms: ??? }) — use discovered selector

**TIMEOUT + SELECTOR RECOVERY RULE:** If browser_wait_for times out, the element may exist under a
DIFFERENT selector. Before reporting failure:
1. Take a **browser_screenshot** to SEE the page
2. Run **browser_evaluate** to inspect what's actually in the DOM
3. If content IS present under a different selector, retry with the correct one
4. Only report "element not found" if you have CONFIRMED via screenshot + DOM inspection that the content truly doesn't exist
The browser handles network-level waiting automatically. Use browser_wait_for for DOM-level state changes.
Auto-screenshots at each step let you (and the user) see exactly what the page looks like.

CRITICAL: If browser_wait_for times out, there are TWO possible causes:
1. Your timeout was too short for the data flow → increase timeout and retry
2. You GUESSED the wrong selector → the element exists under a different class name
Before reporting ANY browser_wait_for failure:
  a) Take a browser_screenshot to SEE the page
  b) Run browser_evaluate to inspect the actual DOM structure
  c) If content IS there under a different selector, use that selector instead
  d) Only report failure if the content is CONFIRMED missing via screenshot + DOM inspection
A page that fetches from Reddit with a 10s timeout WILL time out — that's not a bug, it's a bad timeout.
A page showing real content that you can't find because you guessed \`.post-card\` instead of the
actual class name — that's YOUR selector being wrong, not a code bug.

### Phase 1: Plan Your Tests
Analyze the SWE artifact, acceptance criteria, ${hasDesign ? 'design spec, ' : ''}and available endpoints.
Call **update_test_plan** with a comprehensive set of tests. Aim for 5-8 targeted tests covering:
${hasBackendFiles ? '- API endpoint probes (health check, each relevant endpoint) — use http_get' : ''}
${hasBackendFiles ? '- Response content validation (correct data structure, non-empty results) — use http_get' : ''}
${hasFrontendFiles ? '- Visual validation (navigate, wait for content, screenshot) — use browser tools' : ''}
${hasFrontendFiles && hasDesign ? '- Design spec compliance (layout matches wireframe, key components present)' : ''}
${hasFrontendFiles ? '- Loading state check (page must show REAL DATA, not spinners) — use browser_wait_for + browser_get_text' : ''}
${hasFrontendFiles ? '- Interactive features (forms, buttons, navigation) — use browser_click, browser_fill' : ''}
- Any other checks relevant to the acceptance criteria

### Phase 2: Execute & Revise Tests
For each test in your plan:
1. Call **update_test_plan** to mark the test as \`running\`
2. Execute the test using the appropriate tools (http_get for APIs, browser_* for frontend)
3. Call **update_test_plan** to mark the test as \`passed\` or \`failed\` with a detailed result
4. If you discover something unexpected, ADD new tests to the plan

IMPORTANT: When you discover a failed test, be SPECIFIC in the result — include the URL you probed,
what you expected, and what you actually got. Vague results like "it didn't work" are useless.

### Phase 3: Submit Verdict
After ALL tests are complete (no pending or running tests), call **submit_qa_verdict** with:
- \`passed\`: true only if ALL tests passed (or non-critical ones are skipped with good reason)
- \`issues\`: specific, actionable issues the SWE can fix (empty if passed)
- \`stepsToReproduce\`: ordered steps the SWE can follow to reproduce each failure (empty if passed).
  Write these as numbered CLI commands and observations so the SWE can copy-paste them to verify the fix.
- \`summary\`: comprehensive report of everything you tested and found

IMPORTANT RULES:
- **ACCEPTANCE CRITERIA RULE (CRITICAL):** Your tests MUST be derived from the ACCEPTANCE CRITERIA above.
  Every test in your plan must trace back to a specific acceptance criterion or a directly implied requirement.
  Do NOT invent requirements that aren't stated or clearly implied. For example, if the acceptance criteria
  says "GET /api/posts returns a JSON array of posts", you should test:
    ✅ GET /api/posts returns 200 with a JSON array (stated)
    ✅ Array items have expected fields (directly implied)
    ✅ Health check works (infrastructure prerequisite)
    ❌ POST to a GET endpoint returns a method-specific error (INVENTED — not in criteria)
    ❌ Invalid query parameters return an error (INVENTED — not in criteria)
    ❌ 404 returns JSON instead of HTML (INVENTED — not in criteria)
  If the acceptance criteria doesn't mention error handling, DON'T test error handling.
  If it doesn't mention input validation, DON'T test input validation.
  Inventing requirements that the SWE was never told to implement is a CRITICAL QA ERROR.
- **SCOPE RULE:** ONLY test what THIS TASK requires. If no frontend files were changed, do NOT use
  browser tools to test frontend rendering — it may not exist yet. If no backend files were changed, do NOT probe
  backend endpoints. Failing a task because an unrelated service hasn't been built yet is a critical QA error.
  The "files changed" list tells you exactly what was implemented. Stick to that scope.
- **STABILITY RULE:** On retries, your test plan must be STABLE — test the same things the previous QA tested,
  plus verify that specific prior issues have been fixed. NEVER introduce NEW test categories on a retry that
  weren't tested in the first run. The SWE can only fix what you reported; inventing new failures on each
  retry creates an impossible moving target.
- Any test with \`failed\` status means the overall verdict should be \`passed: false\`
- A page stuck on "Loading..." after browser_navigate + browser_wait_for is an AUTOMATIC FAIL
- Unstyled HTML (raw browser defaults, no CSS) is an AUTOMATIC FAIL
- Do NOT re-run pnpm build — the SWE already verified compilation. Focus on runtime behavior.
- **TIMEOUT RETRY RULE:** If browser_wait_for times out, consider whether you used a long enough timeout
  for the data flow. If the page fetches from an external API and you used < 45000ms, RETRY with a longer
  timeout before reporting failure. A short timeout is YOUR mistake, not a code bug.

BAD TEST PLAN (never do this):
  [{ id: "check-all", name: "Check everything", description: "Test the whole feature", ... }]

GOOD TEST PLAN (always be specific — and ONLY include tests for what was changed):
${hasBackendFiles && hasFrontendFiles ? `  Backend + Frontend example:
  [
    { id: "backend-health", name: "Backend health check", type: "api", description: "GET /health returns 200" },
    { id: "api-posts", name: "GET /api/posts returns data", type: "api", description: "Endpoint returns non-empty array of posts" },
    { id: "api-posts-schema", name: "Posts response schema", type: "content", description: "Each post has title, author, score fields" },
    { id: "frontend-render", name: "Page renders content", type: "visual", description: "Navigate, discover DOM structure via browser_evaluate, verify real content is present" },
    { id: "frontend-styling", name: "Proper CSS styling", type: "visual", description: "browser_evaluate checks Tailwind classes exist on main container" },
    { id: "frontend-interaction", name: "Interaction works", type: "interaction", description: "Discover interactive element selectors via browser_evaluate, click, verify state change" },
  ]` : hasBackendFiles ? `  Backend-only example (NO frontend tests — frontend was not changed):
  [
    { id: "backend-health", name: "Backend health check", type: "api", description: "GET /health returns 200" },
    { id: "api-posts", name: "GET /api/posts returns data", type: "api", description: "Endpoint returns non-empty array of posts" },
    { id: "api-posts-schema", name: "Posts response schema", type: "content", description: "Each post has title, author, score fields" },
    { id: "api-response-time", name: "Response completes", type: "api", description: "Endpoint responds within timeout (not hanging)" },
  ]` : `  Frontend-only example (NO backend tests — backend was not changed):
  [
    { id: "frontend-discover", name: "Discover page structure", type: "visual", description: "Navigate, use browser_evaluate to find actual CSS classes and element structure" },
    { id: "frontend-render", name: "Page shows real data", type: "visual", description: "Using discovered selectors, verify content is present, take screenshot" },
    { id: "frontend-styling", name: "Proper CSS styling", type: "visual", description: "browser_evaluate confirms Tailwind classes on container elements" },
    { id: "frontend-interaction", name: "Interactive features work", type: "interaction", description: "Using discovered selectors, click/interact and verify response" },
  ]`}

ISSUES FORMAT — each issue MUST be specific and actionable so the SWE can fix it:
BAD (too vague — NEVER write issues like these):
  - "Layout does not match wireframe"
  - "Missing components"
  - "Page not working correctly"
GOOD (specific — ALWAYS write issues like these):
  - "GET http://localhost:54372/api/posts returned HTTP 200 but body is empty array [] — expected non-empty array with title, author, score fields"
  - "Screenshot of http://localhost:54372/doomscroll shows unstyled HTML — no Tailwind classes on main container, expected centered single-column layout"
  - "PostCard component missing from /doomscroll — browser_get_text('.main') returns raw JSON instead of styled card content"
Each issue must include: the URL you probed, what you expected, and what you actually found.

STEPS TO REPRODUCE — when the verdict fails, provide an ordered list the SWE can follow:
BAD (too vague):
  - "Start the server and check the endpoint"
GOOD (copy-pasteable):
  - "1. cd /workspace && pnpm --filter @ai-hivemind/backend dev"
  - "2. Wait 3 seconds for server to start"
  - "3. curl http://localhost:3001/api/reddit/posts"
  - "4. Observe: response is empty array [] — expected non-empty array of filtered posts"
  - "5. curl http://localhost:3001/health → returns 200 OK, so the server is running"
The SWE should be able to paste these commands to verify the fix works.`;

    if (isSandboxMode) {
        const { backendPort, webPort } = sandbox!;

        return `You are the QA Engineer agent in an autonomous software engineering swarm.

Your role is SANDBOX VALIDATION — comprehensively test the implementation inside an isolated Docker container.
All CLI commands (execute_cli_command) run inside the container automatically.

SUBTASK: ${subtask}

ACCEPTANCE CRITERIA: ${acceptanceCriteria}
${priorIssuesSection}${designSection}
${taskGraphSection}
SWE ARTIFACT:
${artifactSummary}

PROJECT ROOT (inside container): ${workDir}

SANDBOX PORTS:
${hasBackendFiles ? `  Backend: http://localhost:${backendPort.toString()}` : '  Backend: (no backend files changed — do NOT test backend endpoints)'}
${hasFrontendFiles ? `  Frontend: http://localhost:${webPort.toString()}` : '  Frontend: (no frontend files changed — do NOT test or screenshot the frontend)'}

DEV SERVERS:
${serversStarted.length > 0 ? `The following dev servers are PRE-STARTED and already running:\n${serversStarted.map((s) => `  ✓ ${s}`).join('\n')}\nDo NOT start them again.` : `No dev servers were pre-started. Start them before testing:\n${hasBackendFiles ? `  - Backend: execute_cli_command: "cd ${workDir} && pnpm --filter @ai-hivemind/backend dev &"` : '  - No backend files changed — skip'}\n${hasFrontendFiles ? `  - Frontend: execute_cli_command: "cd ${workDir} && pnpm --filter @ai-hivemind/web dev &"` : '  - No frontend files changed — skip'}\nWait a few seconds after starting, then begin testing.`}

AVAILABLE ENDPOINTS:
${extractedSection !== '' ? `${extractedSection}\n` : ''}${inferredEndpoints !== '' ? `Inferred endpoints (fallback — use only if SWE output above doesn't mention specific paths):\n${inferredEndpoints}\n` : ''}
CRITICAL: Read the SWE ARTIFACT summary above carefully. If it mentions specific endpoint paths
(e.g., "/api/reddit/posts"), test THOSE exact paths — not guessed variations.
IMPORTANT: The "files changed" list contains FILESYSTEM PATHS (e.g., apps/backend/src/routes/foo.ts).
Do NOT use filesystem paths as URL paths. Only probe actual HTTP API routes (e.g., /api/foo, /health).
IMPORTANT: Backend runs on port ${backendPort.toString()}, frontend on port ${webPort.toString()}. Use these ports in ALL URLs.
${testingProcess}`;
    }

    // ── Live mode ────────────────────────────────────────────────────────────

    const urlSection = liveUrlHint !== null
        ? `Live service base URL to probe: ${liveUrlHint}`
        : 'No explicit service URL. Probe http://localhost:3001 (backend) or http://localhost:3000 (frontend) based on what files were changed.';

    return `You are the QA Engineer agent in an autonomous software engineering swarm.

Your role is LIVE ENVIRONMENT VALIDATION — comprehensively test the implementation in the running system.
The SWE/Claude Code agent already ran tsc and build checks. Do NOT re-run those.

SUBTASK: ${subtask}

ACCEPTANCE CRITERIA: ${acceptanceCriteria}
${priorIssuesSection}${designSection}
${taskGraphSection}
SWE ARTIFACT:
${artifactSummary}

${urlSection}

MONOREPO ROOT: ${MONOREPO_ROOT}

AVAILABLE ENDPOINTS:
${extractedSection !== '' ? `${extractedSection}\n` : ''}${inferredEndpoints !== '' ? `Inferred endpoints (fallback — use only if SWE output doesn't mention specific paths):\n${inferredEndpoints}\n` : ''}
CRITICAL: Before testing, read the SWE ARTIFACT summary above. If it mentions specific endpoint paths
(e.g., "/api/reddit/posts", "/api/weather"), test THOSE exact paths.
IMPORTANT: The "files changed" list contains FILESYSTEM PATHS. Do NOT use them as URL paths.
${testingProcess}`;
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
    /** Comprehensive test report summarizing findings */
    summary?: string;
    /** Ordered steps to reproduce failures — gives the SWE a clear repro path */
    stepsToReproduce?: string[];
    /** Final state of the QA test plan */
    testPlan?: QaTestPlan;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class QaEngineer extends BaseAgent {
    /** Active sandbox handle for Docker-based validation */
    #sandbox: SandboxHandle | undefined;

    /** Persistent Playwright browser session for interactive testing */
    #browserSession: QaBrowserSession | null = null;

    /** Structured test plan managed by the QA LLM */
    #testPlan: QaTestPlan | null = null;

    /** Whether submit_qa_verdict has been called */
    #verdictSubmitted = false;

    /** Verdict args stored when submit_qa_verdict is called */
    #pendingVerdict: { passed: boolean; issues: string[]; stepsToReproduce: string[]; summary: string } | null = null;

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
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

        // Launch persistent Playwright browser session for interactive testing
        const allowedPorts = sandbox !== undefined
            ? Object.keys(sandbox.portMap).map(Number)
            : undefined;
        this.#browserSession = new QaBrowserSession(allowedPorts);
        await this.#browserSession.launch();

        const systemPrompt = buildQaSystemPrompt(
            subtask, acceptanceCriteria, artifact, serviceUrl,
            sandbox, serversStarted,
            designSpec ?? undefined,
            taskGraph,
            priorIssues,
        );

        const isRetry = priorIssues !== undefined && priorIssues.length > 0;

        const messages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: isRetry
                    ? 'Begin your QA validation. This is a RETRY — the SWE has attempted to fix the prior issues listed above. '
                      + 'Start by creating your testing plan with update_test_plan. Your plan MUST include a specific test for EACH '
                      + 'prior issue to verify the fix. Then add tests for the acceptance criteria. Execute each test.'
                    : 'Begin your QA validation. Start by creating your testing plan with update_test_plan, then execute each test.',
            },
        ];

        let verdict: QaVerdict = {
            passed: false,
            issues: ['QaEngineer did not complete testing'],
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
                    // LLM stopped calling tools.
                    // If verdict was already submitted via tool, we're done.
                    // Otherwise, fall back to parsing text as JSON verdict (backward compat).
                    if (!this.#verdictSubmitted) {
                        const raw = extractTextContent(completion).trim();
                        verdict = this.#parseVerdict(raw);
                    }
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
                    const isScreenshot = fnCall.function.name === 'browser_screenshot'
                        && !result.startsWith('[BROWSER_ERROR]');

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
                    const browserUrl = this.#browserSession?.getUrl() ?? serviceUrl ?? '';
                    messages.push({
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Here is the browser screenshot. Analyze it visually — does it render correctly? Is it properly styled? Does it show real data (not loading spinners or error pages)? Update your test plan accordingly and continue with your remaining tests.',
                            },
                            {
                                type: 'image_url',
                                image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' },
                            },
                        ],
                    });

                    // Emit screenshot event so the Command Center can display it
                    this.#emitScreenshot(b64, browserUrl);
                }

                // Check if verdict was submitted via tool
                if (this.#verdictSubmitted) break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[${this.agentId}] QA loop error: `, err);
            verdict = { passed: false, issues: [`QaEngineer error: ${msg}`], checksRun: [], visualDescription: 'N/A' };
        }

        // Build final verdict from submitted verdict or fallback.
        // TS control-flow analysis can't track mutations via #handleSubmitVerdict()
        // (called indirectly through #dispatchTool), so it narrows #verdictSubmitted
        // to `false` and #pendingVerdict to `null`. Widen with type assertions.
        const pv = this.#pendingVerdict as { passed: boolean; issues: string[]; stepsToReproduce: string[]; summary: string } | null;
        if ((this.#verdictSubmitted as boolean) && pv !== null) {
            const plan = this.#testPlan as QaTestPlan | null;
            verdict = {
                passed: pv.passed,
                issues: pv.issues,
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

        // Emit verdict event for Command Center visibility
        this.emit('QA_VERDICT', {
            subtask,
            passed: verdict.passed,
            issues: verdict.issues,
            checksRun: verdict.checksRun,
            visualDescription: verdict.visualDescription,
            summary: verdict.summary,
            stepsToReproduce: verdict.stepsToReproduce,
            testPlan: verdict.testPlan,
            artifactSuccess: artifact.success,
            filesChanged: artifact.filesChanged.length,
        });

        this.emit('STATE_CHANGED', {
            message: verdict.passed
                ? `QA PASSED ✓ — ${verdict.checksRun.length} tests run`
                : `QA FAILED ✗ — ${verdict.issues.length} issue(s): ${verdict.issues[0] ?? ''}`,
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
     * Pre-start dev servers inside the sandbox container so they're ready
     * by the time the QA LLM tries to probe endpoints.
     *
     * Handles two scenarios gracefully:
     *  - Fresh container: starts servers via `pnpm dev`
     *  - SWE already started servers: `pnpm dev` fails with EADDRINUSE — that's fine,
     *    the existing server is still running. We detect this in the polling phase.
     *
     * Returns a list of what's running (e.g. ["backend (localhost:55081)"]).
     */
    async #startSandboxServers(_artifact: SweArtifact, sandbox: SandboxHandle): Promise<string[]> {
        const workDir = sandbox.workDir;

        // 1:1 port mapping — same port inside and outside the container.
        // backendPort/webPort are set as env vars in the container at creation time.
        const { backendPort, webPort } = sandbox;
        const servers: Array<{ filter: string; label: string; port: number; healthPath: string; startExtra: string }> = [
            { filter: '@ai-hivemind/backend', label: 'backend', port: backendPort, healthPath: '/health', startExtra: '' },
            { filter: '@ai-hivemind/web', label: 'frontend', port: webPort, healthPath: '/', startExtra: '' },
        ];

        // Attempt to start each server (may fail if already running — that's OK)
        const portsToCheck: Array<{ label: string; port: number; healthPath: string }> = [];
        const ready = new Set<string>();
        for (const { filter, label, port, healthPath, startExtra } of servers) {
            portsToCheck.push({ label, port, healthPath });

            // Check if already responding before trying to start
            try {
                execSync(`curl -sf --max-time 2 http://localhost:${port.toString()}${healthPath}`, { stdio: 'pipe' });
                logger.info(`[${this.agentId}] ${label} already running on port ${port.toString()}`);
                ready.add(label);
                continue;
            } catch {
                // Not running yet — start it
            }

            const cmd = `cd ${workDir} && pnpm --filter ${filter} dev${startExtra} > /tmp/${label}.log 2>&1 &`;
            const dockerCmd = `docker exec ${sandbox.containerName} sh -c ${JSON.stringify(cmd)}`;
            try {
                execSync(dockerCmd, { stdio: 'pipe', timeout: 10_000 });
                logger.info(`[${this.agentId}] Started ${label} on port ${port.toString()}`);
            } catch (e) {
                logger.warn(`[${this.agentId}] Failed to start ${label} (may already be running):`, e);
            }
        }

        if (portsToCheck.length === 0) return [];

        // Skip polling entirely if all servers were already running
        if (ready.size >= portsToCheck.length) {
            logger.info(`[${this.agentId}] All servers already running — skipping warmup poll`);
        } else {
            this.emit('STATE_CHANGED', {
                message: `Waiting for dev server(s) to become ready...`,
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

            // Tail sandbox log files and emit new lines
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

        // Final log flush
        this.#emitSandboxLogs(sandbox, logOffsets);

        // Build result list and emit SERVICE_DEPLOYED for the frontend preview
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
                logger.warn(`[${this.agentId}] ${label} not ready after ${maxWait.toString()}ms — QA may fail to probe it`);
            }
        }

        if (started.length > 0) {
            logger.info(`[${this.agentId}] Dev servers ready: ${started.join(', ')}`);
        }

        // Warm up page routes so Next.js compiles them before QA probes.
        // No port rewriting needed — ports are the same inside and outside.
        const extracted = extractEndpointsFromSummary(_artifact.summary);
        const warmupUrls: string[] = [];
        for (const url of extracted.urls) {
            warmupUrls.push(url);
        }
        for (const p of extracted.paths) {
            const port = p.startsWith('/api') ? backendPort : webPort;
            warmupUrls.push(`http://localhost:${port.toString()}${p}`);
        }
        const pageFiles = _artifact.filesChanged.filter((f) =>
            f.includes('apps/web/src/app/') && f.endsWith('page.tsx'),
        );
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
                    // Warmup failure is non-fatal — the QA LLM will probe and report
                }
            }
            await sleep(2_000);
        }

        return started;
    }

    async #dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (!QA_TOOL_NAMES.has(name)) {
            return `Tool '${name}' is not authorized for QaEngineer.`;
        }

        // ── Agent-local tools (no sandbox routing needed) ────────────────────
        if (name === 'update_test_plan') {
            return this.#handleUpdateTestPlan(args);
        }
        if (name === 'submit_qa_verdict') {
            return this.#handleSubmitVerdict(args);
        }

        // ── Browser tools — routed through persistent QaBrowserSession ────
        if (name.startsWith('browser_')) {
            return this.#dispatchBrowserTool(name, args);
        }

        // ── Sandbox mode: route tools through Docker ──────────────────────
        if (this.#sandbox !== undefined) {
            if (name === 'execute_cli_command') {
                // Run CLI commands inside the container via docker exec
                const command = String(args['command'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 60_000;
                const dockerCmd = `docker exec ${this.#sandbox.containerName} sh -c ${JSON.stringify(command)}`;
                this.emit('TOOL_USED', { toolName: name, input: { command: dockerCmd }, phase: 'qa' });
                const result = await executeTool('execute_cli_command', { command: dockerCmd, timeout_ms: timeout });
                this.#emitToolResult(name, result);
                return result;
            }

            if (name === 'http_get') {
                // 1:1 port mapping — no URL rewriting needed.
                // Block requests to ports not in our portMap to prevent probing host services.
                const url = String(args['url'] ?? '');
                const knownPorts = Object.keys(this.#sandbox.portMap).map(Number);
                try {
                    const parsed = new URL(url);
                    const port = parseInt(parsed.port, 10);
                    if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && !knownPorts.includes(port)) {
                        this.emit('TOOL_USED', { toolName: name, input: { url, blocked: true }, phase: 'qa' });
                        const blockedMsg = `[BLOCKED] Port ${port.toString()} is not a sandbox port. Available: ${knownPorts.join(', ')}`;
                        this.#emitToolResult(name, blockedMsg);
                        return blockedMsg;
                    }
                } catch {
                    // Malformed URL — let it through, executeTool will handle
                }

                this.emit('TOOL_USED', { toolName: name, input: args, phase: 'qa' });

                // Retry on connection refused — dev server may be momentarily restarting
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

        this.emit('TOOL_USED', { toolName: name, input: args, phase: 'qa' });
        const result = await executeTool(name, args);
        this.#emitToolResult(name, result);
        return result;
    }

    // ── Browser tool dispatch ──────────────────────────────────────────────

    async #dispatchBrowserTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (this.#browserSession === null) {
            return '[BROWSER_ERROR] Browser session not available. This is a QA agent internal error.';
        }

        const self = this;

        switch (name) {
            case 'browser_navigate': {
                const url = String(args['url'] ?? '');
                const waitUntil = (args['wait_until'] as 'load' | 'networkidle' | 'domcontentloaded') ?? 'networkidle';
                self.emit('TOOL_USED', { toolName: name, input: { url, waitUntil }, phase: 'qa' });
                const result = await self.#browserSession!.navigate(url, waitUntil);
                self.#emitToolResult(name, result);
                await self.#autoScreenshot(`After navigating to ${url}`);
                return result;
            }
            case 'browser_screenshot': {
                const fullPage = args['full_page'] !== false;
                self.emit('TOOL_USED', { toolName: name, input: { fullPage }, phase: 'qa' });
                const result = await self.#browserSession!.screenshot(fullPage);
                self.#emitToolResult(name, result);
                return result;
            }
            case 'browser_click': {
                const selector = String(args['selector'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : undefined;
                self.emit('TOOL_USED', { toolName: name, input: { selector }, phase: 'qa' });
                const result = await self.#browserSession!.click(selector, timeout);
                self.#emitToolResult(name, result);
                await self.#autoScreenshot(`After clicking ${selector}`);
                return result;
            }
            case 'browser_fill': {
                const selector = String(args['selector'] ?? '');
                const value = String(args['value'] ?? '');
                self.emit('TOOL_USED', { toolName: name, input: { selector, value: value.slice(0, 100) }, phase: 'qa' });
                const result = await self.#browserSession!.fill(selector, value);
                self.#emitToolResult(name, result);
                await self.#autoScreenshot(`After filling ${selector}`);
                return result;
            }
            case 'browser_wait_for': {
                const selector = String(args['selector'] ?? '');
                const state = (args['state'] as 'visible' | 'hidden' | 'attached' | 'detached') ?? 'visible';
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : undefined;
                self.emit('TOOL_USED', { toolName: name, input: { selector, state }, phase: 'qa' });
                const result = await self.#browserSession!.waitFor(selector, state, timeout);
                self.#emitToolResult(name, result);
                await self.#autoScreenshot(`After waiting for ${selector} (${state})`);
                return result;
            }
            case 'browser_get_text': {
                const selector = typeof args['selector'] === 'string' ? args['selector'] : undefined;
                self.emit('TOOL_USED', { toolName: name, input: { selector: selector ?? '(full page)' }, phase: 'qa' });
                const result = await self.#browserSession!.getText(selector);
                self.#emitToolResult(name, result);
                return result;
            }
            case 'browser_evaluate': {
                const expression = String(args['expression'] ?? '');
                self.emit('TOOL_USED', { toolName: name, input: { expression: expression.slice(0, 120) }, phase: 'qa' });
                const result = await self.#browserSession!.evaluate(expression);
                self.#emitToolResult(name, result);
                return result;
            }
            default:
                return `[BROWSER_ERROR] Unknown browser tool: ${name}`;
        }
    }

    /**
     * Automatically capture and emit a screenshot after a browser interaction.
     * These go to the Command Center only (not injected into the LLM conversation).
     * Failures are non-fatal — we just log and continue.
     */
    async #autoScreenshot(description: string): Promise<void> {
        if (this.#browserSession === null) return;
        try {
            const b64 = await this.#browserSession.screenshot(false); // viewport only, not full page
            if (b64.startsWith('[BROWSER_ERROR]')) return;
            const browserUrl = this.#browserSession.getUrl();
            this.#emitScreenshot(b64, browserUrl, description);
        } catch {
            // Non-fatal — screenshot capture failure shouldn't break QA
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

        // Emit STATE_CHANGED with the test plan for UI visibility
        this.emit('STATE_CHANGED', {
            message: summary,
            phase: 'validate',
            testPlan: parsed.data,
        });

        // Also emit as TOOL_USED so the activity log shows this action
        this.emit('TOOL_USED', {
            toolName: 'update_test_plan',
            input: { testCount: parsed.data.tests.length },
            phase: 'qa',
        });

        return summary;
    }

    #handleSubmitVerdict(args: Record<string, unknown>): string {
        const passed = args['passed'] === true;
        const issues = Array.isArray(args['issues']) ? (args['issues'] as unknown[]).map(String) : [];
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

        this.#verdictSubmitted = true;
        this.#pendingVerdict = { passed, issues, stepsToReproduce, summary };

        // Emit as TOOL_USED so the activity log shows this action
        this.emit('TOOL_USED', {
            toolName: 'submit_qa_verdict',
            input: { passed, issueCount: issues.length },
            phase: 'qa',
        });

        return JSON.stringify({ accepted: true, passed, issueCount: issues.length });
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

    // ── Tool result emission ──────────────────────────────────────────────────

    /** Emit a TOOL_USED result event so the activity log shows tool output. */
    #emitToolResult(toolName: string, result: string): void {
        const isScreenshot = (toolName === 'screenshot_url' || toolName === 'browser_screenshot')
            && result.length > 1000 && !result.startsWith('[');

        // Determine error status from the result:
        // 1. Screenshots are always ok
        // 2. HTTP responses — use the status code from the first line
        // 3. Everything else — scan for connection/error keywords
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
            output: isScreenshot ? `data:image/png;base64,${result}` : result.slice(0, 4000),
            status: isError ? 'error' : 'ok',
            phase: 'qa',
        });
    }

    /** Read new lines from sandbox log files and emit SANDBOX_LOG events. */
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
                // File doesn't exist yet or container gone — skip
            }
        }
    }

    // ── Verdict parsing (fallback) ────────────────────────────────────────────

    #parseVerdict(raw: string): QaVerdict {
        // Try to extract JSON from the response
        try {
            const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
            // Find the outermost JSON object
            const match = /\{[\s\S]+\}/m.exec(json);
            if (match) {
                type RawV = { passed: unknown; issues: unknown; checksRun: unknown; visualDescription: unknown; summary: unknown };
                const parsed = JSON.parse(match[0]) as RawV;
                const plan: QaTestPlan | null = this.#testPlan;
                return {
                    passed: parsed.passed === true,
                    issues: Array.isArray(parsed.issues) ? (parsed.issues as unknown[]).map(String) : [],
                    checksRun: Array.isArray(parsed.checksRun) ? (parsed.checksRun as unknown[]).map(String) : [],
                    visualDescription: typeof parsed.visualDescription === 'string' ? parsed.visualDescription : 'N/A',
                    ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
                    ...(plan !== null ? { testPlan: plan } : {}),
                };
            }
        } catch (e) {
            logger.warn(`[${this.agentId}] Failed to parse verdict JSON: `, e);
        }

        // Fallback: infer pass/fail from prose if QA wrote a text report instead of JSON
        const lower = raw.toLowerCase();
        const failSignals = ['fail', 'error', 'issue', 'broke', 'missing', 'refused', 'timeout', 'timed out', '4xx', '5xx', '500', '404'];
        const passSignals = ['pass', 'success', 'all checks passed', 'no issues'];
        const hasFail = failSignals.some((s) => lower.includes(s));
        const hasPass = passSignals.some((s) => lower.includes(s));
        const inferredPass = hasPass && !hasFail;

        logger.warn(`[${this.agentId}] No JSON verdict found — inferred ${inferredPass ? 'PASS' : 'FAIL'} from prose`);
        const fallbackPlan: QaTestPlan | null = this.#testPlan;
        return {
            passed: inferredPass,
            issues: inferredPass ? [] : [`QA wrote prose instead of JSON (inferred FAIL): ${raw.slice(0, 300)}`],
            checksRun: ['inferred-from-prose'],
            visualDescription: raw.slice(0, 200),
            ...(fallbackPlan !== null ? { testPlan: fallbackPlan } : {}),
        };
    }

    #emitScreenshot(b64: string, url: string, description?: string): void {
        // Emit as a custom payload on STATE_CHANGED — the Command Center can render this
        const message = description !== undefined
            ? `${description} — ${url}`
            : `Visual screenshot captured for ${url}`;
        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'STATE_CHANGED',
            sourceId: this.agentId,
            targetId: null,
            traceId: this.traceId,
            payload: {
                message,
                phase: 'validate',
                screenshotB64: `data:image/png;base64,${b64}`,
                screenshotUrl: url,
            },
        });
    }
}
