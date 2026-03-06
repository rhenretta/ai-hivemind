# RFC Index

This directory contains Request for Comment (RFC) documents for breaking changes to `packages/shared`.

## RFC Process

Any MAJOR version bump to `packages/shared` requires an RFC. See [WORKFLOW.md](../WORKFLOW.md) §2.3 for the full process.

## RFC Template

```
docs/rfcs/NNNN-change-summary.md
```

### Required Sections

1. **Summary** — one sentence description of the change
2. **Motivation** — why is this change necessary?
3. **Old Schema** — the current type definition(s)
4. **New Schema** — the proposed type definition(s)
5. **Migration Path** — how each consuming service (`apps/web`, `apps/backend`, `apps/sandbox`) migrates
6. **Deprecation Timeline** — when will the old schema be removed?
7. **Approvals Required** — maintainer sign-offs from each service

## Active RFCs

*No RFCs are currently open.*

## Merged RFCs

*No RFCs have been merged yet.*
