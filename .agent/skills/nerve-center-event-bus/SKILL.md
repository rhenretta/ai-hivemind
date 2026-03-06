---
name: nerve-center-event-bus
description: How to correctly emit, route, and consume events in the Nerve Center — ledger write ordering, Event Bus topics, backpressure, and WebSocket routing to the Command Center
---

# Skill: Nerve Center Event Bus

## When to Use This Skill

Load this skill whenever you are:
- Implementing or modifying the EventBus in `apps/backend`
- Adding new event types or subscribers
- Debugging why events aren't reaching WebSocket clients
- Designing the simulator or any external event injector
- Adding new socket.io event handlers in `useSwarmSocket`
- Implementing a new Nerve Center component (lifecycle manager, interrupt handler, etc.)
- Setting up message routing between agents

**After any of the above:** if you hit a new failure mode in event delivery, add it to the Common Mistakes table and add a new subsection below.

---

## The Ledger-First Invariant

**Events are written to the ledger BEFORE they are published to the bus.**

```typescript
// CORRECT ordering — never swap these
await ledger.append(event);          // 1. Durable write first
await eventBus.publish(topic, event); // 2. Delivery second
```

If the process crashes between step 1 and step 2, the event is in the ledger. On restart, undelivered events can be replayed from the ledger. The reverse is not recoverable — a published event that wasn't written to the ledger is permanently lost.

---

## Topic Naming Convention

Topics on the Event Bus follow this pattern:

```
{taskId}/{agentId}/{eventType}
```

**Examples:**
```
550e8400-e29b-41d4-a716-446655440000/coordinator.0/AGENT_STATE_CHANGED
550e8400-e29b-41d4-a716-446655440000/swe.7f3a/TOOL_CALL_COMPLETED
```

**Subscription patterns:**
```
550e8400-e29b-41d4-a716-446655440000/**          # All events for a task (Command Center)
550e8400-e29b-41d4-a716-446655440000/*/TOOL_CALL_* # All tool events for a task
```

---

## Emitting a New Event Type

When implementing a new feature that needs a new event type:

1. **Add the EventType to `packages/shared`** — run `add-shared-type` workflow.
2. **Define the payload shape** in `packages/shared/src/types/events.ts` as a discriminated union member.
3. **Emit in the correct location:**
   ```typescript
   // apps/backend/src/events/emitter.ts
   export async function emitEvent(event: LedgerEvent): Promise<void> {
     // Validate schema before touching anything
     const validated = LedgerEventSchema.parse(event);
     
     // 1. Write to ledger
     await ledger.append(validated);
     
     // 2. Publish to bus (async, non-blocking)
     void eventBus.publish(
       `${validated.taskId}/${validated.agentId}/${validated.eventType}`,
       validated,
     );
   }
   ```

---

## WebSocket Gateway → Command Center Routing

The Command Center maintains a single WebSocket connection and receives all events for tasks the operator is viewing. Events are routed client-side to the appropriate Zustand store:

```typescript
// apps/web/src/lib/ws/router.ts — add new EventType handlers here
const EVENT_ROUTER: Partial<Record<EventType, (event: LedgerEvent) => void>> = {
  AGENT_STATE_CHANGED:  (e) => swarmStore.getState().handleAgentStateChange(e),
  A2A_MESSAGE_SENT:     (e) => ledgerStore.getState().appendEvent(e),
  TOOL_CALL_STARTED:    (e) => ledgerStore.getState().appendEvent(e),
  TOOL_CALL_COMPLETED:  (e) => ledgerStore.getState().appendEvent(e),
  CONTEXT_MUTATED:      (e) => agentInspectorStore.getState().handleContextMutation(e),
  INTERRUPT_APPLIED:    (e) => interruptStore.getState().handleInterruptAck(e),
  TOOL_REGISTRY_UPDATED:(e) => toolRegistryStore.getState().handleRegistryUpdate(e),
};

export function routeEvent(event: LedgerEvent): void {
  const handler = EVENT_ROUTER[event.eventType];
  if (handler !== undefined) {
    handler(event);
  }
  // All events also go to the global ledger timeline regardless of specific handler
  ledgerTimelineStore.getState().appendRaw(event);
}
```

---

## Backpressure Handling

The WebSocket gateway must not flood a slow Command Center client:

- Apply **per-connection send queue** with a configurable max depth (default: 1000 events).
- When the queue is full, drop the **oldest** events (not newest) and emit a `WS_BACKPRESSURE_DROPPED` synthetic event to the client so it knows it missed events.
- The client should display a "stream lagged — some events may be missing" warning.

---

## Sequence Numbers

Every event in the ledger has a `sequenceNum` that is monotonically increasing **per `streamId`** (not globally). This allows:

- Detecting gaps in delivery (missed events) without a global sequence.
- Replaying a single agent's event stream in order without sorting by timestamp.

```sql
-- Replay all events for a specific agent stream in order
SELECT * FROM execution_events
WHERE stream_id = '{taskId}/{agentId}'
ORDER BY sequence_num ASC;
```

Sequence numbers are assigned by the Nerve Center, not by the emitting agent.

