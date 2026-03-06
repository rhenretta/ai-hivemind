---
name: turborepo-operations
description: How Turborepo works in this monorepo — pipeline ordering, cache strategy, filtering, and adding new tasks
---

# Skill: Turborepo Operations

## When to Use This Skill

Load this skill whenever you are:
- Running or modifying build/test/lint tasks
- Adding a new package or app to the workspace
- Debugging a stale cache hit or unexpected task ordering
- Adding a new script that should participate in the Turborepo pipeline
- Setting environment variable dependencies for tasks

**After resolving any build/lint issue:** if you found a non-obvious fix (tsconfig gotcha,
ESLint rule, cache invalidation bug), add it to the Known Gotchas section before closing.
Run `/complete-phase` at the end of any implementation that touched Turborepo config.

---

## Core Mental Model

Turborepo's `turbo.json` defines a **task graph**, not a script runner. Understanding this distinction prevents common errors.

```
packages/shared build  ──────►  apps/backend build  ──────►  apps/backend test
                                                     
                         └──────►  apps/web build   ──────►  apps/web test
```

The `^` prefix in `dependsOn` means "all packages this package depends on via package.json". Without `^`, it means "this same package".

---

## Task Reference

| `turbo run <task>` | Caching | What it does |
|---|---|---|
| `build` | ✅ By input hash | Compiles all packages. Respects `^build` dependency order. |
| `dev` | ❌ Never | Dev servers with HMR. `persistent: true` — never finishes. |
| `lint` | ✅ By source inputs | ESLint across all `src/**/*.ts`. |
| `lint:fix` | ❌ Never | Mutates files — cannot be cached. |
| `type-check` | ✅ By source inputs | `tsc --noEmit`. Requires `^build` (needs upstream .d.ts). |
| `test` | ❌ Never | Full test suite. Tests must always run. |
| `test:unit` | ✅ By src+test inputs | Vitest unit tests. Coverage output cached. |
| `test:contract` | ❌ Never | Requires live environment. Needs env vars. |
| `test:e2e` | ❌ Never | Playwright. Needs live app. |
| `clean` | ❌ Never | Deletes dist/. Cannot be cached. |

---

## Filtering Syntax

```bash
# Single package
turbo run build --filter=packages/shared
turbo run build --filter=apps/web

# Multiple packages
turbo run test:unit --filter=packages/shared --filter=apps/backend

# Package and all its dependencies
turbo run build --filter=apps/web...

# Only affected packages (compared to main branch)
turbo run build --filter=[main]

# Exclude a package
turbo run lint --filter=!apps/sandbox
```

---

## Cache Rules

**When cache IS used (task reads from cache):**
- Task's `inputs` hash matches a previous run.
- All upstream dependency tasks also hit cache.

**When cache is BUSTED:**
- Any file in `inputs` patterns changed.
- Any `env` variable listed in the task changed.
- Any `globalEnv` variable changed.
- Upstream dependency task busted its cache.

**Adding environment variables to cache keys:**
```json
// turbo.json
{
  "pipeline": {
    "test:contract": {
      "cache": false,
      "env": ["TEST_NERVE_CENTER_URL", "TEST_API_KEY"]
    }
  }
}
```

**NEVER** cache a task that:
- Makes external network calls.
- Reads from a database.
- Depends on wall-clock time.
- Mutates files as a side effect.

---

## Adding a New App or Package

When adding `apps/my-new-app` or `packages/my-lib`:

1. Create the directory and `package.json` with `name: "@ai-hivemind/my-new-app"`.
2. Add `tsconfig.json` extending `../../tsconfig.json`.
3. Ensure all Turborepo task scripts are declared in `package.json` scripts:
   - `build`, `lint`, `type-check`, `test:unit`, `clean` are mandatory.
4. Add any new env vars needed to `turbo.json` `globalEnv` or the specific task's `env`.
5. Run `pnpm install` from the repo root to link the new workspace package.

