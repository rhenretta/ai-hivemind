/**
 * ragStore.ts — Multi-Collection Agent Working Memory (RAG Store) Service
 *
 * Provides isolated collections of agent working memory, partitioned by a `collectionName`
 * key. Each agent round can create its own named collection, store findings there, and later
 * query or delete entries within it.
 *
 * Backed by an in-process SQLite database (better-sqlite3) with FTS5 full-text search
 * for keyword-based retrieval.
 *
 * Production replacement:
 *   In production, queryContext() would call a vector embedding model and perform cosine
 *   similarity search against pgvector/Chroma. The interface is identical.
 *
 * Methods:
 *   ragStore.createCollection(name, description)       → emits RAG_STORE_CREATED
 *   ragStore.getCollections()                          → RagCollection[]
 *   ragStore.storeContext(collectionName, entry)       → emits MEMORY_STORED
 *   ragStore.queryContext(collectionName, query, tags) → MemoryQueryResult[]
 *   ragStore.getEntries(collectionName)                → MemoryEntry[]
 *   ragStore.deleteContext(collectionName, memoryId)   → emits MEMORY_DELETED
 */

import {
    type MemoryEntry,
    MemoryEntrySchema,
    type MemoryQueryResult,
    type RagCollection,
} from '@ai-hivemind/shared';
import BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import { eventBus } from '../eventBus.js';

import { logger } from './logger.js';

// ─── Database initialisation ───────────────────────────────────────────────────

const DB_PATH = process.env['RAG_DB_PATH'] ?? ':memory:';
const db = new BetterSqlite3(DB_PATH);

db.exec(`
    -- Named collections registry
    CREATE TABLE IF NOT EXISTS rag_collections (
        name        TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        createdAt   TEXT NOT NULL
    );

    -- Memories table — partitioned by collectionName
    CREATE TABLE IF NOT EXISTS memories (
        memoryId       TEXT PRIMARY KEY,
        traceId        TEXT NOT NULL,
        agentId        TEXT NOT NULL,
        collectionName TEXT NOT NULL DEFAULT 'default',
        content        TEXT NOT NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        timestamp      TEXT NOT NULL
    );

    -- FTS5 virtual table for full-text search on content
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='rowid');

    -- Keep FTS index in sync with the base table
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
`);

// ─── Prepared statements ───────────────────────────────────────────────────────

const stmtInsertCollection = db.prepare(`
    INSERT OR IGNORE INTO rag_collections (name, description, createdAt)
    VALUES (@name, @description, @createdAt)
`);

const stmtSelectCollections = db.prepare(`
    SELECT name, description, createdAt FROM rag_collections ORDER BY createdAt ASC
`);

const stmtInsertMemory = db.prepare(`
    INSERT INTO memories (memoryId, traceId, agentId, collectionName, content, tags, timestamp)
    VALUES (@memoryId, @traceId, @agentId, @collectionName, @content, @tags, @timestamp)
`);

const stmtDeleteMemory = db.prepare(`
    DELETE FROM memories WHERE memoryId = @memoryId AND collectionName = @collectionName
`);

const stmtSelectByCollection = db.prepare(`
    SELECT * FROM memories WHERE collectionName = @collectionName ORDER BY timestamp DESC
`);

const stmtFtsSearchInCollection = db.prepare(`
    SELECT m.*
    FROM memories m
    JOIN memories_fts f ON m.rowid = f.rowid
    WHERE memories_fts MATCH @query AND m.collectionName = @collectionName
    LIMIT @limit
`);

const stmtRecentInCollection = db.prepare(`
    SELECT * FROM memories WHERE collectionName = @collectionName ORDER BY timestamp DESC LIMIT @limit
`);

// ─── Row → MemoryEntry coercion ────────────────────────────────────────────────

interface MemoryRow {
    memoryId: string;
    traceId: string;
    agentId: string;
    collectionName: string;
    content: string;
    tags: string;
    timestamp: string;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
    return MemoryEntrySchema.parse({
        memoryId: row.memoryId,
        traceId: row.traceId,
        agentId: row.agentId,
        collectionName: row.collectionName,
        content: row.content,
        tags: JSON.parse(row.tags) as string[],
        timestamp: row.timestamp,
    });
}

// ─── Mock relevance score ──────────────────────────────────────────────────────

function mockScore(content: string, query: string): number {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const contentLower = content.toLowerCase();
    const hits = words.filter((w) => contentLower.includes(w)).length;
    return Math.min(hits / Math.max(words.length, 1), 1);
}

// ─── Service ──────────────────────────────────────────────────────────────────

const MAX_RESULTS = 10;

