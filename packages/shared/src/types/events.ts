import { z } from 'zod';

/**
 * Event type definitions for the Global Execution Ledger and the
 * SystemEvent wire format consumed by the Command Center WebSocket stream.
 *
 * EventType is the central discriminant for all events in the system.
 * Adding a new EventType is a MINOR version bump to packages/shared.
 * Removing or renaming an EventType is a MAJOR version bump.
 *
 * @version 0.8.0 — Added TASK_PLAN_CREATED, QA_VERDICT for RPIV loop
 */

// ─── System Event Type (Phase 1 wire-format enum) ─────────────────────────────
//
// These are the simplified event types surfaced over the WebSocket stream to the
// Command Center UI. They intentionally map to the richer internal EventType
// values but use concise names for the client-facing protocol.
//
//   AGENT_SPAWNED  → AGENT_SPAWNED lifecycle event
//   STATE_CHANGED  → AGENT_STATE_CHANGED lifecycle transition
//   MESSAGE_SENT   → A2A_MESSAGE_SENT between agents
//   TOOL_USED      → TOOL_CALL_COMPLETED (result of a tool invocation)
//   ERROR          → Any error or failure event class
//
export const SystemEventTypeSchema = z.enum([
    'AGENT_SPAWNED',
    'STATE_CHANGED',
    'MESSAGE_SENT',
    'TOOL_USED',
    'ERROR',
    /** User-initiated task directive; carries a traceId that groups all derived events. */
    'USER_COMMAND',
    /** An MCP tool was registered in the registry (emitted by mcpRegistry service). */
    'TOOL_REGISTERED',
    /** A memory entry was stored in the RAG store (emitted by ragStore service). */
    'MEMORY_STORED',
    /** A new RAG collection (knowledge base) was created by an agent. */
    'RAG_STORE_CREATED',
    /** A memory entry was deleted from a RAG collection. */
    'MEMORY_DELETED',
    /** An ephemeral specialist agent completed its task and was decommissioned. */
    'AGENT_TERMINATED',
    /**
     * Claude Code CLI detected a local dev server running at a given URL/port.
     * Payload: { serviceName: string, url: string, port: number }
     */
    'SERVICE_DEPLOYED',
    /**
     * Claude Code CLI is blocked and needs human input before it can proceed.
     */
    'AGENT_INPUT_REQUIRED',
    /**
     * The user sent text feedback to a running agent via the Command Center.
     * Payload: { text: string } — written to the Claude Code CLI's stdin.
     */
    'USER_INTERVENTION',
    /**
     * ProjectManager has decomposed an objective into an ordered subtask list.
     * Payload: { subtasks: Array<{ id: string; description: string; acceptanceCriteria: string }> }
     */
    'TASK_PLAN_CREATED',
    /**
     * QaEngineer has reviewed a SWE artifact and issued a pass/fail verdict.
     * Payload: { subtask: string, passed: boolean, issues: string[] }
     */
    'QA_VERDICT',
    /**
     * Real-time text streaming from/to the Claude Code CLI subprocess.
     * Payload: { text: string, direction: 'in' | 'out', kind: 'thought' | 'message' | 'tool' | 'result' | 'input' | 'error' }
     * direction='in'  → text sent TO Claude Code (our prompts)
     * direction='out' → text received FROM Claude Code (thoughts, messages, results)
     */
    'CONDUCTOR_STREAM',
    /**
     * TaskOrchestrator emitted a full task graph snapshot.
     * Emitted once on creation and on every node status change.
     * Payload: { graph: TaskGraph (serialized) }
     */
    'TASK_GRAPH_UPDATED',
    /**
     * A single task node completed (done or failed).
     * Payload: { nodeId: string, status: TaskStatus, result?: string, error?: string }
     */
    'TASK_NODE_COMPLETED',
    /**
     * A credential was stored or updated in the Credential Store.
     * Payload: { serviceName, serviceLabel, envVarName, credentialType } — NEVER the value.
     */
    'CREDENTIAL_STORED',
    /**
     * A credential was deleted from the Credential Store.
     * Payload: { serviceName, envVarName }
     */
    'CREDENTIAL_DELETED',
    /**
     * A feature was approved by the user and merged from sandbox into the monorepo.
     * Payload: { routes: string[], filesChanged: string[] }
     */
    'FEATURE_DEPLOYED',
    /**
     * A feature was deleted by the user. Sandbox is destroyed, feature removed from UI.
     * Payload: { reason?: string }
     */
    'FEATURE_DELETED',
    /**
     * Real-time server log output from a sandbox container.
     * Payload: { text: string, source: 'stdout' | 'stderr' | 'backend' | 'frontend' }
     */
    'SANDBOX_LOG',
]);
export type SystemEventType = z.infer<typeof SystemEventTypeSchema>;

