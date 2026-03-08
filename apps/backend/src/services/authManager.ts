/**
 * authManager.ts — OAuth Token Auto-Refresh for Claude Code CLI
 *
 * On macOS, Claude Code stores OAuth tokens in the Keychain. These tokens
 * expire after ~8 hours. This service proactively refreshes the token before
 * expiry so Claude Code spawns never fail with 401 authentication errors.
 *
 * Skips entirely when:
 *   - ANTHROPIC_API_KEY is set (API keys don't expire)
 *   - Platform is not macOS (Keychain not available)
 *
 * Integration points:
 *   - index.ts calls init() on startup, shutdown() on SIGINT/SIGTERM
 *   - conductor.ts calls ensureFreshToken() before each Claude spawn
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from './logger.js';

// ── Constants ────────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh when token expires within this many milliseconds */
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

/** Background check interval — keep this short to stay in sync with the
 *  interactive Claude Code session which may refresh tokens independently. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── State ────────────────────────────────────────────────────────────────────

let cachedExpiresAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false; // mutex to prevent concurrent refreshes
let enabled = false;

// ── Keychain helpers ─────────────────────────────────────────────────────────

interface OAuthCredential {
    claudeAiOauth: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        scopes?: string[];
        subscriptionType?: string;
        rateLimitTier?: string;
    };
    [key: string]: unknown;
}

function readKeychainCredential(): OAuthCredential | null {
    try {
        const username = os.userInfo().username;
        const raw = execSync(
            `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${username}" -w`,
            { stdio: 'pipe', encoding: 'utf8', timeout: 5000 },
        ).trim();

        const parsed = JSON.parse(raw) as OAuthCredential;
        if (typeof parsed.claudeAiOauth?.accessToken !== 'string') {
            logger.warn('[AuthManager] Keychain credential missing claudeAiOauth.accessToken');
            return null;
        }
        if (typeof parsed.claudeAiOauth?.refreshToken !== 'string') {
            logger.warn('[AuthManager] Keychain credential missing claudeAiOauth.refreshToken');
            return null;
        }
        return parsed;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`[AuthManager] Could not read Keychain: ${msg}`);
        return null;
    }
}

function writeKeychainCredential(credential: OAuthCredential): boolean {
    // Write JSON to a temp file, then use `security` to import via stdin pipe.
    // This avoids all shell-escaping issues with the JSON payload.
    const tmpFile = path.join(os.tmpdir(), `claude-auth-${Date.now()}.json`);
    try {
        const username = os.userInfo().username;
        const json = JSON.stringify(credential);

        fs.writeFileSync(tmpFile, json, { mode: 0o600 });

        // Delete old entry (ignore if missing)
        try {
            execSync(
                `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${username}"`,
                { stdio: 'pipe', timeout: 5000 },
            );
        } catch {
            // Didn't exist — fine
        }

        // Add new entry. Use spawnSync to pass the JSON as an argument
        // without shell interpolation issues.
        const addResult = spawnSync('security', [
            'add-generic-password',
            '-s', KEYCHAIN_SERVICE,
            '-a', username,
            '-w', json,
        ], { stdio: 'pipe', timeout: 5000 });

        if (addResult.status !== 0) {
            const stderr = addResult.stderr?.toString() ?? '';
            logger.error(`[AuthManager] security add-generic-password failed: ${stderr}`);
            return false;
        }

        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AuthManager] Failed to write Keychain: ${msg}`);
        return false;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

// ── Token refresh ────────────────────────────────────────────────────────────

function doRefresh(): boolean {
    if (refreshing) {
        logger.debug('[AuthManager] Refresh already in progress, skipping');
        return false;
    }

    refreshing = true;
    try {
        const credential = readKeychainCredential();
        if (credential === null) {
            logger.warn('[AuthManager] Cannot refresh — no valid credential in Keychain');
            return false;
        }

        const refreshToken = credential.claudeAiOauth.refreshToken;
        logger.info('[AuthManager] Refreshing OAuth token...');

        // Synchronous HTTP POST via curl (keeps ensureFreshToken() synchronous).
        // Use spawnSync to avoid shell escaping issues with the token value.
        const body = JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: OAUTH_CLIENT_ID,
        });

        const curlResult = spawnSync('curl', [
            '-s', '-X', 'POST', OAUTH_TOKEN_URL,
            '-H', 'Content-Type: application/json',
            '-d', body,
        ], { encoding: 'utf8', timeout: 15000 });

        if (curlResult.status !== 0) {
            logger.error(`[AuthManager] curl failed: ${curlResult.stderr?.slice(0, 200) ?? 'unknown error'}`);
            return false;
        }

        const response = (curlResult.stdout ?? '').trim();
        if (response.length === 0) {
            logger.error('[AuthManager] Empty response from OAuth endpoint');
            return false;
        }

        const result = JSON.parse(response) as Record<string, unknown>;

        // Check for error response
        if (typeof result['error'] === 'string') {
            const errorDesc = typeof result['error_description'] === 'string'
                ? result['error_description']
                : '';
            const errorType = result['error'];

            if (errorType === 'invalid_grant') {
                logger.error(
                    '[AuthManager] Refresh token is invalid or consumed. '
                    + 'Run "claude auth login" in a terminal to re-authenticate.',
                );
            } else {
                logger.error(`[AuthManager] OAuth refresh failed: ${String(errorType)} - ${errorDesc}`);
            }
            return false;
        }

        // Extract new tokens
        const newAccessToken = result['access_token'] as string | undefined;
        const newRefreshToken = result['refresh_token'] as string | undefined;
        const expiresIn = result['expires_in'] as number | undefined;

        if (typeof newAccessToken !== 'string') {
            logger.error(`[AuthManager] OAuth refresh response missing access_token: ${response.slice(0, 200)}`);
            return false;
        }

        // Calculate new expiry (expires_in is seconds from now)
        const newExpiresAt = typeof expiresIn === 'number'
            ? Date.now() + (expiresIn * 1000)
            : Date.now() + (8 * 60 * 60 * 1000); // default 8h if not provided

        // Update the credential object, preserving non-OAuth fields
        credential.claudeAiOauth = {
            ...credential.claudeAiOauth,
            accessToken: newAccessToken,
            refreshToken: typeof newRefreshToken === 'string' ? newRefreshToken : credential.claudeAiOauth.refreshToken,
            expiresAt: newExpiresAt,
        };

        // Write back to Keychain
        if (!writeKeychainCredential(credential)) {
            logger.error('[AuthManager] Token refreshed but failed to persist to Keychain');
            // Still update cache so current process uses the new token
        }

        cachedExpiresAt = newExpiresAt;
        const minutesUntilExpiry = Math.round((newExpiresAt - Date.now()) / 60000);
        logger.info(`[AuthManager] Refreshed OAuth token, new expiry in ${minutesUntilExpiry}m`);
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AuthManager] Token refresh error: ${msg}`);
        return false;
    } finally {
        refreshing = false;
    }
}

function checkAndRefresh(): void {
    if (!enabled) return;

    const now = Date.now();
    const remaining = cachedExpiresAt - now;

    if (remaining > REFRESH_BUFFER_MS) {
        const minutesRemaining = Math.round(remaining / 60000);
        logger.debug(`[AuthManager] Token valid, ${minutesRemaining}m remaining`);
        return;
    }

    if (remaining > 0) {
        logger.info(`[AuthManager] Token expiring in ${Math.round(remaining / 60000)}m, refreshing proactively`);
    } else {
        logger.warn(`[AuthManager] Token expired ${Math.round(-remaining / 60000)}m ago, refreshing now`);
    }

    doRefresh();
}

// ── Public API ───────────────────────────────────────────────────────────────

function init(): void {
    // Skip if using API key (doesn't expire)
    if (typeof process.env['ANTHROPIC_API_KEY'] === 'string' && process.env['ANTHROPIC_API_KEY'].length > 0) {
        logger.info('[AuthManager] ANTHROPIC_API_KEY set, OAuth refresh disabled');
        return;
    }

    // Skip if not macOS
    if (process.platform !== 'darwin') {
        logger.info('[AuthManager] Not macOS, OAuth Keychain refresh disabled');
        return;
    }

    enabled = true;

    // Read current token state
    const credential = readKeychainCredential();
    if (credential === null) {
        logger.warn('[AuthManager] No OAuth credential found in Keychain');
        return;
    }

    cachedExpiresAt = credential.claudeAiOauth.expiresAt;
    const remaining = cachedExpiresAt - Date.now();

    if (remaining > REFRESH_BUFFER_MS) {
        const minutesRemaining = Math.round(remaining / 60000);
        logger.info(`[AuthManager] OAuth token valid, expires in ${minutesRemaining}m`);
    } else {
        // Token expired or about to expire — refresh immediately
        const refreshed = doRefresh();
        if (!refreshed) {
            logger.error(
                '[AuthManager] Could not refresh expired OAuth token. '
                + 'Run "claude auth login" in a terminal to re-authenticate.',
            );
        }
    }

    // Schedule periodic checks
    refreshTimer = setInterval(checkAndRefresh, CHECK_INTERVAL_MS);
    logger.info(`[AuthManager] Background refresh scheduled every ${CHECK_INTERVAL_MS / 60000}m`);
}

/**
 * Ensure the OAuth token is fresh before spawning Claude Code.
 * Returns true if auth is OK, false if auth is broken and the user needs to re-login.
 *
 * ALWAYS re-reads the Keychain (not just when our cache says the token is expired).
 * This is critical because the interactive Claude Code session on the host refreshes
 * tokens independently. When it refreshes, it consumes the old refresh token and
 * writes new access + refresh tokens to the Keychain. If we only re-read the Keychain
 * when our cached token expires, we'd miss the new refresh token and try to use the
 * old (consumed) one — resulting in `invalid_grant` errors.
 *
 * A Keychain read is fast (~50ms) and this is only called before each Claude spawn.
 */
