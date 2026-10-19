-- Door sales charge the same price, fees and tax as online checkout
-- (docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml, FR-004).
--
-- A cash sale's platform fee + tax are collected in cash by the organiser and
-- owed to the platform: a CASH_SALE_DEBIT on the organiser's payee, recovered
-- from the next payout (owner ruling R6). A gate refund of the cash sale
-- writes the matching CASH_SALE_DEBIT_REVERSAL.
--
-- ADD VALUE IF NOT EXISTS is transactional on PG 12+; neither value is USED
-- in this migration, so running inside Prisma's per-migration transaction is
-- safe (same reasoning as 20260810190000_ledger_authoritative_foundation).

-- AlterEnum
ALTER TYPE "PayeeLedgerEntryType" ADD VALUE IF NOT EXISTS 'CASH_SALE_DEBIT';
ALTER TYPE "PayeeLedgerEntryType" ADD VALUE IF NOT EXISTS 'CASH_SALE_DEBIT_REVERSAL';
