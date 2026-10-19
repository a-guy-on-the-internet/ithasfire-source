-- Saved-events watchlist (spec 2026-07-01/saved-events-watchlist).
-- Private per-human event bookmarks; save doubles as WATCHING for the
-- change-notification audience (savers ∪ RSVPers). Fully additive: one new
-- table, no changes to Event (NFR-002). Cascades from Event and Human hard-
-- delete their saves (FR-007).

-- CreateTable
CREATE TABLE "EventSave" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventSave_eventId_humanId_key" ON "EventSave"("eventId", "humanId");

-- CreateIndex
CREATE INDEX "EventSave_humanId_createdAt_idx" ON "EventSave"("humanId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventSave" ADD CONSTRAINT "EventSave_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSave" ADD CONSTRAINT "EventSave_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
