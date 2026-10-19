-- Volunteer shift occurrences + claims (generic-volunteer-shifts-occurrences
-- FR-001, phase A).
--
-- VolunteerShiftOccurrence: a concrete dated slot on a STANDING (non-EVENT)
-- ask role, absolute UTC. `patternId` is a plain nullable column reserved for
-- phase B's VolunteerShiftPattern materializer — NO FK yet (the pattern model
-- does not exist); the @@unique([patternId, startsAt]) lands now so the
-- phase B materializer's idempotent insert has its anchor from day one.
-- Postgres treats NULLs as distinct, so one-off (pattern-less) occurrences
-- are unconstrained by that unique.
--
-- VolunteerOccurrenceClaim: one volunteer's commitment to one occurrence.
-- @@unique([occurrenceId, signupId]) is the claim idempotency anchor — a
-- withdrawn row flips back to CLAIMED on re-claim rather than duplicating.

-- CreateEnum
CREATE TYPE "VolunteerOccurrenceStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VolunteerOccurrenceClaimStatus" AS ENUM ('CLAIMED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "VolunteerOccurrenceClaimSource" AS ENUM ('SELF', 'ASSIGNED');

-- CreateTable
CREATE TABLE "VolunteerShiftOccurrence" (
    "id" TEXT NOT NULL,
    "askId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "patternId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "notes" TEXT,
    "status" "VolunteerOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerShiftOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerOccurrenceClaim" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "status" "VolunteerOccurrenceClaimStatus" NOT NULL DEFAULT 'CLAIMED',
    "source" "VolunteerOccurrenceClaimSource" NOT NULL DEFAULT 'SELF',
    "checkedInAt" TIMESTAMP(3),
    "hoursWorked" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerOccurrenceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerShiftOccurrence_patternId_startsAt_key" ON "VolunteerShiftOccurrence"("patternId", "startsAt");

-- CreateIndex
CREATE INDEX "VolunteerShiftOccurrence_askId_startsAt_idx" ON "VolunteerShiftOccurrence"("askId", "startsAt");

-- CreateIndex
CREATE INDEX "VolunteerShiftOccurrence_roleId_startsAt_idx" ON "VolunteerShiftOccurrence"("roleId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerOccurrenceClaim_occurrenceId_signupId_key" ON "VolunteerOccurrenceClaim"("occurrenceId", "signupId");

-- CreateIndex
CREATE INDEX "VolunteerOccurrenceClaim_signupId_status_idx" ON "VolunteerOccurrenceClaim"("signupId", "status");

-- CreateIndex
CREATE INDEX "VolunteerOccurrenceClaim_occurrenceId_status_idx" ON "VolunteerOccurrenceClaim"("occurrenceId", "status");

-- AddForeignKey
ALTER TABLE "VolunteerShiftOccurrence" ADD CONSTRAINT "VolunteerShiftOccurrence_askId_fkey" FOREIGN KEY ("askId") REFERENCES "VolunteerAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerShiftOccurrence" ADD CONSTRAINT "VolunteerShiftOccurrence_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "EventVolunteerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerOccurrenceClaim" ADD CONSTRAINT "VolunteerOccurrenceClaim_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "VolunteerShiftOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerOccurrenceClaim" ADD CONSTRAINT "VolunteerOccurrenceClaim_signupId_fkey" FOREIGN KEY ("signupId") REFERENCES "VolunteerSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
