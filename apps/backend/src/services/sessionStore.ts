/**
 * sessionStore.ts — Persistent Session Storage
 *
 * Stores session metadata (title, status, repo config, project profile) in SQLite.
 * Sessions replace the ephemeral "feature" concept that was reconstructed from
 * ledger events on each load. A session ID is the same as a traceId.
 *
 * Follows the credentialStore.ts singleton pattern: module-level better-sqlite3 DB
 * with prepared statements and EventBus integration.
 */

import {
    type Session,
    type SessionStatus,
    type RepoConfig,
    type ProjectProfile,
    type TaskGraph,
    SessionSchema,
} from '@ai-hivemind/shared';
import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { eventBus } from '../eventBus.js';

import { logger } from './logger.js';

// ─── Database initialisation ─────────────────────────────────────────────────

const DATA_DIR = path.resolve(
    process.env['DATA_DIR'] ?? path.join(import.meta.dirname ?? '.', '..', 'data'),
);
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'sessions.db');
const db = new BetterSqlite3(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'exploring',
        repoConfigJson    TEXT,
        projectProfileJson TEXT,
        taskGraphJson     TEXT,
        createdAt         TEXT NOT NULL,
        updatedAt         TEXT NOT NULL
    );
`);

// Migrate: add taskGraphJson column if missing (existing DBs)
try {
    db.exec(`ALTER TABLE sessions ADD COLUMN taskGraphJson TEXT`);
} catch {
    // Column already exists — ignore
}

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
    INSERT INTO sessions (id, title, status, repoConfigJson, projectProfileJson, createdAt, updatedAt)
    VALUES (@id, @title, @status, @repoConfigJson, @projectProfileJson, @createdAt, @updatedAt)
`);

const stmtSelectById = db.prepare(`SELECT * FROM sessions WHERE id = @id`);

const stmtSelectAll = db.prepare(`SELECT * FROM sessions ORDER BY updatedAt DESC`);

const stmtUpdate = db.prepare(`
    UPDATE sessions
    SET title = COALESCE(@title, title),
        status = COALESCE(@status, status),
        repoConfigJson = COALESCE(@repoConfigJson, repoConfigJson),
        projectProfileJson = COALESCE(@projectProfileJson, projectProfileJson),
        updatedAt = @updatedAt
    WHERE id = @id
`);

const stmtDelete = db.prepare(`DELETE FROM sessions WHERE id = @id`);

const stmtSaveTaskGraph = db.prepare(`
    UPDATE sessions SET taskGraphJson = @taskGraphJson, updatedAt = @updatedAt WHERE id = @id
`);

const stmtGetTaskGraph = db.prepare(`SELECT taskGraphJson FROM sessions WHERE id = @id`);

// ─── Row → Session mapping ──────────────────────────────────────────────────

interface SessionRow {
    id: string;
    title: string;
    status: string;
    repoConfigJson: string | null;
    projectProfileJson: string | null;
    createdAt: string;
    updatedAt: string;
}

function rowToSession(row: SessionRow): Session {
    return SessionSchema.parse({
        id: row.id,
        title: row.title,
        status: row.status,
        repoConfig: row.repoConfigJson !== null ? JSON.parse(row.repoConfigJson) : null,
        projectProfile: row.projectProfileJson !== null ? JSON.parse(row.projectProfileJson) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

class SessionStore {
    createSession(input: {
        id?: string;
        title: string;
        status?: SessionStatus;
        repoConfig?: RepoConfig | null;
    }): Session {
        const now = new Date().toISOString();
        const id = input.id ?? uuidv4();

        const row = {
            id,
            title: input.title,
            status: input.status ?? 'exploring',
            repoConfigJson: input.repoConfig != null ? JSON.stringify(input.repoConfig) : null,
            projectProfileJson: null,
            createdAt: now,
            updatedAt: now,
        };

        stmtInsert.run(row);
        const session = rowToSession(row as SessionRow);

        logger.info(`[SessionStore] Created session ${id}: "${input.title}"`);
        eventBus.emit({
            eventId: uuidv4(),
            timestamp: now,
            eventType: 'SESSION_CREATED',
            sourceId: 'session-store',
            targetId: null,
            traceId: id,
            payload: { ...session },
        });

        return session;
    }

    getSession(id: string): Session | null {
        const row = stmtSelectById.get({ id }) as SessionRow | undefined;
        if (row === undefined) return null;
        return rowToSession(row);
    }

    listSessions(): Session[] {
        const rows = stmtSelectAll.all() as SessionRow[];
        return rows.map(rowToSession);
    }

    updateSession(
        id: string,
        patch: {
            title?: string;
            status?: SessionStatus;
            repoConfig?: RepoConfig | null;
            projectProfile?: ProjectProfile | null;
        },
    ): Session | null {
        const existing = this.getSession(id);
        if (existing === null) return null;

        const now = new Date().toISOString();

        stmtUpdate.run({
            id,
            title: patch.title ?? null,
            status: patch.status ?? null,
            repoConfigJson: patch.repoConfig !== undefined ? JSON.stringify(patch.repoConfig) : null,
            projectProfileJson: patch.projectProfile !== undefined ? JSON.stringify(patch.projectProfile) : null,
            updatedAt: now,
        });

        const updated = this.getSession(id);
        if (updated === null) return null;

        eventBus.emit({
            eventId: uuidv4(),
            timestamp: now,
            eventType: 'SESSION_UPDATED',
            sourceId: 'session-store',
            targetId: null,
            traceId: id,
            payload: { ...patch, id, updatedAt: now },
        });

        return updated;
    }

    deleteSession(id: string): boolean {
        const result = stmtDelete.run({ id });
        if (result.changes > 0) {
            logger.info(`[SessionStore] Deleted session ${id}`);
            return true;
        }
        return false;
    }

    /**
     * Ensure a session exists for a given traceId.
     * If one already exists, returns it. Otherwise creates a new one.
     */
    ensureSession(traceId: string, title: string): Session {
        const existing = this.getSession(traceId);
        if (existing !== null) return existing;
        return this.createSession({ id: traceId, title });
    }

    /**
     * Persist the task graph for a session. Called by DialogueAgent on every graph update.
     */
    saveTaskGraph(id: string, graph: TaskGraph): void {
        stmtSaveTaskGraph.run({
            id,
            taskGraphJson: JSON.stringify(graph),
            updatedAt: new Date().toISOString(),
        });
    }

    /**
     * Restore a previously persisted task graph. Returns null if none saved.
     */
    getTaskGraph(id: string): TaskGraph | null {
        const row = stmtGetTaskGraph.get({ id }) as { taskGraphJson: string | null } | undefined;
        if (row === undefined || row.taskGraphJson === null) return null;
        try {
            return JSON.parse(row.taskGraphJson) as TaskGraph;
        } catch {
            return null;
        }
    }
}

export const sessionStore = new SessionStore();
