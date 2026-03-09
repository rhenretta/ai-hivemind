/**
 * mcpExecutor.ts — MCP Tool Execution Engine
 *
 * Provides actual implementations for all built-in MCP tools.
 * The Coordinator calls executeTool(name, args) and gets back a string result.
 *
 * Tool implementations:
 *   web_search         → Brave Search API → Reddit JSON API → DuckDuckGo JSON
 *   http_get           → Node fetch with timeout
 *   execute_cli_command → child_process.exec in a sandboxed shell
 *   read_file          → fs.readFile
 *   write_file         → fs.writeFile / appendFile
 */

import { exec } from 'node:child_process';
import { readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { logger } from './logger.js';

const execAsync = promisify(exec);

// ── Timeout helper ─────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
        ),
    ]);
}

// ── Tool implementations ───────────────────────────────────────────────────────

/**
 * web_search — priority:
 *  1. Brave Search API (if BRAVE_API_KEY set) — best quality
 *  2. Reddit JSON API for Reddit-related queries — free, no auth
 *  3. DuckDuckGo Instant Answer JSON — general fallback, no auth
 */
async function webSearch(query: string, maxResults = 10): Promise<string> {
    const braveKey = process.env['BRAVE_API_KEY'];

    // ── 1. Brave Search API ────────────────────────────────────────────────────
    if (braveKey !== undefined && braveKey !== '') {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults.toString()}`;
        const res = await withTimeout(
            fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip',
                    'X-Subscription-Token': braveKey,
                },
            }),
            10_000,
            'web_search:brave',
        );
        if (!res.ok) throw new Error(`Brave Search API error: ${res.status}`);
        const data = await res.json() as {
            web?: { results?: { title: string; url: string; description: string }[] };
        };
        const results = data.web?.results ?? [];
        if (results.length === 0) return 'No results found.';
        return results
            .slice(0, maxResults)
            .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description}`)
            .join('\n\n');
    }

    // ── 2. Reddit JSON API for Reddit-related queries ──────────────────────────
    const isRedditQuery = /site:reddit\.com|reddit\.com|reddit/i.test(query);
    const trimmedReddit = query.replace(/site:reddit\.com\s*/i, '').trim();
    const redditSearchQuery = trimmedReddit !== '' ? trimmedReddit : query;

    if (isRedditQuery) {
        const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(redditSearchQuery)}&sort=top&t=month&limit=${maxResults}`;
        try {
            const res = await withTimeout(
                fetch(redditUrl, {
                    headers: {
                        'User-Agent': 'ai-hivemind/1.0 (web search tool)',
                        'Accept': 'application/json',
                    },
                }),
                10_000,
                'web_search:reddit',
            );
            if (res.ok) {
                const data = await res.json() as {
                    data?: {
                        children?: {
                            data: {
                                title: string;
                                selftext: string;
                                score: number;
                                subreddit: string;
                                num_comments: number;
                                permalink: string;
                            };
                        }[];
                    };
                };
                const posts = data.data?.children ?? [];
                if (posts.length > 0) {
                    return posts
                        .slice(0, maxResults)
                        .map((p, i) => {
                            const d = p.data;
                            const snippet = d.selftext.slice(0, 120).replace(/\n/g, ' ');
                            return `${(i + 1).toString()}. r/${d.subreddit}: ${d.title}\n   URL: https://reddit.com${d.permalink}\n   Score: ${d.score.toString()} | Comments: ${d.num_comments.toString()}${snippet !== '' ? `\n   ${snippet}…` : ''}`;
                        })
                        .join('\n\n');
                }
            }
        } catch (redditErr) {
            logger.warn('[MCP Executor] Reddit JSON fallback failed:', redditErr);
        }
    }

    // ── 3. DuckDuckGo Instant Answer JSON (general fallback, no auth) ──────────
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=ai-hivemind`;
    const ddgRes = await withTimeout(
        fetch(ddgUrl, { headers: { 'Accept': 'application/json' } }),
        10_000,
        'web_search:ddg',
    );
    if (!ddgRes.ok) throw new Error(`DuckDuckGo API error: ${ddgRes.status}`);

    const ddgData = await ddgRes.json() as {
        AbstractText?: string;
        AbstractURL?: string;
        AbstractSource?: string;
        RelatedTopics?: { Text?: string; FirstURL?: string }[];
        Results?: { Text?: string; FirstURL?: string }[];
    };

    const parts: string[] = [];
    if (ddgData.AbstractText !== undefined && ddgData.AbstractText !== '') {
        parts.push(`Summary (${ddgData.AbstractSource ?? 'DDG'}):\n${ddgData.AbstractText}\nURL: ${ddgData.AbstractURL ?? ''}`);
    }
    for (const t of [...(ddgData.Results ?? []), ...(ddgData.RelatedTopics ?? [])].slice(0, maxResults)) {
        if (t.Text !== undefined && t.Text !== '' && t.FirstURL !== undefined && t.FirstURL !== '') {
            parts.push(`• ${t.Text}\n  URL: ${t.FirstURL}`);
        }
    }

    if (parts.length === 0) {
        return `No results found for "${query}". Add BRAVE_API_KEY to .env.local for full web search.`;
    }
    return parts.join('\n\n');
}

/**
 * http_get — fetch a URL, return response as text (truncated to 8KB)
 */
async function httpGet(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = 10_000,
): Promise<string> {
    const res = await withTimeout(
        fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ai-hivemind/1.0)',
                ...headers,
            },
        }),
        timeoutMs,
        'http_get',
    );
    const body = await res.text();
    const truncated = body.length > 8192 ? `${body.slice(0, 8192)}\n[...truncated]` : body;
    return `HTTP ${res.status} ${res.statusText}\n\n${truncated}`;
}

/**
 * execute_cli_command — run a shell command, capture stdout/stderr
 */
async function executeCli(command: string, timeoutMs = 30_000): Promise<string> {
    try {
        // Resolve monorepo root — backend cwd is apps/backend/ under turbo dev
        const monorepoRoot = resolve(process.cwd(), '../..');
        const { stdout, stderr } = await withTimeout(
            execAsync(command, { timeout: timeoutMs, cwd: monorepoRoot }),
            timeoutMs + 1000,
            'execute_cli_command',
        );
        const MAX_OUTPUT = 12288; // 12KB — same cap as read_file
        const out = stdout.trim();
        const err = stderr.trim();
        const parts: string[] = [];
        if (out !== '') parts.push(`stdout:\n${out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[...truncated at 12KB]` : out}`);
        if (err !== '') parts.push(`stderr:\n${err.length > MAX_OUTPUT ? `${err.slice(0, MAX_OUTPUT)}\n[...truncated at 12KB]` : err}`);
        return parts.length > 0 ? parts.join('\n') : '(no output)';
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return `Command failed:\nstdout: ${err.stdout ?? ''}\nstderr: ${err.stderr ?? err.message ?? ''}`;
    }
}

