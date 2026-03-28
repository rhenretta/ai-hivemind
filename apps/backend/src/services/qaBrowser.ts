/**
 * qaBrowser.ts — Persistent Playwright Browser Session for QA Agent
 *
 * Wraps a headless Chromium browser that persists across the entire QA loop.
 * The QA LLM uses browser tools (navigate, click, fill, screenshot, etc.) to
 * interactively test features instead of firing one-shot screenshot commands
 * with static wait timers.
 *
 * Lifecycle:
 *   1. Created at start of QaEngineer.run()
 *   2. Used by browser_* tool calls throughout the QA loop
 *   3. Closed in finally block — always cleaned up, even on error
 *
 * Runs on the HOST (not in Docker), connecting to localhost:mappedPort to
 * probe sandbox or live services — same pattern as the old screenshot_url.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

import { logger } from './logger.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Max text returned by getText/evaluate to avoid flooding the LLM context */
const MAX_TEXT_RESULT = 8192;

/** Default timeout for navigation (covers networkidle wait) */
const DEFAULT_NAV_TIMEOUT = 60_000;

/** Default timeout for element interactions (clicks, fills, getText) — safety net only */
const DEFAULT_INTERACTION_TIMEOUT = 10_000;

/**
 * Default timeout for waitFor — safety net only.
 * The QA LLM MUST specify timeout_ms explicitly based on what it's waiting for.
 * This fallback handles the case where it forgets.
 */
const DEFAULT_WAIT_FOR_TIMEOUT = 30_000;

// ── Session class ────────────────────────────────────────────────────────────

export class QaBrowserSession {
    #browser: Browser | null = null;
    #context: BrowserContext | null = null;
    #page: Page | null = null;
    #allowedPorts: number[] | undefined;

