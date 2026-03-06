---
name: command-center-ui-patterns
description: How to build and extend the Command Center React UI — Zustand store patterns, WebSocket state, D3 topology, iframe sandbox safety, and component conventions
---

# Skill: Command Center UI Patterns

## When to Use This Skill

Load this skill whenever you are:
- Building a new UI module in `apps/web`
- Adding a new Zustand store or extending an existing one
- Implementing a new WebSocket event handler in the frontend
- Building D3 visualizations for the swarm topology
- Creating or managing iframe sandboxes for agent-generated UIs
- Adding components that should live in `packages/ui` vs `apps/web`

**After finishing any of the above:** run the `/complete-phase` workflow.
If you encountered any gotcha, retry loop, or non-obvious pattern while implementing —
update the appropriate section in this skill before writing the walkthrough.
This skill only improves when implementation friction is captured here, not just in walkthroughs.

---

## Store Architecture

The Command Center uses **Zustand** with atomic stores — one store per major feature domain. Each store is responsible for exactly one domain of state.

```
apps/web/src/stores/
├── swarmStore.ts         → Agent topology state (nodes, edges, lifecycle state)
├── ledgerStore.ts        → Global event timeline (append-only log of LedgerEvents)
├── agentInspectorStore.ts → Selected agent's context window, messages, tool bindings
├── interruptStore.ts     → Pending and acknowledged interrupt directives
├── toolRegistryStore.ts  → MCP tool catalog state
└── sandboxStore.ts       → Active iframe sandbox registry
```

**Store pattern:**

```typescript
// apps/web/src/stores/swarmStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { LedgerEvent, AgentLifecycleState } from '@ai-hivemind/shared';

interface AgentNode {
  agentId: string;
  agentType: string;
  state: AgentLifecycleState;
  lastEventAt: string;
}

interface SwarmState {
  agents: Map<string, AgentNode>;
  edges: Map<string, { senderId: string; recipientId: string; lastActivityAt: string }>;
  handleAgentStateChange: (event: LedgerEvent) => void;
}

export const useSwarmStore = create<SwarmState>()(
  subscribeWithSelector((set) => ({
    agents: new Map(),
    edges: new Map(),
    handleAgentStateChange: (event) => {
      set((state) => {
        const agents = new Map(state.agents);
        // Mutate immutably
        return { agents };
      });
    },
  })),
);
```

---

## WebSocket Event Flow

```
Nerve Center WebSocket
        │
        ▼
apps/web/src/lib/ws/client.ts   ← manages connection, reconnection, heartbeat
        │
        ▼
apps/web/src/lib/ws/router.ts   ← routes event by EventType to correct store
        │
        ├──► swarmStore.handleAgentStateChange()
        ├──► ledgerStore.appendEvent()
        ├──► agentInspectorStore.handleContextMutation()
        └──► ledgerTimelineStore.appendRaw()  ← always (all events)
```

**Rule:** The WebSocket client must be initialized **once** at the app root level. Never create WebSocket connections inside components — they will be created and destroyed on re-renders.

---

## Component Placement Decision

| Component type | Lives in |
|---|---|
| Design system primitives (Button, Badge, Panel, Icon, Tooltip) | `packages/ui/src/` |
| Domain-specific components (AgentNode, EventRow, ToolCallDetail) | `apps/web/src/components/<module>/` |
| Layout components (AppShell, Sidebar, StatusBar) | `apps/web/src/components/layout/` |
| Page-level components (SwarmTopologyPage, LedgerPage) | `apps/web/src/pages/` |

**Rule:** A component goes to `packages/ui` if and only if it could be reused in a future app that is NOT the Command Center. If it's Command Center–specific (references `@ai-hivemind/shared` types, relates to agent concepts), it stays in `apps/web`.

---

## D3 Topology Graph

The swarm topology view uses D3 force-directed graph simulation.

**Key rules:**
- The simulation runs in a `useRef`-stored D3 instance, NOT in React state. D3 owns the DOM for the SVG elements inside the topology container.
- React owns the wrapper, the controls, and the inspector panel. D3 owns the `<svg>` inside.
- Node state (color, size) is updated by calling `simulation.nodes(updatedNodes)` and `simulation.alpha(0.1).restart()` — NOT by re-rendering the React component.
- Subscribe to `swarmStore` changes using `subscribeWithSelector` so D3 updates happen outside the React render cycle.

```typescript
// Correct pattern for D3 + Zustand integration
useEffect(() => {
  const unsubscribe = useSwarmStore.subscribe(
    (state) => state.agents,
    (agents) => {
      // Update D3 data directly, don't setState
      simulation.nodes([...agents.values()]);
      simulation.alpha(0.1).restart();
    },
  );
  return unsubscribe;
}, [simulation]);
```

