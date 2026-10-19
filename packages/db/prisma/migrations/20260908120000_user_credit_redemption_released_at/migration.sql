-- UserCreditRedemption.releasedAt — the redemption was UNDONE because the
-- PENDING order it was applied to died before it was paid.
--
-- Checkout spends credit, it does not hold it: `redeemConditional` debits
-- `UserCredit.balanceCents` (REDEEMED at zero) and `recordRedemption` pins the
-- cents to the order. Seats, promo holds, fee-waiver allowance and capacity
-- all have a release path for the cart-cancel cases (card decline then retry,
-- cart expiry, buyer-initiated release, stale cart after a sibling succeeded);
-- credit had none, so a staff-granted goodwill credit vanished on the first
-- decline. `releaseForOrder` restores the balance and stamps this column so a
-- replay (reaper racing a buyer release) is a no-op.
--
-- Distinct from `refundedAt`, which reverses a redemption on a SUCCEEDED
-- order under refund policy. A row carries at most one of the two.
--
-- Nullable, no backfill, no default. Additive; re-applicable.

-- AlterTable
ALTER TABLE "UserCreditRedemption" ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);
