-- freeze-the-deal (docs/specs/2026-10-14/freeze-the-deal.spec.yaml).
-- FR-001: the freeze lives on the Event. Null = not frozen; a null
-- dealFrozenByHumanId with dealFrozenAt set = frozen automatically.
-- FR-005: one DealChange row per change made while frozen (append-only).
-- Additive only: two nullable columns and a new table. No backfill here; the
-- one-time freeze of already-published events is a script (FR-009).

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "dealFrozenAt" TIMESTAMP(3),
ADD COLUMN     "dealFrozenByHumanId" TEXT;

-- CreateTable
CREATE TABLE "DealChange" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,

    CONSTRAINT "DealChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealChange_eventId_createdAt_idx" ON "DealChange"("eventId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DealChange_actorHumanId_idx" ON "DealChange"("actorHumanId");

-- AddForeignKey
ALTER TABLE "DealChange" ADD CONSTRAINT "DealChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealChange" ADD CONSTRAINT "DealChange_actorHumanId_fkey" FOREIGN KEY ("actorHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_dealFrozenByHumanId_fkey" FOREIGN KEY ("dealFrozenByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