---

## iframe Sandbox Safety Model

Agent-generated UIs are rendered in `<iframe>` elements with strict isolation.

```tsx
// CORRECT — all three sandbox attributes are required
<iframe
  src={sandboxUrl}
  sandbox="allow-scripts"              // No allow-same-origin — prevents DOM access to host
  csp={`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'`}
  title={`Agent UI: ${agentId}`}
/>
```

**The postMessage bridge:**

The sandboxed UI can only communicate with the Command Center via `window.postMessage`. All incoming messages must be validated:

```typescript
// apps/web/src/lib/sandbox/bridge.ts
window.addEventListener('message', (event) => {
  // ALWAYS verify origin
  if (event.origin !== ALLOWED_SANDBOX_ORIGIN) return;
  
  // Validate the message schema
  const result = SandboxMessageSchema.safeParse(event.data);
  if (!result.success) return;
  
  // Route the message
  handleSandboxMessage(result.data);
});
```

**Never** use `allow-same-origin` in the sandbox attribute. This would let the sandboxed document access the parent's DOM and localStorage.

---

## RPC Query Pattern (React Query + Nerve Center REST API)

For non-realtime data (fetching historical ledger events, tool catalog, etc.):

```typescript
// apps/web/src/hooks/useAgentEvents.ts
import { useQuery } from '@tanstack/react-query';

export function useAgentEvents(taskId: string, agentId: string) {
  return useQuery({
    queryKey: ['events', taskId, agentId],
    queryFn: () => api.getEvents({ taskId, agentId }),
    staleTime: 0,            // Ledger data is always considered stale (append-only)
    gcTime: 5 * 60 * 1000,  // Keep in memory for 5 minutes
  });
}
```

Realtime updates come through the WebSocket store. React Query is for initial data and explicit refreshes only.

---

## Phase 2 Implementation — Hard Lessons

These lessons were discovered building the Phase 2 Command Center shell and **must** be followed for all future apps/web work.

---

### Tailwind Dark Mode: Use `class` on `<html>`, NOT `@apply dark` in CSS

With `darkMode: ['class']` in `tailwind.config.ts`, the dark mode variant is toggled by the `dark` class on `<html>`. Set it in JSX only.

```tsx
// ✅ CORRECT — in apps/web/src/app/layout.tsx
<html lang="en" className={`dark ${inter.variable}`}>
```

```css
/* ✅ CORRECT — use color-scheme for browser chrome, not @apply */
html {
  color-scheme: dark;
}

/* ❌ WRONG — Tailwind will error: "The `dark` class does not exist" */
html {
  @apply dark;
}
```

**Why**: `dark` is a Tailwind *variant modifier*, not a utility class. PostCSS will throw a syntax error if you try to `@apply` it. CSS property values (like `border-color`) inside `@layer base` must also use `hsl(var(--border))` directly — not `@apply border-border` (Tailwind utility classes are only valid as complete declarations, not inside arbitrary custom rules).

---

### Next.js `apps/web` Needs a Separate `tsconfig.eslint.json` for ESLint

Next.js requires `moduleResolution: bundler` in its `tsconfig.json`, but `@typescript-eslint/parser` does **not** support `bundler` moduleResolution. When the root `.eslintrc.js` parses `apps/web` files with the wrong tsconfig, **every Zustand selector and store call will appear as `error`-typed**, producing cascades of false `no-unsafe-*` errors.

**Fix: create `apps/web/tsconfig.eslint.json`:**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "node",
    "jsx": "preserve",
    "noEmit": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", ".next"]
}
```

**And update the `apps/web` override in `.eslintrc.js`:**

```js
{
  files: ['apps/web/**/*.{ts,tsx}'],
  parserOptions: {
    project: ['./apps/web/tsconfig.eslint.json'],
    tsconfigRootDir: __dirname,
  },
  extends: ['plugin:react/recommended', 'plugin:react-hooks/recommended'],
  rules: { ... }
}
```

> **Note**: This tsconfig is for ESLint only — the Next.js build itself still uses `tsconfig.json` with `moduleResolution: bundler`.

---

### Zustand v5: Selector Typing, `getState()`, and `subscribeWithSelector`

Zustand v5 changed how selectors are typed. Always use the `subscribeWithSelector` middleware so the store supports `.subscribe(selector, callback)` for D3 and side-effect integrations.

