# Compatibility Sweep — actionable migration plan

## Overview

This document captures the larger compatibility/legacy items that should be triaged and removed in a small set of focused, low-risk PRs. The goal is to remove technical debt and hidden complexity by replacing legacy code paths rather than layering temporary shims.

### A: Small, low-risk removals (done / in progress)

- Remove `useForegroundLocation` hook — DONE (replaced with `useLocation` + provider)
- Remove deprecated `apps/api/src/routes/tasks.ts` no-op route — DONE
- Remove `packages/ui/src/ui/tamagui/components/overlays/index.ts` shim — DONE
- Remove `packages/ui-email/src/preview/server.ts` shim — DONE
- Remove `order.paidOutAt` return from E2E mark-paid-out helper and update E2E test to assert item-level `paidOutAt` — DONE
- Remove `OrdersRepo.markPaidOut` port + adapter implementation — DONE
- Remove `packages/ui/src/ui/tamagui/components/AutocompleteField.tsx` shim — DONE
- Remove `packages/ui/src/ui/tamagui/components/LocationAutocomplete.tsx` shim — DONE
- Remove `packages/ui/src/ui/tamagui/components/notifications/Alert.tsx` shim — DONE
- Remove `packages/core/src/use-cases/templates/*` shims — DONE (replaced with fail-fast sentinel errors; callers already import from `@th/core/use-cases/event-templates/*`)

### Notes

- These were all single-file, no-logic re-exports. Callers were updated to the canonical import paths and package-level tests ran green.

### B: Medium/High-effort migrations (triage required)

1. UI Component File Duplication (`packages/ui/src/ui/tamagui/components/`)

   - Situation: Root-level component files (`Button.tsx`, `Text.tsx`, etc.) coexist with canonical versions in subdirectories (`forms/Button.tsx`, `display/Text.tsx`, etc.). The barrel `components/index.ts` exports only from subdirectories.
   - Discovery: 4 root-level files are byte-identical to their subdirectory counterparts; 28 have diverged.
   - Blocker: Sibling files (e.g., `notifications/Toast.tsx`) import via relative paths like `../Button`. Deleting root-level files breaks these imports.
   - Steps:
     1. Update all sibling imports to use the canonical public paths (from `components/index.ts` or subdirectory re-exports).
     2. Reconcile the 28 diverged files — determine which version is canonical and migrate callers.
     3. Delete root-level duplicates once all callers are updated.
   - Risk: Medium. Requires codebase-wide import updates and careful reconciliation of diverged implementations.
   - Note: Duplicate Storybook files (16 root-level copies) were already removed without issue.

2. Remove `Order.paidOutAt` (database & code)

   - Impact: DB schema migration, use-case changes, tests (unit + e2e), and consumers that still read `Order.paidOutAt`.
   - Why: We moved to item-level `paidOutAt` on `OrderItem`. `Order.paidOutAt` is deprecated and will be removed.
   - Steps:
     1. Audit code paths and tests still referencing `order.paidOutAt` and migrate them to consult `order.items[].paidOutAt`.
     2. Add a migration to drop `Order.paidOutAt` once all references are removed and tests updated.
     3. Run the full test suite (unit/e2e) and validate data migration scripts for existing DBs.
   - Risk: High. Requires coordinated migration and E2E test updates.
   - Suggested PR: "refactor(orders): migrate off Order.paidOutAt and remove column"

3. Remove `legacyEventBodySchema` acceptance

   - Impact: Validation changes; clients may be sending legacy body shapes.
   - Steps:
     1. Identify clients/tests relying on legacy schema.
     2. Update clients/tests and deprecate the legacy path with a rollout window.
     3. Remove legacy schema branch in `packages/schema`.
   - Risk: Medium

4. Sweep `legacy`/`deprecated` shims across repo

   - Impact: variable. Some shims are harmless; others require refactors.
   - Steps:
     1. Create a PR that compiles a list of active shims (grep for "deprecated|legacy|backward") and their usage coverage.
     2. Pick low-risk ones to remove in separate PRs.
     3. For higher-risk shims, create issues and schedule planned migrations.

5. `legacyBehavior` Link props and other Next.js compatibility flags

   - Steps: Replace `legacyBehavior` Link uses with modern Link usage and fix affected components.

## How I can help

- I can continue the automated low-risk sweep (delete unused shims, update tests, run tsc) and prepare a branch with grouped changes.
- I can create PRs and include the appropriate CI test runs and PR descriptions documenting the impact.
- For larger migrations (Order.paidOutAt), I can prepare a migration plan and a test matrix; this should be reviewed before proceeding.

## Next immediate actions (if you approve)

1. Continue removing single-file compatibility shims that are unused and update callers/tests. (I can do this automatically in a series of small PRs.)
2. Open issues (or draft PRs) for the medium/high-risk items above and prepare migration branches for `Order.paidOutAt` and `legacyEventBodySchema`.

If you'd like me to proceed: say "Proceed with automatic sweep for small shims" to have me continue, or "Start migration PR for Order.paidOutAt" to begin the large migration planning.
