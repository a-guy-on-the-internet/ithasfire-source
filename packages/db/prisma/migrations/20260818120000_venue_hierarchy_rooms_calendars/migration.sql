-- Venue hierarchy — rooms, calendars, availability, booking threads
-- (spec 2026-08-18 venue-hierarchy-and-holds, near-term scope; the Hold layer
-- is DEFERRED and nothing here models it).
--
-- Room     = physical resource (child of Place) conflicts resolve to.
-- Calendar = named public programming stream, M:N to Rooms via CalendarRoom.
-- CalendarAvailability = per-calendar windows/blackouts; calendarId NULL =
--   place-wide row (applies to every calendar of the place).
-- BookingRequestMessage = per-request conversation thread (2026-07-14
--   booking-conversation spec FR-001; the request IS the thread).
-- BookingRequest gains calendar routing, tags, attachments, and a tax-form
--   FLAG (never TIN/identity storage). Event gains nullable roomId/calendarId
--   (SetNull — deleting a room/calendar never deletes events).
--
-- Fully additive; no backfill (greenfield — seed code mints defaults).
--
-- Assembled from `prisma migrate diff --from-config-datasource --to-schema
-- packages/db/prisma --script`, EXCLUDING the following pre-existing drift —
-- intentional Prisma-inexpressible (or Postgres-mangled) constructs, NOT part
-- of this change and deliberately left out here:
--   * AlterEnum "EventCategoryRequestKind" (EVENT_TYPE value retained in DB —
--     residual deliberately left by 20260517190000_drop_event_types)
--   * DropIndex "search_doc_*" (6 raw GIN/GiST/trigram indexes) + AlterTable
--     "SearchDocument" DROP DEFAULT (generated-column raw defaults)
--   * DropIndex "AcceptanceRecord_human_doc_version_scope_key" (raw partial key)
--   * RenameIndex "MembershipTaxJurisdiction_countryCode_postalCode_…" —
--     20260810130000_membership_models created a 65-char index name that
--     Postgres silently truncated to 63 bytes; Prisma's own truncation of the
--     expected name differs, so the diff proposes the rename forever.

-- CreateEnum
CREATE TYPE "BookingTaxFormStatus" AS ENUM ('NONE', 'REQUESTED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "BookingMessageAuthorSide" AS ENUM ('VENUE', 'PERFORMER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "calendarId" TEXT,
ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "taxFormStatus" "BookingTaxFormStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "calendar_id" TEXT,
ADD COLUMN     "room_id" TEXT;

-- AlterTable
ALTER TABLE "Place" ADD COLUMN     "timezone" TEXT;

-- CreateTable
CREATE TABLE "BookingRequestAttachment" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingRequestAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Calendar" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "defaultStartTime" TEXT,
    "defaultCategoryId" TEXT,
    "eventTemplate" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarRoom" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarAvailability" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "calendarId" TEXT,
    "dayOfWeek" INTEGER,
    "date" TIMESTAMP(3),
    "startTime" TEXT,
    "endTime" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequestMessage" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "authorSide" "BookingMessageAuthorSide" NOT NULL,
    "authorHumanId" TEXT,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingRequestMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingRequestAttachment_bookingRequestId_idx" ON "BookingRequestAttachment"("bookingRequestId");

-- CreateIndex
CREATE INDEX "Room_placeId_status_idx" ON "Room"("placeId", "status");

-- CreateIndex
CREATE INDEX "Calendar_placeId_idx" ON "Calendar"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "Calendar_placeId_slug_key" ON "Calendar"("placeId", "slug");

-- CreateIndex (FK maintenance on category deletion — SetNull scans by defaultCategoryId)
CREATE INDEX "Calendar_defaultCategoryId_idx" ON "Calendar"("defaultCategoryId");

-- CreateIndex
CREATE INDEX "CalendarRoom_roomId_idx" ON "CalendarRoom"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarRoom_calendarId_roomId_key" ON "CalendarRoom"("calendarId", "roomId");

-- CreateIndex
CREATE INDEX "CalendarAvailability_placeId_idx" ON "CalendarAvailability"("placeId");

-- CreateIndex
CREATE INDEX "CalendarAvailability_calendarId_idx" ON "CalendarAvailability"("calendarId");

-- CreateIndex
CREATE INDEX "BookingRequestMessage_bookingRequestId_createdAt_idx" ON "BookingRequestMessage"("bookingRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_calendarId_status_idx" ON "BookingRequest"("calendarId", "status");

-- CreateIndex
CREATE INDEX "Event_room_id_startsAt_idx" ON "Event"("room_id", "startsAt");

-- CreateIndex
CREATE INDEX "Event_calendar_id_startsAt_idx" ON "Event"("calendar_id", "startsAt");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestAttachment" ADD CONSTRAINT "BookingRequestAttachment_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "Calendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Calendar" ADD CONSTRAINT "Calendar_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Calendar" ADD CONSTRAINT "Calendar_defaultCategoryId_fkey" FOREIGN KEY ("defaultCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarRoom" ADD CONSTRAINT "CalendarRoom_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarRoom" ADD CONSTRAINT "CalendarRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarAvailability" ADD CONSTRAINT "CalendarAvailability_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarAvailability" ADD CONSTRAINT "CalendarAvailability_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestMessage" ADD CONSTRAINT "BookingRequestMessage_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── At most one default Calendar per Place (SQL-only backstop) ──────────────
-- Partial indexes are not expressible in the Prisma schema, so this exists in
-- SQL only (noted on the Calendar model in venue.prisma; house pattern:
-- 20260812130000_fee_policy_one_active_per_scope). App code flips isDefault
-- with a read-modify-write; this makes two racing writers collide with a
-- P2002 (meta.target "Calendar_placeId_default_key") instead of quietly
-- leaving a place with two default calendars.
CREATE UNIQUE INDEX "Calendar_placeId_default_key" ON "Calendar"("placeId") WHERE "isDefault";