---

## Causation Chain

The `causation_id` field links events causally — event B was caused by event A if `B.causation_id = A.event_id`.

**Always set `causation_id`** when emitting an event in response to another:

```typescript
// A tool call was completed in response to an A2A message that requested it
await emitEvent({
  eventType: 'TOOL_CALL_COMPLETED',
  causationId: incomingMessage.messageId,  // The message that triggered this tool call
  correlationId: task.taskId,
  // ...
});
```

This is what enables the "causation chain trace" in the `debug-agent-issue` workflow.

---

## Common Mistakes

| Mistake | Consequence | Fix |
|---|---|---|
| Publishing to bus before ledger write | Event lost on crash | Always write ledger first |
| Not setting `causation_id` | Breaks causation chain tracing in debug flows | Always set it |
| Hardcoding `schemaVersion` | Stale version mismatch when `packages/shared` bumps | Read from config/env at build time |
| Emitting events from inside agent business logic (not Nerve Center) | Bypasses ledger-first invariant | Agents publish to the bus ONLY through the Nerve Center gateway |
| Missing event type in `apps/web` router | Event silently dropped by UI | Add handler to `EVENT_ROUTER` |
| Simulator imports `eventBus` directly (separate process) | Simulator has its own isolated EventBus — backend ledger stays empty | Use `POST /api/events/inject` HTTP endpoint |
| `ws.off(event)` with no callback in cleanup | Removes ALL listeners for that event — StrictMode silently kills system:event | Always pass the named handler: `ws.off('system:event', onSystemEvent)` |

---

## Critical Bug: Simulator Process Isolation

**Symptom**: Dashboard shows "Connected", backend health shows `ledgerSize: 0`, simulator logs show events being emitted.

**Root cause**: Node.js ESM module caching is per-process. If the simulator runs as a separate OS process (e.g. via `concurrently`), its `import { eventBus }` gives a completely isolated instance — not the server's. All the events go into the simulator's private EventBus. No socket.io clients are subscribed to it.

```typescript
// ❌ WRONG — simulator.ts in a separate process
import { eventBus } from './eventBus.js';  // Different instance than the server's!
eventBus.emit(event);                      // Goes nowhere

// ✅ CORRECT — POST to the server process's HTTP inject endpoint
await fetch('http://localhost:3001/api/events/inject', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(event),
});
```

**The inject endpoint** (`POST /api/events/inject` in `apps/backend/src/server.ts`) calls `eventBus.emit()` in the server process, which correctly broadcasts to all connected socket.io clients.

---

## Critical Bug: `ws.off(event)` Wipes ALL Listeners (StrictMode)

**Symptom**: Dashboard connects, counter shows 0 events, no new events arrive despite "Connected" status.

**Root cause**: In the React `useEffect` cleanup, calling `ws.off('system:event')` with NO callback removes every listener registered on that event channel — not just the one this effect added. React StrictMode double-invokes effects, so:

1. Mount → register `onSystemEvent` handler
2. Cleanup (StrictMode unmount) → `ws.off('system:event')` removes ALL handlers
3. Re-mount → register new handler (this one works)

But if HMR or another re-render causes cleanup to run again, the handler is gone.

```typescript
// ❌ WRONG — removes ALL listeners on this event
return () => {
  ws.off('system:event');
};

// ✅ CORRECT — remove only the specific handler this effect registered
const onSystemEvent = (event: SystemEvent): void => { appendEvent(event); };
ws.on('system:event', onSystemEvent);

return () => {
  ws.off('system:event', onSystemEvent);  // Named ref — only removes ours
};
```

---

## Phase 4: SQLite-Backed Backend Services

Lessons learned implementing `mcpRegistry` and `ragStore` Phase 4.

---

### Singleton SQLite Databases (`better-sqlite3`)

```typescript
// Module-level init — runs once per process; ESM caching makes it a singleton
import Database from 'better-sqlite3';
const db = new Database(process.env['MCP_DB_PATH'] ?? ':memory:');

// DDL before any prepared statements
db.exec(`CREATE TABLE IF NOT EXISTS tools ( toolId TEXT PRIMARY KEY, ... );`);

// Prepare at module level — not inside functions
const stmtUpsert   = db.prepare(`INSERT OR REPLACE INTO tools ... VALUES ...`);
const stmtSelectAll = db.prepare(`SELECT * FROM tools ORDER BY registeredAt ASC`);
```

**Why `better-sqlite3`:** Synchronous API, no async ceremony for local registry reads. Zero config for in-process use. For production, swap `:memory:` with a file path via env var.

---

### FTS5 Virtual Tables — Always Use `IF NOT EXISTS` on Triggers

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='rowid');

-- MUST use IF NOT EXISTS — db.exec runs on every module import (process start)
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

Sanitise FTS5 queries — MATCH throws on `"`, `*`, `^`, `(`, `)`:
```typescript
const ftsQuery = query.replace(/["*^()]/g, ' ').trim();
try { rows = stmt.all({ query: `"${ftsQuery}"`, limit: 5 }) as Row[]; }
catch { rows = []; } // fallback to recent
```

