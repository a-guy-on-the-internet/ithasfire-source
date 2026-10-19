-- The payout item's DURABLE PLAN (spec 2026-08-10, ledger-authoritative-settlement §6).
--
-- Post-cutover a payout item links no settlements, so after a crash there was
-- nothing on the row saying WHICH ledger credits it claimed or WHAT it sent to
-- Stripe. That made the transfer-then-crash window unrecoverable in the one way
-- that matters: the payable still showed the money as owed, the credits still
-- looked unconsumed, and the next batch would re-derive a plan whose amount had
-- drifted (the Connect fee sees the account gone active; the reserve sees its
-- releases already written) — so the Stripe idempotency replay no longer
-- matched and a SECOND real transfer went out.
--
-- Freezing the plan on the row makes that window a pure LEDGER heal: replay the
-- PAYOUT entry under `payoutLedgerKey`, consume `plannedCreditEntryIds`, stamp
-- `plannedOrderItemIds`. No Stripe call, nothing recomputed.
--
-- Idempotent (IF NOT EXISTS) because the dev databases are db-push-managed and
-- this migration must stay re-applicable.
ALTER TABLE "PayoutItem"
  ADD COLUMN IF NOT EXISTS "plannedCreditEntryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "plannedOrderItemIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "plannedNetCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payoutLedgerKey" TEXT;

-- The heal sweep asks "which transferred items for these payees still carry a
-- plan?" once per batch run. Partial index: only transferred rows are ever
-- swept, and pre-cutover rows (no ledger key) are not healable.
CREATE INDEX IF NOT EXISTS "PayoutItem_heal_sweep_idx"
  ON "PayoutItem" ("payeeId")
  WHERE "status" = 'transferred' AND "payoutLedgerKey" IS NOT NULL;