class RagStore {
    constructor() {
        // Seed the default collection on startup
        this._seedCollection('default', 'Default agent working memory collection');
    }

    private _seedCollection(name: string, description: string): void {
        stmtInsertCollection.run({ name, description, createdAt: new Date().toISOString() });
    }

    // ── Collections ────────────────────────────────────────────────────────────

    /**
     * Create a named collection. Idempotent (INSERT OR IGNORE).
     * Emits a RAG_STORE_CREATED SystemEvent.
     */
    createCollection(name: string, description = ''): RagCollection {
        const createdAt = new Date().toISOString();
        stmtInsertCollection.run({ name, description, createdAt });

        const col: RagCollection = { name, description, createdAt };

        eventBus.emit({
            eventId: uuidv4(),
            timestamp: createdAt,
            eventType: 'RAG_STORE_CREATED',
            sourceId: 'rag-store',
            targetId: null,
            payload: { collectionName: name, description },
        });

        logger.info(`[RAG Store] Collection created: ${name}`);
        return col;
    }

    /** Returns all registered collections ordered by creation time. */
    getCollections(): RagCollection[] {
        return (stmtSelectCollections.all() as { name: string; description: string; createdAt: string }[]).map(
            (r) => ({ name: r.name, description: r.description, createdAt: r.createdAt }),
        );
    }

    // ── Entries ────────────────────────────────────────────────────────────────

    /**
     * Store a memory entry in the named collection.
     * Auto-creates the collection if it doesn't exist yet.
     * Emits MEMORY_STORED.
     */
    storeContext(collectionName: string, input: Omit<MemoryEntry, 'collectionName'>): MemoryEntry {
        // Ensure collection exists
        this._seedCollection(collectionName, '');

        const entry = MemoryEntrySchema.parse({ ...input, collectionName });

        stmtInsertMemory.run({
            memoryId: entry.memoryId,
            traceId: entry.traceId,
            agentId: entry.agentId,
            collectionName: entry.collectionName,
            content: entry.content,
            tags: JSON.stringify(entry.tags),
            timestamp: entry.timestamp,
        });

        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'MEMORY_STORED',
            sourceId: entry.agentId,
            targetId: null,
            traceId: entry.traceId,
            payload: {
                memoryId: entry.memoryId,
                collectionName: entry.collectionName,
                agentId: entry.agentId,
                contentPreview: entry.content.slice(0, 120) + (entry.content.length > 120 ? '…' : ''),
                tags: entry.tags,
            },
        });

        return entry;
    }

    /**
     * Delete a specific memory entry from a collection.
     * Emits MEMORY_DELETED.
     */
    deleteContext(collectionName: string, memoryId: string): void {
        stmtDeleteMemory.run({ memoryId, collectionName });

        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'MEMORY_DELETED',
            sourceId: 'operator',
            targetId: null,
            payload: { memoryId, collectionName },
        });
    }

    /**
     * Retrieve all entries in a collection (for UI listing).
     * Returns newest-first, no limit applied.
     */
    getEntries(collectionName: string): MemoryEntry[] {
        const rows = stmtSelectByCollection.all({ collectionName }) as MemoryRow[];
        return rows.map(rowToEntry);
    }

    /**
     * Query memories in a collection by keyword and optional tags.
     *
     * Uses FTS5 MATCH for primary retrieval, filtered by collectionName.
     * Falls back to most-recent if no FTS match. Returns up to MAX_RESULTS.
     */
    queryContext(collectionName: string, query: string, tags?: string[]): MemoryQueryResult[] {
        let rows: MemoryRow[] = [];

        const ftsQuery = query.replace(/["*^()]/g, ' ').trim();

        if (ftsQuery.length > 0) {
            try {
                rows = stmtFtsSearchInCollection.all({
                    query: `"${ftsQuery}"`,
                    collectionName,
                    limit: MAX_RESULTS,
                }) as MemoryRow[];
            } catch {
                rows = [];
            }
        }

        if (rows.length === 0) {
            rows = stmtRecentInCollection.all({ collectionName, limit: MAX_RESULTS }) as MemoryRow[];
        }

        let entries = rows.map(rowToEntry);

        if (tags !== undefined && tags.length > 0) {
            const tagSet = new Set(tags);
            entries = entries.filter((e) => e.tags.some((t: string) => tagSet.has(t)));
        }

        return entries.slice(0, MAX_RESULTS).map((entry) => ({
            entry,
            score: mockScore(entry.content, query),
        }));
    }

    /** Returns the total number of stored memory entries across all collections. */
    get size(): number {
        const row = db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number };
        return row.count;
    }
}

export const ragStore = new RagStore();
