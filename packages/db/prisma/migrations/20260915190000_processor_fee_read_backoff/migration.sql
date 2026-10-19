-- Processor-fee sweep: retry bookkeeping so a permanently failing row cannot
-- starve the backlog.
--
-- settlements.backfill-processor-fees claims unstamped orders OLDEST FIRST.
-- Without failure memory, an order whose intent Stripe can never resolve is
-- retried every run, holds a page slot every run, and fires one Sentry event
-- every run; once `limit` such rows exist the sweep never reaches a newer
-- order and coverage freezes. These two columns let the claim query back a
-- failed row off and park it after a capped number of attempts.
--
-- NEITHER COLUMN IS MONEY. They are never read by a revenue or settlement
-- path, and they are not reset when "processorFeeCents" is finally stamped.
-- Existing rows start at 0 / NULL, i.e. "never failed", so the first sweep
-- after this migration behaves exactly as before.

ALTER TABLE "Order" ADD COLUMN "processorFeeReadFailures" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Order" ADD COLUMN "processorFeeReadFailedAt" TIMESTAMP(3);
