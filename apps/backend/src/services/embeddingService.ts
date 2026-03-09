/**
 * embeddingService.ts — OpenAI Embedding Service
 *
 * Provides text embedding via OpenAI's text-embedding-3-small model.
 * Used by ragStore for semantic vector search.
 *
 * Graceful degradation: when OPENAI_API_KEY is not set, isEmbeddingAvailable()
 * returns false and all callers fall back to FTS5 keyword search.
 */

import OpenAI from 'openai';

import { logger } from './logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

// ─── Lazy OpenAI client (same pattern as llm.ts) ────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
    if (_client === null) {
        const apiKey = process.env['OPENAI_API_KEY'];
        if (apiKey === undefined || apiKey === '' || apiKey === 'sk-...') {
            throw new Error('[Embedding] OPENAI_API_KEY is not set.');
        }
        _client = new OpenAI({ apiKey });
    }
    return _client;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check whether embedding is available (OPENAI_API_KEY is set).
 * Callers use this to decide between semantic and FTS5 paths.
 */
export function isEmbeddingAvailable(): boolean {
    const apiKey = process.env['OPENAI_API_KEY'];
    return apiKey !== undefined && apiKey !== '' && apiKey !== 'sk-...';
}

/**
 * Embed a single text string. Returns a Float64Array of EMBEDDING_DIMENSIONS length.
 */
export async function embedText(text: string): Promise<Float64Array> {
    const client = getClient();
    const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
    });

    const embedding = response.data[0]?.embedding;
    if (embedding === undefined) {
        throw new Error('[Embedding] No embedding returned from API');
    }

    return new Float64Array(embedding);
}

/**
 * Embed multiple texts in a single API call (up to 2048 per batch).
 * Returns an array of Float64Arrays in the same order as input.
 */
export async function embedBatch(texts: string[]): Promise<Float64Array[]> {
    if (texts.length === 0) return [];

    const client = getClient();
    const BATCH_SIZE = 2048;
    const results: Float64Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const response = await client.embeddings.create({
            model: EMBEDDING_MODEL,
            input: batch,
        });

        // API returns embeddings in index order
        const sorted = response.data.sort((a, b) => a.index - b.index);
        for (const item of sorted) {
            results.push(new Float64Array(item.embedding));
        }
    }

    return results;
}

/**
 * Cosine similarity between two embedding vectors.
 * OpenAI embeddings are pre-normalized, so this returns a value in [-1, 1].
 * For ranking purposes, higher = more similar.
 */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += (a[i] ?? 0) * (b[i] ?? 0);
        normA += (a[i] ?? 0) * (a[i] ?? 0);
        normB += (b[i] ?? 0) * (b[i] ?? 0);
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Convert a Float64Array embedding to a Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float64Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert a SQLite BLOB Buffer back to a Float64Array.
 */
export function bufferToEmbedding(buf: Buffer): Float64Array {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float64Array(ab);
}

logger.info(`[Embedding] Service loaded | available=${String(isEmbeddingAvailable())} | model=${EMBEDDING_MODEL}`);