// ─── System Event — the flat wire-format envelope ─────────────────────────────
//
// This is the canonical event shape broadcast over Socket.io to the Command
// Center. It is intentionally simpler than LedgerEvent to minimise client-side
// parsing complexity. All fields are required except `targetId`.
//
export const SystemEventSchema = z.object({
    /** UUID v4 — unique event identifier, set by the Nerve Center. */
    eventId: z.string().uuid(),

    /** ISO 8601 UTC timestamp, set by the Nerve Center on receipt. */
    timestamp: z.string().datetime(),

    /** Discriminant for routing and display in the Command Center. */
    eventType: SystemEventTypeSchema,

    /** Agent that produced the event (e.g. "coordinator.0", "ux-agent.1"). */
    sourceId: z.string().min(1),

    /**
     * Recipient agent ID for directional events (MESSAGE_SENT, AGENT_SPAWNED).
     * null for broadcast or self-referential events.
     */
    targetId: z.string().nullable(),

    /**
     * Arbitrary structured payload. Typed by eventType at the application layer.
     * Record<string, unknown> to satisfy ESLint no-explicit-any.
     */
    payload: z.record(z.string(), z.unknown()),

    /**
     * Groups all events belonging to a single user-initiated task.
     * Set on USER_COMMAND events and propagated to all derived events in the same
     * simulation round. Optional — legacy events without it remain valid.
     */
    traceId: z.string().uuid().optional(),
});
export type SystemEvent = z.infer<typeof SystemEventSchema>;

// ─── Full Event Type Enum (internal — all Ledger event types) ─────────────────

export const EventTypeSchema = z.enum([
    // Agent lifecycle
    'AGENT_SPAWNED',
    'AGENT_STATE_CHANGED',
    'AGENT_TERMINATED',

    // Task management
    'TASK_CREATED',
    'TASK_COMPLETED',
    'TASK_FAILED',

    // A2A Messaging
    'A2A_MESSAGE_SENT',
    'A2A_MESSAGE_DELIVERED',
    'A2A_MESSAGE_DROPPED',

    // Tool execution
    'TOOL_CALL_STARTED',
    'TOOL_CALL_COMPLETED',
    'TOOL_CALL_FAILED',

    // Context mutations
    'CONTEXT_MUTATED',

    // MCP Registry
    'TOOL_REGISTRY_UPDATED',
    'MCP_SERVER_CONNECTED',
    'MCP_SERVER_DISCONNECTED',

    // Interrupts
    'INTERRUPT_ISSUED',
    'INTERRUPT_APPLIED',
    'INTERRUPT_REJECTED',

    // Schema violations
    'SCHEMA_VIOLATION',

    // Sandbox lifecycle
    'SANDBOX_PROVISIONED',
    'SANDBOX_READY',
    'SANDBOX_TERMINATED',

    // Memory (RAG)
    'MEMORY_INDEXED',
    'MEMORY_RETRIEVED',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

// ─── Ledger Event Envelope (internal — persisted to database) ─────────────────

export const LedgerEventSchema = z.object({
    eventId: z.string().uuid(),
    taskId: z.string().uuid(),
    streamId: z.string().min(1), // format: "{taskId}/{agentId}"
    eventType: EventTypeSchema,
    sequenceNum: z.number().int().nonnegative(),
    causationId: z.string().uuid().optional(),
    correlationId: z.string().uuid(),
    agentId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().datetime(),
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