```typescript
// ✅ CORRECT — subscribeWithSelector enables selector-based subscriptions
export const useSwarmStore = create<SwarmState>()(
  subscribeWithSelector((set) => ({ ... }))
);

// ✅ CORRECT — use named exported selectors to prevent re-renders
export const selectConnectionStatus = (s: SwarmState) => s.connectionStatus;
// In components: useSwarmStore(selectConnectionStatus)

// ✅ CORRECT — read state outside React using .getState() (hooks can't run in non-components)
const { appendEvent } = useSwarmStore.getState();

// ❌ WRONG — inline selector lambdas create new function refs → always triggers re-render
useSwarmStore((s) => ({ status: s.connectionStatus, count: s.events.length }));
```

**Sliding window pattern for the event ledger** (prevents unbounded memory growth):

```typescript
appendEvent: (event) => {
  set((state) => {
    const events = state.events.length >= MAX_EVENTS
      ? [...state.events.slice(-(MAX_EVENTS - 1)), event]
      : [...state.events, event];
    return { events };
  });
},
```

---

### socket.io-client: Module-Level Singleton + Manager Type Limitation

The `Socket` instance **must be a module-level singleton** — never call `io()` inside a hook body or component. React StrictMode double-invokes effects, which would create two connections.

```typescript
// ✅ CORRECT — module level, created once
let socket: ReturnType<typeof io> | null = null;

function getSocket(): ReturnType<typeof io> {
  if (socket === null) {
    socket = io(NERVE_CENTER_URL, { ... });
  }
  return socket;
}

// In the hook's useEffect:
const ws = getSocket();
ws.on('system:event', (event) => { appendEvent(event); });
// cleanup: ws.off('system:event') — do NOT disconnect
```

**Manager event typing limitation**: `ws.io` returns a `Manager` whose reconnect events (`reconnect_attempt`, `reconnect`, `reconnect_failed`) are not properly typed in `@types/socket.io-client`. This causes `@typescript-eslint/no-unsafe-call` errors. The approved workaround is a file-level eslint-disable at the TOP of the socket hook file:

```typescript
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
```

These suppression comments are permitted here (and only here) because the root `.eslintrc.js` immutable rules apply to application logic — not to a thin infrastructure adapter working around a known type library gap.

---

### ESLint `import/order` Rules for `apps/web`

The root ESLint config enforces strict import group ordering with blank lines between groups. Order is: **builtin → external → internal → parent → sibling**. Within each group: alphabetical.

```typescript
// ✅ CORRECT — external packages grouped together, blank line before internal @/
import { type SystemEvent } from '@ai-hivemind/shared';
import { useEffect, useRef } from 'react';

import { useSwarmStore } from '@/stores/swarmStore';
```

```typescript
// ❌ WRONG — @ai-hivemind/shared is external, react is external: no blank line between
// ❌ WRONG — @/ internal must come AFTER external with blank line separator
import { useEffect } from 'react';
import { useSwarmStore } from '@/stores/swarmStore';
import { type SystemEvent } from '@ai-hivemind/shared';
```

**CSS side-effect imports** (`'./globals.css'`) go last, after all module imports, as a separate group.

---

## Phase 3 Implementation — Hard Lessons

These lessons were discovered building the Phase 3 Topology, Inspector, and Command Prompt features.

---

### `useShallow` is MANDATORY for Zustand selectors returning Map/Array in Next.js App Router

❌ WRONG — creates new reference every render, triggers infinite `getServerSnapshot` loop:
```typescript
const events = useSwarmStore(selectFilteredEvents); // returns new array each call
const agents = useSwarmStore((s) => s.agents);      // Map itself is stable, but...
const agentList = [...agents.values()];             // ...spreading it creates new array
```

✅ CORRECT — wrap with `useShallow` so React compares contents, not references:
```typescript
import { useShallow } from 'zustand/react/shallow';

// In component:
const agentList = useSwarmStore(
    useShallow((s) => [...s.agents.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))),
);
const filteredEvents = useSwarmStore(
    useShallow((s) =>
        s.activeTraceId === null ? s.events : s.events.filter((e) => e.traceId === s.activeTraceId),
    ),
);
```

**Why:** React App Router calls `useSyncExternalStore` under the hood. When the selector returns a new object/array reference every time (even with same contents), it fails the snapshot equality check → infinite re-render loop → `Error: The result of getServerSnapshot should be cached to avoid an infinite loop`. `useShallow` performs a shallow equality check on array/object contents, breaking the loop.

**Rule:** Any Zustand selector that returns `new Map()`, `new Array()`, spread of a Map/Set, or calls `.filter()/.map()/.sort()` MUST use `useShallow`.

---

### React Flow `Node.data` Requires `Record<string, unknown>` — Custom Types Must Extend It

