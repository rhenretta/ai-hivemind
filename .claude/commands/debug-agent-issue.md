# Debugging an Agent Execution Issue

> How to debug an agent execution issue using the Global Execution Ledger.

Use this workflow when an agent behaves unexpectedly, produces incorrect output,
gets stuck, or triggers a cascade failure. The Global Execution Ledger is the
primary debugging tool — all answers are in the event stream.

## Database Reference

- **Path:** `apps/backend/data/ledger.db` (SQLite, WAL mode)
- **Table:** `ledger`
- **Columns:** `seq` (auto PK), `eventId`, `timestamp`, `eventType`, `sourceId`, `targetId`, `traceId`, `payload` (JSON)
- **Indexes:** `traceId`, `eventType`
- **traceId** groups all events for one feature request

## Steps

1. **Get the trace ID**
   - From the Command Center UI: click the stuck/failed agent → copy `traceId` from the inspector.
   - From the ledger: find the feature by its user command text (see step 2).

2. **Find the feature request**
   ```sql
   SELECT traceId, timestamp,
     json_extract(payload, '$.originalText') as request
   FROM ledger
   WHERE eventType = 'USER_COMMAND'
   ORDER BY timestamp DESC
   LIMIT 10;
   ```

3. **Query the full event stream for the feature**
   ```sql
   SELECT
     seq, eventId, eventType, sourceId, targetId, timestamp,
     substr(payload, 1, 200) as payload_preview
   FROM ledger
   WHERE traceId = '<trace-id>'
   ORDER BY seq ASC;
   ```

4. **Identify the last successful event before the failure**
   - Look for the last `TOOL_USED`, `STATE_CHANGED`, or `TASK_NODE_COMPLETED` event.
   - The event immediately after this is where the problem started.

5. **Get event counts by type for this feature**
   ```sql
   SELECT eventType, COUNT(*) as count
   FROM ledger
   WHERE traceId = '<trace-id>'
   GROUP BY eventType
   ORDER BY count DESC;
   ```

6. **Check for ERROR events**
   ```sql
   SELECT seq, timestamp, sourceId,
     json_extract(payload, '$.message') as message,
     json_extract(payload, '$.error') as error
   FROM ledger
   WHERE traceId = '<trace-id>'
     AND eventType = 'ERROR'
   ORDER BY seq ASC;
   ```

7. **Inspect agent lifecycle (spawn/terminate)**
   ```sql
   SELECT timestamp, eventType, sourceId,
     json_extract(payload, '$.role') as role,
     json_extract(payload, '$.agentId') as agentId,
     json_extract(payload, '$.message') as message
   FROM ledger
   WHERE traceId = '<trace-id>'
     AND eventType IN ('AGENT_SPAWNED', 'AGENT_TERMINATED')
   ORDER BY seq ASC;
   ```

8. **Check tool calls for a specific agent**
   ```sql
   SELECT timestamp,
     json_extract(payload, '$.tool') as tool,
     substr(json_extract(payload, '$.input'), 1, 200) as input,
     substr(json_extract(payload, '$.output'), 1, 200) as output
   FROM ledger
   WHERE traceId = '<trace-id>'
     AND eventType = 'TOOL_USED'
     AND sourceId LIKE '<agent-prefix>%'
   ORDER BY seq ASC;
   ```

9. **Check state transitions**
   ```sql
   SELECT timestamp, sourceId,
     json_extract(payload, '$.phase') as phase,
     substr(json_extract(payload, '$.message'), 1, 150) as message
   FROM ledger
   WHERE traceId = '<trace-id>'
     AND eventType = 'STATE_CHANGED'
   ORDER BY seq ASC;
   ```

10. **Reproduce in isolation**
    - If the issue is in the agent's system prompt or tool handling, extract the exact
      context window from the ledger and replay it locally against the LLM directly.

11. **Fix and verify**
    - If the bug is in a system prompt → update the prompt in `apps/backend/src/agents/`.
    - If the bug is in a Zod schema → run `/add-shared-type` workflow for the fix.
    - If the bug is in agent lifecycle → fix in `apps/backend/src/agents/baseAgent.ts`.
    - If the bug is QA-specific → use `/debug-qa` for targeted QA diagnosis.
    - Build to verify: `pnpm --filter @ai-hivemind/backend build`
