import { z } from 'zod';

import { SweArtifactSchema } from './memory.js';

/**
 * Session type definitions.
 *
 * A Session is a persistent work unit that wraps a traceId with additional
 * metadata: the target repository, detected project profile, and lifecycle status.
 * Sessions replace the ephemeral "feature" concept that was reconstructed from
 * ledger events on each load.
 */

// ─── Session Status ──────────────────────────────────────────────────────────

export const SessionStatusSchema = z.enum([
    /** Conversational phase — no tasks created yet. */
    'exploring',
    /** Task graph created, not yet executing. */
    'planning',
    /** FeatureDeveloper actively executing tasks. */
    'active',
    /** Waiting for user input (QA escalated or agent blocked). */
    'blocked',
    /** All tasks completed successfully. */
    'completed',
    /** Terminal failure after all retries exhausted. */
    'failed',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// ─── Repository Configuration ────────────────────────────────────────────────

export const RepoConfigSchema = z.object({
    /** GitHub HTTPS URL (e.g. "https://github.com/owner/repo"). */
    url: z.string().url(),

    /** Default branch to clone from (e.g. "main"). */
    defaultBranch: z.string().min(1).default('main'),

    /** ID of the credential in credentialStore holding the GitHub OAuth token. */
    oauthTokenCredentialId: z.string().uuid().optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// ─── Project Profile (detected from repo contents) ──────────────────────────

export const ProjectProfileSchema = z.object({
    /** Detected package manager. */
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'bun', 'none']),

    /** Detected framework (e.g. "nextjs", "express", "react", "fastapi"). */
    framework: z.string().optional(),

    /** Primary language (e.g. "typescript", "javascript", "python"). */
    language: z.string().optional(),

    /** Build command (e.g. "npm run build"). */
    buildCommand: z.string().optional(),

    /** Dev server command (e.g. "npm run dev"). */
    devCommand: z.string().optional(),

    /** Dev server port (e.g. 3000). */
    devPort: z.number().int().positive().optional(),

    /** Key entry point files. */
    entryPoints: z.array(z.string()).optional(),

    /** Whether the repo is a monorepo (turbo, nx, lerna, pnpm workspaces). */
    monorepo: z.boolean().default(false),

    /** Workspace package names for monorepos. */
    workspacePackages: z.array(z.string()).optional(),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

// ─── Session ─────────────────────────────────────────────────────────────────

export const SessionSchema = z.object({
    /** UUID v4 — session identifier (same as traceId). */
    id: z.string().uuid(),

    /** User-facing session title (derived from first message or objective). */
    title: z.string().min(1),

    /** Current lifecycle status. */
    status: SessionStatusSchema,

    /** Target repository configuration. Null = local/monorepo mode. */
    repoConfig: RepoConfigSchema.nullable().default(null),

    /** Detected project structure. Null = not yet discovered. */
    projectProfile: ProjectProfileSchema.nullable().default(null),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

// ─── Session Artifacts (aggregated for Details panel) ────────────────────────

export const SweArtifactEntrySchema = z.object({
    memoryId: z.string(),
    agentId: z.string(),
    timestamp: z.string(),
    artifact: SweArtifactSchema.nullable(),
    rawContent: z.string(),
});
export type SweArtifactEntry = z.infer<typeof SweArtifactEntrySchema>;

export const ResearchFindingSchema = z.object({
    memoryId: z.string(),
    agentId: z.string(),
    timestamp: z.string(),
    content: z.string(),
    tags: z.array(z.string()),
});
export type ResearchFinding = z.infer<typeof ResearchFindingSchema>;

export const QaVerdictSummarySchema = z.object({
    eventId: z.string(),
    timestamp: z.string(),
    subtask: z.string(),
    passed: z.boolean(),
    issues: z.array(z.string()),
    warnings: z.array(z.string()),
    summary: z.string().optional(),
    checksRun: z.array(z.string()),
});
export type QaVerdictSummary = z.infer<typeof QaVerdictSummarySchema>;

export const SandboxStatusSchema = z.object({
    containerName: z.string(),
    running: z.boolean(),
    backendPort: z.number(),
    webPort: z.number(),
});
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const TaskStateSnapshotSchema = z.object({
    phase: z.string(),
    objective: z.string(),
    attempt: z.number(),
    filesChanged: z.array(z.string()),
});
export type TaskStateSnapshot = z.infer<typeof TaskStateSnapshotSchema>;

export const SessionArtifactsSchema = z.object({
    sweArtifacts: z.array(SweArtifactEntrySchema),
    researchFindings: z.array(ResearchFindingSchema),
    qaVerdicts: z.array(QaVerdictSummarySchema),
    sandbox: SandboxStatusSchema.nullable(),
    taskState: TaskStateSnapshotSchema.nullable(),
});
export type SessionArtifacts = z.infer<typeof SessionArtifactsSchema>;
