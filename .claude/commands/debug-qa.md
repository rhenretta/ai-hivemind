# Debugging QA Failures

> Diagnose why QA failed for a feature request using the event ledger.

Use this workflow when a feature request's QA phase fails repeatedly, produces
false negatives, or exhibits known anti-patterns. The event ledger at
`apps/backend/data/ledger.db` is the single source of truth.

## Database Reference

- **Path:** `apps/backend/data/ledger.db` (SQLite, WAL mode)
- **Table:** `ledger`
- **Columns:** `seq` (auto PK), `eventId`, `timestamp`, `eventType`, `sourceId`, `targetId`, `traceId`, `payload` (JSON)
- **Indexes:** `traceId`, `eventType`
- **traceId** groups all events for one feature request

## Steps

1. **List recent features with QA stats**

   ```sql
   SELECT
     l.traceId,
     MIN(l.timestamp) as started,
     json_extract(u.payload, '$.originalText') as request,
     COUNT(*) as qa_rounds,
     COUNT(CASE WHEN json_extract(l.payload, '$.passed') = 1 THEN 1 END) as passed,
     COUNT(CASE WHEN json_extract(l.payload, '$.passed') = 0 THEN 1 END) as failed
   FROM ledger l
   LEFT JOIN ledger u ON u.traceId = l.traceId
     AND u.eventType = 'USER_COMMAND'
     AND u.seq = (SELECT MIN(seq) FROM ledger WHERE traceId = l.traceId AND eventType = 'USER_COMMAND')
   WHERE l.eventType = 'QA_VERDICT'
   GROUP BY l.traceId
   ORDER BY started DESC
   LIMIT 10;
   ```

   Pick the `traceId` you want to investigate.

2. **Show the QA timeline for that feature**

   ```sql
   SELECT
     timestamp,
     eventType,
     sourceId,
     CASE
       WHEN eventType = 'QA_VERDICT' THEN
         'passed=' || json_extract(payload, '$.passed') ||
         ' issues=' || COALESCE(json_extract(payload, '$.issues'), '[]')
       WHEN eventType = 'STATE_CHANGED' THEN
         COALESCE(json_extract(payload, '$.phase'), '') || ': ' ||
         substr(COALESCE(json_extract(payload, '$.message'), ''), 1, 150)
       WHEN eventType = 'ERROR' THEN
         substr(COALESCE(json_extract(payload, '$.message'), json_extract(payload, '$.error')), 1, 150)
       ELSE substr(payload, 1, 100)
     END as detail
   FROM ledger
   WHERE traceId = '<TRACE_ID>'
     AND eventType IN ('STATE_CHANGED', 'QA_VERDICT', 'ERROR', 'TASK_NODE_COMPLETED')
   ORDER BY seq ASC;
   ```

   This shows the full lifecycle: research → design → SWE implement → QA validate → retry loop.

3. **Inspect failed QA verdicts in detail**

   ```sql
   SELECT
     timestamp,
     sourceId,
     json_extract(payload, '$.passed') as passed,
     json_extract(payload, '$.summary') as summary,
     json_extract(payload, '$.issues') as issues,
     json_extract(payload, '$.warnings') as warnings,
     json_extract(payload, '$.stepsToReproduce') as steps,
     json_extract(payload, '$.testPlan') as test_plan
   FROM ledger
   WHERE traceId = '<TRACE_ID>'
     AND eventType = 'QA_VERDICT'
   ORDER BY seq ASC;
   ```

   Read each verdict chronologically. On retries, compare issues across rounds —
   if issues change completely between rounds, that's **test plan drift**.

4. **Check what SWE built (the artifact QA was testing)**

   ```sql
   SELECT
     timestamp,
     sourceId,
     substr(json_extract(payload, '$.message'), 1, 300) as message
   FROM ledger
   WHERE traceId = '<TRACE_ID>'
     AND eventType = 'STATE_CHANGED'
     AND sourceId LIKE 'swe-agent%'
   ORDER BY seq ASC;
   ```

   The final SWE STATE_CHANGED before each QA run describes what was built/fixed.

