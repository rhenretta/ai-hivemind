---
name: agent-hierarchy-rules
description: The complete agent authority model, communication rules, context namespace rules, and invariants for the ai-hivemind swarm
---

# Skill: Agent Hierarchy & Communication Rules

## When to Use This Skill

Load this skill whenever you are:
- Scaffolding a new built-in agent
- Implementing A2A message routing logic
- Deciding where a piece of state/context should live
- Designing a new agent capability or tool authorization rule
- Debugging an agent that is behaving outside its authority

---

## The Authority Model (Never Deviate From This)

```
TIER 0: COORDINATOR (singleton)
  │  Authority: spawn Tier 1, write global task graph, signal task completion
  │  Context: reads/writes top-level task context namespace
  │
  ├─ TIER 1: PROJECT_MANAGER (one per work stream)
  │    │  Authority: spawn Tier 2 within work stream, error recovery within stream
  │    │  Context: reads/writes work-stream context namespace
  │    │
  │    ├─ TIER 2: DATA_RESEARCHER
  │    ├─ TIER 2: SWE
  │    ├─ TIER 2: UX_DESIGNER
  │    ├─ TIER 2: UI_ENGINEER
  │    ├─ TIER 2: QA_ENGINEER
  │    └─ TIER 2: PLANNER
  │         Authority: NONE — no spawning. Pure execution workers.
  │         Context: reads/writes ONLY their assigned namespace
  │
  └─ TIER 3: RUNTIME_GENERATED (synthesized on demand)
       Authority: none beyond their RuntimeAgentSpec
       Context: reads/writes ONLY their contextNamespace field
       Parent: must be Tier 0 or Tier 1
       TTL: enforced — GC'd when TTL expires
```

---

## The Communication Law

**Agents NEVER communicate directly with each other.**

All A2A communication is mediated by the Nerve Center's Event Bus. This is a hard architectural invariant — not a suggestion.

```
Agent A ──(publish A2AMessage)──► Nerve Center Event Bus
                                       │ (log to Ledger)
                                       │ (route to topic)
                                       ▼
                              Agent B's input queue
```

**Why this is non-negotiable:**
1. No message goes unlogged.
2. No message bypasses policy enforcement.
3. Agents can be suspended or substituted without the sender knowing.

---

## Context Namespace Rules

Each agent has a `contextNamespace` string that defines the exact key prefix it may read/write.

| Agent | Namespace pattern | Can read other namespaces? |
|---|---|---|
| Coordinator | `task:{taskId}` | YES — all namespaces in the task |
| Project Manager | `task:{taskId}/stream:{streamId}` | Only its own stream + task root |
| Tier 2 Specialists | `task:{taskId}/stream:{streamId}/agent:{agentId}` | Their own namespace only |
| Runtime Generated | As specified in `RuntimeAgentSpec.contextNamespace` | Their namespace only |

**If a Tier 2 agent tries to write to another stream's namespace** → Nerve Center rejects the context mutation and emits a `TASK_CONTEXT_NAMESPACE_VIOLATION` error event.

---

## Behavioral Constraints Every Agent Must Declare

When scaffolding a new agent, ALWAYS declare explicit negative constraints in the `behavioralConstraints` array. These are written to the agent's system prompt.

**Universal constraints (all agents must include):**
```typescript
[
  'Never emit A2A messages directly to another agent — always route through the Event Bus.',
  'Never read or write context outside your assigned namespace.',
  'Never invoke a tool not listed in your active ToolBinding list.',
  'Never claim to have executed an action you did not actually execute.',
  'Always emit a structured result object matching your declared output content type.',
]
```

**Tier 0/1 specific:**
```typescript
[
  'Do not perform Tier 2 specialist work directly — delegate to the appropriate specialist agent.',
  'When a subtask fails, attempt recovery within your authority before escalating.',
]
```

**Tier 2 specific:**
```typescript
[
  'Do not spawn subagents — escalate to your parent Project Manager if you cannot complete the task.',
  'Do not issue orchestration directives of any kind.',
]
```

---

## Message Priority Rules

| Priority | When to use | Queue behavior |
|---|---|---|
| `NORMAL` | All regular A2A communication | Processed in FIFO order |
| `HIGH` | Time-sensitive responses (e.g., QA blocking the build pipeline) | Front of queue |
| `INTERRUPT` | Operator directives only | Bypasses queue entirely — synchronous delivery |

**Only the Command Center (operators) may issue INTERRUPT priority messages.** Agents that attempt to set `priority: 'INTERRUPT'` will have the message rejected by the Nerve Center.

---

## Tool Authorization Decision

When deciding which tools an agent should have access to:

1. **Minimum necessary access** — agents should only have the tools required to complete their role.
2. **Tool bindings are per-agent-instance**, not per-agent-type — the same agent type can have different tool sets for different tasks.
3. **The Nerve Center enforces tool authorization** — the agent cannot "try" a tool it's not bound to. The call will be rejected.
4. **Tool call depth** — each `ToolBinding` has a `maxCallDepth`. Agents that loop on tool calls are hard-stopped at this limit.

---

## Runtime Agent Spec Checklist

When generating a `RuntimeAgentSpec`, verify:

- [ ] `specVersion` matches current `packages/shared` SemVer
- [ ] `agentId` is a fresh UUID (not reused)
- [ ] `persona.behavioralConstraints` includes at minimum the universal constraints listed above
- [ ] `tools` contains ONLY tools from the current MCP registry
- [ ] `contextNamespace` is scoped correctly (child of the parent's namespace)
- [ ] `parentAgentId` is a Tier 0 or Tier 1 agent (never another Tier 2 or runtime agent)
- [ ] `maxTokenBudget` is set (no unbounded agents)
- [ ] `ttl` is set (no permanent runtime agents)

---

## Cascade Failure Prevention

The reason all agent communication is mediated and all agents are isolated processes:

- A Tier 2 agent crash MUST NOT affect: the Nerve Center, sibling agents, or the Coordinator.
- The Project Manager is responsible for detecting the crash (via `AGENT_STATE_CHANGED` event with state `ERROR`) and either retrying or escalating.
- The Coordinator is the last line of defense — it can terminate the entire work stream if recovery fails.

**Never** put recovery logic in the Nerve Center itself. The Nerve Center is policy-free.
