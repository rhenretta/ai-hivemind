/**
 * softwareEngineer.ts — Software Engineer Agent (Claude Code CLI Bridge)
 *
 * The SWE agent bridges PM subtask instructions to a Claude Code CLI session.
 *
 * KEY CHANGE: The ConductorWrapper is injected from outside (usually ProjectManager)
 * so the SAME session persists across QA retry iterations. This preserves all
 * session context (files changed, commands run, git state) between retries.
 *
 * Workflow for each run(objective, conductor) call:
 *  1. AGENT_SPAWNED
 *  2. conductor.runTask(objective) — streams events; resolves on result event
 *  3. Store SweArtifact (structured) in RAG store for QaEngineer retrieval
 *  4. AGENT_TERMINATED
 *
 * The conductor is NOT aborted here. ProjectManager.abort()s it after all retries.
 */

import { ConductorWrapper } from '../services/conductor.js';
import { logger } from '../services/logger.js';
import { ragStore } from '../services/ragStore.js';

import { BaseAgent } from './baseAgent.js';

import type { SweArtifact } from '@ai-hivemind/shared';

export class SoftwareEngineer extends BaseAgent {
    /** Collection name for SWE outputs in the RAG store */
    static readonly RAG_COLLECTION = 'swe-outputs';

    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    /**
     * Run a coding task on an injected persistent Conductor session.
     *
     * @param objective  Self-contained description of what Claude Code should build/fix.
     * @param conductor  Shared ConductorWrapper instance (owned by ProjectManager).
     *                   If omitted, creates a temporary one (legacy / standalone use).
     */
    async run(
        objective: string,
        conductor?: ConductorWrapper,
    ): Promise<void> {
        // If no conductor injected, create a temporary session (backwards compat)
        const ownedLocally = conductor === undefined;
        const cond = conductor ?? new ConductorWrapper(this.agentId, this.traceId);

        this.spawn('swe-agent');
        this.emit('STATE_CHANGED', {
            message: `Received coding objective: "${objective}"`,
            objective,
        });

        // Accumulate structured artifact from Conductor stream events
        const artifact: SweArtifact = {
            subtask: objective,
            filesChanged: [],
            commandsRun: [],
            errors: [],
            success: false,
            summary: '',
        };

        // Subscribe to our own events on the bus to capture conductor output
        const { eventBus } = await import('../eventBus.js');
        const unsub = eventBus.subscribe('TOOL_USED', (event) => {
            if (event.sourceId !== this.agentId) return;
            const p = event.payload;
            const toolName = typeof p['toolName'] === 'string' ? p['toolName'] : '';
            const source = typeof p['source'] === 'string' ? p['source'] : '';

            if (source === 'conductor:code_change' || toolName === 'code_change') {
                const filePath = typeof p['filePath'] === 'string' ? p['filePath'] : '';
                if (filePath && !artifact.filesChanged.includes(filePath)) {
                    artifact.filesChanged.push(filePath);
                }
            } else if (source === 'conductor:terminal' || toolName === 'cli') {
                const command = typeof p['command'] === 'string' ? p['command'] : '';
                if (command) artifact.commandsRun.push(command);
            }
        });

        const unsubError = eventBus.subscribe('STATE_CHANGED', (event) => {
            if (event.sourceId !== this.agentId) return;
            const p = event.payload;
            const source = typeof p['source'] === 'string' ? p['source'] : '';
            const message = typeof p['message'] === 'string' ? p['message'] : '';

            if (source === 'conductor:error' && message.startsWith('Error:')) {
                artifact.errors.push(message.replace(/^Error:\s*/, ''));
            } else if (source === 'conductor:done' || source === 'conductor:result') {
                if (message && message !== 'Task complete') artifact.summary = message;
                if (p['success'] === true) artifact.success = true;
            }
        });

        try {
            await cond.runTask(objective);
            artifact.success = true;
            if (!artifact.summary) artifact.summary = 'Claude Code completed successfully.';

            this.emit('STATE_CHANGED', {
                message: 'Claude Code completed objective successfully.',
                objective,
                success: true,
                filesChanged: artifact.filesChanged.length,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            artifact.errors.push(msg);
            this.emit('ERROR', {
                message: `Claude Code failed: ${msg}`,
                objective,
                agentId: this.agentId,
            });
            logger.error(`[${this.agentId}] Claude Code error:`, err);
        } finally {
            unsub();
            unsubError();
            // Store structured artifact in RAG for ProjectManager/QaEngineer retrieval
            try {
                this.#storeArtifact(artifact);
            } catch (ragErr) {
                logger.warn(`[${this.agentId}] Failed to store artifact in RAG:`, ragErr);
            }
            // Only abort the conductor if this SWE owns it (standalone / compat mode)
            if (ownedLocally) cond.abort();
            this.terminate(artifact.success ? 'task_complete' : 'claude_code_failed');
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    #storeArtifact(artifact: SweArtifact): void {
        const collections = ragStore.getCollections();
        const exists = collections.some((c) => c.name === SoftwareEngineer.RAG_COLLECTION);
        if (!exists) {
            ragStore.createCollection(SoftwareEngineer.RAG_COLLECTION, 'Structured SweArtifact outputs from SWE agent Claude Code runs');
        }

        ragStore.storeContext(SoftwareEngineer.RAG_COLLECTION, {
            memoryId: crypto.randomUUID(),
            traceId: this.traceId,
            agentId: this.agentId,
            content: `[${artifact.success ? 'SUCCESS' : 'FAILED'}] ${this.agentId}\n${JSON.stringify(artifact)}`,
            tags: ['swe', 'conductor', artifact.success ? 'success' : 'failed', 'phase:implement'],
            timestamp: new Date().toISOString(),
        });
    }
}
