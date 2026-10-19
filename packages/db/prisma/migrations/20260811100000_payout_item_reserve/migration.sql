-- Rolling reserve on membership payouts (spec 2026-08-05, "Dispute policy"):
-- "hold a small percentage of membership revenue for 90 days, released if no
-- dispute lands. A reserve is deferred payout, not revenue… It must apply to
-- NEW and unproven payees from day one and season down with history."
--
-- Two audit columns on PayoutItem, mirroring the existing deduction stamps
-- (recoveredDebtCents / connectAccountFeeCents): `amountCents` stays GROSS
-- (it must keep equalling the sum of the linked Settlement rows — the
-- reconciliation invariant), and the Stripe transfer is sent for
--
--   amountCents - recoveredDebtCents - reserveHeldCents
--               - connectAccountFeeCents + reserveReleasedCents
--
--  * PayoutItem.reserveHeldCents — cents DEFERRED out of this transfer,
--    computed on the payout's MEMBERSHIP portion only, at the seasoning-curve
--    rate (packages/core/src/use-cases/settlements/membership-reserve.ts; a
--    platform admin can pin a rate via MembershipStanding). Stamped once at
--    PayoutItem creation on the already-claimed settlement set, never
--    recomputed — same replay-safety discipline as the other two deductions.
--    The deferred cents live on PayeeLedgerBalance.reserveBalanceCents via a
--    RESERVE_HOLD ledger entry until they mature.
--
--  * PayoutItem.reserveReleasedCents — matured reserve RETURNED on this
--    transfer. Stamped pre-transfer so the transfer amount is read off the
--    persisted row; the RESERVE_RELEASE ledger entries are written only after
--    the transfer executes (a failed transfer must leave the holds untouched),
--    with the batch's pre-run sweep as the crash heal.
--
-- Both purely additive with constant DEFAULTs (PG 11+ does not rewrite the
-- table), and both backfill to 0 — the honest value: nothing was ever
-- reserved before this migration.

-- AlterTable
ALTER TABLE "PayoutItem" ADD COLUMN "reserveHeldCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PayoutItem" ADD COLUMN "reserveReleasedCents" INTEGER NOT NULL DEFAULT 0;