**No edits to `turbo.json` pipeline are required** for new packages — the pipeline rules apply universally to all workspace packages.

---

## Remote Caching Setup

For team use, configure Turborepo remote cache (Vercel or self-hosted):

```bash
# Authenticate (one-time, per developer)
turbo login

# Link this repo to a remote cache
turbo link

# Verify cache hits are coming from remote
turbo run build --verbosity=2 | grep "remote cache"
```

Remote cache dramatically speeds up CI — a build with zero changes takes seconds instead of minutes.

---

## Debugging Pipeline Issues

```bash
# See what turbo WOULD run without running it (dry run)
turbo run build --dry-run

# See detailed graph output
turbo run build --graph

# Force run ignoring cache
turbo run build --force

# See why a task didn't hit cache
turbo run build --verbosity=2
```

---

## Package Manager: pnpm

```bash
# Install dependencies (from repo root)
pnpm install

# Add a dependency to a specific workspace package
pnpm add zod --filter=packages/shared

# Add a devDependency
pnpm add -D vitest --filter=apps/backend

# Add a workspace dependency
pnpm add @ai-hivemind/shared@"workspace:*" --filter=apps/backend

# Remove a dependency
pnpm remove some-package --filter=apps/web
```

**Never use `npm` or `yarn` in this repo.**

---

## Known Gotchas (Hard-Won Lessons)

### 1. Turbo v2: `pipeline` → `tasks`

Turbo v2.0 renamed the top-level key in `turbo.json` from `pipeline` to `tasks`.

```json
// ❌ WRONG — v1 syntax, fails with "Found pipeline field" error
{ "pipeline": { ... } }

// ✅ CORRECT — v2 syntax
{ "tasks": { ... } }
```

This repo uses Turbo v2.x — always use `tasks`.

---

### 2. Never use tsconfig `paths` to alias workspace packages to their src

When a package is installed via `workspace:*`, TypeScript should resolve it through
`node_modules` symlinks to the package's COMPILED `dist/` output. Using `paths` to
point directly at the workspace package's `src/` files causes TS6059 errors because
those files fall outside the consuming package's `rootDir`.

```json
// ❌ WRONG — violates rootDir when tsc walks the shared source tree
{
  "paths": {
    "@ai-hivemind/shared": ["../../packages/shared/src/index.ts"]
  }
}

// ✅ CORRECT — no paths needed; pnpm node_modules symlink handles resolution
// Just ensure packages/shared builds before apps/* (guaranteed by ^build in tasks)
```

---

### 3. Explicit type annotations needed for pnpm-hoisted Express exports

When exporting Express `app` from a module, the inferred type contains a
deep reference into pnpm's node_modules path that tsc can't portably name.
Always annotate explicitly:

```typescript
import express, { type Application } from 'express';

// ❌ WRONG — TS2742: inferred type cannot be named (pnpm path too deep)
export const app = express();

// ✅ CORRECT — explicit annotation resolves portable type
export const app: Application = express();
```

---

### 4. turbo filter syntax uses package names, not directory paths

```bash
# ❌ WRONG — package not found by path
turbo run build --filter=packages/shared

# ✅ CORRECT — use the name field from package.json
turbo run build --filter=@ai-hivemind/shared
```

---

### 5. Next.js `moduleResolution: bundler` Breaks `@typescript-eslint/parser`

Next.js 15 requires `moduleResolution: bundler` in `tsconfig.json`. The root `parserOptions.project` in `.eslintrc.js` points at each package's `tsconfig.json`. When the ESLint TypeScript parser encounters `moduleResolution: bundler`, it cannot properly resolve module types — every Zustand selector, socket.io import, and store call will appear as `error`-typed, causing cascades of false `no-unsafe-*` errors.

**Fix for any Next.js app added to this monorepo:**

1. Create `apps/<name>/tsconfig.eslint.json` — identical to `tsconfig.json` but with `"moduleResolution": "node"` and no Next.js plugins.

