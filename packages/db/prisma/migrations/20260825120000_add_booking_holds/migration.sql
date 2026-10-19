-- Booking holds (spec docs/specs/2026-08-25/booking-holds.spec.yaml, Step 1).
-- Adds BookingHold — a venue calendar hold on a booking request with an
-- ordered line per (calendar, date) and a challenge/keep/release/confirm
-- lifecycle (NOT the short-TTL POS/promo/resale inventory "hold") — plus the
-- two venue-internal workflow fields the hold notifications depend on:
-- BookingRequest.assigneeHumanId and org-scoped BookingTag +
-- BookingRequestTag. Fully additive; no backfill. The legacy
-- BookingRequest.tags String[] column is left in place (superseded, no new
-- writes).

-- CreateEnum
CREATE TYPE "BookingHoldStatus" AS ENUM ('ACTIVE', 'CHALLENGED', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BookingHoldReleaseReason" AS ENUM ('MANUAL', 'EXPIRED', 'CONFIRMED_OTHER', 'REQUEST_CLOSED', 'SIBLING_CONFIRMED', 'PAST_DATE');

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN "assigneeHumanId" TEXT;

-- CreateTable
CREATE TABLE "BookingHold" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "spaceId" TEXT,
    "date" DATE NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "BookingHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "placedByHumanId" TEXT NOT NULL,
    "challengedAt" TIMESTAMP(3),
    "respondBy" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedReason" "BookingHoldReleaseReason",
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingTag" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequestTag" (
    "bookingRequestId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BookingRequest_assigneeHumanId_status_idx" ON "BookingRequest"("assigneeHumanId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingHold_bookingRequestId_calendarId_date_key" ON "BookingHold"("bookingRequestId", "calendarId", "date");

-- CreateIndex
CREATE INDEX "BookingHold_calendarId_date_status_idx" ON "BookingHold"("calendarId", "date", "status");

-- CreateIndex
CREATE INDEX "BookingHold_bookingRequestId_status_idx" ON "BookingHold"("bookingRequestId", "status");

-- CreateIndex
CREATE INDEX "BookingHold_spaceId_idx" ON "BookingHold"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingTag_orgId_slug_key" ON "BookingTag"("orgId", "slug");

-- CreateIndex
CREATE INDEX "BookingTag_orgId_sortOrder_idx" ON "BookingTag"("orgId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequestTag_bookingRequestId_tagId_key" ON "BookingRequestTag"("bookingRequestId", "tagId");

-- CreateIndex
CREATE INDEX "BookingRequestTag_tagId_idx" ON "BookingRequestTag"("tagId");

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingTag" ADD CONSTRAINT "BookingTag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestTag" ADD CONSTRAINT "BookingRequestTag_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestTag" ADD CONSTRAINT "BookingRequestTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "BookingTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lazy-expiry sweep support (booking-holds FR-007): the only rows with a
-- meaningful respondBy are CHALLENGED ones, so a partial index keeps the
-- "which challenges have lapsed" scan tiny instead of indexing NULL on every
-- ACTIVE/CONFIRMED/RELEASED row. Partial indexes are not expressible in the
-- Prisma schema — SQL-only, noted on the BookingHold model in
-- agreement.prisma (same trick as "BookingRequest_open_pair_key",
-- 20260610120000, and "EntityReport_open_reporter_subject_key",
-- 20260817130000).
CREATE INDEX "BookingHold_challenged_respondBy_idx"
  ON "BookingHold"("respondBy")
  WHERE "status" = 'CHALLENGED';
