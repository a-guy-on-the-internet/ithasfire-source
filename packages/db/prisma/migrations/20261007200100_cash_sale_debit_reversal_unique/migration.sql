-- One CASH_SALE_DEBIT_REVERSAL per CASH_SALE_DEBIT (spec 2026-10-07
-- door-sales-same-price-and-tax, FR-008).
--
-- A gate refund of a cash sale reverses the sale's fee + tax debit exactly
-- once. The writer (`cashSaleDebitReversal`) already refuses a second
-- reversal through its idempotency key and a prior-reversal read; this makes
-- the rule hold in the database for ANY key, the same way
-- "PayeeLedgerEntry_relatedEntryId_consumed_key" (20260515120000) does for
-- the DISPUTE_* entries. A loser of a race fails with P2002 instead of
-- crediting the payee twice.
--
-- A separate migration from 20261007200000 on purpose: Postgres refuses to
-- use an enum value in the transaction that added it ("unsafe use of new
-- value"), and this predicate names CASH_SALE_DEBIT_REVERSAL.
--
-- Existing data cannot violate it: the value was introduced by
-- 20261007200000 and nothing wrote reversals before this release.
-- Partial, so Prisma's schema language can't express it — it lives here only,
-- like the DISPUTE_* index. IF NOT EXISTS: re-applicable.
CREATE UNIQUE INDEX IF NOT EXISTS "PayeeLedgerEntry_relatedEntryId_cash_sale_reversal_key"
  ON "PayeeLedgerEntry"("relatedEntryId")
  WHERE "relatedEntryId" IS NOT NULL
    AND "type" = 'CASH_SALE_DEBIT_REVERSAL'::"PayeeLedgerEntryType";