5. **Check what port QA was testing on**

   ```sql
   SELECT
     timestamp,
     sourceId,
     json_extract(payload, '$.url') as url,
     json_extract(payload, '$.port') as port,
     payload
   FROM ledger
   WHERE traceId = '<TRACE_ID>'
     AND eventType = 'SERVICE_DEPLOYED'
   ORDER BY seq ASC;
   ```

   Compare deployed ports against URLs in QA verdict issues. Mismatches indicate **port confusion**.

6. **Check for QA tool calls (what QA actually did)**

   ```sql
   SELECT
     timestamp,
     sourceId,
     json_extract(payload, '$.tool') as tool,
     substr(json_extract(payload, '$.input'), 1, 200) as input,
     substr(json_extract(payload, '$.output'), 1, 200) as output
   FROM ledger
   WHERE traceId = '<TRACE_ID>'
     AND eventType = 'TOOL_USED'
     AND sourceId LIKE 'qa-engineer%'
   ORDER BY seq ASC;
   ```

   Look for: http_get to wrong endpoints, browser_wait_for with low timeouts,
   execute_cli_command with regex-based content checks.

7. **Check arbiter decisions (intelligent retry routing)**

   ```sql
   SELECT
     timestamp,
     sourceId,
     json_extract(payload, '$.decision') as decision,
     json_extract(payload, '$.reasoning') as reasoning,
     substr(json_extract(payload, '$.sweFeedback'), 1, 200) as swe_feedback,
     substr(json_extract(payload, '$.qaGuidance'), 1, 200) as qa_guidance,
     json_extract(payload, '$.updatedAcceptanceCriteria') as updated_criteria,
     json_extract(payload, '$.userQuestion') as user_question
   FROM ledger
   WHERE traceId = '<TRACE_ID>'
     AND eventType = 'QA_ARBITER_DECISION'
   ORDER BY seq ASC;
   ```

   The arbiter runs after each QA failure to decide: `retry` (with refined feedback),
   `ask_user` (escalate to user), or `accept` (override QA). Check if:
   - The arbiter correctly detected test plan drift and refined acceptance criteria
   - The arbiter provided useful SWE feedback vs. just forwarding raw QA issues
   - The arbiter escalated to the user when it should have retried (or vice versa)

8. **Classify the failure against known anti-patterns**

   After reviewing the data, classify each failed verdict:

   | Anti-Pattern | Signal |
   |---|---|
   | **Test plan drift** | Issues change completely between retry rounds; QA invents requirements not in acceptance criteria (e.g., demands `score` field, `sentiment` field) |
   | **Wrong endpoint** | QA tests `/api/reddit` when SWE built `/api/reddit/posts`; 404 errors on valid implementations |
   | **Port confusion** | QA tests on hardcoded port (3001) instead of dynamic sandbox port shown in SERVICE_DEPLOYED |
   | **Protocol violation** | Verdict summary contains "QA wrote prose instead of JSON (inferred FAIL)" |
   | **Over-strict judgment** | QA flags benign content as violating filters (e.g., `technology` subreddit = "political") |
   | **Timeout miscalibration** | browser_wait_for with low timeout_ms for external API data; "Loading" spinner reported as failure |
   | **Selector guessing** | browser_wait_for or browser_click on CSS selectors like `.post-card`, `[class*="loading"]` that don't exist in the actual DOM |
   | **Semantic regression** | QA uses jq/grep/regex to validate content quality instead of reasoning about it |

9. **If the failure is a QA bug, an arbiter misjudgment, or not a real implementation issue**

   - **QA bugs:** Fix in `apps/backend/src/agents/qaEngineer.ts` in `buildQaSystemPrompt()`.
     Key sections: ACCEPTANCE CRITERIA RULE, STABILITY RULE, SEMANTIC VALIDATION RULE,
     TIMEOUT RETRY RULE, Endpoint inference logic.

   - **Arbiter misjudgments:** Fix in `apps/backend/src/agents/projectManager.ts` in `#runArbiter()`.
     The arbiter system prompt defines how it evaluates attempt history, detects drift,
     and decides retry/ask_user/accept.

   After updating the prompt, test by re-running the feature request.
