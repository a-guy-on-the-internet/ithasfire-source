-- Booking-request attachment uploader columns (venue-hierarchy Step 5;
-- spec 2026-08-18 venue-hierarchy-and-holds, FR-008 refinement).
--
-- Enables the uploader-or-venue delete posture: the venue may delete any
-- attachment; the performer may delete ONLY performer-side uploads. Reuses
-- the existing 3-value "BookingMessageAuthorSide" enum — SYSTEM never
-- uploads; app code only ever writes VENUE | PERFORMER (documented on the
-- Prisma model and the record type; the adapter maps an out-of-contract
-- SYSTEM to null on read). Both columns are nullable: pre-existing rows have
-- no uploader and are treated as venue-managed.
--
-- Fully additive; no backfill. Assembled per the house pattern of
-- 20260818120000_venue_hierarchy_rooms_calendars (prisma migrate diff,
-- EXCLUDING that migration's same pre-existing intentional drift hunks:
-- AlterEnum "EventCategoryRequestKind", the SearchDocument raw-index /
-- generated-column drops, the "AcceptanceRecord_human_doc_version_scope_key"
-- raw partial key, and the truncated MembershipTaxJurisdiction index rename).

-- AlterTable
ALTER TABLE "BookingRequestAttachment" ADD COLUMN     "uploadedByHumanId" TEXT,
ADD COLUMN     "uploadedBySide" "BookingMessageAuthorSide";