/**
 * read_file — read a file from disk
 */
async function readFileTool(filePath: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
    // Resolve relative paths from monorepo root, not apps/backend/
    const monorepoRoot = resolve(process.cwd(), '../..');
    const safePath = isAbsolute(filePath) ? filePath : resolve(monorepoRoot, filePath);
    const buffer = await readFile(safePath);
    const content = encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8');
    return content.length > 12288 ? `${content.slice(0, 12288)}\n[...truncated at 12KB]` : content;
}

/**
 * write_file — write or append to a file
 */
async function writeFileTool(filePath: string, content: string, append = false): Promise<string> {
    const safePath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
    if (append) {
        await appendFile(safePath, content, 'utf8');
        return `Appended ${content.length} bytes to ${safePath}`;
    }
    await writeFile(safePath, content, 'utf8');
    return `Wrote ${content.length} bytes to ${safePath}`;
}

/**
 * screenshot_url — take a headless Playwright screenshot, return base64 PNG.
 * Returns '[PLAYWRIGHT_UNAVAILABLE] <reason>' on failure so QA can degrade gracefully.
 *
 * @param waitAfterLoadMs — Extra delay (ms) after the page `load` event before
 *   capturing. This lets client-side React/Next.js apps finish async data fetches
 *   so the screenshot shows real content instead of a loading spinner.
 *   Default: 3000ms (3 seconds).
 */
