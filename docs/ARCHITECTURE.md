# ARCHITECTURE: Agentic Control Plane & Execution Environment

> **Version:** 0.1.0 — Foundational  
> **Status:** Living Document  
> **Audience:** Senior Engineers, Principal Architects  
> **Last Updated:** 2026-03-03

---

## 0. Guiding Architectural Philosophy

This document defines the **high-level system architecture**. It is intentionally abstract at the implementation level while being precise at the boundary level. The key discipline here is **defining what crosses which boundary and under what contract**. Implementation details live in service-level READMEs. Boundary contracts live in `packages/shared`.

**Architecture = Boundaries + Contracts + Invariants.**

---

## 1. System Topology Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENTIC CONTROL PLANE                               │
│                                                                             │
│  ┌──────────────────────┐          ┌────────────────────────────────────┐  │
│  │   COMMAND CENTER      │ ◄──WS──► │          NERVE CENTER              │  │
│  │   (apps/web)          │          │         (apps/backend)             │  │
│  │                       │          │                                    │  │
│  │  • Swarm Topology View│          │  • WebSocket Gateway               │  │
│  │  • Agent Inspector    │          │  • Event Bus (pub/sub)             │  │
│  │  • Ledger Timeline    │          │  • Global Execution Ledger         │  │
│  │  • Interrupt Console  │          │  • Agent Lifecycle Manager         │  │
│  │  • iframe Sandboxes   │          │  • MCP Tool Registry               │  │
│  │  • RAG Memory Browser │          │  • Interrupt Vector Handler        │  │
│  └──────────────────────┘          │  • Auth / Policy Enforcement       │  │
│                                    └─────────────┬──────────────────────┘  │
│                                                  │                          │
│                                    ┌─────────────▼──────────────────────┐  │
│                                    │      AGENT EXECUTION LAYER          │  │
│                                    │                                    │  │
│                      ┌─────────────┤  Agent Process Manager             │  │
│                      │             └─────────────┬──────────────────────┘  │
│                      │                           │                          │
│         ┌────────────▼─────┐    ┌────────────────▼─────────────────────┐  │
│         │  BUILT-IN AGENTS  │    │    EXECUTION SANDBOXES (apps/sandbox)│  │
│         │                  │    │                                       │  │
│         │  • Coordinator   │    │  ┌──────────────┐ ┌──────────────┐   │  │
│         │  • Proj Manager  │    │  │  SWE Sandbox │ │  UX Sandbox  │   │  │
│         │  • Data Research │    │  │  (Docker/µVM)│ │  (Docker/µVM)│   │  │
│         │  • QA Engineer   │    │  └──────────────┘ └──────────────┘   │  │
│         │  • Planner       │    │                                       │  │
│         └──────────────────┘    │  Runtime-generated agent processes    │  │
│                                  └──────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │                      SHARED INFRASTRUCTURE                              ││
│  │   Vector DB (RAG Memory) │ PostgreSQL (Ledger) │ MCP Servers            ││
│  └────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Agent Hierarchy

The agent hierarchy is **not** a management org chart. It is a **delegation and authority model** that defines which agents can spawn other agents, which agents own global state, and which agents are ephemeral execution workers.

### 2.1 Tier 0 — Coordinator

**One per swarm, always. The sovereign authority.**

| Property | Value |
|---|---|
| **Cardinality** | Singleton |
| **Persistence** | Long-lived (persists for the lifetime of a task graph) |
| **Spawning Authority** | Can spawn any Tier 1 agent |
| **State Ownership** | Owns the top-level task graph and the canonical task decomposition |
| **Tool Access** | Agent Lifecycle Manager (spawn/suspend/terminate), Global Ledger Query |

The Coordinator receives the initial human-issued directive, decomposes it into a task graph, assigns subtasks to Tier 1 agents, and maintains a live view of aggregate progress. It does **not** execute subtasks directly. It is the **only** agent authorized to:
- Write to the top-level task context.
- Issue spawn directives to the Agent Process Manager.
- Signal task completion to the Command Center.

### 2.2 Tier 1 — Project Manager

**One per major work stream, spawned by Coordinator.**

| Property | Value |
|---|---|
| **Cardinality** | 1–N per task (one per independent work stream) |
| **Persistence** | Mid-lived (persists for the duration of a work stream) |
| **Spawning Authority** | Can spawn Tier 2 agents within its work stream |
| **State Ownership** | Owns the work stream context and subtask status |

The Project Manager breaks a Coordinator-assigned work stream into concrete subtasks, sequences them based on data dependencies, and manages the execution pipeline for those subtasks. It is responsible for **error recovery within its work stream** before escalating to the Coordinator.