---

### New Services Must Emit via EventBus, Not Directly to Socket.io

```typescript
// ❌ WRONG — bypasses ledger-first invariant + creates circular dep
import { io } from '../server.js';
io.emit('system:event', event);

// ✅ CORRECT — EventBus wildcard subscriber fans out to all socket.io clients
import { eventBus } from '../eventBus.js';
eventBus.emit({ eventType: 'TOOL_REGISTERED', ... });
```

---

### Frontend `Record<SystemEventType, T>` Maps Are Exhaustive — Update All When Adding Event Types

TypeScript will error at compile time if a `Record<SystemEventType, T>` object is missing any new enum member. This is intentional exhaustiveness checking. When adding a new `SystemEventType`, update all four maps in `apps/web`:

| File | Map name |
|---|---|
| `LedgerPanel.tsx` | `EVENT_COLORS` |
| `RosterPanel.tsx` | `EVENT_TYPE_COLORS` |
| `EventInspectorSheet.tsx` | `EVENT_BADGE` |
| `AgentNode.tsx` | `EVENT_DOT` |

**Color convention:** tool registry events → `teal-400`; memory/RAG events → `indigo-400`.

---

### Simulator → Backend Service Calls Must Go Through HTTP (Process Boundary)

The simulator is a separate OS process. It cannot call `mcpRegistry.getAvailableTools()` directly. Use HTTP and handle startup race conditions:

```typescript
// ✅ CORRECT — fetch from server's REST endpoint
let toolNames = FALLBACK_TOOL_NAMES; // always have a fallback
try {
    const res = await fetch(`${NERVE_CENTER}/api/tools`);
    if (res.ok) {
        const tools = await res.json() as Array<{ name: string }>;
        toolNames = tools.map((t) => t.name);
    }
} catch { /* server may not be ready yet — use fallback */ }
```

---

### Gemini CLI stream-json uses Anthropic-style event type names

❌ WRONG — assuming Gemini CLI uses the same names as the Gemini API:
```
type: "tool_call"    // This is what you might expect
type: "tool_result"  // Ditto
```

✅ CORRECT — Gemini CLI's actual `--output-format stream-json` event types:
```
type: "init"         // Startup metadata — ignore silently
type: "tool_use"     // Tool invocation (Anthropic name, not tool_call)
type: "tool_result"  // Tool execution result
type: "result"       // Final step output (contains result text)
type: "message"      // Streaming assistant message delta
```

Why: Gemini CLI's stream-json format is modeled after the Anthropic Messages API, not Google's own API.
Always check actual stderr/stdout with `console.log` before building the switch statement.

---

### Gemini CLI workspace is rooted at the process CWD

❌ WRONG — spawning Conductor from `apps/backend`:
```typescript
spawn(GEMINI_BIN, [...], { cwd: process.cwd() })
// Gemini CLI sandbox: /Users/.../ai-hivemind/apps/backend only
// Any file access outside apps/backend → "Path not in workspace" error
```

✅ CORRECT — spawn from the monorepo root:
```typescript
const MONOREPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
spawn(GEMINI_BIN, [...], { cwd: MONOREPO_ROOT })
// Gemini CLI sandbox: full monorepo accessible
```

Why: Gemini CLI's workspace sandbox is rooted at the CWD of the spawned process. The backend runs from `apps/backend`, which locks Gemini out of the rest of the repo.

---

### All four frontend color-map Records are exhaustive over SystemEventType — update all four simultaneously

The Command Center has four `Record<SystemEventType, string | object>` color maps, one per component:

| File | Map name |
|---|---|
| `apps/web/src/components/layout/LedgerPanel.tsx` | `EVENT_COLORS` |
| `apps/web/src/components/layout/RosterPanel.tsx` | `EVENT_TYPE_COLORS` |
| `apps/web/src/components/topology/AgentNode.tsx` | `EVENT_DOT` |
| `apps/web/src/components/inspector/EventInspectorSheet.tsx` | `EVENT_BADGE` |

❌ WRONG — adding a new event type to `packages/shared` but only updating 1–3 maps:
```
// packages/shared: TASK_GRAPH_UPDATED added to SystemEventTypeSchema
// LedgerPanel: updated ✓
// RosterPanel: FORGOT ✗  → TS error: "Property 'TASK_GRAPH_UPDATED' is missing in type..."
```

✅ CORRECT — in the same commit, add the new event to all four maps:
```typescript
// In all 4 files, add your entry to the respective Record:
TASK_GRAPH_UPDATED: 'text-violet-400 bg-violet-400/10 border-violet-400/20',
TASK_NODE_COMPLETED: 'text-teal-400 bg-teal-400/10 border-teal-400/20',
```

Why: TypeScript enforces that `Record<K, V>` object literals cover every key in `K`. Missing any one of the four maps causes a compile error in the *other three* components due to shared type inference.

> [!IMPORTANT]
> The only safe approach is a single multi-file edit adding the new event type to all four maps in the same edit session. Use `multi_replace_file_content` in parallel calls, one per file.
