/**
 * baseAgent.ts — Abstract base class for all swarm agents
 *
 * Handles lifecycle events (AGENT_SPAWNED, AGENT_TERMINATED) and provides
 * a thin emit helper so subclasses don't work directly with the EventBus.
 *
 * Usage:
 *   class MyAgent extends BaseAgent {
 *     async run(objective: string) { ... }
 *   }
 *
 * Architecture rule: agents never share state; each run() is independent.
 * Coordinators may create child agent instances and await their run().
 */

import { type SystemEvent, type SystemEventType } from '@ai-hivemind/shared';
import { v4 as uuidv4 } from 'uuid';

import { eventBus } from '../eventBus.js';
import { logger } from '../services/logger.js';

export abstract class BaseAgent {
    /** Unique identifier shown in the Command Center topology. */
    readonly agentId: string;

    /** Trace context — links all events from this run to a single user command. */
    readonly traceId: string;

    protected constructor(agentId: string, traceId: string) {
        this.agentId = agentId;
        this.traceId = traceId;
    }

    /**
     * Override this to implement the agent's work loop.
     * Should call spawn() at the start and terminate() at the end.
     * Signature is intentionally permissive — subclasses may declare
     * more specific parameter/return types for their own callers.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abstract run(...args: any[]): Promise<unknown>;

    // ── Lifecycle helpers ─────────────────────────────────────────────────────

    /** Emit AGENT_SPAWNED — marks this agent as live in the topology. */
    protected spawn(role: string): void {
        this.emit('AGENT_SPAWNED', {
            role,
            agentId: this.agentId,
            message: `${role} agent spawned.`,
        });
        logger.info(`[${this.agentId}] Spawned (role=${role})`);
    }

    /**
     * Emit AGENT_TERMINATED — removes this agent from the live topology.
     * Uses targetId = this.agentId (per the Phase 4.6 convention).
     */
    protected terminate(reason = 'task_complete'): void {
        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'AGENT_TERMINATED',
            sourceId: this.agentId,
            targetId: this.agentId, // self-terminate
            traceId: this.traceId,
            payload: {
                reason,
                agentId: this.agentId,
                message: `${this.agentId} decommissioned. Reason: ${reason}.`,
            },
        });
        logger.info(`[${this.agentId}] Terminated (reason=${reason})`);
    }

    // ── Emit helper ───────────────────────────────────────────────────────────

    /** Emit any SystemEvent with this agent as the source, bound to the current trace. */
    protected emit(
        eventType: SystemEventType,
        payload: SystemEvent['payload'],
        targetId: string | null = null,
    ): void {
        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType,
            sourceId: this.agentId,
            targetId,
            traceId: this.traceId,
            payload,
        });
    }

    /** Emit a MESSAGE_SENT event to a specific target agent. */
    protected sendMessage(targetId: string, content: string, metadata?: Record<string, unknown>): void {
        this.emit('MESSAGE_SENT', { content, ...metadata }, targetId);
    }
}
