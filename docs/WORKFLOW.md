# WORKFLOW: Engineering Rules of Engagement

> **Version:** 0.1.0 — Foundational  
> **Status:** Living Document  
> **Audience:** All Contributors  
> **Last Updated:** 2026-03-03

---

## 0. Philosophy

This document defines **how we work**. Monorepo velocity is destroyed not by build tools but by **undisciplined boundaries** — shared code that grows without contracts, CI that nobody trusts, and reviews that optimize for speed over correctness. Every rule in this document exists to prevent a specific class of damage. When a rule feels bureaucratic, re-read its rationale.

---

## 1. Monorepo Tooling: Turborepo

### 1.1 Why Turborepo

Turborepo provides **intelligent task orchestration with caching** — not just parallelism, but the elimination of redundant work across the workspace. Key properties we rely on:

- **Remote caching:** Build artifacts are cached by input hash, not timestamp. `turbo build` on a clean CI machine is fast if the code hasn't changed.
- **Dependency graph:** Turborepo understands that `apps/web` depends on `packages/ui` which depends on `packages/shared`. It rebuilds only what's affected.
- **Pipeline as code:** The `turbo.json` at the repo root is the authoritative definition of how tasks compose. There are no hidden build scripts.

### 1.2 Task Pipeline Conventions

All Turbo tasks must be declared in `/turbo.json` before they can be relied upon in CI. The pipeline is the **contract** between packages.

```json
// turbo.json — excerpt showing pipeline conventions
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],   // Build dependencies first (^)
      "outputs": ["dist/**", ".next/**"]
    },
    "test": {
      "dependsOn": ["build"],    // Test requires current package built
      "outputs": [],
      "cache": false             // Tests are never cached — always run
    },
    "test:unit": {              // Scoped test variant — cacheable by input
      "dependsOn": ["build"],
      "outputs": ["coverage/**"],
      "inputs": ["src/**", "test/**"]
    },
    "lint": {
      "outputs": [],
      "inputs": ["src/**", "*.ts", "*.tsx", "*.js"]
    },
    "type-check": {
      "dependsOn": ["^build"],
      "outputs": []
    }
  }
}
```

**Rule:** Never add `"cache": false` without a code comment explaining why. Disabling cache has a real cost that must be justified.

### 1.3 Running Tasks

```bash
# Run a task across all packages (respects dependency graph)
turbo run build
turbo run test
turbo run lint

# Run a task scoped to a single package
turbo run build --filter=apps/web
turbo run test --filter=packages/shared

# Run multiple tasks concurrently
turbo run build lint type-check

# Watch mode during development (only for apps, not packages)
turbo run dev --filter=apps/web --filter=apps/backend
```

**Critical:** Never run `npm run build` or `yarn build` directly in a package directory during CI. Always use `turbo run` so the dependency graph is respected and caches are populated correctly.

---

## 2. packages/shared — The Contract Layer

`packages/shared` is the **most important package in the repository**. It is the only place where data structures that cross service boundaries are defined. This makes it the riskiest package to change carelessly.

### 2.1 What Lives in packages/shared

**Mandatory contents (must not live elsewhere):**

| Category | Examples |
|---|---|
| **Event types and enums** | `EventType`, `AgentLifecycleState`, `MessageRole`, `MessagePriority` |
| **A2A message schema** | `A2AMessage`, `MessageContentType`, all content type payload schemas |
| **Agent specifications** | `RuntimeAgentSpec`, `AgentPersona`, `ToolBinding` |
| **Ledger schemas** | `LedgerEvent`, `EventMetadata` |
| **Interrupt protocol types** | `InterruptDirective`, `InterruptResult` |
| **API request/response contracts** | All types used in REST or WebSocket API surfaces |
| **Error taxonomy** | `ControlPlaneError`, `AgentError`, error code enums |

**Forbidden contents (must never live in packages/shared):**

- Business logic of any kind. `packages/shared` is a types-only package.
- Runtime dependencies other than `zod` for schema validation.
- Anything that imports from `apps/*` or other `packages/*`.

### 2.2 Versioning Protocol

`packages/shared` follows **strict SemVer** with the following interpreted semantics:

| Change Type | Version Bump | Governance |
|---|---|---|
| New type or enum value added | MINOR | PR required, no special approval |
| Existing type field added (optional) | MINOR | PR required, migration notes mandatory |
| Existing type field changed (type or constraint) | **MAJOR** | RFC required (see §2.3), migration path documented |
| Existing type field removed | **MAJOR** | RFC required, deprecation period mandatory |
| Enum value removed | **MAJOR** | RFC required |
| Bug fix (non-behavioral schema change) | PATCH | PR required |

**The `schemaVersion` field on all cross-boundary messages must always match the SemVer of `packages/shared`.** The Nerve Center validates this on every incoming message. If validation fails, the message is rejected and a `SCHEMA_VIOLATION` event is written to the ledger.

### 2.3 RFC Process for Breaking Changes

Any MAJOR version bump to `packages/shared` requires:

1. **An RFC document** filed as `/docs/rfcs/NNNN-change-summary.md` (using the next sequential RFC number).
2. The RFC must specify: the old schema, the new schema, the migration path for all consumers, and the deprecation timeline.
3. A minimum **2-business-day review period** before merge, with explicit approvals from at least one maintainer of each consuming service (`apps/web`, `apps/backend`, `apps/sandbox`).
4. The breaking change must be merged in a separate PR from any consumer updates, so the migration can be audited independently.

### 2.4 The Zod Validation Discipline

All types in `packages/shared` that cross a network boundary **must** have a corresponding Zod schema. TypeScript types are compile-time only; Zod schemas provide runtime validation.

```typescript
// Pattern: co-locate schema and type
// packages/shared/src/types/agent.ts

import { z } from 'zod';

export const ToolBindingSchema = z.object({
  toolName:      z.string().min(1),
  versionRange:  z.string().regex(/^\d+\.\d+\.\d+$/),
  maxCallDepth:  z.number().int().min(1).max(100),
  paramOverrides: z.record(z.unknown()).optional(),
});

// Derive the TypeScript type from the Zod schema — single source of truth
export type ToolBinding = z.infer<typeof ToolBindingSchema>;
```

**Rule:** If a type has a Zod schema, the type annotation (`type ToolBinding = ...`) must be derived from the schema via `z.infer<typeof Schema>`, **never** defined independently. Type and schema must be consistent by construction.

---

## 3. CI/CD Philosophy

### 3.1 The CI Contract

CI is a **quality gate**, not a formality. The following invariants are **non-negotiable**:

1. **CI must pass before any PR is merged.** No exceptions. Not for "trivial" changes. Not for hotfixes. The only exception is a P0 incident declared by a principal engineer, which must be logged.
2. **A failing CI suite is the highest-priority work for the team.** A broken main branch blocks every other engineer. It is treated as a P1 incident.
3. **CI must be deterministic.** A test that passes 90% of the time is a broken test. Flaky tests are immediately quarantined (moved to a non-blocking suite and assigned to the author's next sprint).

### 3.2 CI Pipeline Stages

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CI PIPELINE (GitHub Actions)                  │
├───────────────┬────────────────┬──────────────────┬───────────────── │
│  STAGE 1      │  STAGE 2       │  STAGE 3         │  STAGE 4         │
│  Fast Checks  │  Build         │  Test            │  Integration     │
│  (~2 min)     │  (~5 min)      │  (~10 min)       │  (~15 min)       │
│               │                │                  │                  │
│  • ESLint     │  • turbo build │  • turbo test:   │  • E2E tests     │
│  • Prettier   │    (affected)  │    unit          │    (Playwright)  │
│  • Type-check │  • Check for   │    (affected)    │  • API contract  │
│  • packages/  │    unused deps │  • Coverage      │    tests         │
│    shared     │                │    gate (>80%)   │  • Sandbox smoke │
│    Zod parity │                │                  │    tests         │
└───────────────┴────────────────┴──────────────────┴──────────────────┘
```

**Stage gates:** Each stage must pass before the next begins. Stage 1 runs on every commit to every branch. Stages 2–4 run on PRs targeting `main` and on pushes to `main`.

### 3.3 Linting Rules

ESLint config is defined at the repo root in `.eslintrc.js` and **cannot be overridden** at the package level except to add rules (never to disable existing ones).

**Immutable core rules:**

```javascript
// These rules may NEVER be disabled via eslint-disable comments
// Any PR disabling these rules will be rejected in review.
const IMMUTABLE_RULES = [
  'no-explicit-any',              // TypeScript: no `any` escapes
  'no-unsafe-assignment',         // TypeScript: unsafe any assignments
  'no-unsafe-member-access',      // TypeScript: unsafe member access on any
  '@typescript-eslint/strict-boolean-expressions', // No implicit truthiness
  'no-console',                   // Use structured logger, not console.*
  'import/no-cycle',              // No circular imports — ever
];
```

**Rule:** `// eslint-disable` comments for any immutable rule will cause the PR to fail review. The correct fix is to write code that satisfies the rule.

**Disabling non-immutable rules** is permitted with a `// eslint-disable-next-line [rule] -- [reason]` comment. The `-- [reason]` justification is mandatory. PRs with `// eslint-disable` comments (without reason) will be flagged in review.

### 3.4 Prettier Configuration

Prettier is run as a **formatter, not a linter**. It runs pre-commit (via Husky + lint-staged) and in CI. PRs with unformatted code fail CI at Stage 1.

Root `.prettierrc` is **non-negotiable** — no per-package overrides.

### 3.5 Test Philosophy

**Unit Tests** (`test:unit`)
- Test pure functions and isolated logic.
- No network calls, no filesystem I/O, no database connections.
- Must run in under 5 seconds per file.
- Coverage gate: 80% line coverage across `packages/*`, 70% across `apps/*`.
- Framework: Vitest (fast, TypeScript-native, compatible with Turborepo caching).

**Contract Tests** (`test:contract`)
- Verify that the actual runtime behavior of services conforms to the types in `packages/shared`.
- Run against a real (test-environment) Nerve Center instance.
- Every A2A message type has a contract test that sends a valid payload and an invalid payload, asserting correct acceptance/rejection behavior.
- **These tests are the primary regression guard for `packages/shared` changes.**

**Agent Prompt Tests** (`test:prompts`)
- A specialized test category unique to this project.
- Each built-in agent's system prompt has a test suite that:
  1. Submits a representative input.
  2. Asserts that the output conforms to the expected `contentType` schema.
  3. Asserts that specific behavioral invariants hold (e.g., Coordinator never generates code, SWE never emits orchestration directives).
- These tests run against the real LLM API (gated behind a `--integration` flag in CI to control cost). They are **always** run before any agent prompt changes are merged.

**E2E Tests** (`test:e2e`)
- Playwright-based.
- Verify critical operator workflows in the Command Center UI.
- Coverage: task submission flow, live event stream rendering, interrupt console issuance, iframe sandbox rendering.
- Run against a fully deployed test environment (not a local mock).

### 3.6 PR Review Rules

**Mandatory for all PRs:**

| Check | Rule |
|---|---|
| **Self-review** | Author must review their own diff before requesting review. No "WIP" PRs against `main`. |
| **PR size** | Soft limit: 400 lines changed. Hard limit: 1000 lines. Larger PRs must include a written justification in the PR body. |
| **PR description** | Must include: What changed, Why it changed, How it was tested, Any migration steps required. |
| **Linked issue** | Every PR must reference a GitHub Issue or a documented work item. No orphan code. |
| **One reviewer minimum** | At least one non-author approval required. |
| **packages/shared changes** | Require approval from **all service owners** (see §2.3). |
| **No force-push to main** | Git history on `main` is immutable. Use `git merge` or `git revert`. |

**Reviewer responsibilities:**

Reviewers are **co-owners** of the code they approve. Approving a PR means you have verified:
1. The logic is correct and the tests are meaningful (not just present).
2. The change does not violate architectural boundaries (see ARCHITECTURE.md).
3. The change does not introduce a circular dependency.
4. If `packages/shared` is modified, the version bump is correct and the RFC (if required) is complete.

---

## 4. Branching Strategy

```
main           ──●──────────────────────────────────────────────●── (protected)
                  │                                            ↑
feature/NNN-xxx   └──●──●──●──●── (squash merge after CI pass)┘
```

**Rules:**

- `main` is **always deployable**. It is protected: no direct pushes, CI must pass, at least one approval required.
- All work happens on short-lived `feature/NNN-xxx` branches, where `NNN` is the issue number.
- Branches are **squash-merged** into `main` to maintain a linear, readable history.
- Feature branches must be rebased onto `main` before merging (no stale merge commits).
- `hotfix/*` branches may be merged directly to `main` in P0 incidents; this **must** be followed by a post-mortem within 24 hours.

---

## 5. Package Management

**Package manager:** `pnpm` with `pnpm-workspace.yaml`.

**Rule:** `npm` and `yarn` are prohibited in this repository. `pnpm` is the only installed package manager. Commits modifying `package-lock.json` or `yarn.lock` will be rejected.

**Dependency governance:**

| Category | Rule |
|---|---|
| **Adding a new dependency** | Requires PR approval; must not duplicate functionality already provided by an existing dep; must have an active maintenance history. |
| **Adding to packages/shared** | Only `zod` and types-only packages (no runtime code) are permitted. |
| **Pinning vs. ranges** | All production dependencies in `apps/*` are pinned to exact versions. `packages/*` use `^` ranges to be composable. |
| **Auditing** | `pnpm audit` runs in CI (Stage 1). High+ severity vulnerabilities that have patches available will fail CI. |

---

## 6. Environment and Secrets Management

- All secrets are stored in environment variables.
- `.env` files are **never committed** (enforced by `.gitignore` and a pre-commit hook).
- Local development uses `.env.local` files.
- CI secrets are stored in GitHub Actions encrypted secrets.
- Production secrets are managed by the deployment platform's secret store (Kubernetes Secrets + external secrets operator in production).
- Any file containing secrets (even example files) must use `.env.example` naming with placeholder values only.

---

## 7. Commit Message Convention

We use **Conventional Commits** (`conventionalcommits.org`) enforced by `commitlint` on every commit (via Husky).

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build`.

Valid scopes: `web`, `backend`, `sandbox`, `shared`, `ui`, `docs`, `infra`.

**Examples:**
```
feat(backend): add interrupt vector handler to WebSocket gateway
fix(shared): correct ToolBinding version range regex to allow semver wildcards
docs(arch): add sequence diagram for agent interrupt flow
chore(ci): add pnpm audit to stage 1 pipeline
```

Commit messages that do not conform to this convention **fail the pre-commit hook** and cannot be pushed.

---

*Every rule in this document has a cost. That cost is paid in discipline. The benefit is a codebase that scales with the team and remains navigable five years from now. Resist the temptation to shortcut. The shortcuts always compound.*
