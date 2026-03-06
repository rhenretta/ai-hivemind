/**
 * taskStateStore.ts — Restart-Resilient Task State
 *
 * Persists in-flight task state to /tmp/conductor-task-state.json.
 * On backend restart (triggered by tsx watch after sandbox promotion),
 * index.ts reads this file and resumes the task at the QA phase.
 *
 * Phases:
 *   conductor         → Claude Code CLI is running (subprocess live)
 *   awaiting-qa       → Claude Code done, files promoted; server restarting
 *   done              → QA complete (pass or fail); state cleared
 */

import fs from 'fs';

import { logger } from './logger.js';

const STATE_FILE = '/tmp/conductor-task-state.json';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PersistedTaskState {
    /** Original trace ID from the user command — used to reconnect Command Center */
    traceId: string;
    /** Node ID from the TaskGraph */
    nodeId: string;
    /** Agent ID that ran the SWE phase */
    sweId: string;
    /** Full task objective */
    objective: string;
    /** Acceptance criteria string */
    acceptanceCriteria: string;
    /** Current execution phase */
    phase: 'conductor' | 'awaiting-qa' | 'done';
    /** Retry attempt number (0-indexed) */
    attempt: number;
    /** Files confirmed written by Claude Code (for SweArtifact) */
    filesChanged: string[];
    /** QA issues from previous attempt (for retry prompts) */
    priorIssues: string[];
    /** Service URL if Claude Code deployed a dev server */
    serviceUrl?: string;
    /** Summary from Claude Code result event */
    conductorSummary: string;
    /** ISO timestamp */
    savedAt: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist the current task phase to disk.
 * Called before each phase transition so a restart always has a valid checkpoint.
 */
export function saveState(state: PersistedTaskState): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        logger.info(`[TaskStateStore] Saved state: phase=${state.phase} node=${state.nodeId}`);
    } catch (e) {
        logger.error('[TaskStateStore] Failed to save state:', e);
    }
}

/**
 * Load a pending task state from disk.
 * Returns null if no state file exists or the phase is 'done'.
 */
export function loadPendingState(): PersistedTaskState | null {
    try {
        if (!fs.existsSync(STATE_FILE)) return null;
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const state = JSON.parse(raw) as PersistedTaskState;
        if (state.phase === 'done') {
            clearState();
            return null;
        }
        logger.info(`[TaskStateStore] Loaded pending state: phase=${state.phase} node=${state.nodeId} savedAt=${state.savedAt}`);
        return state;
    } catch (e) {
        logger.warn('[TaskStateStore] Failed to load state (corrupted?):', e);
        return null;
    }
}

/**
 * Mark task as done and remove the state file.
 * Call this when QA passes, or after MAX_RETRIES exhausted.
 */
export function clearState(): void {
    try {
        if (fs.existsSync(STATE_FILE)) {
            fs.unlinkSync(STATE_FILE);
            logger.info('[TaskStateStore] Cleared task state');
        }
    } catch (e) {
        logger.warn('[TaskStateStore] Failed to clear state:', e);
    }
}