2. Add a `parserOptions` override to the root `.eslintrc.js`:

```js
// In overrides array:
{
  files: ['apps/<name>/**/*.{ts,tsx}'],
  parserOptions: {
    project: ['./apps/<name>/tsconfig.eslint.json'],
    tsconfigRootDir: __dirname,
  },
  extends: ['plugin:react/recommended', 'plugin:react-hooks/recommended'],
}
```

The `tsconfig.eslint.json` is **not** referenced by Next.js build — it is purely for ESLint's TypeScript parser. The Next.js build continues to use `tsconfig.json` with `moduleResolution: bundler`.

> This pattern must be applied to ALL future Next.js apps in this monorepo.

---

### 6. Non-Next.js processes (tsx) do NOT auto-load `.env.local`

Next.js loads `.env.local` automatically. Plain `tsx watch` does not.
Backend services run via `tsx` will have `undefined` for any key not passed explicitly.

❌ WRONG — running `tsx watch src/index.ts` and expecting `.env.local` values:
```bash
"dev": "tsx watch src/index.ts"
# OPENAI_API_KEY is undefined at runtime — LLM client throws on first call
```

✅ CORRECT — pass `--env-file` flag:
```bash
"dev": "tsx watch --env-file=../../.env.local src/index.ts"
```

Also declare **every env var** used by that package in `turbo.json` `globalEnv`:
```json
"globalEnv": [
  "OPENAI_API_KEY",
  "OPENAI_HIGH_TIER_MODEL",
  "OPENAI_LOW_TIER_MODEL",
  "GEMINI_CLI_BIN"
]
```

Why: Turborepo strips env vars not listed in `globalEnv` from child process environments.
Both fixes are required — `--env-file` makes vars available to the process, `globalEnv` prevents Turborepo from stripping them.

---

### 7. Self-management rule: YOU restart the dev server — never ask the user

When any of the following change, **immediately kill and restart dev** using the `/restart-dev-server` workflow:

| Change | Restart needed |
|---|---|
| `package.json` `scripts` | ✅ Always |
| `turbo.json` `globalEnv` | ✅ Always |
| `--env-file` flag | ✅ Always |
| New npm dependency added | ✅ Always |
| `.env.local` values changed | ✅ If service uses lazy singleton (OpenAI client, DB) |
| `.ts` file edits | ❌ `tsx watch` handles automatically |

Kill sequence:
```bash
pkill -f "turbo run dev" 2>/dev/null
pkill -f "tsx.*index.ts" 2>/dev/null
pkill -f "next.*dev" 2>/dev/null
sleep 2
```

Start sequence (background, log to file):
```bash
cd /path/to/ai-hivemind
pnpm turbo run dev > /tmp/turbo-dev.log 2>&1 &
sleep 12 && curl -s http://localhost:3001/health
```

Always confirm with a `/health` check before reporting the fix is live.

---

## Known Gotchas

### 8. NEVER use large `WaitMsBeforeAsync` — always background + poll

**What went wrong:** Commands like `pnpm type-check`, `tsc --noEmit`, and even `grep` with large `WaitMsBeforeAsync` values (5000, 10000, 30000) caused the agent to block indefinitely — requiring the user to cancel and restart.

**Root cause:** When `turbo run dev` is active, Turborepo holds task locks. Any command that touches pnpm/turbo acquires or waits for these locks and hangs. Even standalone commands like `tsc` can be slow (>60s) on this large workspace.

**The fix — always use this pattern:**
```
run_command:
  WaitMsBeforeAsync: 2000   ← ALWAYS 2000, never more
  → get a background CommandId

command_status:
  WaitDurationSeconds: 15   ← poll in short chunks, call multiple times if needed
```

> [!CAUTION]
> **Never** set `WaitMsBeforeAsync` above 2000 in this monorepo. If you need a result, poll with `command_status` repeatedly instead of waiting inline.

### 9. Use `tsx watch` log as the live type-checker — not `tsc`

