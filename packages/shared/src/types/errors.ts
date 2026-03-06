import { z } from 'zod';

/**
 * Error taxonomy for the Agentic Control Plane.
 *
 * All errors that cross service boundaries must be instances of ControlPlaneError
 * or its subtypes. Raw Error objects must never be serialized over the wire.
 */

export const ErrorCodeSchema = z.enum([
    // Schema errors
    'SCHEMA_VALIDATION_FAILED',
    'SCHEMA_VERSION_INCOMPATIBLE',

    // Agent errors
    'AGENT_NOT_FOUND',
    'AGENT_SPAWN_FAILED',
    'AGENT_TOKEN_BUDGET_EXCEEDED',
    'AGENT_TTL_EXPIRED',
    'AGENT_INVALID_STATE_TRANSITION',

    // Task errors
    'TASK_NOT_FOUND',
    'TASK_CONTEXT_NAMESPACE_VIOLATION',

    // Tool errors
    'TOOL_NOT_FOUND',
    'TOOL_CALL_DEPTH_EXCEEDED',
    'TOOL_EXECUTION_FAILED',
    'TOOL_AUTHORIZATION_DENIED',

    // Interrupt errors
    'INTERRUPT_DELIVERY_FAILED',
    'INTERRUPT_SLA_EXCEEDED',

    // Sandbox errors
    'SANDBOX_PROVISION_FAILED',
    'SANDBOX_OOM_KILLED',
    'SANDBOX_TTL_EXPIRED',

    // Auth errors
    'AUTHENTICATION_FAILED',
    'AUTHORIZATION_DENIED',

    // Internal
    'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ControlPlaneErrorSchema = z.object({
    errorId: z.string().uuid(),
    code: ErrorCodeSchema,
    message: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional(),
    causedBy: z.string().optional(), // errorId of the upstream error
    occurredAt: z.string().datetime(),
});
export type ControlPlaneError = z.infer<typeof ControlPlaneErrorSchema>;