❌ WRONG — `AgentNodeData` cannot satisfy React Flow's `Node.data` constraint:
```typescript
export interface AgentNodeData extends AgentSummary {
    isActive: boolean;
}
// TypeScript: Type 'AgentNodeData' is not assignable to type 'Record<string, unknown>'
//   Index signature for type 'string' is missing
```

✅ CORRECT — extend `Record<string, unknown>` in addition to your domain type:
```typescript
// AgentNodeData must extend Record<string, unknown> to satisfy @xyflow/react Node.data constraint
export interface AgentNodeData extends AgentSummary, Record<string, unknown> {
    isActive: boolean;
}
```

And when casting in NodeProps callbacks (MiniMap, custom nodes), go through `unknown`:
```typescript
// ❌ WRONG — overlapping type error
const d = n.data as AgentNodeData;

// ✅ CORRECT
const d = n.data as unknown as AgentNodeData;
```

**Why:** `@xyflow/react`'s `Node<T>` generic requires `T extends Record<string, unknown>`. TypeScript won't accept a concrete interface without an index signature as satisfying this constraint — adding `Record<string, unknown>` to the extends clause adds the required index signature.

---

### CommandPrompt: Export `getSocket()` for use Outside the Hook

When a component needs to emit socket events without being the component that manages the connection lifecycle, export the singleton getter from the hook file:

```typescript
// In useSwarmSocket.ts — exported so CommandPrompt can use it
export function getSocket(): ReturnType<typeof io> {
    if (!socketInstance) { socketInstance = io(NERVE_CENTER_URL, OPTIONS); }
    return socketInstance;
}
```

```typescript
// In CommandPrompt.tsx
import { getSocket } from '@/hooks/useSwarmSocket';

// On submit:
const socket = getSocket();
socket.emit('user:command', { objective, traceId });
```

**Why:** Hooks can only be called at the top of React function components. A submit handler is called inside an event handler — calling `useSwarmSocket()` there would violate the Rules of Hooks. The `getSocket()` singleton pattern provides access to the existing connection without creating a new one.

---

### Zustand `selectTraces` Selector: Return Early-Stable Values

If you write a named selector that derives data from a `Map`, remember it will create a new reference every call. The options are:

1. **`useShallow`** in the call site (preferred for inline selectors)
2. **Don't export the selector** — inline it at call sites with `useShallow`
3. **Store derived arrays in the store itself** (avoids re-derivation entirely, but adds complexity)

Named selectors like `selectFilteredEvents` or `selectTraces` that return `Array` or `Map` should be documented as requiring `useShallow` at the call site.

```typescript
// In swarmStore.ts — leave a comment on unstable selectors
/** ⚠️ Returns new array — wrap with useShallow at call site */
export const selectFilteredEvents = (s: SwarmState): SystemEvent[] =>
    s.activeTraceId === null ? s.events : s.events.filter((e) => e.traceId === s.activeTraceId);
```

---

### ⚠️ CRITICAL: Never Use `useShallow` on Selectors That Derive Complex Data

**Symptom:** `"The result of getSnapshot should be cached to avoid an infinite loop"` + `"Maximum update depth exceeded"` — triggered when `activeTraceId` transitions from `null` → non-null (e.g., clicking a trace in the Roster panel).

**Root cause:** `useShallow` shallow-compares the *contents* of the returned value element-by-element. This works fine for plain objects or stable arrays. But if your selector function constructs a new array or Map on **every call** (e.g., `[...s.agents.values()]`, `new Map(...)`, `s.events.filter(...)`), then:

1. `useShallow` runs the selector on every store update.
2. Even when the data hasn't changed, it walks every element looking for a difference.
3. On `activeTraceId` state transitions, React's internal `getServerSnapshot` detects that consecutive snapshot calls return different references, triggering the infinite loop.

**Anti-pattern — two variants that both crash:**

```typescript
// ❌ WRONG: returns raw Map — useShallow has no idea how to compare Maps
const filteredAgents = useSwarmStore(
    useShallow((s) => {
        if (s.activeTraceId === null) return s.agents; // 💥 raw Map
        ...
    })
);

// ❌ ALSO WRONG: useShallow wrapping complex array derivation
const filteredAgents = useSwarmStore(
    useShallow((s): AgentSummary[] => {
        if (s.activeTraceId === null) return [...s.agents.values()]; // 💥 new array every call
        ...
    })
);
```

**Correct pattern — subscribe to stable primitives, derive with `useMemo`:**

