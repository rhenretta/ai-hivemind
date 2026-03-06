import { z } from 'zod';

/**
 * Interrupt protocol types.
 *
 * Interrupts are operator-issued directives that bypass the normal agent
 * message queue and are delivered synchronously to the target agent's
 * interrupt handler. Only the Command Center (authenticated operators) may
 * issue interrupts. See docs/ARCHITECTURE.md §3.1 for the Interrupt Vector Handler.
 */

export const InterruptCommandSchema = z.enum([
    'SUSPEND_AGENT',
    'RESUME_AGENT',
    'TERMINATE_AGENT',
    'INJECT_CONTEXT',
    'REDIRECT_TASK',
    'FORCE_COMPLETE',
]);
export type InterruptCommand = z.infer<typeof InterruptCommandSchema>;

export const InterruptDirectiveSchema = z.object({
    directiveId: z.string().uuid(),
    taskId: z.string().uuid(),
    targetAgentId: z.string().min(1),
    command: InterruptCommandSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().min(1).max(1024), // Mandatory — written to ledger
    issuedByOperatorId: z.string().min(1),
    issuedAt: z.string().datetime(),
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type InterruptDirective = z.infer<typeof InterruptDirectiveSchema>;

export const InterruptResultSchema = z.object({
    directiveId: z.string().uuid(),
    success: z.boolean(),
    appliedAt: z.string().datetime().optional(),
    rejectionReason: z.string().optional(),
    agentStateAfter: z.string().optional(),
});
export type InterruptResult = z.infer<typeof InterruptResultSchema>;
