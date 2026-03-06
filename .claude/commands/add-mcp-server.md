# Adding a New MCP Server

> How to register a new MCP server with the Nerve Center tool registry.

Use this workflow when connecting a new upstream MCP server to the Nerve Center's
tool registry. All tool calls must be proxied through the Nerve Center — no agent
should call an MCP server directly.

See `docs/ARCHITECTURE.md §7` for the full MCP integration spec.

## Steps

1. **Get the MCP server's tool manifest**
   - Every MCP server exposes a `/v1/mcp/tools` endpoint listing its available tools.
   - Retrieve and inspect the tool schemas before proceeding.

2. **Validate the tool schemas**
   - Each tool must conform to the `ToolSchema` type in `packages/shared/src/types/tools.ts`.
   - Check that `toolName`, `version`, `description`, and `parameters` are all populated.
   - If the upstream schema is non-conformant, write an adapter in `apps/backend/src/mcp/adapters/`.

3. **Add the server configuration**
   - Add the MCP server config to `apps/backend/src/mcp/registry.config.ts`:
   ```ts
   {
     serverId: 'my-mcp-server',       // Unique, kebab-case
     displayName: 'My MCP Server',
     baseUrl: process.env.MY_MCP_SERVER_URL ?? '',   // Never hardcode URLs
   }
   ```

4. **Add the environment variable**
   - Add `MY_MCP_SERVER_URL` to `.env.example` with a placeholder value.
   - Add it to the `turbo.json` `globalEnv` array so Turborepo cache is invalidated on change.
   - Document the variable in `apps/backend/README.md`.

5. **Implement the health check**
   - The Nerve Center polls each registered MCP server for health.
   - Add the server to the health check schedule in `apps/backend/src/mcp/health.ts`.

6. **Update the authorization policy**
   - Define which agent types are allowed to call which tools from this server.
   - Authorization policies live in `apps/backend/src/policy/tool-auth.ts`.
   - Use the attribute-based model: `{ agentTier, agentType, toolName } → allow | deny`.

7. **Write a contract test**
   - Test that the Nerve Center correctly proxies a known tool call to the new MCP server.
   - Test file: `apps/backend/test/contract/mcp/<server-id>.test.ts`

8. **Trigger a TOOL_REGISTRY_UPDATED event**
   - After the server connects, the Nerve Center must emit `TOOL_REGISTRY_UPDATED` to the Event Bus.
   - Verify this event appears in the Command Center's tool catalog UI.

9. **Run CI**
   ```bash
   turbo run build lint type-check test:unit test:contract
   ```
