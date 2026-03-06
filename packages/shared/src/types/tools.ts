import { z } from 'zod';

/**
 * MCP (Model Context Protocol) Tool Registry types.
 *
 * The Nerve Center aggregates tool schemas from all registered MCP servers
 * into a unified, deduplicated catalog. All tool calls are proxied through
 * the Nerve Center for logging and policy enforcement.
 * See docs/ARCHITECTURE.md §7 for the full tool integration spec.
 */

export const ToolParameterSchema = z.object({
    name: z.string().min(1),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    description: z.string(),
    required: z.boolean().default(false),
    schema: z.record(z.string(), z.unknown()).optional(), // JSON Schema for complex types
});
export type ToolParameter = z.infer<typeof ToolParameterSchema>;

export const ToolSchemaSchema = z.object({
    toolName: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    parameters: z.array(ToolParameterSchema),
    returnSchema: z.record(z.string(), z.unknown()).optional(),
    mcpServerId: z.string().min(1),
    registeredAt: z.string().datetime(),
});
export type ToolSchema = z.infer<typeof ToolSchemaSchema>;

export const McpServerStatusSchema = z.enum(['CONNECTED', 'DISCONNECTED', 'ERROR', 'DEGRADED']);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpServerRegistrationSchema = z.object({
    serverId: z.string().min(1),
    displayName: z.string().min(1),
    baseUrl: z.string().url(),
    status: McpServerStatusSchema,
    toolCount: z.number().int().nonnegative(),
    connectedAt: z.string().datetime().optional(),
    lastHealthCheckAt: z.string().datetime().optional(),
});
export type McpServerRegistration = z.infer<typeof McpServerRegistrationSchema>;

// ─── McpTool — the simplified agent-facing tool descriptor ────────────────────
//
// Distinct from ToolSchema (low-level MCP server integration spec).
// McpTool is what agents discover via getAvailableTools() and pass in
// TOOL_REGISTERED SystemEvents. inputSchema is a JSON Schema object.
//
export const McpToolSchema = z.object({
    /** UUID v4 — unique across all registered tools. */
    toolId: z.string().uuid(),
    /** Machine-readable tool name used in agent function calls (snake_case). */
    name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
    /** Human-readable description for LLM tool selection. */
    description: z.string().min(1),
    /** JSON Schema describing the tool's input parameters. */
    inputSchema: z.record(z.string(), z.unknown()),
    /** SemVer version of the tool implementation. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** ISO 8601 UTC timestamp of when the tool was registered. */
    registeredAt: z.string().datetime(),
    /** Registry / server this tool belongs to. Defaults to 'built-in'. */
    serverId: z.string().min(1).default('built-in'),
});
export type McpTool = z.infer<typeof McpToolSchema>;
