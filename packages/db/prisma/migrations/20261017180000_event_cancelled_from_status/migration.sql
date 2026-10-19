-- Public calendar feeds (owner ruling 2026-10-17): a show that was not
-- PUBLISHED at the moment it was cancelled stays out of the feeds.
-- `publishedAt` survives unpublish, so it cannot say that; this column records
-- the status the row had when `EventsRepo.cancel` flipped it to CANCELLED.
--
-- Nullable, no default, no backfill: a metadata-only ALTER (no table rewrite,
-- brief ACCESS EXCLUSIVE lock only). Existing CANCELLED rows stay NULL, and
-- the feeds EXCLUDE NULL. Nothing recorded the pre-cancel status before now
-- (the "cancelled" audit row carries no from-status, unpublish writes no audit
-- row, and EventChangeNotice rows are purged after dispatch), so there is
-- nothing trustworthy to backfill from. Excluding NULL costs subscribers
-- nothing: the cancelled-in-feed read ships with this column, and the code
-- before it dropped cancelled events from the feeds silently, so no
-- subscriber's calendar holds an entry for a row cancelled before now.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "cancelledFromStatus" "EventStatus";