function ensureFreshToken(): boolean {
    if (!enabled) return true; // API key mode — always OK

    // Always re-read Keychain to pick up tokens refreshed by other processes
    // (e.g. the interactive Claude Code session running on the host).
    const credential = readKeychainCredential();
    if (credential !== null) {
        const keychainExpiry = credential.claudeAiOauth.expiresAt;
        if (keychainExpiry !== cachedExpiresAt) {
            cachedExpiresAt = keychainExpiry;
            logger.debug(`[AuthManager] Synced token from Keychain, expires in ${Math.round((keychainExpiry - Date.now()) / 60000)}m`);
        }

        const remaining = keychainExpiry - Date.now();
        if (remaining > REFRESH_BUFFER_MS) {
            return true; // Token is fresh
        }
    }

    // Token is expired or about to expire — attempt refresh
    const refreshed = doRefresh();
    if (!refreshed) {
        // Refresh failed — re-read Keychain one more time in case another process
        // refreshed between our read and the failed attempt (race condition).
        const retryCredential = readKeychainCredential();
        if (retryCredential !== null) {
            const retryExpiry = retryCredential.claudeAiOauth.expiresAt;
            const retryRemaining = retryExpiry - Date.now();
            if (retryRemaining > REFRESH_BUFFER_MS) {
                cachedExpiresAt = retryExpiry;
                logger.info('[AuthManager] Token refreshed by another process during our refresh attempt');
                return true;
            }
        }

        logger.error('[AuthManager] OAuth token is expired and could not be refreshed. Run "claude auth login" to re-authenticate.');
        return false;
    }
    return true;
}

function shutdown(): void {
    if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
    enabled = false;
    logger.info('[AuthManager] Shut down');
}

export const authManager = { init, ensureFreshToken, shutdown };