### 2.3 Tier 2 — Specialist Agents

**Spawned by Project Manager. Pure execution workers.**

| Agent | Specialty | Key Tools | Cardinality |
|---|---|---|---|
| **Data Researcher** | Information acquisition, synthesis | `web.search`, `web.scrape`, `rag.query`, `http.get` | N per work stream |
| **SWE (Software Engineer)** | Code generation, implementation, debugging | Code execution sandbox, `git.*`, file system tools | N per work stream |
| **UX Designer** | User experience specification, wireframes | Design system queries, component library | N per work stream |
| **UI Engineer** | UI artifact generation (HTML/CSS/JS) | Sandboxed code execution, component tools | N per work stream |
| **QA Engineer** | Testing, validation, regression | Test runner, code execution sandbox, assertion tools | N per work stream |
| **Planner** | Subtask decomposition, dependency mapping | Task graph tools, estimation tools | N per work stream |

**Critical invariant:** Tier 2 agents have **no cross-work-stream visibility**. They can only read and write to the context namespace provided by their parent Project Manager. They cannot directly communicate with agents in sibling work streams. All cross-stream coordination happens at Tier 1 or above.

### 2.4 Tier 3 — Runtime-Generated Agents

**Synthesized on demand by any Tier 0/1 agent when a novel capability is required that is not covered by the built-in specialist roster.**

A Runtime Generated Agent is defined by a `RuntimeAgentSpec` (defined in `packages/shared`):

```typescript
// packages/shared/src/types/agent.ts
export interface RuntimeAgentSpec {
  specVersion: string;         // SemVer — must match packages/shared version
  agentId: string;             // UUID, assigned by Nerve Center
  persona: AgentPersona;       // Name, description, behavioral constraints
  tools: ToolBinding[];        // Subset of MCP tool registry
  contextNamespace: string;    // Scoped context key this agent may read/write
  parentAgentId: string;       // Must be Tier 0 or Tier 1 agent
  maxTokenBudget: number;      // Hard cap — enforced by Nerve Center
  ttl: number;                 // Time-to-live in seconds, after which agent is GC'd
}
```

---

## 3. The Nerve Center (apps/backend)

### 3.1 Responsibilities

The Nerve Center is a **policy-free event infrastructure**. This distinction is critical: it enforces *structural* invariants (schema validity, lifecycle state machine transitions, authorization scope) but contains **zero agent-specific business logic**.

**Core components:**

| Component | Responsibility |
|---|---|
| **WebSocket Gateway** | Multiplexed, authenticated WebSocket server. One connection per Command Center client. Agents connect via gRPC or internal IPC, not WebSocket. |
| **Event Bus** | Topic-based pub/sub. Topics are keyed by `{taskId}/{agentId}/{eventType}`. The Command Center subscribes to `{taskId}/**` for full visibility. |
| **Global Execution Ledger** | PostgreSQL-backed, append-only event store. Every event is written to the ledger before being published on the bus. Ledger is the source of truth; the bus is a delivery mechanism. |
| **Agent Lifecycle Manager** | Implements the agent state machine. Manages process spawning (via container runtime API), health checks, and termination. |
| **MCP Tool Registry** | Aggregates tool schemas from all registered MCP servers. Exposes a unified `/v1/tools` endpoint. Handles tool call proxying. |
| **Interrupt Vector Handler** | Receives operator directives from the Command Center. Translates them to events on the bus. Ensures delivery to the target agent's input queue within the SLA. |
| **Auth / Policy Enforcement** | JWT-based authentication for Command Center clients. Agent-to-Nerve-Center communication uses short-lived mTLS certificates. Policy enforcement is attribute-based (ABAC). |

### 3.2 Agent Communication Model

Agents do **not** communicate directly with each other. All A2A communication is **mediated by the Nerve Center's Event Bus**. This is a hard constraint.

```
Agent A  ──(publish event)──►  Event Bus  ──(route to topic)──►  Agent B's input queue
              │
              └──────────────►  Global Ledger (async write, ack before bus publish)
```

This model guarantees:
1. Every A2A message is durably logged before delivery.
2. The Nerve Center can inspect, filter, or block any message (for policy or interrupt purposes).
3. Agent B cannot be "surprised" by a message — it always reads from its own input queue at a time of its choosing.

### 3.3 Global Execution Ledger Schema

The ledger uses a single, wide events table with JSONB payload to balance query flexibility with write performance:

```sql
CREATE TABLE execution_events (
  id            BIGSERIAL PRIMARY KEY,
  event_id      UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL,
  stream_id     TEXT NOT NULL,          -- "{taskId}/{agentId}"
  event_type    TEXT NOT NULL,          -- See EventType enum in packages/shared
  sequence_num  BIGINT NOT NULL,        -- Monotonic per stream_id
  causation_id  UUID,                   -- event_id of the event that caused this one
  correlation_id UUID NOT NULL,         -- Top-level task or operation ID
  agent_id      TEXT NOT NULL,
  payload       JSONB NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes optimized for the most common query patterns
CREATE INDEX idx_events_task_id ON execution_events(task_id);
CREATE INDEX idx_events_stream   ON execution_events(stream_id, sequence_num);
CREATE INDEX idx_events_type     ON execution_events(event_type);
CREATE INDEX idx_events_ts       ON execution_events(created_at DESC);
```

### 3.4 Telemetry Captured per Event

Every event in the ledger carries a `metadata` envelope (defined in `packages/shared/src/types/telemetry.ts`):

```typescript
export interface EventMetadata {
  // Token Economics
  promptTokens?:     number;
  completionTokens?: number;
  totalTokens?:      number;
  modelId?:          string;
  estimatedCostUsd?: number;

  // Latency
  durationMs?:       number;
  queueWaitMs?:      number;

  // Tool Execution
  toolName?:         string;
  toolVersion?:      string;
  toolCallId?:       string;
  toolInputHash?:    string;   // SHA-256 of serialized input for deduplication

  // CLI / Process Telemetry (for SWE agent sandbox)
  exitCode?:         number;
  stdoutByteLen?:    number;
  stderrByteLen?:    number;
  commandHash?:      string;

  // Environment
  sandboxId?:        string;
  containerImage?:   string;
  regionId?:         string;
}
```

---

## 4. The Command Center (apps/web)

### 4.1 Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Framework** | React 19 + TypeScript (strict) | Component model fits the panel-based operational UI |
| **State Management** | Zustand (atomic stores) + React Query (server state) | Avoid Redux ceremony; event-driven updates map well to Zustand |
| **WebSocket Client** | Native WebSocket + custom reactive wrapper | Full control over reconnection, backpressure, and event routing |
| **Visualization** | D3.js (swarm topology graph) | Non-standard graph rendering requires low-level control |
| **UI Components** | `packages/ui` (internal component library) | Enforces design system consistency |
| **Build** | Vite + Turborepo | Fast HMR during development, optimized production bundles |

### 4.2 Core UI Modules

**Module: Swarm Topology**
- Force-directed graph (D3) where nodes are agents and edges are active communication channels.
- Node state is color-coded by AgentLifecycleState (IDLE=gray, PLANNING=blue, EXECUTING=green, SUSPENDED=amber, ERROR=red, TERMINATED=black).
- Edge thickness represents message throughput in the last N seconds.
- Click any node to open the Agent Inspector slide-over panel.

**Module: Agent Inspector**
- Full context window viewer with token count annotations.
- Message history with role-based rendering (SYSTEM, USER, ASSISTANT, TOOL).
- Active tool bindings list with last-used timestamp.
- Performance sparklines: tokens/min, latency p50/p95.

**Module: Global Ledger Timeline**
- Virtualized, reverse-chronological event stream.
- Filter by: `agentId`, `eventType`, `taskId`, `toolName`, time range.
- Full-text search across event payloads.
- Event detail panel with full JSONB payload inspection and causation chain tracing.

**Module: Interrupt Console**
- Operator-privileged panel (RBAC-gated).
- Commands: `SUSPEND_AGENT`, `INJECT_CONTEXT`, `TERMINATE_AGENT`, `REDIRECT_TASK`, `FORCE_COMPLETE`.
- All directives require a mandatory `reason` string (written to ledger).
- Confirmation dialog for destructive operations.

**Module: Sandbox Viewer**
- Grid of active iframe sandboxes showing agent-generated UIs.
- Each sandbox is labeled with the producing agent ID and task context.
- Trust level badge (UNTRUSTED renders with visible orange border).

### 4.3 WebSocket Event Routing

The Command Center maintains a single WebSocket connection to the Nerve Center. Incoming events are routed by type to the appropriate Zustand store:

```typescript
// Pseudocode — actual implementation in apps/web/src/lib/ws/router.ts
const EVENT_ROUTER: Record<EventType, (event: LedgerEvent) => void> = {
  [EventType.AGENT_STATE_CHANGED]:  swarmStore.handleAgentStateChange,
  [EventType.A2A_MESSAGE_SENT]:     ledgerStore.appendEvent,
  [EventType.TOOL_CALL_STARTED]:    ledgerStore.appendEvent,
  [EventType.TOOL_CALL_COMPLETED]:  ledgerStore.appendEvent,
  [EventType.CONTEXT_MUTATED]:      agentInspectorStore.handleContextMutation,
  [EventType.INTERRUPT_APPLIED]:    interruptStore.handleInterruptAck,
  // ...
};
```

---

## 5. Execution Sandboxes (apps/sandbox)

### 5.1 Isolation Model

Every agent that executes code (primarily SWE and UI agents) does so inside an **isolated execution sandbox**. The sandbox is the only place where untrusted code runs.

**Sandbox specification:**

| Property | Value |
|---|---|
| **Runtime** | Docker container (CI/CD) or Firecracker microVM (production) |
| **Network** | Allow-listed egress only (no arbitrary internet access) |
| **Filesystem** | Ephemeral overlay FS with a read-only base image; task workspace mounted as a named volume |
| **Resource Limits** | CPU: configurable per agent type; Memory: hard cap (OOM = sandbox terminated, not crashed); Time: TTL enforced by Agent Lifecycle Manager |
| **Communication** | Sandbox ↔ Nerve Center only, via authenticated gRPC over Unix domain socket or secured TCP |

### 5.2 Sandbox Lifecycle

```
PROVISION ──► INITIALIZING ──► READY ──► EXECUTING ──► IDLE ──► TERMINATED
                                  │                         │
                                  │                         └──► (TTL reached → GC)
                                  └──► ERROR ──────────────────► TERMINATED
```

All lifecycle transitions emit events to the Global Execution Ledger.

### 5.3 CLI Telemetry Capture

For any CLI command executed inside a sandbox (by a SWE agent, for instance), the sandbox runtime wrapper captures:

- Full `stdout` and `stderr` (streamed in real time to the Nerve Center).
- Exit code.
- Wall-clock execution time.
- Peak memory usage (via cgroup metrics).
- A hash of the command and arguments for deduplication.

This captures the "CLI telemetry" referenced in VISION.md §1.1 without requiring any instrumentation inside the agent's code.

---

## 6. A2A Messaging Protocol

### 6.1 Message Envelope

All A2A messages conform to the `A2AMessage` type defined in `packages/shared`:

```typescript
export interface A2AMessage {
  // Routing & Identity
  messageId:     string;     // UUID
  taskId:        string;     // UUID of the root task
  senderId:      string;     // Fully qualified agent ID (e.g., "coordinator.0")
  recipientId:   string;     // Fully qualified agent ID or broadcast topic
  replyToId?:    string;     // messageId of the message this is a reply to

  // Content
  role:          MessageRole;       // DIRECTIVE | RESPONSE | BROADCAST | INTERRUPT
  contentType:   MessageContentType; // TEXT | TOOL_CALL | TOOL_RESULT | CONTEXT_PATCH | TASK_SPEC
  content:       unknown;           // Typed by contentType — validated at Nerve Center boundary

  // Metadata
  priority:      MessagePriority;   // NORMAL | HIGH | INTERRUPT (INTERRUPT bypasses queue)
  ttl:           number;            // Seconds. Message dropped if not consumed in time.
  timestamp:     string;            // ISO 8601, set by Nerve Center on receipt (not sender)
  schemaVersion: string;            // Must match packages/shared SemVer
}
```

### 6.2 Routing Rules

| `role` | Routing Behavior |
|---|---|
| `DIRECTIVE` | Point-to-point delivery to `recipientId`'s input queue. |
| `RESPONSE` | Point-to-point delivery to sender of `replyToId`. |
| `BROADCAST` | Delivered to all agents subscribed to the task's broadcast topic. |
| `INTERRUPT` | Bypasses all queues. Delivered synchronously to the target agent's interrupt handler. Highest priority. |

### 6.3 Schema Versioning and Compatibility

The `schemaVersion` field on every message envelope corresponds to the SemVer of `packages/shared` that was used to construct it. The Nerve Center:

1. Validates the message against the schema version specified.
2. **Rejects** messages with schema versions that are incompatible (major version mismatch).
3. **Accepts with warning** messages with older minor versions (backward-compatible by contract).
4. Logs all version mismatches to the ledger for operational visibility.

---

## 7. MCP Tool Integration

### 7.1 Tool Registration Flow