    /**
     * @param allowedPorts — In sandbox mode, only these localhost ports are
     *   reachable. Requests to other ports are blocked. Omit for live mode.
     */
    constructor(allowedPorts?: number[]) {
        this.#allowedPorts = allowedPorts;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async launch(): Promise<void> {
        this.#browser = await chromium.launch({ headless: true });
        this.#context = await this.#browser.newContext({
            viewport: { width: 1280, height: 720 },
            // Ignore HTTPS errors for localhost dev servers with self-signed certs
            ignoreHTTPSErrors: true,
        });
        this.#page = await this.#context.newPage();
        logger.info('[QaBrowser] Browser session launched (headless Chromium)');
    }

    /** Idempotent — safe to call multiple times or after a crash. */
    async close(): Promise<void> {
        try {
            await this.#context?.close();
        } catch {
            // Context may already be closed
        }
        try {
            await this.#browser?.close();
        } catch {
            // Browser may already be closed
        }
        this.#page = null;
        this.#context = null;
        this.#browser = null;
        logger.info('[QaBrowser] Browser session closed');
    }

    // ── Tool methods ─────────────────────────────────────────────────────────
    // Each returns a string result for the LLM. Never throws — errors become
    // descriptive strings so the LLM can decide how to recover.

    /**
     * Navigate to a URL. Waits for the page to reach the specified load state.
     *
     * Default `waitUntil: 'networkidle'` waits until there are no network
     * requests for 500ms — dynamically detects when async data fetches complete.
     */
    async navigate(
        url: string,
        waitUntil: 'load' | 'networkidle' | 'domcontentloaded' = 'networkidle',
    ): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started. Call launch() first.';

        // Port validation for sandbox mode
        if (this.#allowedPorts !== undefined) {
            try {
                const parsed = new URL(url);
                const port = parseInt(parsed.port, 10);
                if (
                    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
                    && !isNaN(port)
                    && !this.#allowedPorts.includes(port)
                ) {
                    return `[BLOCKED] Port ${port.toString()} is not a sandbox port. Available: ${this.#allowedPorts.join(', ')}`;
                }
            } catch {
                return `[BROWSER_ERROR] Invalid URL: ${url}`;
            }
        }

        try {
            const response = await this.#page.goto(url, {
                waitUntil,
                timeout: DEFAULT_NAV_TIMEOUT,
            });
            const status = response?.status() ?? 'unknown';
            const title = await this.#page.title();
            const finalUrl = this.#page.url();
            logger.info(`[QaBrowser] Navigated to ${url} (status=${String(status)}, waitUntil=${waitUntil})`);
            return `Navigated to "${title}" (${finalUrl}). HTTP status: ${String(status)}. Page is loaded and network is idle.`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // If networkidle times out, the page is likely still usable
            if (msg.includes('Timeout') && waitUntil === 'networkidle') {
                const title = await this.#page.title().catch(() => 'unknown');
                logger.warn(`[QaBrowser] networkidle timeout for ${url} — page may still be usable`);
                return `Navigation to ${url} loaded but networkidle timed out (some requests may still be pending). Page title: "${title}". You can still interact with the page — try browser_wait_for to check if specific content has appeared.`;
            }
            logger.warn(`[QaBrowser] navigate failed: ${msg}`);
            return `[BROWSER_ERROR] Navigation to ${url} failed: ${msg}`;
        }
    }

    /**
     * Capture the current page as a base64-encoded PNG screenshot.
     */
    async screenshot(fullPage = true): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        try {
            const buffer = await this.#page.screenshot({ fullPage, type: 'png' });
            const b64 = buffer.toString('base64');
            logger.info(`[QaBrowser] Screenshot captured (${buffer.length.toString()} bytes, fullPage=${String(fullPage)})`);
            return b64;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] screenshot failed: ${msg}`);
            return `[BROWSER_ERROR] Screenshot failed: ${msg}`;
        }
    }

    /**
     * Click an element by CSS selector.
     */
    async click(selector: string, timeoutMs = DEFAULT_INTERACTION_TIMEOUT): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        try {
            await this.#page.click(selector, { timeout: timeoutMs });
            logger.info(`[QaBrowser] Clicked: ${selector}`);

            // Wait for any network activity triggered by the click to settle.
            // Many clicks trigger async fetches (e.g. "next" button loads new data).
            // Without this, the QA agent reads stale content before the fetch completes.
            try {
                await this.#page.waitForLoadState('networkidle', { timeout: 15_000 });
            } catch {
                // Non-fatal — if networkidle times out, the page is still usable.
                // Static clicks (no network) resolve in <500ms so this doesn't slow them down.
                logger.info(`[QaBrowser] networkidle wait after click timed out — continuing`);
            }

            return `Clicked element: ${selector}. Page network activity has settled.`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] click failed on "${selector}": ${msg}`);
            return `[BROWSER_ERROR] Failed to click "${selector}": ${msg}`;
        }
    }

    /**
     * Fill a form input by CSS selector with the given value.
     * Works with <input>, <textarea>, and [contenteditable] elements.
     */
    async fill(selector: string, value: string): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        try {
            await this.#page.fill(selector, value, { timeout: DEFAULT_INTERACTION_TIMEOUT });
            logger.info(`[QaBrowser] Filled "${selector}" with "${value.slice(0, 50)}"`);

            // Wait for any network activity triggered by the fill to settle.
            // Covers debounced search inputs, auto-submit forms, etc.
            try {
                await this.#page.waitForLoadState('networkidle', { timeout: 15_000 });
            } catch {
                logger.info(`[QaBrowser] networkidle wait after fill timed out — continuing`);
            }

            return `Filled "${selector}" with "${value}". Page network activity has settled.`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] fill failed on "${selector}": ${msg}`);
            return `[BROWSER_ERROR] Failed to fill "${selector}": ${msg}`;
        }
    }

    /**
     * Wait for an element to reach a desired state (visible, hidden, attached, detached).
     * Returns when the condition is met, or an error if it times out.
     */
    async waitFor(
        selector: string,
        state: 'visible' | 'hidden' | 'attached' | 'detached' = 'visible',
        timeoutMs = DEFAULT_WAIT_FOR_TIMEOUT,
    ): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        try {
            await this.#page.waitForSelector(selector, { state, timeout: timeoutMs });
            logger.info(`[QaBrowser] waitFor: "${selector}" is now ${state}`);
            return `Element "${selector}" is now ${state}.`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] waitFor "${selector}" (state=${state}) failed: ${msg}`);
            return `[BROWSER_ERROR] Timed out waiting for "${selector}" to be ${state} (waited ${timeoutMs.toString()}ms): ${msg}`;
        }
    }

    /**
     * Read text content from a specific element or the entire page body.
     * Result is truncated to MAX_TEXT_RESULT characters.
     */
    async getText(selector?: string): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        try {
            let text: string;
            if (selector !== undefined && selector !== '') {
                const content = await this.#page.textContent(selector, { timeout: DEFAULT_INTERACTION_TIMEOUT });
                text = content ?? '';
            } else {
                text = await this.#page.locator('body').innerText({ timeout: DEFAULT_INTERACTION_TIMEOUT });
            }

            // Normalize whitespace and truncate
            text = text.replace(/\s+/g, ' ').trim();
            if (text.length > MAX_TEXT_RESULT) {
                text = text.slice(0, MAX_TEXT_RESULT) + `\n... [truncated at ${MAX_TEXT_RESULT.toString()} chars]`;
            }

            const selectorDesc = selector !== undefined && selector !== '' ? `"${selector}"` : 'full page';
            logger.info(`[QaBrowser] getText(${selectorDesc}): ${text.length.toString()} chars`);
            return text !== '' ? text : '[EMPTY] No text content found.';
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] getText failed: ${msg}`);
            return `[BROWSER_ERROR] Failed to get text${selector !== undefined ? ` from "${selector}"` : ''}: ${msg}`;
        }
    }

    /**
     * Execute JavaScript in the page context.
     * Returns JSON.stringify'd result, truncated to MAX_TEXT_RESULT.
     */
    async evaluate(expression: string): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const result = await this.#page.evaluate(expression);
            let text = JSON.stringify(result, null, 2);
            if (text.length > MAX_TEXT_RESULT) {
                text = text.slice(0, MAX_TEXT_RESULT) + `\n... [truncated at ${MAX_TEXT_RESULT.toString()} chars]`;
            }
            logger.info(`[QaBrowser] evaluate: ${expression.slice(0, 80)} → ${text.slice(0, 100)}`);
            return text;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] evaluate failed: ${msg}`);
            return `[BROWSER_ERROR] JavaScript evaluation failed: ${msg}`;
        }
    }

    /**
     * Navigate to a URL and return a structural summary of the page.
     * Discovers interactive elements, containers, and visible text so the
     * caller doesn't need to manually evaluate DOM structure.
     */
    async inspectPage(
        url: string,
        waitUntil: 'load' | 'networkidle' | 'domcontentloaded' = 'networkidle',
    ): Promise<string> {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';

        const navResult = await this.navigate(url, waitUntil);
        if (navResult.startsWith('[BROWSER_ERROR]') || navResult.startsWith('[BLOCKED]')) {
            return navResult;
        }

        try {
            // The inspection script runs in the browser context (DOM APIs).
            // Use evaluate(string) to avoid TS needing DOM lib types.
            const inspectionScript = `(() => {
                const title = document.title;
                const bodyText = (document.body && document.body.innerText || '').slice(0, 2000);

                function getSelector(el) {
                    const id = el.id ? '#' + el.id : '';
                    const cn = el.className && typeof el.className === 'string'
                        ? '.' + el.className.split(' ').filter(Boolean).join('.') : '';
                    return id || (el.tagName.toLowerCase() + cn);
                }

                const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0, 20).map(el => ({
                    selector: getSelector(el),
                    text: (el.innerText || '').trim().slice(0, 80) || el.getAttribute('aria-label') || ''
                }));

                const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 20).map(el => ({
                    selector: el.id ? '#' + el.id : 'a' + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).join('.') : ''),
                    text: (el.innerText || '').trim().slice(0, 80),
                    href: el.getAttribute('href') || ''
                }));

                const inputs = Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 20).map(el => ({
                    selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.name ? '[name="' + el.name + '"]' : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).join('.') : ''),
                    type: el.type || el.tagName.toLowerCase(),
                    placeholder: el.placeholder || ''
                }));

                const containers = Array.from(document.querySelectorAll('main, section, article, nav, header, footer, [role="main"], [role="navigation"]')).slice(0, 15).map(el => ({
                    selector: getSelector(el),
                    tag: el.tagName.toLowerCase(),
                    childCount: el.children.length
                }));

                const hasSpinner = document.querySelector('[class*="loading"], [class*="spinner"], [class*="skeleton"], [role="progressbar"]') !== null;

                return { title, bodyText, buttons, links, inputs, containers, hasSpinner };
            })()`;

            const result = await this.evaluate(inspectionScript);
            logger.info(`[QaBrowser] inspectPage: ${url} (${result.length.toString()} chars)`);
            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[QaBrowser] inspectPage failed: ${msg}`);
            return `[BROWSER_ERROR] Page inspection failed: ${msg}`;
        }
    }

    /**
     * Get the current page URL.
     */
    getUrl(): string {
        if (this.#page === null) return '[BROWSER_ERROR] Browser session not started.';
        return this.#page.url();
    }
}
