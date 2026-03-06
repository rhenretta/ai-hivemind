# VISION: Agentic Control Plane & Execution Environment

> **Version:** 0.1.0 — Foundational  
> **Status:** Living Document  
> **Audience:** Senior Engineers, Principal Architects  
> **Last Updated:** 2026-03-03

---

## Preface

This document is not a requirements specification. It is a **manifesto**. It defines why this system exists, the precise problem it solves, and the non-negotiable principles that must guide every architectural decision made hereafter. Read it before touching a single line of code. Reference it when trade-offs emerge.

---

## 1. The Core Problem: AI Swarms Are Black Boxes

The proliferation of LLM-based agents has outpaced our ability to govern them. A single autonomous agent is already difficult to reason about. A *swarm* of collaborating agents — each with its own tools, memory, and behavioral policies — is, in most current implementations, completely opaque.

### 1.1 The Observability Gap

When an agent swarm executes a complex multi-step task, the following information is routinely lost or inaccessible in real time:

| Dimension | What's Missing |
|---|---|
| **Agent-to-Agent Communication** | The full graph of which agent sent what message to which agent, under what authorization scope, and at what timestamp. |
| **Tool Execution Provenance** | Which specific tool call (with exact parameters) triggered a state change, and what the exact response payload was before deserialization. |
| **Dynamic State Evolution** | How the shared working context (the "world model") changed at each step — what was injected, what was pruned, and why. |
| **Decision Rationale** | The intermediate reasoning chain that caused an agent to select one tool or delegate to one sub-agent versus another. |
| **Token Economics** | Aggregate and per-step token consumption across the swarm, mapped to cost centers and task IDs. |
| **Failure Attribution** | When a pipeline fails, precisely which agent, which tool invocation, or which context mutation caused the cascade. |

### 1.2 The Control Gap

Observability alone is insufficient. Current agent frameworks offer no first-class mechanism for a human operator to:

- **Intercept** a running agent's next action before it is executed (the "human-in-the-loop" checkpoint).
- **Steer** an in-flight agent by injecting revised context, corrected data, or a hard constraint without aborting and restarting the entire pipeline.
- **Eject** a rogue or stuck agent from the swarm without cascading failures to its dependents.
- **Replay** a failed task from a specific checkpoint using a surgical state patch.

### 1.3 The Composability Gap

Most agent orchestration systems are monolithic in their agent definitions. Agents are defined at build time, with fixed tools and fixed personas. This creates a critical limitation:

- **No runtime specialization:** You cannot compose a new "expert" agent on the fly in response to a novel subtask discovered mid-execution.
- **Static tool binding:** Tools discovered via MCP (Model Context Protocol) after system startup cannot be seamlessly surfaced to running agents.
- **No sandboxed execution context:** Dynamically-generated code (e.g., from a Software Engineering agent) has no safe, isolated, instrumented environment to execute within.

---

## 2. The Solution: A Real-Time Agentic Command Center

We are building a **platform**, not a framework. The distinction is critical. A framework provides primitives. A platform provides a *governed, observable, steerable environment in which agents operate*.

The system has two fundamental layers:

### 2.1 The Nerve Center (Backend)

A WebSocket-driven, event-sourced backend that serves as the authoritative nervous system of the swarm. Every agent action, every A2A message, every tool call, and every state mutation **emits a structured event**. The Nerve Center:

- Maintains the **Global Execution Ledger** — an append-only, immutable record of all events with causal ordering.
- Runs the **Event Bus** — a high-throughput pub/sub system enabling both agent-to-agent and system-to-UI communication.
- Enforces **Agent Lifecycle Management** — agents are processes with well-defined states (IDLE, PLANNING, EXECUTING, SUSPENDED, TERMINATED).
- Hosts the **MCP Tool Registry** — a live catalog of all registered tools, updated dynamically as new MCP servers connect.
- Manages **Interrupt Vectors** — the mechanism by which the Command Center UI injects human directives into a running pipeline.

### 2.2 The Command Center (Frontend)

A React-based operational UI that consumes the Nerve Center's WebSocket stream and renders the swarm's activity in real time. It provides:

- **Live Swarm Topology View:** A force-directed graph showing all active agents, their current state, and active communication channels.
- **Agent Inspector:** For any agent, a drill-down view into its full context window, active tools, message history, and current task.
- **Global Ledger Timeline:** A chronological, filterable, queryable timeline of all events across the swarm.
- **Interrupt Console:** A privileged interface for operators to issue directives, inject context, suspend agents, or terminate tasks.
- **Dynamic UI Sandboxes:** `<iframe>`-based sandboxes where agent-generated UIs (e.g., a data visualization widget produced by a UX agent) can render safely and communicate back to the control plane.

---

## 3. Key Capabilities

### 3.1 Absolute Real-Time Observability

The system provides **zero-latency** (WebSocket push) visibility into:

- The full A2A message graph, with message payloads, sender/receiver identities, and routing decisions.
- Every tool invocation: the tool name, input parameters, raw output, latency, and success/failure status.
- The diff between a task's working context before and after each agent step.
- All token usage metrics, mapped to individual agents, steps, and cost centers.

