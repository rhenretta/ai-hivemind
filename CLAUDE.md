# AI Hivemind -- Project Knowledge Base

Monorepo: `apps/backend`, `apps/web`, `apps/sandbox`, `packages/shared`, `packages/ui`

---

## Critical Invariants

### Ledger-First Rule
Events are written to the ledger BEFORE publishing to the bus. Never swap the order -- a published event without a ledger entry is permanently lost on crash.

### Zod-First Law (packages/shared)
Every cross-boundary type MUST have a co-located Zod schema. The TypeScript type MUST be derived via `z.infer<typeof Schema>` -- never define the type separately.

### Agent Communication Law
Agents NEVER communicate directly. All A2A communication goes through the Nerve Center Event Bus. No exceptions -- this ensures every message is logged and policy-enforced.

### Process Isolation
The simulator runs as a separate OS process. It cannot import `eventBus` directly (gets its own isolated instance). Use `POST /api/events/inject` HTTP endpoint instead. Same applies to any cross-process service call -- use HTTP, not direct imports.

---

## Event Bus

**Topic pattern:** `{taskId}/{agentId}/{eventType}`
**Subscription wildcards:** `{taskId}/**` (all task events), `{taskId}/*/TOOL_CALL_*` (pattern match)

**Sequence numbers:** Monotonically increasing per `streamId` (not global). Assigned by Nerve Center, not agents.

**Causation chain:** Always set `causationId` when emitting an event in response to another event.

**Backpressure:** Per-connection send queue (max 1000). Drop oldest on overflow + emit `WS_BACKPRESSURE_DROPPED`.

**New services emit via EventBus, never directly to socket.io** -- bypassing the bus breaks the ledger-first invariant.

---

## Adding a New SystemEventType -- Checklist

1. Add to `SystemEventTypeSchema` in `packages/shared/src/types/events.ts`
2. Define payload Zod schema if needed, export from `packages/shared/src/index.ts`
3. `pnpm --filter @ai-hivemind/shared build`
4. Update ALL FOUR frontend color maps (TypeScript `Record<SystemEventType, T>` enforces this):
   - `apps/web/src/components/layout/LedgerPanel.tsx` -- `EVENT_COLORS`
   - `apps/web/src/components/layout/RosterPanel.tsx` -- `EVENT_TYPE_COLORS`
   - `apps/web/src/components/topology/AgentNode.tsx` -- `EVENT_DOT`
   - `apps/web/src/components/inspector/EventInspectorSheet.tsx` -- `EVENT_BADGE`
5. Build backend and web to verify: `pnpm --filter @ai-hivemind/backend build && pnpm --filter @ai-hivemind/web build`

**Color conventions:** lifecycle->slate/gray, state->blue/indigo, memory/RAG->purple, errors->red, services->green/yellow, planning->orange, QA->lime, conductor/streaming->green-300, task graph->violet/teal, tool registry->teal-400, memory/RAG events->indigo-400.

---

## Agent Hierarchy

```
TIER 0: COORDINATOR (singleton) -- spawns Tier 1, writes global task graph
  TIER 1: PROJECT_MANAGER (per work stream) -- spawns Tier 2, error recovery
    TIER 2: Specialists (SWE, DATA_RESEARCHER, etc.) -- no spawning, pure execution
  TIER 3: RUNTIME_GENERATED -- TTL-enforced, GC'd on expiry
```

**Context namespaces:** Coordinator reads all; PM reads own stream + root; Tier 2 reads only own namespace. Violations emit `TASK_CONTEXT_NAMESPACE_VIOLATION`.

**Message priority:** NORMAL (FIFO), HIGH (front of queue), INTERRUPT (operator-only, synchronous).

**Behavioral constraints:** All agents must declare negative constraints. Universal: no direct A2A, no out-of-namespace writes, no unbound tools, no fabricated actions. Tier 0/1: delegate specialist work. Tier 2: no spawning, no orchestration.

**RuntimeAgentSpec:** Must have fresh UUID, universal constraints, valid MCP tools, scoped namespace, Tier 0/1 parent, maxTokenBudget, and TTL.

---

## packages/shared Governance

Only runtime dependency allowed: `zod`. Everything else is devDependency. Never import from apps.

**Version bumps:** Alter/remove existing export -> MAJOR (RFC required). New optional field or new type -> MINOR. Typo/jsdoc -> PATCH.

**File structure:** All exports re-exported from `src/index.ts`. Consumers never import sub-paths.

**schemaVersion field:** Every network envelope carries it. Major mismatch -> rejected. Minor mismatch -> accepted with warning.

---

## Command Center UI

### Architecture
- **Zustand** atomic stores: `swarmStore`, `ledgerStore`, `agentInspectorStore`, `interruptStore`, `toolRegistryStore`, `sandboxStore`
- **WebSocket** client initialized once at app root (never in components). Routes events by type to stores via `router.ts`.
- **D3 topology** runs in a `useRef`, not React state. Subscribe to Zustand with `subscribeWithSelector` for D3 updates outside React render cycle.
- **React Query** for initial/historical data fetches; WebSocket for realtime.

### Component placement
- `packages/ui`: design system primitives reusable outside Command Center
- `apps/web/src/components/<module>/`: domain-specific (agent, event, tool concepts)

