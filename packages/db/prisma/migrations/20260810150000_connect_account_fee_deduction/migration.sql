-- Stripe Connect $2 monthly active-account fee: recovered as a payout DEDUCTION.
--
-- Stripe bills the PLATFORM $2 per Express connected account, but only for
-- calendar months in which that account RECEIVES a payout. Dormant accounts
-- cost nothing. So the fee is triggered by the payout, not by the membership —
-- and the fix is to withhold it from the payout rather than to gate who may
-- have one. Collecting it separately would burn ~$0.36 in processing to
-- recover $2, an 18% loss on the recovery, so no charge object is ever created.
--
-- Two columns, both purely additive with constant DEFAULTs (PG 11+ does not
-- rewrite the table), and both backfill to 0 — which is the honest value:
-- nothing was ever withheld before this migration.
--
--  * FeePolicy.connectAccountFeeCents — the knob. NOT `monthlyPayoutCents`,
--    which already exists two lines above it: that one lives in the per-ticket
--    PRICING block (threaded into payoutTermsPolicySchema next to payoutPct /
--    payoutFixedCents and editable on the platform fee form), so it means "a
--    monthly processor cost component of ticket pricing". This is a withholding
--    applied once per payee per month at PAYOUT time. Overloading one integer
--    with both meanings would make a future pricing edit silently change what
--    we withhold from someone's payout.
--
--    DEFAULT 0 means the recovery is OFF until the platform explicitly sets it
--    to 200 on the GLOBAL policy. Applying this migration therefore cannot
--    change a single existing payout amount.
--
--  * PayoutItem.connectAccountFeeCents — the audit record. `amountCents` stays
--    GROSS (it must keep equalling the sum of the linked Settlement rows, which
--    is what reconciliation leans on); the Stripe transfer is sent for
--    `amountCents - connectAccountFeeCents`, and the withheld cents simply stay
--    on the platform balance. Storing the deduction on the row is also what
--    makes a re-run idempotent: the batch computes it once, at PayoutItem
--    creation, on the already-claimed settlement set.

-- AlterTable
ALTER TABLE "FeePolicy" ADD COLUMN "connectAccountFeeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PayoutItem" ADD COLUMN "connectAccountFeeCents" INTEGER NOT NULL DEFAULT 0;
