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
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { eventBus } from '../eventBus.js';

import {
    isEmbeddingAvailable,
    embedText,
    cosineSimilarity,
    embeddingToBuffer,
    bufferToEmbedding,
} from './embeddingService.js';
import { logger } from './logger.js';

// ─── Database initialisation ───────────────────────────────────────────────────

const DATA_DIR = path.resolve(
    process.env['DATA_DIR'] ?? path.join(import.meta.dirname ?? '.', '..', 'data'),
);
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env['RAG_DB_PATH'] ?? path.join(DATA_DIR, 'rag.db');
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

// ─── Schema migrations (idempotent) ────────────────────────────────────────────

try { db.exec(`ALTER TABLE memories ADD COLUMN relatedMemoryIds TEXT NOT NULL DEFAULT '[]'`); } catch { /* column already exists */ }
try { db.exec(`ALTER TABLE memories ADD COLUMN taskNodeId TEXT DEFAULT NULL`); } catch { /* column already exists */ }
try { db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB DEFAULT NULL`); } catch { /* column already exists */ }

// ─── Prepared statements ───────────────────────────────────────────────────────

const stmtInsertCollection = db.prepare(`
    INSERT OR IGNORE INTO rag_collections (name, description, createdAt)
    VALUES (@name, @description, @createdAt)
`);

const stmtSelectCollections = db.prepare(`
    SELECT name, description, createdAt FROM rag_collections ORDER BY createdAt ASC
`);

const stmtInsertMemory = db.prepare(`
    INSERT INTO memories (memoryId, traceId, agentId, collectionName, content, tags, timestamp, relatedMemoryIds, taskNodeId)
    VALUES (@memoryId, @traceId, @agentId, @collectionName, @content, @tags, @timestamp, @relatedMemoryIds, @taskNodeId)
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

const stmtSelectByCollectionAndTrace = db.prepare(`
    SELECT * FROM memories
    WHERE collectionName = @collectionName AND traceId = @traceId
    ORDER BY timestamp DESC LIMIT 50
`);

const stmtSelectByTrace = db.prepare(`
    SELECT * FROM memories WHERE traceId = @traceId ORDER BY timestamp DESC LIMIT @limit
`);

const stmtFtsSearchByTrace = db.prepare(`
    SELECT m.*
    FROM memories m
    JOIN memories_fts f ON m.rowid = f.rowid
    WHERE memories_fts MATCH @query AND m.traceId = @traceId
    LIMIT @limit
`);

const stmtRecentByTrace = db.prepare(`
    SELECT * FROM memories WHERE traceId = @traceId ORDER BY timestamp DESC LIMIT @limit
`);

const stmtUpdateEmbedding = db.prepare(`
    UPDATE memories SET embedding = @embedding WHERE memoryId = @memoryId
`);

const stmtSelectWithEmbedding = db.prepare(`
    SELECT * FROM memories WHERE collectionName = @collectionName AND embedding IS NOT NULL
`);

const stmtSelectWithEmbeddingByTrace = db.prepare(`
    SELECT * FROM memories WHERE traceId = @traceId AND embedding IS NOT NULL
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
    relatedMemoryIds: string;
    taskNodeId: string | null;
    embedding: Buffer | null;
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
        relatedMemoryIds: JSON.parse(row.relatedMemoryIds) as string[],
        taskNodeId: row.taskNodeId ?? undefined,
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
    storeContext(
        collectionName: string,
        input: Omit<MemoryEntry, 'collectionName' | 'relatedMemoryIds' | 'taskNodeId'> & {
            relatedMemoryIds?: string[];
            taskNodeId?: string;
        },
    ): MemoryEntry {
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
            relatedMemoryIds: JSON.stringify(entry.relatedMemoryIds ?? []),
            taskNodeId: entry.taskNodeId ?? null,
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

        // Fire-and-forget: embed the content for semantic search
        if (isEmbeddingAvailable()) {
            void this._embedEntry(entry.memoryId, entry.content);
        }

        return entry;
    }

    /**
     * Asynchronously embed a memory entry's content and store the vector.
     * Called fire-and-forget from storeContext — failures are logged, not thrown.
     */
    private async _embedEntry(memoryId: string, content: string): Promise<void> {
        try {
            const vec = await embedText(content);
            const buf = embeddingToBuffer(vec);
            stmtUpdateEmbedding.run({ memoryId, embedding: buf });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[RAG Store] Embedding failed for ${memoryId}: ${msg}`);
        }
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
     * Retrieve entries in a collection filtered by traceId (session).
     * Returns newest-first, capped at 50 entries.
     */
    getEntriesByTrace(collectionName: string, traceId: string): MemoryEntry[] {
        const rows = stmtSelectByCollectionAndTrace.all({ collectionName, traceId }) as MemoryRow[];
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

    // ── Cross-collection queries ──────────────────────────────────────────────

    /**
     * Query memories across ALL collections for a given traceId.
     * If `query` is provided, uses FTS5; otherwise returns most-recent.
     */
    queryAcrossCollections(traceId: string, query?: string, limit = 20): MemoryQueryResult[] {
        let rows: MemoryRow[] = [];

        if (query !== undefined && query.length > 0) {
            const ftsQuery = query.replace(/["*^()]/g, ' ').trim();
            if (ftsQuery.length > 0) {
                try {
                    rows = stmtFtsSearchByTrace.all({
                        query: `"${ftsQuery}"`,
                        traceId,
                        limit,
                    }) as MemoryRow[];
                } catch {
                    rows = [];
                }
            }
        }

        if (rows.length === 0) {
            rows = stmtRecentByTrace.all({ traceId, limit }) as MemoryRow[];
        }

        return rows.map(rowToEntry).map((entry) => ({
            entry,
            score: query !== undefined ? mockScore(entry.content, query) : 1,
        }));
    }

    /**
     * Retrieve all entries for a traceId across all collections (no scoring).
     * Used by the Memory Explorer UI to show all session knowledge.
     */
    getAllEntriesByTrace(traceId: string, limit = 100): MemoryEntry[] {
        const rows = stmtSelectByTrace.all({ traceId, limit }) as MemoryRow[];
        return rows.map(rowToEntry);
    }

    /**
     * Batch-fetch entries by their memoryIds (across any collection).
     * Used to resolve relatedMemoryIds links.
     */
    getRelatedEntries(memoryIds: string[]): MemoryEntry[] {
        if (memoryIds.length === 0) return [];
        const placeholders = memoryIds.map(() => '?').join(', ');
        const stmt = db.prepare(`SELECT * FROM memories WHERE memoryId IN (${placeholders})`);
        const rows = stmt.all(...memoryIds) as MemoryRow[];
        return rows.map(rowToEntry);
    }

    // ── Semantic (embedding-based) queries ─────────────────────────────────

    /**
     * Semantic search within a single collection using vector cosine similarity.
     * Falls back to FTS5 queryContext() when embeddings are unavailable.
     */
    async queryContextSemantic(collectionName: string, query: string, tags?: string[]): Promise<MemoryQueryResult[]> {
        if (!isEmbeddingAvailable()) {
            return this.queryContext(collectionName, query, tags);
        }

        try {
            const queryVec = await embedText(query);
            const rows = stmtSelectWithEmbedding.all({ collectionName }) as MemoryRow[];

            let scored = rows.map((row) => {
                const entryVec = bufferToEmbedding(row.embedding!);
                const semantic = cosineSimilarity(queryVec, entryVec);
                const keyword = mockScore(row.content, query);
                return { row, score: 0.7 * semantic + 0.3 * keyword };
            });

            scored.sort((a, b) => b.score - a.score);

            if (tags !== undefined && tags.length > 0) {
                const tagSet = new Set(tags);
                scored = scored.filter((s) => {
                    const entryTags = JSON.parse(s.row.tags) as string[];
                    return entryTags.some((t) => tagSet.has(t));
                });
            }

            return scored.slice(0, MAX_RESULTS).map((s) => ({
                entry: rowToEntry(s.row),
                score: Math.max(0, Math.min(1, s.score)),
            }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[RAG Store] Semantic query failed, falling back to FTS: ${msg}`);
            return this.queryContext(collectionName, query, tags);
        }
    }

    /**
     * Semantic cross-collection search for a given traceId.
     * Falls back to FTS-based queryAcrossCollections() when embeddings are unavailable.
     */
    async queryAcrossCollectionsSemantic(traceId: string, query: string, limit = 20): Promise<MemoryQueryResult[]> {
        if (!isEmbeddingAvailable()) {
            return this.queryAcrossCollections(traceId, query, limit);
        }

        try {
            const queryVec = await embedText(query);
            const rows = stmtSelectWithEmbeddingByTrace.all({ traceId }) as MemoryRow[];

            const scored = rows.map((row) => {
                const entryVec = bufferToEmbedding(row.embedding!);
                const semantic = cosineSimilarity(queryVec, entryVec);
                const keyword = mockScore(row.content, query);
                return { row, score: 0.7 * semantic + 0.3 * keyword };
            });

            scored.sort((a, b) => b.score - a.score);

            return scored.slice(0, limit).map((s) => ({
                entry: rowToEntry(s.row),
                score: Math.max(0, Math.min(1, s.score)),
            }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[RAG Store] Semantic cross-collection query failed, falling back to FTS: ${msg}`);
            return this.queryAcrossCollections(traceId, query, limit);
        }
    }

    /** Returns the total number of stored memory entries across all collections. */
    get size(): number {
        const row = db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number };
        return row.count;
    }
}

export const ragStore = new RagStore();
