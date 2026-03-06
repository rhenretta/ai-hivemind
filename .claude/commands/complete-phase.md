# Phase Completion Checklist

> Mandatory checklist to run at the end of every phase or major implementation -- always update skills and workflows before writing the walkthrough.

Use this workflow at the end of **every phase, major feature, or significant implementation**.
This is non-negotiable — the walkthrough is the LAST step, not the first.

## Why This Exists

Skills and workflows improve Claude Code's effectiveness on **future** tasks.
Documenting lessons only in a walkthrough artifact means they are lost the next time a
similar task runs. This workflow enforces codification of hard-won knowledge.

---

## Auto-Trigger: When This MUST Run

This workflow must run automatically — without user prompting — whenever ALL of the following are true:

1. A build command (`pnpm build`, `turbo run build`, `tsc`) just returned **clean** (exit 0, no errors)
2. The task included **more than one retry** on any step, OR touched multiple files across packages
3. You are about to report the task complete

**The rule:** before every completion report that closes an implementation task, ask:
> "Did I encounter anything I had to fix, retry, or look up during this task?"

If YES → run `/complete-phase` FIRST, then report completion.
If NO → you may skip it (trivial one-liner fixes do not need a phase completion sweep).

**Why it was skipped before:** The condition was described as "end of every phase" which requires judgment. The rule above is mechanical — it fires on a successful build after a non-trivial task, every time, without exception.

---

## Steps

1. **Collect lessons learned from this phase**

   Review the walkthrough draft and the execution history. For each friction point,
   bug, non-obvious pattern, or tool invocation that caused multiple retries, ask:

   > "If I started this task fresh tomorrow, which skill would have prevented this mistake?"

   Write down the list before touching any files.

2. **Triage each lesson into the right skill**

   | Lesson type | Target skill |
   |---|---|
   | Next.js / React / Tailwind / UI patterns | `command-center-ui-patterns` |
   | Zustand, socket.io, WebSocket patterns | `command-center-ui-patterns` |
   | Turborepo pipeline, tsconfig, ESLint | `turborepo-operations` |
   | Event Bus, ledger, WebSocket routing | `nerve-center-event-bus` |
   | `packages/shared` types, Zod schemas, RFC | `packages-shared-governance` |
   | Agent hierarchy, A2A protocol, authority | `agent-hierarchy-rules` |
   | Anything that doesn't fit an existing skill | Create a new skill |

3. **Update or create skills**

   For each lesson, add a new subsection to the appropriate `SKILL.md`.
   Use the pattern:
   ```
   ### [Short title: the mistake or rule]
   WRONG — [what the bad approach looks like, with code]
   CORRECT — [what to do instead, with code]
   Why: [one sentence root cause]
   ```

   Creating a new skill:
   ```bash
   mkdir -p .agent/skills/<skill-name>
   # Write .agent/skills/<skill-name>/SKILL.md following the template above
   ```

4. **Update workflows if the phase revealed a missing or incorrect workflow step**

   Check: does any existing workflow (e.g. `new-app-feature.md`, `scaffold-agent.md`)
   reflect the new understanding? If a step was in the wrong order, incomplete, or
   missing entirely — update the workflow file now.

5. **Only then — write or finalize the walkthrough**

   The walkthrough can reference the skills for deep context (link to them).
   It should confirm that skills were updated:

   ```markdown
   ## Skills Updated
   - `command-center-ui-patterns` — added: Tailwind dark mode, socket.io singleton
   - `turborepo-operations` — added: Next.js ESLint tsconfig gotcha
   ```

6. **Run a self-check before closing**

   Answer these questions explicitly in your head before marking the phase done:

   - [ ] Did I encounter any error I had to retry more than once?
         → If yes, that retry loop is a skill.
   - [ ] Did I write any `eslint-disable` comment?
         → The reason it was needed belongs in the skill.
   - [ ] Did I have to look up or reason about a non-obvious config pattern?
         → That pattern belongs in the skill.
   - [ ] Did any workflow step not exist but should have?
         → Create or update the workflow.
   - [ ] Is there a new reusable component, hook, or architecture pattern?
         → Document it in the relevant skill.

---

## Anti-Patterns (what caused this workflow to be created)

- Writing lessons only in `walkthrough.md` — walkthroughs are human-readable history,
  not machine-actionable guidance. Skills are the actionable layer.
- Treating the pre-task "evaluate skills" directive as a one-time checkbox — skill
  evaluation must also happen POST-task after real implementation friction is discovered.
- Completing the task loop (build passing, browser test passing) and considering the
  job done without a post-phase sweep.