**tsx watch IS the type-checker.** When `turbo run dev` runs, `tsx watch` recompiles every `.ts` on save and logs errors to `/tmp/turbo-dev.log`. This is instant and never hangs.

```bash
# ✅ The right way to check for compile errors — instant, no hang risk
grep -E 'TransformError|ERROR:|error TS' /tmp/turbo-dev.log | tail -6
```

Check for `[INFO] [Nerve Center] WebSocket ready` after a `Restarting...` line to confirm a clean reload. If you see `Error [TransformError]` the file failed to compile — check the ERROR line for the exact file:line.

### 10. esbuild (tsx) cannot call private class methods (`#name`) inside EventEmitter closures

**What went wrong:** TypeScript private fields (`#field`, `#method()`) are transformed by esbuild when used in arrow-function closures on EventEmitter `.on('data', ...)` handlers. This produces:
```
ERROR: Private name "#detectAskUserError" must be declared in an enclosing class
ERROR: Expected ";" but found "."
```

**The fix:** Capture `this` as `const self = this` at the top of the method, and call instance members via `self.method()` (no `#` prefix) inside closures. This means using regular (non-private) properties when the class needs to call them from EventEmitter callbacks.

```typescript
// ❌ Breaks in esbuild — private method call in closure
this.process_.on('data', (chunk) => { this.#handleLine(chunk); });

// ✅ Works — capture self, use regular property
const self = this;
self.process_.on('data', (chunk) => { self.handleLine(chunk); });
```

> [!IMPORTANT]
> When writing any class in `apps/backend/src/` that attaches EventEmitter listeners and calls instance methods from them, use the `const self = this` pattern and avoid `#` private fields.

### 11. NEVER use heredoc (`<< 'EOF'`) in `run_command` — use `write_to_file` instead

**What went wrong:** A command like `cat > file.md << 'EOF' ... EOF` inside `run_command` hung for **21+ minutes**, blocking every subsequent shell invocation in the session.

**Why it hangs:** The tool's shell environment doesn't always handle heredoc delimiters correctly when newlines are embedded in multi-line strings. The `EOF` delimiter never signals end-of-input to the subshell.

**The fix — always use `write_to_file` for any file content:**
```
# ❌ Hangs — heredoc in run_command
cat > conductor/index.md << 'EOF'
# Title
content
EOF

# ✅ Always use write_to_file instead
write_to_file(TargetFile="conductor/index.md", CodeContent="# Title\ncontent\n")
```

> [!CAUTION]
> **Never** write file content via heredoc in `run_command`. Use the `write_to_file` tool for all file creation/overwriting. This saved 20+ minutes of blocked time.

---

### 12. `replace_file_content` is a PATCH tool — it does not discard the remaining file

**What went wrong:** Tried to "overwrite" `projectManager.ts` by replacing its opening comment block with the entire new file content. The tool correctly replaced the TargetContent… and then **appended the old rest-of-file after it**. The result was a 400-line file with duplicate class declarations and syntax errors.

❌ WRONG — using `replace_file_content` to wholesale replace a file:
```
TargetContent: "/**\n * projectManager.ts — Project Manager..."
ReplacementContent: "<entire new 35-line file>"
// RESULT: 35 new lines + 310 remaining old lines = broken file
```

✅ CORRECT — when you need to replace the ENTIRE content of an existing file, use `write_to_file` with `Overwrite: true`:
```
write_to_file(
  TargetFile="apps/backend/src/agents/projectManager.ts",
  Overwrite=true,
  CodeContent="<full new file content>"
)
```

Why: `replace_file_content` is designed for targeted patches. It finds `TargetContent` within the file's line range and substitutes it — the rest of the file is untouched. It is NOT a file truncation tool.

> [!IMPORTANT]
> Use `replace_file_content` / `multi_replace_file_content` for surgical edits (1–N non-contiguous hunks).
> Use `write_to_file` with `Overwrite: true` when the entire file content changes (e.g., rewriting a class from scratch).
