import { z } from 'zod';

/**
 * Telemetry metadata attached to every event in the Global Execution Ledger.
 *
 * All fields are optional — not every event carries all telemetry dimensions.
 * See docs/ARCHITECTURE.md §3.4 for the full field descriptions.
 */

export const EventMetadataSchema = z.object({
    // Token Economics
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    modelId: z.string().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),

    // Latency
    durationMs: z.number().nonnegative().optional(),
    queueWaitMs: z.number().nonnegative().optional(),

    // Tool Execution
    toolName: z.string().optional(),
    toolVersion: z.string().optional(),
    toolCallId: z.string().uuid().optional(),
    toolInputHash: z.string().length(64).optional(), // SHA-256 hex

    // CLI / Process Telemetry (SWE agent sandbox)
    exitCode: z.number().int().optional(),
    stdoutByteLen: z.number().int().nonnegative().optional(),
    stderrByteLen: z.number().int().nonnegative().optional(),
    commandHash: z.string().length(64).optional(), // SHA-256 hex

    // Environment
    sandboxId: z.string().uuid().optional(),
    containerImage: z.string().optional(),
    regionId: z.string().optional(),
});
export type EventMetadata = z.infer<typeof EventMetadataSchema>;
