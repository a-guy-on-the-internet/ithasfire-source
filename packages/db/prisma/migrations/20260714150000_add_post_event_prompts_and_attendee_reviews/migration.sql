-- Post-event prompt outbox + attendee reviews (2026-07-14).
--
-- PostEventPrompt: the SHARED post-event solicitation outbox mandated by both
-- booking-review-data-weave WS3 (FR-009/FR-010, PERFORMER audience) and
-- attendee-reviews FR-006 (ATTENDEE audience). One pipeline, discriminated by
-- `audience`; @@unique(eventId, humanId, audience) is the enqueue idempotency
-- anchor (one prompt, sent once, no reminders).
--
-- AttendeeReview: verified scanned-ticket-only reviews (attendee-reviews
-- FR-001), one per (eventId, humanId), with aggregation targets denormalized
-- at submit time (placeId, ownerType/ownerId, seriesId) and moderation flags.
-- See packages/db/prisma/post-event-prompt.prisma / attendee-review.prisma.

-- CreateEnum
CREATE TYPE "PostEventPromptAudience" AS ENUM ('PERFORMER', 'ATTENDEE');

-- CreateEnum
CREATE TYPE "PostEventPromptStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "PostEventPrompt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "placeId" TEXT,
    "audience" "PostEventPromptAudience" NOT NULL,
    "status" "PostEventPromptStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostEventPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendeeReview" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "overallRating" INTEGER NOT NULL,
    "soundQuality" INTEGER,
    "venueComfort" INTEGER,
    "organization" INTEGER,
    "valueForMoney" INTEGER,
    "text" VARCHAR(2000),
    "placeId" TEXT,
    "ownerType" TEXT,
    "ownerId" TEXT,
    "seriesId" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendeeReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostEventPrompt_eventId_humanId_audience_key" ON "PostEventPrompt"("eventId", "humanId", "audience");

-- CreateIndex
CREATE INDEX "PostEventPrompt_status_createdAt_idx" ON "PostEventPrompt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PostEventPrompt_humanId_idx" ON "PostEventPrompt"("humanId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendeeReview_eventId_humanId_key" ON "AttendeeReview"("eventId", "humanId");

-- CreateIndex
CREATE INDEX "AttendeeReview_humanId_idx" ON "AttendeeReview"("humanId");

-- CreateIndex
CREATE INDEX "AttendeeReview_placeId_idx" ON "AttendeeReview"("placeId");

-- CreateIndex
CREATE INDEX "AttendeeReview_ownerType_ownerId_idx" ON "AttendeeReview"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "AttendeeReview_seriesId_idx" ON "AttendeeReview"("seriesId");

-- AddForeignKey
ALTER TABLE "PostEventPrompt" ADD CONSTRAINT "PostEventPrompt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostEventPrompt" ADD CONSTRAINT "PostEventPrompt_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeReview" ADD CONSTRAINT "AttendeeReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendeeReview" ADD CONSTRAINT "AttendeeReview_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
