import { z } from 'zod';

/**
 * A2A (Agent-to-Agent) messaging protocol types.
 *
 * All messages crossing between agents are mediated by the Nerve Center's
 * Event Bus. No agent may communicate directly to another agent.
 * See docs/ARCHITECTURE.md §6 for the full protocol specification.
 */

export const MessageRoleSchema = z.enum(['DIRECTIVE', 'RESPONSE', 'BROADCAST', 'INTERRUPT']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessagePrioritySchema = z.enum(['NORMAL', 'HIGH', 'INTERRUPT']);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

export const MessageContentTypeSchema = z.enum([
    'TEXT',
    'TOOL_CALL',
    'TOOL_RESULT',
    'CONTEXT_PATCH',
    'TASK_SPEC',
    'AGENT_SPEC',
    'ERROR',
]);
export type MessageContentType = z.infer<typeof MessageContentTypeSchema>;

export const A2AMessageSchema = z.object({
    messageId: z.string().uuid(),
    taskId: z.string().uuid(),
    senderId: z.string().min(1),
    recipientId: z.string().min(1),
    replyToId: z.string().uuid().optional(),
    role: MessageRoleSchema,
    contentType: MessageContentTypeSchema,
    content: z.unknown(), // Validated by consumer based on contentType
    priority: MessagePrioritySchema.default('NORMAL'),
    ttl: z.number().int().positive().default(30),
    // timestamp is set by Nerve Center on receipt, not by sender
    timestamp: z.string().datetime().optional(),
    schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type A2AMessage = z.infer<typeof A2AMessageSchema>;
