-- Recurring dates for (community) event listings, slice 1.
-- ONE Event row + a child table of expanded occurrences (EventDate) defined by
-- an RRULE/FIXED_DATES schedule stored on Event.recurrence_schedule. Per-date
-- RSVPs get their table now (EventDateRsvp) but no use-cases yet (later slice).
-- Fully additive: single-date events keep NULL recurrence_schedule and zero
-- EventDate rows. Does not touch the community ownerless+RSVP check constraint.

-- CreateEnum
CREATE TYPE "EventDateStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "recurrence_schedule" JSONB;

-- CreateTable
CREATE TABLE "EventDate" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" "EventDateStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventDateRsvp" (
    "id" TEXT NOT NULL,
    "eventDateId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDateRsvp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventDate_eventId_ordinal_key" ON "EventDate"("eventId", "ordinal");

-- CreateIndex
CREATE INDEX "EventDate_eventId_startsAt_idx" ON "EventDate"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "EventDate_startsAt_idx" ON "EventDate"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventDateRsvp_eventDateId_humanId_key" ON "EventDateRsvp"("eventDateId", "humanId");

-- CreateIndex
CREATE INDEX "EventDateRsvp_humanId_idx" ON "EventDateRsvp"("humanId");

-- AddForeignKey
ALTER TABLE "EventDate" ADD CONSTRAINT "EventDate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDateRsvp" ADD CONSTRAINT "EventDateRsvp_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDateRsvp" ADD CONSTRAINT "EventDateRsvp_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
