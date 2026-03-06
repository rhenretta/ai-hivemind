# Adding a New Type to packages/shared

> How to add a new type or schema to packages/shared.

This workflow governs all additions to `packages/shared` — the single source of truth for
all cross-boundary data contracts. Read `docs/WORKFLOW.md §2` before starting.

## Steps

1. **Determine version bump required**
   - Adding a new type/enum/interface → MINOR bump
   - Changing or removing an existing type → MAJOR bump (requires RFC first — see `new-rfc` workflow)
   - If MAJOR bump is needed, run the `new-rfc` workflow first and get approval before continuing.

2. **Create the type file or add to existing file**
   - Types live in: `packages/shared/src/types/<domain>.ts`
   - Domains: `agent.ts`, `events.ts`, `messages.ts`, `telemetry.ts`, `interrupts.ts`, `tools.ts`, `errors.ts`
   - If a new domain file is needed, create it and add the export to `packages/shared/src/index.ts`

3. **Write the Zod schema FIRST, derive the TypeScript type from it**
   ```ts
   // CORRECT pattern — single source of truth
   export const MyThingSchema = z.object({ ... });
   export type MyThing = z.infer<typeof MyThingSchema>;

   // NEVER do this — type and schema are now separate and can drift
   export type MyThing = { ... };
   export const MyThingSchema = z.object({ ... });
   ```

4. **Add exports to `packages/shared/src/index.ts`**
   - Every new type file must be re-exported from the index.
   - Never add sub-path exports to `package.json` (consumers always import from root).

5. **Bump the version in `packages/shared/package.json`**
   ```bash
   # From repo root
   cd packages/shared
   # Edit version field manually following SemVer rules
   ```

6. **Write a unit test for the new schema**
   - Test file: `packages/shared/src/types/__tests__/<domain>.test.ts`
   - Test valid inputs parse correctly.
   - Test invalid inputs are rejected with meaningful Zod errors.

7. **Run type-check and tests**
   ```bash
   turbo run type-check --filter=packages/shared
   turbo run test:unit --filter=packages/shared
   ```

8. **Run type-check on all consumers to confirm no regressions**
   ```bash
   turbo run type-check
   ```

9. **Update `schemaVersion` references if needed**
   - Any service that hardcodes a `schemaVersion` value must be updated to match the new `packages/shared` version.
   - Search for stale references:
   ```bash
   grep -r "schemaVersion" apps/ --include="*.ts"
   ```

10. **Open a PR**
    - PR title format: `feat(shared): add <TypeName> schema [minor]` or `feat(shared): <change> [major]`
    - PR must include: what was added, why, and which services are consumers.
    - Tag all service owners as reviewers (web, backend, sandbox).
