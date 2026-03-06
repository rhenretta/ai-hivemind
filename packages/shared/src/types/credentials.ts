import { z } from 'zod';

/**
 * Credential Store type definitions.
 *
 * Three projections of credential data, each with a different security posture:
 *   1. ServiceCredential     — internal shape (no plaintext value)
 *   2. ServiceCredentialMasked — frontend-safe (masked last 4 chars)
 *   3. ServiceManifestEntry   — agent-safe (names + env var mapping only)
 */

// ─── Credential Type ─────────────────────────────────────────────────────────

export const CredentialTypeSchema = z.enum(['api_key', 'oauth_token']);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

// ─── Service Credential (internal — never carries plaintext value) ───────────

export const ServiceCredentialSchema = z.object({
    /** UUID v4 — unique credential identifier. */
    id: z.string().uuid(),

    /** Machine-friendly slug (lowercase, hyphens/underscores ok). */
    serviceName: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),

    /** Human-readable label (e.g. "OpenAI"). */
    serviceLabel: z.string().min(1),

    /** Whether this is an API key or OAuth token. */
    credentialType: CredentialTypeSchema,

    /** Environment variable name injected into sandboxes (UPPER_SNAKE_CASE). */
    envVarName: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/),

    /** Arbitrary metadata (provider docs URL, scopes, etc.). */
    metadata: z.record(z.string(), z.unknown()).default({}),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type ServiceCredential = z.infer<typeof ServiceCredentialSchema>;

// ─── Masked Credential (frontend-safe — last 4 chars only) ──────────────────

export const ServiceCredentialMaskedSchema = ServiceCredentialSchema.extend({
    /** Masked value showing only the last 4 characters (e.g. "***abc4"). */
    maskedValue: z.string(),
});
export type ServiceCredentialMasked = z.infer<typeof ServiceCredentialMaskedSchema>;

// ─── Service Manifest Entry (agent-safe — names only, NO values) ─────────────

export const ServiceManifestEntrySchema = z.object({
    serviceName: z.string().min(1),
    serviceLabel: z.string().min(1),
    credentialType: CredentialTypeSchema,
    envVarName: z.string().min(1),
});
export type ServiceManifestEntry = z.infer<typeof ServiceManifestEntrySchema>;
