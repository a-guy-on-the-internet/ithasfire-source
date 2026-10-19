-- Platform P&L cost inputs.
--
-- Both columns are NULLABLE and both mean "not attributed", never zero. They
-- are costs netted against platform revenue, so a missing value read as 0
-- would OVERSTATE what the platform kept. Consumers report coverage and
-- refuse to compute a net below full coverage.
--
-- No backfill, deliberately:
--   * "Order"."processorFeeCents" is filled by the settlements.backfill-processor-fees
--     sweep, which reads each charge's real Stripe balance transaction. A rate-card
--     estimate would be indistinguishable from a measured value once stored.
--   * "OrderItem"."refundedPlatformFeeCents" can only be measured at refund
--     execution. For refunds already issued the breakdown survives only in
--     audit-log JSON, so those rows stay NULL permanently.

ALTER TABLE "Order" ADD COLUMN "processorFeeCents" INTEGER;

ALTER TABLE "OrderItem" ADD COLUMN "refundedPlatformFeeCents" INTEGER;

-- No index. Prisma cannot express a partial index, so one created only in raw
-- SQL shows up as drift the next time somebody runs `migrate dev`. The sweep
-- that reads this column is a background job with no latency contract, and a
-- predicate that starts by matching EVERY row would index the whole table on
-- day one anyway — it only earns its keep once mostly filled. Revisit with a
-- real @@index if the sweep ever shows up in slow queries.
