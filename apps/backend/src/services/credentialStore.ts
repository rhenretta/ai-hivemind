/**
 * credentialStore.ts — Encrypted Credential Storage Service
 *
 * Stores user-provided API keys for external services (OpenAI, Brave, etc.)
 * encrypted at rest using AES-256-GCM. Provides three access tiers:
 *
 *   1. listCredentials()     → masked values (last 4 chars) for the web UI
 *   2. getManifest()         → names only (no values) for agent prompt injection
 *   3. getDecryptedEnvVars() → plaintext values for sandbox env var injection
 *
 * Credentials may be global (sessionId = NULL, injected into all sandboxes) or
 * session-scoped (sessionId set, injected only into that session's sandbox).
 * Session-scoped values override globals for the same envVarName.
 *
 * Follows the ragStore.ts singleton pattern: module-level better-sqlite3 DB
 * with prepared statements and EventBus integration.
 */

import {
    ServiceCredentialSchema,
    type ServiceCredential,
    type ServiceCredentialMasked,
    type ServiceManifestEntry,
} from '@ai-hivemind/shared';
import BetterSqlite3 from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { eventBus } from '../eventBus.js';

import { logger } from './logger.js';

// ─── Database initialisation ─────────────────────────────────────────────────

const DB_PATH = process.env['CREDENTIAL_DB_PATH'] ?? ':memory:';

// Ensure parent directory exists (like ledgerStore does)
if (DB_PATH !== ':memory:') {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

const db = new BetterSqlite3(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
        id              TEXT PRIMARY KEY,
        serviceName     TEXT NOT NULL,
        serviceLabel    TEXT NOT NULL,
        credentialType  TEXT NOT NULL DEFAULT 'api_key',
        encryptedValue  TEXT NOT NULL,
        iv              TEXT NOT NULL,
        authTag         TEXT NOT NULL,
        envVarName      TEXT NOT NULL,
        sessionId       TEXT,
        metadata        TEXT NOT NULL DEFAULT '{}',
        createdAt       TEXT NOT NULL,
        updatedAt       TEXT NOT NULL
    );
`);

// Composite unique indexes: serviceName and envVarName are unique per session scope.
// COALESCE handles NULL sessionId (global) so it participates in uniqueness.
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_service_session ON credentials (serviceName, COALESCE(sessionId, '__global__'))`); } catch { /* already exists or legacy schema */ }
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_envvar_session ON credentials (envVarName, COALESCE(sessionId, '__global__'))`); } catch { /* already exists or legacy schema */ }

// Migration: add sessionId column if missing (existing DBs with old schema)
try { db.exec(`ALTER TABLE credentials ADD COLUMN sessionId TEXT`); } catch { /* column already exists */ }

// Drop legacy column-level UNIQUE constraints by rebuilding (only needed once).
// SQLite doesn't support DROP CONSTRAINT, so we detect and skip if already migrated.
try {
    const tableInfo = db.pragma('index_list(credentials)') as Array<{ name: string; unique: number }>;
    const hasLegacyUnique = tableInfo.some(
        (idx) => idx.unique === 1 && idx.name.startsWith('sqlite_autoindex_credentials_'),
    );
    if (hasLegacyUnique) {
        logger.info('[CredentialStore] Migrating: removing legacy UNIQUE column constraints');
        db.exec(`
            CREATE TABLE IF NOT EXISTS credentials_new (
                id              TEXT PRIMARY KEY,
                serviceName     TEXT NOT NULL,
                serviceLabel    TEXT NOT NULL,
                credentialType  TEXT NOT NULL DEFAULT 'api_key',
                encryptedValue  TEXT NOT NULL,
                iv              TEXT NOT NULL,
                authTag         TEXT NOT NULL,
                envVarName      TEXT NOT NULL,
                sessionId       TEXT,
                metadata        TEXT NOT NULL DEFAULT '{}',
                createdAt       TEXT NOT NULL,
                updatedAt       TEXT NOT NULL
            );
            INSERT OR IGNORE INTO credentials_new SELECT id, serviceName, serviceLabel, credentialType, encryptedValue, iv, authTag, envVarName, sessionId, metadata, createdAt, updatedAt FROM credentials;
            DROP TABLE credentials;
            ALTER TABLE credentials_new RENAME TO credentials;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_service_session ON credentials (serviceName, COALESCE(sessionId, '__global__'));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cred_envvar_session ON credentials (envVarName, COALESCE(sessionId, '__global__'));
        `);
        logger.info('[CredentialStore] Migration complete');
    }
} catch (err) {
    logger.warn(`[CredentialStore] Migration check skipped: ${String(err)}`);
}

// ─── Encryption ──────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';

function getMasterKey(): Buffer {
    const keyHex = process.env['CREDENTIAL_MASTER_KEY'];
    if (keyHex && keyHex.length === 64) {
        return Buffer.from(keyHex, 'hex');
    }
    // Fallback: derive from ANTHROPIC_API_KEY via SHA-256 (development only)
    const fallback = process.env['ANTHROPIC_API_KEY'] ?? '';
    if (fallback.length === 0) {
        throw new Error(
            'Neither CREDENTIAL_MASTER_KEY nor ANTHROPIC_API_KEY is set. Cannot encrypt credentials.',
        );
    }
    logger.warn(
        '[CredentialStore] Using derived master key from ANTHROPIC_API_KEY. Set CREDENTIAL_MASTER_KEY for production.',
    );
    return crypto.createHash('sha256').update(fallback).digest();
}

function encrypt(plaintext: string): { encrypted: string; iv: string; authTag: string } {
    const key = getMasterKey();
    const ivBuf = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv(ALGORITHM, key, ivBuf);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        encrypted: encrypted.toString('hex'),
        iv: ivBuf.toString('hex'),
        authTag: tag.toString('hex'),
    };
}

function decrypt(encryptedHex: string, ivHex: string, authTagHex: string): string {
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, 'hex')),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}

// ─── Row type (what SQLite returns) ──────────────────────────────────────────

interface CredentialRow {
    id: string;
    serviceName: string;
    serviceLabel: string;
    credentialType: string;
    encryptedValue: string;
    iv: string;
    authTag: string;
    envVarName: string;
    sessionId: string | null;
    metadata: string;
    createdAt: string;
    updatedAt: string;
}

function maskValue(row: CredentialRow): string {
    try {
        const decrypted = decrypt(row.encryptedValue, row.iv, row.authTag);
        return decrypted.length > 4 ? '***' + decrypted.slice(-4) : '****';
    } catch (err) {
        logger.error(`[CredentialStore] Failed to decrypt ${row.serviceName}: ${String(err)}`);
        return '[decryption failed]';
    }
}

function rowToMasked(row: CredentialRow): ServiceCredentialMasked {
    return {
        id: row.id,
        serviceName: row.serviceName,
        serviceLabel: row.serviceLabel,
        credentialType: row.credentialType as 'api_key' | 'oauth_token',
        envVarName: row.envVarName,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        maskedValue: maskValue(row),
    };
}

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmtUpsert = db.prepare(`
    INSERT INTO credentials (id, serviceName, serviceLabel, credentialType, encryptedValue, iv, authTag, envVarName, sessionId, metadata, createdAt, updatedAt)
    VALUES (@id, @serviceName, @serviceLabel, @credentialType, @encryptedValue, @iv, @authTag, @envVarName, @sessionId, @metadata, @createdAt, @updatedAt)
    ON CONFLICT(serviceName, COALESCE(sessionId, '__global__')) DO UPDATE SET
        serviceLabel    = excluded.serviceLabel,
        credentialType  = excluded.credentialType,
        encryptedValue  = excluded.encryptedValue,
        iv              = excluded.iv,
        authTag         = excluded.authTag,
        envVarName      = excluded.envVarName,
        metadata        = excluded.metadata,
        updatedAt       = excluded.updatedAt
