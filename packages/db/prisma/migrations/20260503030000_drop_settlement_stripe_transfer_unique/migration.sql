-- Settlement.stripeTransferId was historically declared UNIQUE in the
-- consolidated baseline migration, but the Prisma schema only marks it
-- @@index. A single Stripe Transfer covers a whole PayoutItem (which can
-- consolidate multiple Settlements for the same payee), so the same
-- transferId legitimately lands on N Settlement rows. The unique
-- constraint was breaking bulkMarkTransferred in any payout with N>1
-- settlements per payee. Drop the unique, recreate the lookup index that
-- the schema declares.

DROP INDEX IF EXISTS "Settlement_stripeTransferId_key";
CREATE INDEX IF NOT EXISTS "Settlement_stripeTransferId_idx" ON "Settlement"("stripeTransferId");
