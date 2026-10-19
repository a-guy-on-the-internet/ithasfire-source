-- Venue hierarchy — rename the physical-resource entity Room → Space.
--
-- FINAL vocabulary (user-locked, second naming pass):
--   Place    = the physical location owned by an org (unchanged)
--   Space    = the physical, bookable resource conflicts resolve against
--              (main stage, back bar, patio) — THIS rename, was `Room`
--   Calendar = the named public programming stream (unchanged)
--
-- Pure rename: every statement is ALTER … RENAME. Nothing is dropped and
-- nothing is recreated, so seeded/live rows survive untouched (a
-- drop-and-recreate would silently lose every Space and every calendar↔space
-- join). Postgres does NOT cascade a table rename to its indexes or
-- constraints, so each one is renamed explicitly to keep the DB's object
-- names identical to what `prisma migrate diff` expects from the schema.
--
-- The Hold layer stays DEFERRED — nothing here models it
-- (docs/specs/2026-08-18/venue-hierarchy-and-holds.spec.yaml).
--
-- Assembled from `prisma migrate diff --from-config-datasource --to-schema
-- packages/db/prisma --script`, whose output was REWRITTEN from
-- drop/recreate into renames, and EXCLUDING the following pre-existing drift
-- — intentional Prisma-inexpressible (or Postgres-mangled) constructs, NOT
-- part of this change and deliberately left out here (same exclusion list as
-- 20260818120000_venue_hierarchy_rooms_calendars):
--   * AlterEnum "EventCategoryRequestKind" (EVENT_TYPE value retained in DB —
--     residual deliberately left by 20260517190000_drop_event_types)
--   * DropIndex "search_doc_*" (6 raw GIN/GiST/trigram indexes) + AlterTable
--     "SearchDocument" DROP DEFAULT (generated-column raw defaults)
--   * DropIndex "AcceptanceRecord_human_doc_version_scope_key" (raw partial key)
--   * RenameIndex "MembershipTaxJurisdiction_countryCode_postalCode_…" —
--     20260810130000_membership_models created a 65-char index name that
--     Postgres silently truncated to 63 bytes; Prisma's own truncation of the
--     expected name differs, so the diff proposes the rename forever.

-- ── Enum ────────────────────────────────────────────────────────────────────
ALTER TYPE "RoomStatus" RENAME TO "SpaceStatus";

-- ── Room → Space ────────────────────────────────────────────────────────────
ALTER TABLE "Room" RENAME TO "Space";
ALTER TABLE "Space" RENAME CONSTRAINT "Room_pkey" TO "Space_pkey";
ALTER TABLE "Space" RENAME CONSTRAINT "Room_placeId_fkey" TO "Space_placeId_fkey";
ALTER INDEX "Room_placeId_status_idx" RENAME TO "Space_placeId_status_idx";

-- ── CalendarRoom → CalendarSpace (+ its roomId column) ──────────────────────
ALTER TABLE "CalendarRoom" RENAME TO "CalendarSpace";
ALTER TABLE "CalendarSpace" RENAME COLUMN "roomId" TO "spaceId";
ALTER TABLE "CalendarSpace" RENAME CONSTRAINT "CalendarRoom_pkey" TO "CalendarSpace_pkey";
ALTER TABLE "CalendarSpace" RENAME CONSTRAINT "CalendarRoom_calendarId_fkey" TO "CalendarSpace_calendarId_fkey";
ALTER TABLE "CalendarSpace" RENAME CONSTRAINT "CalendarRoom_roomId_fkey" TO "CalendarSpace_spaceId_fkey";
ALTER INDEX "CalendarRoom_calendarId_roomId_key" RENAME TO "CalendarSpace_calendarId_spaceId_key";
ALTER INDEX "CalendarRoom_roomId_idx" RENAME TO "CalendarSpace_spaceId_idx";

-- ── Event.room_id → Event.space_id ──────────────────────────────────────────
ALTER TABLE "Event" RENAME COLUMN "room_id" TO "space_id";
ALTER TABLE "Event" RENAME CONSTRAINT "Event_room_id_fkey" TO "Event_space_id_fkey";
ALTER INDEX "Event_room_id_startsAt_idx" RENAME TO "Event_space_id_startsAt_idx";
