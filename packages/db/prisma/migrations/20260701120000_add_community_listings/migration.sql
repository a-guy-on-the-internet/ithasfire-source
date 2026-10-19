-- Community-managed event listings (spec 2026-07-01).
-- Adds two axes to Event (attendance mode + stewardship), the anonymous
-- edit-suggestion queue, moderator applications, and personal RSVP rows.
-- Existing events backfill to TICKETED + OWNED via column defaults (NFR-003);
-- no downtime, fully additive.

-- AlterEnum
-- New HumanRole for verified community moderators. Kept first and never
-- referenced by any DML in this migration: ALTER TYPE ... ADD VALUE'd values
-- cannot be used inside the same transaction that added them.
ALTER TYPE "HumanRole" ADD VALUE 'COMMUNITY_MODERATOR';

-- CreateEnum
CREATE TYPE "EventAttendanceMode" AS ENUM ('TICKETED', 'RSVP');

-- CreateEnum
CREATE TYPE "EventStewardship" AS ENUM ('OWNED', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "EventEditSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CommunityModeratorApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "attendance_mode" "EventAttendanceMode" NOT NULL DEFAULT 'TICKETED',
ADD COLUMN     "stewardship" "EventStewardship" NOT NULL DEFAULT 'OWNED';

-- Check constraint (FR-002): COMMUNITY direction ONLY — a COMMUNITY event
-- must be ownerless AND RSVP. The OWNED => has-owner direction is deliberately
-- NOT DB-enforced: Event.humanId is ON DELETE SET NULL, so human deletion
-- (admin-delete-human / GDPR erasure) already orphans personal OWNED events;
-- a bidirectional constraint would abort that path and could fail validation
-- against existing orphaned rows. OWNED => has-owner stays a use-case-layer
-- invariant on the creation paths (Wikipedia analog: content is ownerless and
-- account removal never cascades into content).
-- Event.humanId / Event.orgId have no @map, so the DB columns are camelCase.
ALTER TABLE "Event" ADD CONSTRAINT "event_community_ownerless_rsvp_check" CHECK (
    "stewardship" = 'OWNED'
    OR ("humanId" IS NULL AND "orgId" IS NULL AND "attendance_mode" = 'RSVP')
);

-- CreateTable
CREATE TABLE "EventEditSuggestion" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "submitterHumanId" TEXT,
    "submitterIp" TEXT,
    "fields" JSONB NOT NULL,
    "baseVersion" JSONB NOT NULL,
    "note" TEXT,
    "status" "EventEditSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "appliedFields" JSONB,
    "conflictedFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventEditSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityModeratorApplication" (
    "id" TEXT NOT NULL,
    "applicantHumanId" TEXT NOT NULL,
    "statement" TEXT,
    "status" "CommunityModeratorApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityModeratorApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRsvp" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRsvp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventEditSuggestion_status_createdAt_idx" ON "EventEditSuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EventEditSuggestion_eventId_status_idx" ON "EventEditSuggestion"("eventId", "status");

-- CreateIndex
CREATE INDEX "CommunityModeratorApplication_status_createdAt_idx" ON "CommunityModeratorApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityModeratorApplication_applicantHumanId_status_idx" ON "CommunityModeratorApplication"("applicantHumanId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EventRsvp_eventId_humanId_key" ON "EventRsvp"("eventId", "humanId");

-- CreateIndex
CREATE INDEX "EventRsvp_humanId_idx" ON "EventRsvp"("humanId");

-- AddForeignKey
ALTER TABLE "EventEditSuggestion" ADD CONSTRAINT "EventEditSuggestion_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRsvp" ADD CONSTRAINT "EventRsvp_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRsvp" ADD CONSTRAINT "EventRsvp_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