### iframe Sandbox
Always use `sandbox="allow-scripts"` (never `allow-same-origin`). Communication via `postMessage` with origin verification and Zod schema validation.

### Phase 6 Notes
- Tab discriminant: port number (not string name). Render all iframes at mount, hide inactive with CSS.
- User intervention chain: Component -> `socket.emit('user:intervention')` -> server handler -> eventBus -> conductor -> `child.stdin.write()`. Set `targetId` in both envelope and payload.
- CSS modules: use bracket notation (`styles['container']`).

---

## Hard-Won Lessons (Frontend)

- **Tailwind dark mode:** `dark` is a variant, not a utility class. Set via `className="dark"` on `<html>`, never `@apply dark`.
- **Next.js ESLint:** Create separate `tsconfig.eslint.json` with `"moduleResolution": "node"` (bundler breaks `@typescript-eslint/parser`).
- **Zustand useShallow:** Only for selectors returning plain objects with scalar values. For derived/filtered data, subscribe to stable refs + `useMemo`.
- **socket.io singleton:** Module-level, never inside hooks. Manager reconnect events are untyped (file-level eslint-disable approved).
- **ws.off cleanup:** Always pass the named handler ref. `ws.off('event')` with no callback removes ALL listeners (breaks in StrictMode).
- **React Flow Node.data:** Must extend `Record<string, unknown>`. Cast through `unknown`.
- **ESLint import/order:** builtin -> external -> internal -> parent -> sibling. CSS last.
- **getSocket() export:** For socket access outside React component lifecycle (event handlers).

---

## Claude Code CLI Integration

Spawn with `claude -p <prompt>` for non-interactive autonomous execution.

Key flags: `--dangerously-skip-permissions`, `--output-format stream-json`, `--allowedTools <csv>`, `--max-turns <n>`

**stdin must be 'ignore'** (not 'pipe'). When stdin is a pipe, the CLI enters interactive mode and blocks.

**Environment whitelist:** Only pass system essentials (PATH, HOME, etc.) + ANTHROPIC_API_KEY. Strip all Claude Desktop vars. Set `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`.

**stream-json event types:** `system`, `assistant`, `user`, `result`

Bridge stdout JSON to EventBus: `tool_use`->`TOOL_USED`, `text`->`CONDUCTOR_STREAM`, `result`->`STATE_CHANGED`.

Monitor stderr for dev server port declarations -> emit `SERVICE_DEPLOYED`.

### Sandbox Isolation (Docker)

Each feature task gets a dedicated Docker container (`ai-hivemind-sandbox:latest`). The image has pre-installed pnpm dependencies; source code is injected per-task via `docker cp` (~580KB). Complete host isolation -- no filesystem, no process access.

**Container config:** `--memory 4g`, `--cpus 2`, port mapping for dev servers (3000, 3001, 5173, 8000), Claude auth mounted read-only.

**Lifecycle:**
1. `buildSandboxImage()` -- runs on backend startup, builds from `Dockerfile.sandbox`
2. `createFeatureSandbox(traceId)` -- `docker create` + `docker cp` source → returns `SandboxHandle { containerName, workDir, portMap }`
3. Claude Code runs via `docker exec <container> claude -p <prompt>`
4. QA validates by running commands inside container (`docker exec`) and probing sandbox's mapped ports
5. `mergeFeatureSandbox()` -- extracts changed files via `docker cp`, diffs against real monorepo
6. `destroyFeatureSandbox()` -- `docker rm -f`

**SandboxHandle type:** `{ containerName: string; workDir: string; portMap: Record<number, number> }`

**Stale cleanup:** `cleanupStaleSandboxes()` runs on backend startup, removes containers older than 24h.

---

## SQLite Backend Services (better-sqlite3)

- Module-level singleton DB init. DDL with `IF NOT EXISTS` on tables and triggers.
- FTS5: sanitize queries (strip `"*^()`) and wrap in try/catch.
- Prepared statements at module level, not inside functions.

---

## Turborepo & pnpm

**Package manager: pnpm only.** Never npm or yarn.

**Key tasks:** `build` (cached), `dev` (persistent, never cached), `lint` (cached), `type-check` (cached, needs `^build`), `test` (never cached).

**Filter syntax:** `--filter=@ai-hivemind/shared` (package name, not directory path). `...` suffix for with-dependencies. `!` prefix to exclude.

**Cache busters:** Changed input files, changed env vars (declared in turbo.json), upstream cache bust. Never cache network calls or DB reads.

### Gotchas
- Turbo v2: top-level key is `tasks`, not `pipeline`
- Never use tsconfig `paths` to alias workspace packages to src -- resolve through `node_modules` symlinks to `dist/`
- Explicit type annotations on exported Express `app` (avoids TS2742 from deep pnpm paths)
- Non-Next.js processes (tsx): use `--env-file=../../.env.local` AND declare vars in turbo.json `globalEnv`
- Restart dev server when `package.json`, `turbo.json`, or dependencies change
- Never use large wait timeouts when turbo dev is active -- background + poll (2s max)
- Check `/tmp/turbo-dev.log` for compile errors instead of running `tsc --noEmit`
- esbuild (tsx) can't call private `#` methods inside EventEmitter closures -- use `const self = this`
- Never use heredoc in shell commands for file content -- use the Write tool
- Edit tool is a PATCH tool; use Write for complete file rewrites
