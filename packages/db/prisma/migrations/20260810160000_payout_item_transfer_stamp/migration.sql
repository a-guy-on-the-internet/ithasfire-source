-- Payout batch review fixes: month attribution + dispute-debt recovery.
--
-- Two columns on PayoutItem, both purely additive with constant DEFAULT/NULL
-- (PG 11+ does not rewrite the table). Backfill semantics are honest for both:
-- nothing was ever withheld for debt before this migration, and no historical
-- row recorded WHEN its transfer landed.
--
--  * PayoutItem.transferredAt — when the Stripe transfer actually EXECUTED.
--    Stripe bills its $2 monthly active-account fee for the calendar month a
--    payout LANDS, not the month the PayoutItem row was created; keying the
--    "already active this month?" question on createdAt misattributes a fee
--    whenever a pending item straddles a month boundary before transferring.
--    The period query filters on transferredAt and falls back to createdAt
--    ONLY for legacy rows where transferredAt IS NULL — for those, creation
--    and transfer happened in the same batch run, so createdAt is a faithful
--    proxy. NULL (not a backfill from createdAt) is the correct value here
--    precisely so that fallback stays scoped to pre-migration rows.
--
--  * PayoutItem.recoveredDebtCents — dispute-debt withheld from this item's
--    transfer. Lost membership disputes debit the payee ledger
--    (PayeeLedgerEntry DISPUTE_DEBIT → negative ledgerBalanceCents); the batch
--    recovers that debt by withholding from the next payout, debt FIRST, then
--    the connect-account fee. The transfer sent to Stripe is
--    `amountCents - recoveredDebtCents - connectAccountFeeCents`; amountCents
--    stays GROSS (it must keep equalling the sum of the linked Settlement
--    rows). Unlike the $2 fee, debt recovery may consume the ENTIRE payout —
--    in that case no Stripe transfer is created and the row completes as
--    "transferred" with a NULL stripeTransferId. Stamped at PayoutItem
--    creation on the already-claimed settlement set and never recomputed, the
--    same idempotency discipline connectAccountFeeCents follows. DEFAULT 0
--    backfills honestly: no existing payout ever withheld debt.

-- AlterTable
ALTER TABLE "PayoutItem" ADD COLUMN "recoveredDebtCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PayoutItem" ADD COLUMN "transferredAt" TIMESTAMP(3);
