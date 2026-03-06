/**
 * Nerve Center — Entry Point
 *
 * Starts the HTTP + WebSocket server and registers graceful shutdown handlers.
 *
 * Environment: tsx loads .env.local via --env-file flag in the dev script.
 * In production, set env vars via your hosting platform or docker-compose env_file.
 */

import { httpServer, io } from './server.js';
import { authManager } from './services/authManager.js';
import { logger } from './services/logger.js';
import { buildSandboxImage, cleanupStaleSandboxes } from './services/sandboxManager.js';
import { loadPendingState, clearState } from './services/taskStateStore.js';
import { QaEngineer } from './agents/qaEngineer.js';

import type { SweArtifact } from '@ai-hivemind/shared';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
    logger.info(`[Nerve Center] Listening on http://localhost:${PORT}`);
    logger.info(`[Nerve Center] WebSocket ready   ws://localhost:${PORT}`);
    logger.info(`[Nerve Center] Health check      http://localhost:${PORT}/health`);
    logger.info(`[Nerve Center] Ledger replay     http://localhost:${PORT}/api/events`);

    // ── Sandbox Docker image build ─────────────────────────────────────────────
    // Build the sandbox image on startup (cached by Docker — near-instant
    // unless Dockerfile.sandbox or package manifests changed).
    try {
        buildSandboxImage();
    } catch (err) {
        logger.warn('[Nerve Center] Sandbox image build failed — sandbox tasks will not work:', err);
    }

    // ── Stale sandbox cleanup ─────────────────────────────────────────────────
    cleanupStaleSandboxes();

    // ── OAuth token auto-refresh ────────────────────────────────────────────
    authManager.init();

    // ── Restart resilience ────────────────────────────────────────────────────
    // If the backend was restarted by tsx watch after sandbox promotion,
    // a persisted 'awaiting-qa' state tells us to run QA immediately.
    const pending = loadPendingState();
    if (pending?.phase === 'awaiting-qa') {
        logger.info(`[Nerve Center] Resuming task ${pending.nodeId} at QA phase (traceId=${pending.traceId})`);

        // Allow server to fully bind before starting async QA
        setTimeout(() => {
            void resumeAtQa(pending.traceId, pending.nodeId, pending.objective, pending.acceptanceCriteria, {
                subtask: pending.objective,
                filesChanged: pending.filesChanged,
                commandsRun: [],
                errors: [],
                success: true,
                summary: pending.conductorSummary,
            }, pending.serviceUrl);
        }, 500);
    }
});

// ─── Resume at QA after restart ───────────────────────────────────────────────

async function resumeAtQa(
    traceId: string,
    nodeId: string,
    objective: string,
    acceptanceCriteria: string,
    artifact: SweArtifact,
    serviceUrl?: string,
): Promise<void> {
    try {
        const qaId = `qa-engineer.${nodeId.slice(0, 8)}`;
        const qa = new QaEngineer(qaId, traceId);
        logger.info(`[Nerve Center] Running post-restart QA for node=${nodeId}`);
        const verdict = await qa.run(objective, acceptanceCriteria, artifact, serviceUrl);
        logger.info(`[Nerve Center] Post-restart QA ${verdict.passed ? 'PASSED' : 'FAILED'} for node=${nodeId}`);
    } catch (err) {
        logger.error('[Nerve Center] Post-restart QA error:', err);
    } finally {
        clearState();
    }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
//
// On SIGINT (Ctrl-C) or SIGTERM (container orchestrator stop):
//  1. Stop accepting new Socket.io connections.
//  2. Close the HTTP server (stops accepting new HTTP connections; waits for
//     in-flight requests to complete).
//  3. Exit with code 0.
//
// This ensures the Command Center clients receive a clean disconnect event
// rather than a hard TCP reset.

async function shutdown(signal: string): Promise<void> {
    logger.info(`\n[Nerve Center] Received ${signal}. Shutting down gracefully...`);
    authManager.shutdown();

    // 1. Close Socket.io — disconnects all clients with a proper close frame.
    await io.close();
    logger.info('[Nerve Center] Socket.io closed.');

    // 2. Close HTTP server — no new requests, drain in-flight ones.
    await new Promise<void>((resolve) => {
        httpServer.close((err) => {
            if (err !== undefined) {
                logger.error('[Nerve Center] Error during HTTP server close:', err);
                process.exit(1);
            }
            logger.info('[Nerve Center] HTTP server closed. Goodbye.');
            resolve();
        });
    });

    process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