```
MCP Server (external)
    │
    └──(connect)──► Nerve Center MCP Gateway
                        │
                        ├──► Fetch tool schemas (/v1/mcp/tools)
                        ├──► Validate schemas against ToolSchema type in packages/shared
                        ├──► Merge into unified Tool Registry (dedup by tool name + version)
                        ├──► Publish TOOL_REGISTRY_UPDATED event on Event Bus
                        └──► Command Center receives update, refreshes tool catalog UI
```

### 7.2 Tool Authorization Model

Tool access is **not** granted at the agent type level. It is granted via the `ToolBinding` list in each agent's specification (`RuntimeAgentSpec` for runtime agents; explicit config for built-in agents).

A `ToolBinding` specifies:
- The tool name and version constraint.
- Any parameter overrides (e.g., forcing a specific API key or rate limit).
- The **maximum call depth** — how many times this agent may invoke this tool within a single message-turn. Prevents runaway tool loops.

---

## 8. RAG Memory Architecture

### 8.1 Memory Namespaces

| Namespace | Scope | Access | TTL |
|---|---|---|---|
| `task:{taskId}` | Single task execution | Read/write: any agent in the task | Deleted on task completion |
| `project:{projectId}` | Shared across all tasks in a project | Read: all; Write: Coordinator only | Persistent |
| `global` | Entire system | Read: all; Write: privileged agents only | Persistent |

### 8.2 Indexing Pipeline

Every event in the Global Execution Ledger is evaluated by an asynchronous **memory indexer** process (not part of the critical path):

1. Filter events by type (only `TASK_COMPLETED`, `TOOL_CALL_COMPLETED` with non-trivial output, `A2A_MESSAGE_SENT` with RESPONSE role).
2. Extract the text payload.
3. Generate embeddings via the configured embedding model.
4. Upsert into the vector database with metadata tags: `{taskId, agentId, eventType, timestamp}`.

The memory indexer is intentionally decoupled from the Nerve Center to avoid adding latency to the critical event processing path.

---

## 9. Deployment Architecture

```
                        ┌─────────────────────────────────────┐
                        │        Load Balancer / CDN          │
                        └─────────────┬───────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
    ┌─────────▼─────────┐   ┌─────────▼─────────┐  ┌─────────▼──────────┐
    │  Command Center   │   │   Nerve Center     │  │  Sandbox Cluster   │
    │  (CDN-hosted SPA) │   │ (K8s StatefulSet)  │  │  (K8s DaemonSet)   │
    └───────────────────┘   └─────────┬──────────┘  └────────────────────┘
                                      │
                            ┌─────────┴──────────┐
                            │                    │
                    ┌───────▼──────┐    ┌────────▼──────┐
                    │  PostgreSQL  │    │  Vector DB     │
                    │  (Ledger)    │    │  (RAG Memory)  │
                    └──────────────┘    └───────────────┘
```

**Key deployment invariants:**
- The Nerve Center is a `StatefulSet` with a stable network identity (required for WebSocket persistence).
- The Nerve Center maintains **zero horizontal state** — all state is in PostgreSQL. Any Nerve Center replica can serve any client after a restart.
- Sandbox containers/microVMs run on dedicated nodes with no other workloads (security isolation).

---

## 10. Sequence Diagrams

### 10.1 Task Initiation Flow

```
Human Operator         Command Center         Nerve Center          Coordinator
      │                      │                     │                     │
      │── submit directive──► │                     │                     │
      │                      │──POST /v1/tasks ───► │                     │
      │                      │                     │── TASK_CREATED ──►  │
      │                      │                     │   (Ledger + Bus)    │
      │                      │                     │── spawn process ──► │ (new process)
      │                      │                     │                     │
      │                      │◄── WS: AGENT_STATE_CHANGED (IDLE→PLANNING)│
      │◄── UI update ────────│                     │                     │
      │                      │                     │◄── DIRECTIVE ───────│
      │                      │                     │   (spawn PM)        │
      │                      │                     │──spawn PM process──►│(Project Manager)
```

### 10.2 Agent Interrupt Flow

```
Human Operator         Command Center         Nerve Center          Target Agent
      │                      │                     │                     │
      │── INTERRUPT cmd ───► │                     │                     │
      │                      │──POST /v1/interrupt─► │                   │
      │                      │                     │─INTERRUPT message──►│ (bypass queue)
      │                      │                     │                     │── ACK
      │                      │                     │── setState(SUSPENDED)
      │                      │◄── WS: AGENT_STATE_CHANGED (→SUSPENDED)  │
      │◄── confirmation ─────│                     │                     │
```

---

*Architecture evolves. Boundary contracts do not. When in doubt, consult `packages/shared` as the single source of truth for what crosses any system boundary.*
