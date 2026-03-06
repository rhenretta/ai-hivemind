import { z } from 'zod';

/**
 * Agent type definitions for the Agentic Control Plane.
 *
 * All types are derived from Zod schemas — never defined independently.
 * See docs/WORKFLOW.md §2.4 for the Zod validation discipline.
 */

// ─── Agent Tier ───────────────────────────────────────────────────────────────

export const AgentTierSchema = z.enum(['COORDINATOR', 'PROJECT_MANAGER', 'SPECIALIST', 'RUNTIME']);
export type AgentTier = z.infer<typeof AgentTierSchema>;

// ─── Agent Lifecycle State ────────────────────────────────────────────────────

export const AgentLifecycleStateSchema = z.enum([
    'IDLE',
    'PLANNING',
    'EXECUTING',
    'SUSPENDED',
    'ERROR',
    'TERMINATED',
]);
export type AgentLifecycleState = z.infer<typeof AgentLifecycleStateSchema>;

// ─── Built-in Agent Types ─────────────────────────────────────────────────────

export const BuiltInAgentTypeSchema = z.enum([
    'COORDINATOR',
    'PROJECT_MANAGER',
    'DATA_RESEARCHER',
    'SWE',
    'UX_DESIGNER',
    'UI_ENGINEER',
    'QA_ENGINEER',
    'PLANNER',
]);
export type BuiltInAgentType = z.infer<typeof BuiltInAgentTypeSchema>;

// ─── Tool Binding ─────────────────────────────────────────────────────────────

export const ToolBindingSchema = z.object({
    toolName: z.string().min(1),
    versionRange: z.string().regex(/^\^?\d+\.\d+\.\d+$/, 'Must be a valid semver or ^semver range'),
    maxCallDepth: z.number().int().min(1).max(100).default(10),
    paramOverrides: z.record(z.string(), z.unknown()).optional(),
});
export type ToolBinding = z.infer<typeof ToolBindingSchema>;

// ─── Agent Persona ────────────────────────────────────────────────────────────

export const AgentPersonaSchema = z.object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    behavioralConstraints: z.array(z.string()).min(1),
    outputContentTypes: z.array(z.string()).min(1),
});
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;

// ─── Runtime Agent Spec ───────────────────────────────────────────────────────

export const RuntimeAgentSpecSchema = z.object({
    specVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'Must be a valid semver string'),
    agentId: z.string().uuid(),
    persona: AgentPersonaSchema,
    tools: z.array(ToolBindingSchema).min(1),
    contextNamespace: z.string().min(1),
    parentAgentId: z.string().min(1),
    maxTokenBudget: z.number().int().positive(),
    ttl: z.number().int().positive().describe('Time-to-live in seconds'),
});
export type RuntimeAgentSpec = z.infer<typeof RuntimeAgentSpecSchema>;