*This is not logging. This is a live, queryable, structured operational view.*

### 3.2 Polymorphic Agent Swarms

The system supports two categories of agents:

**Built-in Agents** — pre-defined, versioned, well-tested agents with fixed personas and tool sets. These form the *core workforce* of the swarm (see ARCHITECTURE.md §2 for the full hierarchy).

**Runtime-Generated Agents** — agents synthesized on demand in response to novel task requirements. These agents:
- Are described by a structured specification emitted by the Coordinator agent.
- Are spun up in isolated execution sandboxes.
- Inherit the MCP tool registry's current state.
- Are first-class citizens of the observability layer from the moment they are created.

### 3.3 Dynamic UI Generation via Iframe Sandboxes

Agent-generated UI artifacts (HTML/CSS/JS bundles produced by UI or UX agents) are rendered in strictly-sandboxed `<iframe>` elements with:

- **Content Security Policy (CSP)** enforced at the iframe boundary.
- A **postMessage bridge** providing a controlled, typed API surface the sandboxed UI can call back to the Control Plane.
- **Lifecycle management** — sandboxes can be created, updated, and destroyed by the control plane in response to agent output.

This allows a fully autonomous UI agent to produce a functional, interactive interface artifact that can be presented to a human operator for review and approval without any risk of malicious or accidental DOM manipulation of the host application.

### 3.4 Seamless MCP Tool Discovery

The system treats the Model Context Protocol (MCP) as a first-class citizen:

- The Nerve Center acts as an **MCP aggregator** — it connects to multiple upstream MCP servers and publishes a unified, deduplicated tool catalog.
- New MCP servers can be registered at runtime without restarting the control plane.
- All tool calls routed through the system are proxied via the Nerve Center, ensuring that every invocation is captured in the Global Execution Ledger.
- Tool authorization policies are enforced at the Nerve Center boundary, not at the agent level.

### 3.5 Persistent RAG Memory via Vector Databases

The system provides a **shared, persistent memory layer** accessible to all agents in the swarm:

- Indexed in a vector database (pgvector / Qdrant, configurable at deployment time).
- Populated automatically from the Global Execution Ledger — every significant event is a candidate for memory storage.
- Queryable by agents at any point in their execution via a standardized memory retrieval tool.
- Supports **namespaced memory contexts** — task-scoped, project-scoped, and global memory buckets with explicit access control.

---

## 4. Non-Negotiable Principles

These principles are **architectural axioms**. They are not to be compromised for the sake of velocity.

1. **Event Sourcing is the Source of Truth.** The system's state is always derived from its event stream. There is no "live mutable state" that exists outside of the ledger. This enables replay, audit, and time-travel debugging.

2. **The Nerve Center is Policy-Free.** The Nerve Center routes events and enforces lifecycle contracts. It does not contain agent business logic. Business logic lives in agents. This separation ensures the Nerve Center is a stable, low-churn core.

3. **All Agent Boundaries are Process Boundaries.** No agent runs in the same process as the Nerve Center. Full stop. Agents may crash. They must not crash the control plane.

4. **Observability is not Optional.** There is no "fast path" that bypasses event emission. Every action, regardless of performance constraints, emits a structured event. If a feature cannot be built with observability, the feature's architecture is wrong.

5. **Human Override is Sovereign.** Any operator-issued directive from the Command Center takes absolute precedence over any agent action. The system must be able to suspend any agent within a bounded, predictable time window (target: <500ms).

6. **Shared Contracts are Versioned.** All data structures crossing service boundaries (defined in `packages/shared`) are typed, versioned, and backward-compatible. Breaking changes require a major version bump and a migration path.

---

## 5. What This System is NOT

Clarity on exclusions prevents scope creep:

- This is **not** a general-purpose LLM framework (use LangChain, LlamaIndex, etc. as dependencies, not as architectural replacements).
- This is **not** a model serving platform. Model inference happens via external API calls or self-hosted inference servers; we do not manage GPU resources.
- This is **not** a workflow automation tool in the n8n/Zapier sense. Our agents exhibit autonomous reasoning, not deterministic rule-following.
- This is **not** a consumer product. It is an **operational platform for engineers and operators** who deeply understand the systems they are governing.

---

## 6. Success Criteria

The v1.0 release of this platform is considered successful when:

1. A 9-agent swarm can execute a full-stack feature request (from specification to tested, deployed code) with **zero opacity** — every decision, message, and tool call is visible in the Command Center in real time.
2. A human operator can **intercept and redirect** any agent in the swarm within 500ms without aborting the broader task.
3. A runtime-generated agent can be **synthesized, deployed, and garbage-collected** within a single task's lifecycle with no residual state leakage.
4. All MCP tools are **auto-discovered** and available without a control-plane restart.
5. The Global Execution Ledger can be **replayed** from any checkpoint to reproduce any historical system state exactly.

---

*This vision document must be reviewed and reaffirmed at the start of every major milestone. If the system being built diverges from this vision, the divergence must be explicitly documented and justified, not silently rationalized.*
