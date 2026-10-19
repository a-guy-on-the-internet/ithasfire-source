-- ABSORB is removed (owner ruling 2026-10-01, docs/decisions/absorb-removed.md).
-- Step 2 of 3: every PayoutTerms row that says ABSORB now says PASS_THROUGH.
-- Step 1 (20261001230000) has already marked the affected events for reindex.
--
-- PASS_THROUGH rather than NULL: a NULL mode inherits the mode of the fee
-- policy the terms are pinned to (or resolve to), so NULL would leave these
-- rows one policy row away from ABSORB. An explicit PASS_THROUGH depends on
-- nothing. Step 3 converts the policies too, and pricing no longer reads
-- either mode (`SALE_FEE_MODE`), so all three would have to fail together
-- for a sale to price ABSORB.
--
-- Covers every kind (PRIMARY, RESALE, MERCH), every status, entity defaults
-- and event-owned rows alike. Orders already sold are untouched: each order
-- carries its own `feesPlatformCents`, `feePolicySnapshot` (with its own
-- `feeMode`) and per-item `meta.effectiveFeeMode`, and no read path re-derives
-- a past order from its live terms row.
--
-- ONE-WAY. There is no down migration and none should be written: after this
-- runs nothing records which rows said ABSORB, and restoring them would
-- reopen a fee mode the owner removed. If the affected set is needed, run the
-- pre-deploy query in docs/decisions/absorb-removed.md BEFORE migrating, or
-- read past sales from `Order."feePolicySnapshot"->>'feeMode' = 'ABSORB'`.
--
-- Single statement. Idempotent: a second run matches nothing.
UPDATE "PayoutTerms"
SET "feeMode" = 'PASS_THROUGH',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "feeMode" = 'ABSORB';
