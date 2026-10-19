-- Capture Stripe's per-dispute fee.
--
-- Until now the webhook read `dispute.amount` only and nothing read
-- `balance_transactions`, so the dispute fee was invisible — meaning dispute
-- COST could not be measured on ticketing either, where a single $15 fee
-- erases roughly 30 tickets of platform revenue.
--
-- `feeCents` is summed across the dispute's balance transactions rather than
-- taken from the first: a WON dispute receives a reversing balance transaction
-- carrying a negative fee, so the sum returns to 0 with no special-casing.
--
-- `feeBorneBy` is nullable because the fee is typically absent at
-- `charge.dispute.created` and only materialises at `funds_withdrawn`; null
-- means "not yet observed", not "nobody pays".
--
-- Existing rows backfill to 0 / NULL, which is honest: we never captured the
-- fee for them and inventing a $15 default would fabricate financial data.

-- CreateEnum
CREATE TYPE "DisputeFeeBearer" AS ENUM ('PLATFORM', 'PAYEE');

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN "feeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Dispute" ADD COLUMN "feeBorneBy" "DisputeFeeBearer";
