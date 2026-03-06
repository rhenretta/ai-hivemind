# Filing an RFC for packages/shared Breaking Change

> How to file an RFC for a breaking change to packages/shared.

Any MAJOR version bump to `packages/shared` (changing or removing an existing type, removing an enum value)
requires an RFC. See `docs/WORKFLOW.md §2.3`.

## Steps

1. **Determine the next RFC number**
   ```bash
   ls docs/rfcs/ | grep -v README | sort | tail -1
   # Increment the number by 1 for the new RFC
   ```

2. **Create the RFC file**
   - Path: `docs/rfcs/NNNN-<kebab-case-summary>.md`
   - Use the RFC template:

   ```markdown
   # RFC NNNN: <Title>

   **Status:** OPEN | APPROVED | MERGED | REJECTED
   **Author:** <name>
   **Created:** <date>
   **Approvals Required:** @web-maintainer, @backend-maintainer, @sandbox-maintainer

   ## Summary
   One sentence description of the change.

   ## Motivation
   Why is this change necessary? What problem does it solve?

   ## Old Schema
   (paste the current type definition)

   ## New Schema
   (paste the proposed type definition)

   ## Migration Path

   ### apps/web
   Describe how this app migrates to the new schema.

   ### apps/backend
   Describe how this app migrates to the new schema.

   ### apps/sandbox
   Describe how this app migrates to the new schema.

   ## Deprecation Timeline
   When will the old schema be removed? Is there a transition period?

   ## Approvals
   - [ ] @web-maintainer
   - [ ] @backend-maintainer
   - [ ] @sandbox-maintainer
   ```

3. **Open a PR with just the RFC document** — no code changes yet
   - PR title: `rfc(shared): <NNNN> <title>`
   - Assign all service owners as reviewers
   - Set a minimum 2-business-day review period label

4. **Wait for all approvals** — the RFC PR must get sign-off from all three service owners before any implementation begins

5. **After RFC is approved**: run the `add-shared-type` workflow to implement the change
   - Update the RFC status to APPROVED in the RFC file before merging the RFC PR

6. **After implementation is merged**: update the RFC status to MERGED and close the RFC PR