`);

const stmtSelectGlobal = db.prepare(`SELECT * FROM credentials WHERE sessionId IS NULL ORDER BY createdAt ASC`);
const stmtSelectBySession = db.prepare(`SELECT * FROM credentials WHERE sessionId = @sessionId ORDER BY createdAt ASC`);
const stmtSelectById = db.prepare(`SELECT * FROM credentials WHERE id = @id`);
const stmtDelete = db.prepare(`DELETE FROM credentials WHERE id = @id`);
const stmtDeleteBySession = db.prepare(`DELETE FROM credentials WHERE sessionId = @sessionId`);

// ─── Service ─────────────────────────────────────────────────────────────────

class CredentialStore {
    /**
     * Store or update a credential. The plaintext value is encrypted before
     * writing. Emits CREDENTIAL_STORED (no value in payload).
     *
     * @param input.sessionId — if provided, credential is scoped to that session only.
     */
    storeCredential(input: {
        serviceName: string;
        serviceLabel: string;
        credentialType?: string;
        envVarName: string;
        value: string;
        sessionId?: string | null;
        metadata?: Record<string, unknown>;
    }): ServiceCredential {
        const now = new Date().toISOString();
        const id = uuidv4();
        const { encrypted, iv, authTag } = encrypt(input.value);

        const credential: ServiceCredential = ServiceCredentialSchema.parse({
            id,
            serviceName: input.serviceName,
            serviceLabel: input.serviceLabel,
            credentialType: input.credentialType ?? 'api_key',
            envVarName: input.envVarName,
            metadata: input.metadata ?? {},
            createdAt: now,
            updatedAt: now,
        });

        stmtUpsert.run({
            ...credential,
            encryptedValue: encrypted,
            iv,
            authTag,
            sessionId: input.sessionId ?? null,
            metadata: JSON.stringify(credential.metadata),
        });

        // Audit event — NEVER include the value
        eventBus.emit({
            eventId: uuidv4(),
            timestamp: now,
            eventType: 'CREDENTIAL_STORED',
            sourceId: 'credential-store',
            targetId: null,
            payload: {
                serviceName: credential.serviceName,
                serviceLabel: credential.serviceLabel,
                envVarName: credential.envVarName,
                credentialType: credential.credentialType,
                sessionId: input.sessionId ?? null,
            },
        });

        logger.info(`[CredentialStore] Stored credential for service: ${credential.serviceName}${input.sessionId ? ` (session: ${input.sessionId})` : ''}`);
        return credential;
    }

    /**
     * List global credentials (sessionId IS NULL) with masked values.
     * Used by the global Settings page.
     */
    listCredentials(): ServiceCredentialMasked[] {
        const rows = stmtSelectGlobal.all() as CredentialRow[];
        return rows.map(rowToMasked);
    }

    /**
     * List session-scoped credentials with masked values.
     * Used by the per-session env var editor in DetailsTab.
     */
    listCredentialsBySession(sessionId: string): ServiceCredentialMasked[] {
        const rows = stmtSelectBySession.all({ sessionId }) as CredentialRow[];
        return rows.map(rowToMasked);
    }

    /**
     * Delete a credential by ID. Emits CREDENTIAL_DELETED.
     */
    deleteCredential(id: string): boolean {
        const row = stmtSelectById.get({ id }) as CredentialRow | undefined;
        if (!row) return false;

        stmtDelete.run({ id });

        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'CREDENTIAL_DELETED',
            sourceId: 'credential-store',
            targetId: null,
            payload: { serviceName: row.serviceName, envVarName: row.envVarName },
        });

        logger.info(`[CredentialStore] Deleted credential: ${row.serviceName}`);
        return true;
    }

    /**
     * Delete all credentials scoped to a session. Called on session deletion.
     */
    deleteSessionCredentials(sessionId: string): number {
        const result = stmtDeleteBySession.run({ sessionId });
        if (result.changes > 0) {
            logger.info(`[CredentialStore] Deleted ${result.changes.toString()} session credential(s) for ${sessionId}`);
        }
        return result.changes;
    }

    /**
     * Agent-safe projection: service names and env var mappings only.
     * Used in agent system prompts for service discovery.
     * Returns global credentials only.
     */
    getManifest(): ServiceManifestEntry[] {
        const rows = stmtSelectGlobal.all() as CredentialRow[];
        return rows.map((row) => ({
            serviceName: row.serviceName,
            serviceLabel: row.serviceLabel,
            credentialType: row.credentialType as 'api_key' | 'oauth_token',
            envVarName: row.envVarName,
        }));
    }

    /**
     * Returns decrypted env var pairs for sandbox injection.
     * This is the ONLY method that exposes plaintext values.
     *
     * If sessionId is provided, returns global vars merged with session-scoped
     * vars (session overrides global for the same envVarName).
     */
    getDecryptedEnvVars(sessionId?: string): Record<string, string> {
        // Start with global credentials
        const globalRows = stmtSelectGlobal.all() as CredentialRow[];
        const envVars: Record<string, string> = {};
        for (const row of globalRows) {
            try {
                envVars[row.envVarName] = decrypt(row.encryptedValue, row.iv, row.authTag);
            } catch (err) {
                logger.error(`[CredentialStore] Failed to decrypt ${row.serviceName}: ${String(err)}`);
            }
        }

        // Overlay session-scoped credentials (overrides globals for same envVarName)
        if (sessionId !== undefined) {
            const sessionRows = stmtSelectBySession.all({ sessionId }) as CredentialRow[];
            for (const row of sessionRows) {
                try {
                    envVars[row.envVarName] = decrypt(row.encryptedValue, row.iv, row.authTag);
                } catch (err) {
                    logger.error(`[CredentialStore] Failed to decrypt session credential ${row.serviceName}: ${String(err)}`);
                }
            }
        }

        return envVars;
    }

    /**
     * Hydrate process.env with stored credentials.
     * Called once at backend startup so services like llm.ts can read API keys
     * via process.env without needing direct credential store access.
     * Only sets vars that are NOT already set (env vars take precedence).
     * Uses global credentials only.
     */
    hydrateProcessEnv(): void {
        try {
            const vars = this.getDecryptedEnvVars();
            let count = 0;
            for (const [key, value] of Object.entries(vars)) {
                if (process.env[key] === undefined || process.env[key] === '') {
                    process.env[key] = value;
                    count++;
                }
            }
            if (count > 0) {
                logger.info(`[CredentialStore] Hydrated ${count.toString()} env var(s) from credential store`);
            }
        } catch (err) {
            logger.warn(`[CredentialStore] Failed to hydrate process.env: ${String(err)}`);
        }
    }
}

export const credentialStore = new CredentialStore();