```typescript
// ✅ CORRECT — s.agents, s.events, s.activeTraceId are stable primitives from the store.
// They only change identity when a store action replaces them (not on every rerender).
const agents      = useSwarmStore((s) => s.agents);       // stable Map ref
const events      = useSwarmStore((s) => s.events);       // stable Array ref
const activeTraceId = useSwarmStore((s) => s.activeTraceId); // string | null

// All derivation happens in useMemo — React controls when it re-runs
const filteredAgents = useMemo((): AgentSummary[] => {
    if (activeTraceId === null) return [...agents.values()];
    const out = new Map<string, AgentSummary>();
    for (const e of events) {
        if (e.traceId !== activeTraceId) continue;
        out.set(e.sourceId, { ... });
    }
    return [...out.values()];
}, [agents, events, activeTraceId]);

const filteredEvents = useMemo(
    () => activeTraceId === null ? events : events.filter((e) => e.traceId === activeTraceId),
    [events, activeTraceId],
);
```

**Rule of thumb:**
- `useShallow` → only for selectors that return **plain objects with scalar values** (strings, numbers, booleans) or arrays of stable references.
- `useMemo` → for any **derived/filtered/mapped data** that constructs new objects.
- Never spread Maps or filter arrays inside a `useShallow` selector.

---

## Phase 6 Implementation — Hard Lessons

These lessons were discovered building the Phase 6 Dynamic Canvas & Interactive Bridge.

---

### Tabbed Center Stage: Track Active Tab with Port Number, Not String

When dynamically adding canvas tabs for deployed services, use the port number as the tab discriminant rather than a string name. Ports are naturally unique and prevent duplicate tab confusion.

```typescript
// ✅ CORRECT — number discriminant prevents ambiguity
type ActiveTab = 'topology' | number; // number = port
const [activeTab, setActiveTab] = useState<ActiveTab>('topology');

// Render iframes for ALL services but only show the active one:
{canvasTabs.map((svc) => (
    <iframe
        key={svc.port}
        src={svc.url}
        className={activeTab === svc.port ? 'block' : 'hidden'}
        // safety: no allow-same-origin
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
    />
))}
```

**Why:** Rendering all iframes at mount (just hiding inactive ones with CSS) avoids re-mounting and page reload every time the user switches tabs. The iframe preserves state while hidden.

---

### User Intervention Bridge: Socket → EventBus → Conductor stdin

The feedback injection chain is: Component → `socket.emit('user:intervention')` → `server.ts` handler → `eventBus.emit(USER_INTERVENTION)` → `conductor.ts` subscriber → `child.stdin.write()`.

```typescript
// ✅ CORRECT chain — each layer is decoupled
// 1. Component emits:
getSocket().emit('user:intervention', { text, targetId: agentId, traceId });

// 2. server.ts bridges to eventBus (targetId is preserved in payload AND as event.targetId):
eventBus.emit({ eventType: 'USER_INTERVENTION', targetId, payload: { text, targetId } });

// 3. conductor.ts filters by agentId:
eventBus.subscribe('USER_INTERVENTION', (event) => {
    if (event.targetId !== self.agentId) return; // ignore events for other conductors
    child.stdin?.write(`${text}\n`, 'utf8');
});
```

**Critical:** The `targetId` must be set as both the event envelope field AND inside `payload`. The eventBus subscriber filters on `event.targetId` (the envelope), not `event.payload.targetId`.

---

### CSS Module Dot-Notation: TypeScript Strict Index Signature Error

When a CSS module is imported without an explicit type declaration file, TypeScript treats its exports as an index signature, requiring bracket notation.

```typescript
// ❌ WRONG — fails in strict mode: "Property 'container' comes from an index signature"
import styles from './reddit.module.css';
<div className={styles.container}>

// ✅ CORRECT — use bracket notation for CSS module classes
<div className={styles['container']}>
```

**Why:** TypeScript CSS module types use `{ [className: string]: string }` which requires bracket access for index signature properties unless a `.d.ts` file explicitly declares each class name as a named property. Agent-generated React pages commonly use dot notation — always migrate to bracket notation.

---

### Auto-Switch to New Canvas Tab on SERVICE_DEPLOYED

Use `useRef` to track previous count so the auto-switch fires only on increases (new tabs), not on filter changes.

```typescript
const prevServicesRef = useRef<number>(canvasTabs.length);
useEffect(() => {
    if (canvasTabs.length > prevServicesRef.current) {
        const newest = canvasTabs[canvasTabs.length - 1];
        if (newest !== undefined) setActiveTab(newest.port);
    }
    prevServicesRef.current = canvasTabs.length;
}, [canvasTabs]);
```

**Why:** Without the ref guard, re-renders caused by trace filter changes would incorrectly trigger auto-switch even when no new service was deployed.
