/**
 * ledgerStore.ts — Durable Event Ledger (SQLite)
 *
 * Persists the EventBus ledger to SQLite so all system events survive
 * backend restarts. The frontend reconstructs features, chat, and
 * notifications from replayed events via `system:replay`.
 *
 * Follows the established singleton pattern (see credentialStore.ts,
 * mcpRegistry.ts, ragStore.ts): module-level DB init, prepared
 * statements, WAL mode for concurrent reads/writes.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { type SystemEvent } from '@ai-hivemind/shared';
import BetterSqlite3 from 'better-sqlite3';

// ─── Database initialisation ─────────────────────────────────────────────────

const DB_PATH = process.env['LEDGER_DB_PATH'] ?? 'data/ledger.db';

// Ensure parent directory exists
const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
}

const db = new BetterSqlite3(DB_PATH);

// WAL mode for concurrent read/write without blocking
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        eventId     TEXT NOT NULL UNIQUE,
        timestamp   TEXT NOT NULL,
        eventType   TEXT NOT NULL,
        sourceId    TEXT NOT NULL,
        targetId    TEXT,
        traceId     TEXT,
        payload     TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_traceId ON ledger(traceId);
    CREATE INDEX IF NOT EXISTS idx_ledger_eventType ON ledger(eventType);
`);

// ─── Row type ────────────────────────────────────────────────────────────────

interface LedgerRow {
    seq: number;
    eventId: string;
    timestamp: string;
    eventType: string;
    sourceId: string;
    targetId: string | null;
    traceId: string | null;
    payload: string;
}

// ─── Prepared statements (module-level, reused forever) ──────────────────────

const stmtInsert = db.prepare(`
    INSERT INTO ledger (eventId, timestamp, eventType, sourceId, targetId, traceId, payload)
    VALUES (@eventId, @timestamp, @eventType, @sourceId, @targetId, @traceId, @payload)
`);

const stmtSelectAll = db.prepare(`
    SELECT * FROM ledger ORDER BY seq ASC
`);

const stmtSelectByTrace = db.prepare(`
    SELECT * FROM ledger WHERE traceId = @traceId ORDER BY seq ASC
`);

const stmtSelectByType = db.prepare(`
    SELECT * FROM ledger WHERE eventType = @eventType ORDER BY seq ASC
`);

const stmtSelectByTypeLimit = db.prepare(`
    SELECT * FROM ledger WHERE eventType = @eventType ORDER BY seq DESC LIMIT @limit
`);

const stmtCount = db.prepare(`SELECT COUNT(*) AS count FROM ledger`);

// ─── Row → SystemEvent conversion ───────────────────────────────────────────

function rowToEvent(row: LedgerRow): SystemEvent {
    return {
        eventId: row.eventId,
        timestamp: row.timestamp,
        eventType: row.eventType as SystemEvent['eventType'],
        sourceId: row.sourceId,
        targetId: row.targetId,
        traceId: row.traceId ?? undefined,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
}

// ─── Exported functions ──────────────────────────────────────────────────────

/** Append a single event to the durable ledger. Synchronous (fast with WAL). */
export function appendEvent(event: SystemEvent): void {
    stmtInsert.run({
        eventId: event.eventId,
        timestamp: event.timestamp,
        eventType: event.eventType,
        sourceId: event.sourceId,
        targetId: event.targetId ?? null,
        traceId: event.traceId ?? null,
        payload: JSON.stringify(event.payload),
    });
}

/** Return all events ordered by sequence number. */
export function getAllEvents(): SystemEvent[] {
    const rows = stmtSelectAll.all() as LedgerRow[];
    return rows.map(rowToEvent);
}

/** Return events for a specific trace (feature). */
export function getEventsByTrace(traceId: string): SystemEvent[] {
    const rows = stmtSelectByTrace.all({ traceId }) as LedgerRow[];
    return rows.map(rowToEvent);
}

/** Return events of a specific type, optionally limited. */
export function getEventsByType(eventType: string, limit?: number): SystemEvent[] {
    if (limit !== undefined && limit > 0) {
        // Query in DESC with limit, then reverse to get chronological order
        const rows = stmtSelectByTypeLimit.all({ eventType, limit }) as LedgerRow[];
        return rows.reverse().map(rowToEvent);
    }
    const rows = stmtSelectByType.all({ eventType }) as LedgerRow[];
    return rows.map(rowToEvent);
}

/** Return the total number of events in the ledger. */
export function getLedgerSize(): number {
    const row = stmtCount.get() as { count: number };
    return row.count;
}
