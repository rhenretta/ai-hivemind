import { z } from 'zod';

/**
 * Agent Working Memory (RAG Store) types.
 *
 * MemoryEntry is the unit stored by ragStore.storeContext() and retrieved by
 * ragStore.queryContext(). In production this is backed by vector embeddings
 * (pgvector or Chroma); in Phase 4/4.5 it is backed by SQLite FTS5 keyword search.
 *
 * These types cross the apps/backend → apps/web boundary (MEMORY_STORED events
 * carry a MemoryEntry in their payload) and must live in packages/shared.
 *
 * @version 0.6.0 — Added relatedMemoryIds, taskNodeId to MemoryEntry for cross-collection linking
 */

// ─── RagCollection ────────────────────────────────────────────────────────────

export const RagCollectionSchema = z.object({
    /** Unique slug for the collection — used as a partition key. */
    name: z.string().min(1),

    /** Human-readable description of the collection's purpose. */
    description: z.string(),

    /** ISO 8601 UTC timestamp when the collection was created. */
    createdAt: z.string().datetime(),
});
export type RagCollection = z.infer<typeof RagCollectionSchema>;

// ─── MemoryEntry ──────────────────────────────────────────────────────────────

export const MemoryEntrySchema = z.object({
    /** UUID v4 — unique memory identifier. */
    memoryId: z.string().uuid(),

    /**
     * Trace group this memory belongs to.
     * Set from the USER_COMMAND that initiated the agent round.
     */
    traceId: z.string().uuid(),

    /** Agent that produced this memory entry. */
    agentId: z.string().min(1),

    /**
     * The RAG collection this entry belongs to.
     * Defaults to 'default' when not otherwise specified.
     */
    collectionName: z.string().min(1).default('default'),

    /**
     * Free-form text content — a web scrape, tool output, or synthesised
     * knowledge chunk. This is the field searched by queryContext().
     */
    content: z.string().min(1),

    /**
     * Flat string tags for secondary filtering (e.g. ['auth', 'oauth2']).
     * Stored as a JSON array in SQLite, returned as a plain string[].
     */
    tags: z.array(z.string()),

    /** ISO 8601 UTC timestamp of when the memory was stored. */
    timestamp: z.string().datetime(),

    /**
     * IDs of related MemoryEntries across any collection.
     * Enables explicit cross-collection linking (e.g. research → SWE → QA chain).
     */
    relatedMemoryIds: z.array(z.string().uuid()).optional().default([]),

    /**
     * TaskGraph node ID this memory is associated with.
     * Links memory entries back to the task that prompted their creation.
     */
    taskNodeId: z.string().optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// ─── QueryResult — returned by ragStore.queryContext() ───────────────────────

export const MemoryQueryResultSchema = z.object({
    entry: MemoryEntrySchema,
    /** Mock relevance score (0–1). In production this is cosine similarity. */
    score: z.number().min(0).max(1),
});
export type MemoryQueryResult = z.infer<typeof MemoryQueryResultSchema>;

// ─── SweArtifact — structured output produced by SoftwareEngineer ────────────
//
// Replaces the old "\"[SUCCESS] Conductor run for: ...\"" plain-string approach.
// The QaEngineer reads this from the RAG store to reason about SWE quality.
//
export const SweArtifactSchema = z.object({
    /** The subtask description this run addressed. */
    subtask: z.string().min(1),

    /** Paths of files created or modified during the Conductor run. */
    filesChanged: z.array(z.string()),

    /** Shell commands executed (from `terminal` Gemini events). */
    commandsRun: z.array(z.string()),

    /** Error messages captured from `error` Gemini events. */
    errors: z.array(z.string()),

    /** Whether the Conductor exited successfully. */
    success: z.boolean(),

    /** The final `done.summary` from the Conductor stream (or last `result.result`). */
    summary: z.string(),
});
export type SweArtifact = z.infer<typeof SweArtifactSchema>;
