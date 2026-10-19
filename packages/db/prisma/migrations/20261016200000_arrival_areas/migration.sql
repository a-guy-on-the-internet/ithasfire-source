-- CreateEnum
CREATE TYPE "ArrivalAreaKind" AS ENUM ('PARKING', 'ACCESSIBLE_DROP_OFF', 'LOAD_IN');

-- CreateEnum
CREATE TYPE "ArrivalAreaCost" AS ENUM ('FREE', 'PAID', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ArrivalArea" (
    "id" TEXT NOT NULL,
    "placeId" TEXT,
    "eventId" TEXT,
    "kind" "ArrivalAreaKind" NOT NULL,
    "geometry" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "cost" "ArrivalAreaCost" NOT NULL DEFAULT 'UNKNOWN',
    "priceText" TEXT,
    "note" TEXT,
    "accessibleSpots" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "createdByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArrivalArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventArrivalAreaHide" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "arrivalAreaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventArrivalAreaHide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArrivalArea_placeId_idx" ON "ArrivalArea"("placeId");

-- CreateIndex
CREATE INDEX "ArrivalArea_eventId_idx" ON "ArrivalArea"("eventId");

-- CreateIndex
CREATE INDEX "ArrivalArea_createdByHumanId_idx" ON "ArrivalArea"("createdByHumanId");

-- CreateIndex
CREATE INDEX "EventArrivalAreaHide_arrivalAreaId_idx" ON "EventArrivalAreaHide"("arrivalAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "EventArrivalAreaHide_eventId_arrivalAreaId_key" ON "EventArrivalAreaHide"("eventId", "arrivalAreaId");

-- AddForeignKey
ALTER TABLE "ArrivalArea" ADD CONSTRAINT "ArrivalArea_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalArea" ADD CONSTRAINT "ArrivalArea_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalArea" ADD CONSTRAINT "ArrivalArea_createdByHumanId_fkey" FOREIGN KEY ("createdByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventArrivalAreaHide" ADD CONSTRAINT "EventArrivalAreaHide_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventArrivalAreaHide" ADD CONSTRAINT "EventArrivalAreaHide_arrivalAreaId_fkey" FOREIGN KEY ("arrivalAreaId") REFERENCES "ArrivalArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An arrival area belongs to exactly one parent: a place (shown on every event
-- there) or an event (event-only). Prisma cannot express this, so it lives
-- here; the schema comment on ArrivalArea names it.
ALTER TABLE "ArrivalArea" ADD CONSTRAINT "ArrivalArea_parent_xor"
    CHECK (num_nonnulls("placeId", "eventId") = 1);
