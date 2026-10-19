-- Order.kind discriminator + nullable Order.eventId.
--
-- Membership invoices are materialised as Orders so settlement, refunds, the
-- ledger and dispute holds all work unchanged — but a membership has no event,
-- so `eventId` must become nullable.
--
-- `kind` is added in the SAME migration deliberately: it gives every existing
-- consumer a POSITIVE narrowing (`kind = 'TICKETING'`) instead of forcing them
-- to null-check `eventId`. Ticket-only read models keep their non-null types
-- and gain a kind filter; only genuinely mixed reads go nullable.
--
-- All three statements are non-destructive and fast:
--   * ADD COLUMN with a constant DEFAULT does not rewrite the table (PG 11+).
--   * DROP NOT NULL is a catalogue-only change.
--   * Every existing row is a ticketing order, so the DEFAULT backfills
--     correctly with no data migration.
--
-- NOTE for the eventual production run: CREATE INDEX takes an ACCESS EXCLUSIVE
-- lock. On a large Order table prefer CREATE INDEX CONCURRENTLY, which cannot
-- run inside Prisma's per-migration transaction and therefore needs to be
-- applied out-of-band.

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('TICKETING', 'MEMBERSHIP');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "kind" "OrderKind" NOT NULL DEFAULT 'TICKETING';

ALTER TABLE "Order" ALTER COLUMN "eventId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Order_kind_idx" ON "Order"("kind");
