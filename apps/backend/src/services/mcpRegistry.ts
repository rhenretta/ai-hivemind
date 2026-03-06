/**
 * mcpRegistry.ts — MCP Tool Registry Service
 *
 * Single source of truth for all tools available to the swarm.
 * Backed by an in-process SQLite database (better-sqlite3).
 *
 * Usage:
 *   import { mcpRegistry } from './services/mcpRegistry.js';
 *   mcpRegistry.registerTool(tool);          // register + emit TOOL_REGISTERED
 *   mcpRegistry.getAvailableTools();         // returns McpTool[]
 *
 * Architecture notes:
 *   - `:memory:` by default; set MCP_DB_PATH env var for a file-backed DB.
 *   - `registerTool` is idempotent — re-registering the same toolId replaces
 *     the old record (UPSERT) without emitting a duplicate event.
 *   - Seeding happens once at import time via seedBuiltInTools(). Subsequent
 *     hot-reloads skip seeding because the `:memory:` DB is recreated each run.
 */

import { type McpTool, McpToolSchema } from '@ai-hivemind/shared';
import BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import { eventBus } from '../eventBus.js';

import { logger } from './logger.js';

// ─── Database initialisation ───────────────────────────────────────────────────

const DB_PATH = process.env['MCP_DB_PATH'] ?? ':memory:';
const db = new BetterSqlite3(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
        toolId      TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        inputSchema TEXT NOT NULL,
        version     TEXT NOT NULL,
        serverId    TEXT NOT NULL DEFAULT 'built-in',
        registeredAt TEXT NOT NULL
    );
`);

// ─── Prepared statements ───────────────────────────────────────────────────────

const stmtUpsert = db.prepare(`
    INSERT INTO tools (toolId, name, description, inputSchema, version, serverId, registeredAt)
    VALUES (@toolId, @name, @description, @inputSchema, @version, @serverId, @registeredAt)
    ON CONFLICT(name) DO UPDATE SET
        description  = excluded.description,
        inputSchema  = excluded.inputSchema,
        version      = excluded.version,
        serverId     = excluded.serverId,
        registeredAt = excluded.registeredAt
`);

const stmtSelectAll = db.prepare(`SELECT * FROM tools ORDER BY registeredAt ASC`);

// ─── Row → McpTool coercion ────────────────────────────────────────────────────

interface ToolRow {
    toolId: string;
    name: string;
    description: string;
    inputSchema: string;
    version: string;
    serverId: string;
    registeredAt: string;
}

function rowToMcpTool(row: ToolRow): McpTool {
    return {
        toolId: row.toolId,
        name: row.name,
        description: row.description,
        inputSchema: JSON.parse(row.inputSchema) as Record<string, unknown>,
        version: row.version,
        serverId: row.serverId,
        registeredAt: row.registeredAt,
    };
}

// ─── Service ──────────────────────────────────────────────────────────────────

class McpRegistry {
    /**
     * Register a tool.
     *
     * Validates the input against McpToolSchema, upserts into SQLite,
     * then emits a TOOL_REGISTERED SystemEvent to the EventBus.
     *
     * @throws ZodError if the tool object fails validation
     */
    registerTool(input: McpTool): McpTool {
        const tool = McpToolSchema.parse(input);

        stmtUpsert.run({
            toolId: tool.toolId,
            name: tool.name,
            description: tool.description,
            inputSchema: JSON.stringify(tool.inputSchema),
            version: tool.version,
            serverId: tool.serverId,
            registeredAt: tool.registeredAt,
        });

        eventBus.emit({
            eventId: uuidv4(),
            timestamp: new Date().toISOString(),
            eventType: 'TOOL_REGISTERED',
            sourceId: 'mcp-registry',
            targetId: null,
            payload: {
                toolId: tool.toolId,
                name: tool.name,
                description: tool.description,
                version: tool.version,
                serverId: tool.serverId,
            },
        });

        logger.info(`[MCP Registry] Registered tool: ${tool.name} v${tool.version}`);
        return tool;
    }

    /** Returns all registered tools, ordered by registration timestamp. */
    getAvailableTools(): McpTool[] {
        return (stmtSelectAll.all() as ToolRow[]).map(rowToMcpTool);
    }
}

export const mcpRegistry = new McpRegistry();

// ─── Built-in tool definitions ─────────────────────────────────────────────────

function makeBuiltIn(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    version = '1.0.0',
): McpTool {
    return {
        toolId: uuidv4(),
        name,
        description,
        inputSchema,
        version,
        serverId: 'built-in',
        registeredAt: new Date().toISOString(),
    };
}

const BUILT_IN_TOOLS: McpTool[] = [
    makeBuiltIn(
        'execute_cli_command',
        'Execute a shell command in a sandboxed environment and return stdout, stderr, and exit code.',
        {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                timeout_ms: { type: 'number', description: 'Maximum execution time in milliseconds', default: 30000 },
            },
            required: ['command'],
        },
    ),
    makeBuiltIn(
        'read_file',
        'Read the contents of a file at the specified path.',
        {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or relative file path' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
            },
            required: ['path'],
        },
    ),
    makeBuiltIn(
        'write_file',
        'Write content to a file, creating it if it does not exist.',
        {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or relative file path' },
                content: { type: 'string', description: 'Content to write' },
                append: { type: 'boolean', description: 'Append to existing file instead of overwriting', default: false },
            },
            required: ['path', 'content'],
        },
    ),
    makeBuiltIn(
        'web_search',
        'Search the web and return a list of relevant results with titles, URLs, and snippets.',
        {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                max_results: { type: 'number', description: 'Maximum number of results', default: 10 },
            },
            required: ['query'],
        },
    ),
    makeBuiltIn(
        'http_get',
        'Perform an HTTP GET request to the specified URL and return the response body.',
        {
            type: 'object',
            properties: {
                url: { type: 'string', format: 'uri', description: 'URL to fetch' },
                headers: { type: 'object', description: 'Optional HTTP headers', additionalProperties: { type: 'string' } },
                timeout_ms: { type: 'number', default: 10000 },
            },
            required: ['url'],
        },
    ),
    makeBuiltIn(
        'screenshot_url',
        'Take a full-page screenshot of a URL using Playwright (headless Chromium) and return the image as a base64-encoded PNG. Returns [PLAYWRIGHT_UNAVAILABLE] if Playwright is not installed.',
        {
            type: 'object',
            properties: {
                url: { type: 'string', format: 'uri', description: 'URL to screenshot' },
                timeout_ms: { type: 'number', description: 'Page load timeout in milliseconds', default: 15000 },
            },
            required: ['url'],
        },
    ),
    makeBuiltIn(
        'reddit_get_subreddit',
        'Fetch a listing of posts from a specific subreddit.',
        {
            type: 'object',
            properties: {
                subreddit: { type: 'string', description: 'Name of the subreddit (e.g., "technology")' },
                sort: { type: 'string', enum: ['hot', 'new', 'top'], default: 'hot' },
                limit: { type: 'number', description: 'Number of posts to return', default: 25 },
                after: { type: 'string', description: 'Pagination token for the next page of results' },
            },
            required: ['subreddit'],
        },
    ),
];

/** Seed the registry with built-in tools on startup. */
function seedBuiltInTools(): void {
    for (const tool of BUILT_IN_TOOLS) {
        mcpRegistry.registerTool(tool);
    }
    logger.info(`[MCP Registry] Seeded ${BUILT_IN_TOOLS.length.toString()} built-in tools.`);
}

seedBuiltInTools();
