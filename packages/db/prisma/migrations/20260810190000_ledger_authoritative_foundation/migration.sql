-- Ledger-authoritative settlement, Step A: the ledger foundation
-- (docs/specs/2026-08-10/ledger-authoritative-settlement.spec.md).
--
-- `PayeeLedgerEntry` becomes the only source of truth for what a payee is
-- owed. Two schema primitives are missing for that:
--
--   * `availableAt` — a balance says HOW MUCH; it never said WHEN. This
--     carries what `Settlement.scheduledPayoutDate` carries today, stamped at
--     write time. Only SETTLEMENT_CREDIT rows get a value (credits mature);
--     debits, holds and payouts are always effective — the asymmetry IS the
--     P0 fix (a refund reduces the payable balance the instant it is written).
--   * `consumedByEntryId` — stamped on a SETTLEMENT_CREDIT when a PAYOUT
--     entry consumes its net contribution. Attribution only (order-item
--     `paidOutAt` stamping, reporting); never an input to amounts.
--
-- Plus one enum member: TRANSFER_REVERSAL_CREDIT, written when a post-payout
-- refund successfully reverses a Stripe transfer (+effect; relatedEntryId →
-- the REFUND_DEBIT it compensates, netting the pair to zero).
--
-- All statements are idempotent (IF NOT EXISTS / guarded DO block) because
-- the dev databases here are db-push-managed, so a migration can legitimately
-- be re-applied over a schema that already has the changes (same reasoning as
-- 20260812130000_fee_policy_one_active_per_scope).

-- ── 1. Enum member ──────────────────────────────────────────────────────────
-- ADD VALUE IF NOT EXISTS is transactional on PG 12+; the new value is not
-- USED anywhere else in this migration, so running inside Prisma's per-
-- migration transaction is safe.
ALTER TYPE "PayeeLedgerEntryType" ADD VALUE IF NOT EXISTS 'TRANSFER_REVERSAL_CREDIT';

-- ── 2. Maturity + consumption columns ───────────────────────────────────────
ALTER TABLE "PayeeLedgerEntry" ADD COLUMN IF NOT EXISTS "availableAt" TIMESTAMP(3);
ALTER TABLE "PayeeLedgerEntry" ADD COLUMN IF NOT EXISTS "consumedByEntryId" TEXT;

-- ── 3. Indexes ──────────────────────────────────────────────────────────────
-- (payeeId, currency, availableAt) serves the payable query's per-payee
-- maturity filter; (consumedByEntryId) serves FIFO consumption attribution
-- ("which credits did this payout cover") and the unconsumed-credits scan.
CREATE INDEX IF NOT EXISTS "PayeeLedgerEntry_payeeId_currency_availableAt_idx"
  ON "PayeeLedgerEntry"("payeeId", "currency", "availableAt");

CREATE INDEX IF NOT EXISTS "PayeeLedgerEntry_consumedByEntryId_idx"
  ON "PayeeLedgerEntry"("consumedByEntryId");

-- ── 4. The maturity invariant, DB-enforced ──────────────────────────────────
-- Every SETTLEMENT_CREDIT must carry a maturity date. A NULL `availableAt` on
-- a credit would silently read as "never payable" in the payable query
-- (`availableAt <= asOf` is never true for NULL) — money that vanishes
-- without an error is exactly the bug class this rearchitecture exists to
-- kill, so the invariant is expressed in Postgres, not just in the adapter.
-- Other entry types deliberately allow NULL (they are always effective and
-- never consult the column).
--
-- CHECK constraints aren't expressible in the Prisma schema, so this is
-- SQL-only (noted on the PayeeLedgerEntry model in finance.prisma; house
-- precedent: BookingRequest_direction_shape_check, migration 20260721).
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guarded DO block.
--
-- Safe to VALIDATE against existing rows: SETTLEMENT_CREDIT has had zero
-- writers since the enum member was declared (verified at authoring time —
-- this migration is what starts wiring it). If a row somehow violates, the
-- migration fails loudly, which is correct for a money invariant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayeeLedgerEntry_settlement_credit_available_check'
      AND conrelid = 'public."PayeeLedgerEntry"'::regclass
  ) THEN
    ALTER TABLE "PayeeLedgerEntry"
      ADD CONSTRAINT "PayeeLedgerEntry_settlement_credit_available_check"
      CHECK ("type" <> 'SETTLEMENT_CREDIT' OR "availableAt" IS NOT NULL);
  END IF;
END
$$;
