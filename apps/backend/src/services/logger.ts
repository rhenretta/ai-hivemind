/**
 * logger.ts — Structured Logger wrapper for the Nerve Center
 *
 * Provides a central point for all logging.
 * Satisfies the `no-console` ESLint rule by being the ONLY place where
 * console.log/error are called (with appropriate disable comments).
 */

/* eslint-disable no-console */

export const logger = {
    info: (message: string, ...args: unknown[]) => {
        console.log(`[INFO] ${message}`, ...args);
    },
    warn: (message: string, ...args: unknown[]) => {
        console.warn(`[WARN] ${message}`, ...args);
    },
    error: (message: string, ...args: unknown[]) => {
        console.error(`[ERROR] ${message}`, ...args);
    },
    debug: (message: string, ...args: unknown[]) => {
        if (process.env['DEBUG'] === 'true') {
            console.log(`[DEBUG] ${message}`, ...args);
        }
    },
};
