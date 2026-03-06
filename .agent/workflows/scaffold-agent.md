---
description: how to scaffold a new built-in agent (Tier 0, 1, or 2) in the system
---

# Scaffolding a New Built-In Agent

Use this workflow when adding a new built-in agent to the Nerve Center's roster.
For runtime-generated agents (defined dynamically via `RuntimeAgentSpec`), no scaffolding
is needed — they are synthesized at runtime.

See `docs/ARCHITECTURE.md §2` for the agent tier definitions and authority model.

// turbo-all

## Steps

1. **Determine the tier**
   - Tier 0 (Coordinator): singleton per swarm, sovereign authority — only one exists.
   - Tier 1 (Project Manager): one per work stream, spawned by Coordinator.
   - Tier 2 (Specialist): pure execution workers — DATA_RESEARCHER, SWE, UX_DESIGNER, UI_ENGINEER, QA_ENGINEER, PLANNER.
   - If none of these fit the use case, the agent should probably be a runtime-generated agent.

2. **Add the agent type to packages/shared** (MINOR bump — run `add-shared-type` workflow)
   - Add the new type to the `BuiltInAgentTypeSchema` enum in `packages/shared/src/types/agent.ts`.
   - Bump `packages/shared` minor version.

3. **Create the agent definition file**
   - Path: `apps/backend/src/agents/<tier>/<agent-type>/index.ts`
   - The agent definition includes:
     - `persona: AgentPersona` — name, description, behavioral constraints, output content types
     - `defaultTools: ToolBinding[]` — the default tool set (overridable per-task)
     - `systemPrompt: string` — the base system prompt
     - `contextNamespacePolicy: 'READ_OWN' | 'READ_ALL_IN_WORKSTREAM'` — what context the agent can read

4. **Define behavioral constraints explicitly**
   ```ts
   // Every agent MUST define what it is NOT allowed to do
   const behavioralConstraints = [
     'NEVER emit orchestration directives — only the Coordinator and PM may spawn agents.',
     'NEVER read or write context outside your assigned namespace.',
     'NEVER call tools not in your ToolBinding list.',
     // Add agent-specific constraints...
   ];
   ```

5. **Register the agent with the Agent Lifecycle Manager**
   - Add it to the registry in `apps/backend/src/lifecycle/agent-registry.ts`.
   - Define the spawn parameters: max instances, allowed parent tiers, resource limits.

6. **Write prompt tests**
   - Test file: `apps/backend/test/prompts/<agent-type>.prompt.test.ts`
   - Required test cases:
     - Happy path: representative input → valid output schema
     - Behavioral constraints: trigger scenarios where the agent should refuse to act
     - Output content type: assert the agent only produces its declared content types

7. **Add telemetry labels**
   - Ensure the agent sets its `agentType` field correctly in all emitted events.
   - Verify events appear correctly filtered in the Command Center.

8. **Run tests**
   ```bash
   turbo run test:unit test:contract --filter=apps/backend
   ```

9. **Update ARCHITECTURE.md if the agent hierarchy changes**
   - The agent hierarchy table in `docs/ARCHITECTURE.md §2.3` must stay current.

10. **Run `/complete-phase` checklist — MANDATORY**

    Before marking this agent complete, run the `complete-phase` workflow.
    If scaffolding this agent revealed any non-obvious patterns in the agent registration
    flow, authority rules, or tool binding — update `agent-hierarchy-rules` skill now.
