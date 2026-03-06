---
description: how to debug an agent execution issue using the Global Execution Ledger
---

# Debugging an Agent Execution Issue

Use this workflow when an agent behaves unexpectedly, produces incorrect output,
gets stuck, or triggers a cascade failure. The Global Execution Ledger is the
primary debugging tool — all answers are in the event stream.

See `docs/ARCHITECTURE.md §3.3` for the Ledger schema.

## Steps

1. **Get the task ID**
   - From the Command Center UI: click the stuck/failed agent → copy `taskId` from the inspector.
   - From logs: `grep "taskId" apps/backend/logs/*.log | grep <agent-name>`

2. **Query the full event stream for the task**
   ```sql
   SELECT
     event_id, event_type, agent_id, sequence_num, causation_id,
     payload, metadata, created_at
   FROM execution_events
   WHERE task_id = '<task-id>'
   ORDER BY sequence_num ASC;
   ```

3. **Identify the last successful event before the failure**
   - Look for the last `TOOL_CALL_COMPLETED`, `A2A_MESSAGE_DELIVERED`, or `CONTEXT_MUTATED` event.
   - The event immediately after this is where the problem started.

4. **Trace the causation chain**
   ```sql
   -- Follow the causation chain from the failure event backwards
   WITH RECURSIVE causation_chain AS (
     SELECT event_id, event_type, agent_id, causation_id, payload, created_at
     FROM execution_events
     WHERE event_id = '<failure-event-id>'
     UNION ALL
     SELECT e.event_id, e.event_type, e.agent_id, e.causation_id, e.payload, e.created_at
     FROM execution_events e
     JOIN causation_chain c ON e.event_id = c.causation_id
   )
   SELECT * FROM causation_chain ORDER BY created_at ASC;
   ```

5. **Check for SCHEMA_VIOLATION events**
   ```sql
   SELECT * FROM execution_events
   WHERE task_id = '<task-id>'
   AND event_type = 'SCHEMA_VIOLATION'
   ORDER BY created_at ASC;
   ```
   Schema violations mean an agent sent a message that didn't conform to `packages/shared` types.
   The payload will contain the validation error details.

6. **Inspect the agent's context at the point of failure**
   - Find the last `CONTEXT_MUTATED` event before the failure.
   - The `payload.diff` field shows what was written to the context namespace.
   - Check if the agent had access to information it needed.

7. **Check token budget and tool call depth**
   ```sql
   SELECT
     SUM((metadata->>'totalTokens')::int) as total_tokens,
     MAX((metadata->>'maxCallDepth')::int) as max_call_depth
   FROM execution_events
   WHERE task_id = '<task-id>' AND agent_id = '<agent-id>';
   ```
   If `total_tokens` approaches `maxTokenBudget` or `maxCallDepth` is exceeded, resource limits are the cause.

8. **Check for INTERRUPT events**
   ```sql
   SELECT * FROM execution_events
   WHERE task_id = '<task-id>'
   AND event_type IN ('INTERRUPT_ISSUED', 'INTERRUPT_APPLIED', 'INTERRUPT_REJECTED');
   ```

9. **Reproduce in isolation**
   - If the issue is in the agent's system prompt or tool handling, extract the exact
     context window from the ledger and replay it locally against the LLM directly.

10. **Fix and verify**
    - If the bug is in a system prompt → update prompt, write/update prompt regression test.
    - If the bug is in a Zod schema → run `add-shared-type` workflow for the fix.
    - If the bug is in agent lifecycle → fix in `apps/backend/src/lifecycle/` and write a contract test.
    - Run: `turbo run test:unit test:contract --filter=apps/backend`
