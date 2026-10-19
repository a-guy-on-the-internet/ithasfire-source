-- Event-change notification outbox (spec 2026-07-01/community-listing-change-
-- notifications). A use-case that cancels/reschedules/venue-changes/archives/
-- unpublishes an event writes one EventChangeNotice row inside the SAME
-- repos.tx as the mutation (transactional outbox, mirrors
-- pending_object_deletions). A scheduled jobs-service task later drains
-- undispatched rows (dispatchedAt IS NULL, oldest first) and fans out to
-- watchers. Fully additive: one new enum + one new table, cascading from
-- Event on hard-delete. No changes to Event's own columns.
--
-- Assembled from `prisma migrate diff --from-config-datasource --to-schema`,
-- EXCLUDING the following pre-existing drift already documented by the
-- 20260701120000_add_community_listings + 20260702150000_add_volunteer_rewards
-- migrations — these are intentional Prisma-inexpressible constructs, NOT part
-- of this change and deliberately left out here:
--   * AlterEnum "EventCategoryRequestKind" (EVENT_TYPE value retained in DB)
--   * DropIndex "AcceptanceRecord_human_doc_version_scope_key" (raw partial key)
--   * DropIndex "search_doc_*" (6 raw GIN/GiST/trigram indexes)
--   * AlterTable "SearchDocument" DROP DEFAULT (generated-column raw defaults)

-- CreateEnum
CREATE TYPE "EventChangeType" AS ENUM ('CANCELLED', 'RESCHEDULED', 'VENUE_CHANGED', 'ARCHIVED', 'UNPUBLISHED');

-- CreateTable
CREATE TABLE "EventChangeNotice" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "changeType" "EventChangeType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- Durable per-recipient dedup: humanIds already notified for this notice.
    -- The drain subtracts these before fanning out so a partial fan-out that
    -- retries only re-targets the still-un-notified remainder (no duplicate
    -- sends across the notify idempotency TTL).
    "notifiedHumanIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "EventChangeNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventChangeNotice_dispatchedAt_createdAt_idx" ON "EventChangeNotice"("dispatchedAt", "createdAt");

-- CreateIndex
CREATE INDEX "EventChangeNotice_eventId_idx" ON "EventChangeNotice"("eventId");

-- AddForeignKey
ALTER TABLE "EventChangeNotice" ADD CONSTRAINT "EventChangeNotice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
