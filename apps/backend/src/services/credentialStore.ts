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
        serviceName     TEXT NOT NULL UNIQUE,
        serviceLabel    TEXT NOT NULL,
        credentialType  TEXT NOT NULL DEFAULT 'api_key',
        encryptedValue  TEXT NOT NULL,
        iv              TEXT NOT NULL,
        authTag         TEXT NOT NULL,
        envVarName      TEXT NOT NULL UNIQUE,
        metadata        TEXT NOT NULL DEFAULT '{}',
        createdAt       TEXT NOT NULL,
        updatedAt       TEXT NOT NULL
    );
`);

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
    metadata: string;
    createdAt: string;
    updatedAt: string;
}

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmtUpsert = db.prepare(`
    INSERT INTO credentials (id, serviceName, serviceLabel, credentialType, encryptedValue, iv, authTag, envVarName, metadata, createdAt, updatedAt)
    VALUES (@id, @serviceName, @serviceLabel, @credentialType, @encryptedValue, @iv, @authTag, @envVarName, @metadata, @createdAt, @updatedAt)
    ON CONFLICT(serviceName) DO UPDATE SET
        serviceLabel    = excluded.serviceLabel,
        credentialType  = excluded.credentialType,
        encryptedValue  = excluded.encryptedValue,
        iv              = excluded.iv,
        authTag         = excluded.authTag,
        envVarName      = excluded.envVarName,
        metadata        = excluded.metadata,
        updatedAt       = excluded.updatedAt
`);

const stmtSelectAll = db.prepare(`SELECT * FROM credentials ORDER BY createdAt ASC`);
const stmtSelectById = db.prepare(`SELECT * FROM credentials WHERE id = @id`);
const stmtDelete = db.prepare(`DELETE FROM credentials WHERE id = @id`);

// ─── Service ─────────────────────────────────────────────────────────────────

class CredentialStore {
    /**
     * Store or update a credential. The plaintext value is encrypted before
     * writing. Emits CREDENTIAL_STORED (no value in payload).
     */
    storeCredential(input: {
        serviceName: string;
        serviceLabel: string;
        credentialType?: string;
        envVarName: string;
        value: string;
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
            },
        });

        logger.info(`[CredentialStore] Stored credential for service: ${credential.serviceName}`);
        return credential;
    }

    /**
     * List all credentials with masked values (last 4 chars).
     * Used by the web UI.
     */
    listCredentials(): ServiceCredentialMasked[] {
        const rows = stmtSelectAll.all() as CredentialRow[];
        return rows.map((row) => {
            let masked = '****';
            try {
                const decrypted = decrypt(row.encryptedValue, row.iv, row.authTag);
                masked = decrypted.length > 4
                    ? '***' + decrypted.slice(-4)
                    : '****';
            } catch (err) {
                logger.error(`[CredentialStore] Failed to decrypt ${row.serviceName}: ${String(err)}`);
                masked = '[decryption failed]';
            }
            return {
                id: row.id,
                serviceName: row.serviceName,
                serviceLabel: row.serviceLabel,
                credentialType: row.credentialType as 'api_key' | 'oauth_token',
                envVarName: row.envVarName,
                metadata: JSON.parse(row.metadata) as Record<string, unknown>,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                maskedValue: masked,
            };
        });
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
     * Agent-safe projection: service names and env var mappings only.
     * Used in agent system prompts for service discovery.
     */
    getManifest(): ServiceManifestEntry[] {
        const rows = stmtSelectAll.all() as CredentialRow[];
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
     * Called by sandboxManager, conductor, and hydrateProcessEnv.
     */
    getDecryptedEnvVars(): Record<string, string> {
        const rows = stmtSelectAll.all() as CredentialRow[];
        const envVars: Record<string, string> = {};
        for (const row of rows) {
            try {
                envVars[row.envVarName] = decrypt(row.encryptedValue, row.iv, row.authTag);
            } catch (err) {
                logger.error(`[CredentialStore] Failed to decrypt ${row.serviceName}: ${String(err)}`);
            }
        }
        return envVars;
    }

    /**
     * Hydrate process.env with stored credentials.
     * Called once at backend startup so services like llm.ts can read API keys
     * via process.env without needing direct credential store access.
     * Only sets vars that are NOT already set (env vars take precedence).
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
