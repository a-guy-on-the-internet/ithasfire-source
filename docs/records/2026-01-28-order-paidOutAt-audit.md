# Order.paidOutAt — audit & migration actions

## Summary

This document audits every reference to `paidOutAt` (and specifically `Order.paidOutAt`) and provides a recommended migration action for each occurrence. The aim is to migrate all callers to item-level `OrderItem.paidOutAt` and then drop the `Order.paidOutAt` column in a follow-up DB migration.


## Audit (file -> suggested action)

- packages/types/src/repos/orders.ts

  - Action: Remove `paidOutAt` from the `Order` DTO/type once all callers are migrated. Keep `OrderItem` types.

- packages/ports/src/repos/orders.ts

  - Action: Remove `markPaidOut(orderId, paidOutAt)` from the orders port. Encourage callers to use `orderItems.markItemsPaidOut(itemIds, paidOutAt)`.

- packages/adapters/src/db/prisma/orders.ts

  - Action: Remove `markPaidOut` adapter implementation and any projections that select `paidOutAt` from `Order`. Verify no callers remain.

- packages/adapters/src/db/prisma/order-items.ts

  - Action: Keep `markItemsPaidOut` which writes `OrderItem.paidOutAt`. Ensure it is used where appropriate (e.g., executeSettlementTransfer).

- packages/core/src/use-cases/orders/refund-by-payout-status.ts

  - Action: Replace checks against `order.paidOutAt` with item-level checks (e.g., `order.items.some(i => i.paidOutAt !== null)`). Confirm refund logic semantics (per-item vs order-level) and add tests for edge cases.

- packages/core/src/use-cases/orders/get-my-order.ts

  - Action: Ensure projections return `items[].paidOutAt` (they already seem to) and remove any references to order-level paidOutAt in outputs/DTOs.

- packages/core tests referencing `order.paidOutAt` (e.g., __tests__/*)

  - Action: Update tests to assert on `OrderItem.paidOutAt` (either by checking a particular item or by computing the expected aggregate if necessary).

- apps/api/src/routes/e2e.ts

  - Action: We already removed returning `order.paidOutAt` and updated tests. Keep this as-is and ensure any E2E helpers used by other suites are updated.

- packages/db/prisma/schema.prisma

  - Action (Phase 2/3): After code changes and tests pass, add a migration to:

    1. Backfill `OrderItem.paidOutAt` where `Order.paidOutAt` is NOT NULL: set all item.paidOutAt = order.paidOutAt (or decide a business rule if not all items should receive the same timestamp).
    2. Drop the `Order.paidOutAt` column in a subsequent migration once backfill is confirmed.

- Schema & validation (packages/schema)

  - Action: Remove any zod schemas or branches that accept `order.paidOutAt` as an input/output shape. Update API contracts accordingly and bump docs.

- E2E and UI tests (apps/web e2e/my-tickets-refund.spec.ts and item-level-settlements.spec.ts)

  - Action: Update any tests to assert on item-level `paidOutAt`. Ensure fixture generators produce items with `paidOutAt` when appropriate.

- Misc (docs/specs/2026-03-06/completed/item-level-settlements-and-resale.md)

  - Action: Document the migration phases (already present). Reference this doc and link to the migration PRs.


## Migration plan (high level)

1. Audit and migrate code: Update all code and tests to consult item-level `OrderItem.paidOutAt`. Leave database untouched for now.

2. Add backfill migration: Add a migration that copies `Order.paidOutAt` -> `OrderItem.paidOutAt` for orders where the former is not null.

3. Rolling verification: Deploy and run smoke/e2e tests that confirm item-level paidOutAt behaves the same as previously.

4. Drop column migration: Once verified and no code reads `Order.paidOutAt`, remove the column and update Prisma schema.

5. Cleanup: Remove extinct types/ports/tests; update docs and changelog.


## Checklist before DB migration

- [ ] `git grep -n "order.paidOutAt"` is empty
- [ ] `git grep -n "paidOutAt"` only finds item-level usages and schema
- [ ] Unit tests updated and passing
- [ ] E2E tests updated and passing
- [ ] Migration SQL prepared and reviewed


## Automation / scripts

- Provide a simple script (or prisma migration) that does the backfill:

  ```sql
  UPDATE "OrderItem"
  SET "paidOutAt" = o."paidOutAt"
  FROM "Order" o
  WHERE "OrderItem"."orderId" = o.id AND o."paidOutAt" IS NOT NULL;
  ```

- Include a reversible check in the migration: count of rows updated and a small sample to audit.


## Notes & Risks

- This impacts accounting/settlement flows. Coordinate with finance or team owning settlement logic and choose a safe backfill (set all items or only certain items depending on business rules).
- Tests referring to order-level `paidOutAt` must be updated carefully to reflect the intended semantics (e.g., "an order is paid out if any of its items are paid out" vs "if all items are paid out").


## Next actions

- I can prepare a draft PR that:

  1. Replaces `markPaidOut` usages and removes adapter impls
  2. Updates types/ports and tests
  3. Adds the backfill migration SQL in a `packages/db/prisma/migrations` folder (with a clear `up` and `down` plan)

Say "Start migration PR for Order.paidOutAt" and I'll start implementing the code migrations and tests in a draft branch, then open a PR for review.
