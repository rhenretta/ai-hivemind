---
name: packages-shared-governance
description: Deep knowledge of packages/shared governance rules, Zod-first discipline, SemVer versioning, and RFC process for the ai-hivemind monorepo
---

# Skill: packages/shared Governance

## When to Use This Skill

Load this skill whenever you are:
- Adding, modifying, or removing anything in `packages/shared/`
- Seeing a TypeScript cross-boundary type defined inside `apps/*` (this is a bug)
- Evaluating whether a change requires a MINOR or MAJOR version bump
- Writing or reviewing an RFC
- Diagnosing a `SCHEMA_VIOLATION` ledger event

---

## The Prime Directive

`packages/shared` is the **only** place where types that cross a service boundary may be defined.

**Cross a boundary** means: used by more than one of the following:
- `apps/web`
- `apps/backend`
- `apps/sandbox`
- Any future `apps/*`

If a type is only used within a single app, it lives in that app. The moment it crosses a boundary, it moves to `packages/shared`.

---

## The Zod-First Law

Every type that crosses a boundary MUST have a co-located Zod schema. The TypeScript type MUST be derived from the schema — never the other way around.

```typescript
// ✅ CORRECT — single source of truth
export const FooSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(256),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export type Foo = z.infer<typeof FooSchema>;

// ❌ WRONG — type and schema can drift
export type Foo = { id: string; name: string; status: 'ACTIVE' | 'INACTIVE' };
export const FooSchema = z.object({ ... }); // may silently drift from the type above
```

**Why this matters:** TypeScript types vanish at runtime. Zod schemas provide runtime validation at every service boundary. The Nerve Center uses these schemas to reject malformed messages. If type and schema drift, the TypeScript compiler gives a false green while runtime rejections happen in production.

---

## Allowed Runtime Dependencies

The ONLY runtime dependencies permitted in `packages/shared`:

| Dependency | Reason |
|---|---|
| `zod` | Runtime schema validation |

Everything else must be a `devDependency`. Importing from `@ai-hivemind/ui`, `@ai-hivemind/backend`, or any `apps/*` is **prohibited** (enforced by ESLint `import/no-extraneous-dependencies`).

---

## Version Bump Decision Tree

```
Q: Does this change alter or remove an existing exported type, schema, or enum value?
│
├─ YES → MAJOR version bump → RFC required → see new-rfc workflow
│
└─ NO → Q: Does this add a new optional field to an existing type?
         │
         ├─ YES → MINOR bump → No RFC needed, but document migration notes in PR
         │
         └─ NO → Q: Does this add a completely new type/schema/enum?
                  │
                  ├─ YES → MINOR bump → No RFC needed
                  │
                  └─ NO → Could be PATCH (typo fix, jsdoc correction)
```

---

## File Organization

```
packages/shared/src/
├── index.ts              ← THE ONLY EXPORT SURFACE. All exports re-exported here.
└── types/
    ├── agent.ts          ← AgentTier, AgentLifecycleState, BuiltInAgentType, RuntimeAgentSpec, ToolBinding, AgentPersona
    ├── events.ts         ← EventType (50+ events), LedgerEvent
    ├── messages.ts       ← A2AMessage, MessageRole, MessageContentType, MessagePriority
    ├── telemetry.ts      ← EventMetadata (tokens, latency, tool, CLI, sandbox)
    ├── interrupts.ts     ← InterruptCommand, InterruptDirective, InterruptResult
    ├── tools.ts          ← ToolSchema, ToolParameter, McpServerRegistration
    └── errors.ts         ← ErrorCode, ControlPlaneError
```

**Rule:** `packages/shared/src/index.ts` must `export * from './types/<file>.js'` for every type file. Consumers NEVER import from sub-paths.

---

## schemaVersion Field

Every message or event envelope that crosses a network boundary carries a `schemaVersion` field.

- Its value must always equal the SemVer of `packages/shared` at build time.
- The Nerve Center validates this on every incoming message.
- Mismatch behavior:
  - Major version mismatch → message **rejected** with `SCHEMA_VIOLATION` event.
  - Minor version mismatch → message **accepted with warning** → `SCHEMA_VIOLATION` event with severity `WARN`.

When bumping the version, search for hardcoded `schemaVersion` references in `apps/`:
```bash
grep -r "schemaVersion" apps/ --include="*.ts"
```

---

## Validation Patterns at Boundaries

The Nerve Center validates ALL incoming messages at the boundary. Consumer code should never trust that validation has happened — validate at every boundary crossing.

```typescript
// In apps/backend — validating an incoming A2A message
import { A2AMessageSchema } from '@ai-hivemind/shared';

const result = A2AMessageSchema.safeParse(rawMessage);
if (!result.success) {
  // Emit SCHEMA_VIOLATION event to ledger
  // Reject the message
  return;
}
const message = result.data; // Fully typed and validated
```

---

## RFC Template Location

`docs/rfcs/NNNN-<kebab-summary>.md`

RFC numbering is sequential from 0001. Use the `new-rfc` workflow to create one.

---

## Adding a New SystemEventType — Complete Checklist

Adding a new event type requires changes in **five places**. Missing any one causes a TypeScript compile error.

```
Step 1  packages/shared/src/types/events.ts
        Add the new value to SystemEventTypeSchema z.enum([...])
        Add JSDoc comment explaining the payload shape above it

Step 2  packages/shared/src/types/<newfile>.ts  (if new payload type needed)
        Define the Zod schema for the payload (Zod-first law applies)
        Export from packages/shared/src/index.ts

Step 3  pnpm --filter @ai-hivemind/shared build
        Must be clean before consumers can see the new type.
        ALL downstream TypeScript errors before this step are cache lag — not real.

Step 4  apps/web — all four color maps (parallel multi_replace_file_content calls):
        - apps/web/src/components/layout/LedgerPanel.tsx         → EVENT_COLORS
        - apps/web/src/components/layout/RosterPanel.tsx         → EVENT_TYPE_COLORS
        - apps/web/src/components/topology/AgentNode.tsx         → EVENT_DOT
        - apps/web/src/components/inspector/EventInspectorSheet.tsx → EVENT_BADGE

Step 5  pnpm --filter @ai-hivemind/backend build
        pnpm --filter @ai-hivemind/web build
        Both must be clean.
```

> [!CAUTION]
> **Never** add an event type to only some of the four frontend maps. The Records are typed as `Record<SystemEventType, T>` — TypeScript will flag *every* map that is missing the new key. Add all four in the same edit.

### Color palette conventions
| Event category | Color family |
|---|---|
| Lifecycle (spawn, terminate) | slate / gray |
| State transitions | blue / indigo |
| Memory / RAG | purple |
| Errors | red / rose |
| Service events (deployed, input) | green / yellow |
| Task planning | orange |
| QA | lime |
| Conductor/streaming | green-300 (lighter) |
| Task graph | violet (graph), teal (node) |