async function screenshotUrl(url: string, timeoutMs = 15_000, waitAfterLoadMs = 3_000): Promise<string> {
    const outPath = resolve(tmpdir(), `qa-screenshot-${randomUUID()}.png`);
    try {
        // Use npx so Playwright doesn't need to be globally installed.
        // --timeout controls the page-load wait; --full-page captures the entire scroll height.
        // --wait-for-timeout adds a delay AFTER page load for async JS to finish rendering.
        const cmd = [
            'npx', '--yes', 'playwright', 'screenshot',
            '--browser', 'chromium',
            '--full-page',
            '--timeout', String(timeoutMs),
            '--wait-for-timeout', String(waitAfterLoadMs),
            url,
            outPath,
        ].join(' ');

        const totalTimeout = timeoutMs + waitAfterLoadMs + 10_000;
        await withTimeout(
            execAsync(cmd, { timeout: totalTimeout }),
            totalTimeout + 2_000,
            'screenshot_url',
        );

        const png = await readFile(outPath);
        const b64 = png.toString('base64');
        logger.info(`[MCP Executor] Screenshot captured for ${url} (${png.length.toString()} bytes, waited ${waitAfterLoadMs.toString()}ms after load)`);
        return b64;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[MCP Executor] screenshot_url failed for ${url}: ${msg}`);
        return `[PLAYWRIGHT_UNAVAILABLE] ${msg}`;
    } finally {
        // Best-effort cleanup — ignore errors
        unlink(outPath).catch(() => { /* noop */ });
    }
}

// ── Public dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute a named MCP tool with the given arguments.
 * Returns a string result for the LLM. Never throws — errors become strings.
 */
export async function executeTool(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    logger.info(`[MCP Executor] Executing tool="${name}" args=${JSON.stringify(args).slice(0, 120)}`);

    try {
        switch (name) {
            case 'web_search': {
                const query = String(args['query'] ?? '');
                const maxResults = typeof args['max_results'] === 'number' ? args['max_results'] : 10;
                return await webSearch(query, maxResults);
            }

            case 'http_get': {
                const url = String(args['url'] ?? '');
                const headers = (args['headers'] ?? {}) as Record<string, string>;
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 10_000;
                return await httpGet(url, headers, timeout);
            }

            case 'execute_cli_command': {
                const command = String(args['command'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 30_000;
                return await executeCli(command, timeout);
            }

            case 'read_file': {
                const path = String(args['path'] ?? '');
                const encoding = args['encoding'] === 'base64' ? 'base64' : 'utf8';
                return await readFileTool(path, encoding);
            }

            case 'write_file': {
                const path = String(args['path'] ?? '');
                const content = String(args['content'] ?? '');
                const append = args['append'] === true;
                return await writeFileTool(path, content, append);
            }

            case 'screenshot_url': {
                const url = String(args['url'] ?? '');
                const timeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 15_000;
                const waitAfterLoad = typeof args['wait_after_load_ms'] === 'number' ? args['wait_after_load_ms'] : 3_000;
                return await screenshotUrl(url, timeout, waitAfterLoad);
            }

            default:
                return `Tool '${name}' is not implemented in the MCP executor.`;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[MCP Executor] Tool "${name}" failed: ${msg}`);
        return `Tool '${name}' failed: ${msg}`;
    }
}
