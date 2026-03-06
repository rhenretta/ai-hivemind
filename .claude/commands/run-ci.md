# Running CI Locally

> How to run the CI pipeline locally before opening a PR.

Run the full CI pipeline locally before opening a PR to catch issues before they reach CI.
This mirrors the 4-stage GitHub Actions pipeline defined in `docs/WORKFLOW.md §3.2`.

## Stage 1: Fast Checks (~2 min)

Run these first — they catch the most common issues fastest.

```bash
# Lint the entire workspace
turbo run lint

# Format check (must pass — Prettier is non-negotiable)
pnpm format:check

# Type-check the entire workspace (respects dependency graph)
turbo run type-check
```

If any of these fail, fix them before proceeding. Do not open a PR with failing lints or type errors.

## Stage 2: Build

```bash
# Build all packages and apps (only affected by your changes)
turbo run build
```

Confirm that `packages/shared` builds before `apps/*` — Turborepo handles this via the `^build` dependency,
but check the output to verify ordering if something unexpected fails.

## Stage 3: Unit Tests

```bash
# Run unit tests with coverage
turbo run test:unit

# Check coverage output — gate is 80% for packages/*, 70% for apps/*
# Coverage reports are in: <package>/coverage/
```

## Stage 4: Integration / Contract Tests (optional locally)

These require a running test environment. Run only if you changed API surfaces or shared types.

```bash
# Contract tests — requires TEST_NERVE_CENTER_URL env var
TEST_NERVE_CENTER_URL=http://localhost:3001 turbo run test:contract

# E2E tests — requires TEST_BASE_URL env var
TEST_BASE_URL=http://localhost:3000 turbo run test:e2e
```

## Quick Check (for small changes)

For a targeted check on only the packages you changed:

```bash
# Example: only changed packages/shared and apps/backend
turbo run lint type-check test:unit --filter=packages/shared --filter=apps/backend
```

## Before Opening the PR

Run this final check to confirm everything is clean:

```bash
turbo run build lint type-check test:unit
```

All four commands must exit 0. If not, fix and re-run before opening the PR.
