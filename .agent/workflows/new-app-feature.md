---
description: how to scaffold and implement a new feature across apps in the monorepo
---

# Implementing a New App Feature

Use this workflow when implementing a feature that touches one or more apps
(`apps/web`, `apps/backend`, `apps/sandbox`) and potentially `packages/shared`.

// turbo-all

## Steps

1. **Check if new shared types are needed**
   - If the feature introduces new cross-boundary data structures, run `add-shared-type` workflow first.
   - Never define cross-boundary types inside `apps/*`. They belong in `packages/shared`.

2. **Identify which apps are affected**
   - Backend (Nerve Center): WebSocket gateway, Event Bus, Ledger, Agent Lifecycle, MCP Registry, Interrupt handler
   - Web (Command Center): Zustand stores, React components, D3 topology, WebSocket client router
   - Sandbox: Container orchestration, sandbox lifecycle, CLI telemetry capture

3. **Backend: implement the feature**
   - All A2A messages must be validated via Zod schemas from `packages/shared` at the Nerve Center boundary
   - Every new agent action or state change must emit a structured event to the ledger BEFORE publishing to the bus
   - New API endpoints must follow the REST convention in `apps/backend/src/routes/`
   - New WebSocket message types must be added to the event router in `apps/backend/src/ws/`

4. **Frontend: implement the feature**
   - New Zustand store atoms live in `apps/web/src/stores/`
   - New React components live in `apps/web/src/components/<module>/`
   - Shared, reusable UI primitives go in `packages/ui/src/` — not in `apps/web`
   - WebSocket event routing: add new `EventType` handlers to `apps/web/src/lib/ws/router.ts`

5. **Write unit tests**
   ```bash
   # Run after implementing
   turbo run test:unit --filter=apps/backend
   turbo run test:unit --filter=apps/web
   ```

6. **Write contract tests if a new API surface was added**
   - Contract tests live in `apps/backend/test/contract/`
   - Must test both valid and invalid payloads at every new endpoint

7. **Run full type-check**
   ```bash
   turbo run type-check
   ```

8. **Run lint**
   ```bash
   turbo run lint
   ```

9. **Build all affected packages**
   ```bash
   turbo run build
   ```

10. **Open a PR per app** (prefer one feature = one PR, but split if diff > 400 lines)
    - Format: `feat(<scope>): <description>` where scope is `web`, `backend`, or `sandbox`
    - Link to the GitHub issue
    - Include test evidence (test output or coverage delta)

11. **Run `/complete-phase` checklist — MANDATORY**

    Before marking this feature done, run the `complete-phase` workflow.
    This is not optional. Skipping it means lessons from this implementation are lost.

    Specifically: for every ESLint retry loop, config gotcha, or non-obvious pattern
    encountered during this feature, update the appropriate skill. If a new architectural
    pattern was established (new store shape, new hook convention, new API pattern),
    document it in `command-center-ui-patterns` or the relevant skill.
