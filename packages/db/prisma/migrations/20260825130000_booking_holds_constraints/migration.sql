-- Booking holds — review follow-ups to 20260825120000_add_booking_holds
-- (spec docs/specs/2026-08-25/booking-holds.spec.yaml, Step 1). Forward-only
-- on top of the already-applied first migration; no data exists yet, so no
-- backfill. Changes:
--   1. The full-status unique on (bookingRequestId, calendarId, date) bricked
--      re-holding a date once released → replaced by a LIVE-only partial
--      unique.
--   2. NFR-002 is a LINE-level invariant (one CONFIRMED hold per
--      calendar+date), not only per-row → partial unique backstop.
--   3. respondBy exists only while CHALLENGED → CHECK.
--   4. The respondBy partial index served no query → dropped.
--   5. BookingRequestTag had no primary key → composite PK.
--   6. Calendar FK Cascade → Restrict (no calendar-delete path exists; a
--      future one must handle live holds explicitly).

-- DropIndex (full-status unique; replaced below by the live-only partial)
DROP INDEX "BookingHold_bookingRequestId_calendarId_date_key";

-- DropIndex (no reader; lazy expiry evaluates per row on read, never scans)
DROP INDEX "BookingHold_challenged_respondBy_idx";

-- One LIVE hold per request per calendar-day. RELEASED / CONFIRMED rows fall
-- outside the predicate, so a request can be re-held on a date it released.
-- SQL-only (Prisma can't express partial uniques — same trick as
-- "BookingRequest_open_pair_key", 20260610120000). The adapter maps this
-- index's P2002 on create to `booking_hold_exists`.
CREATE UNIQUE INDEX "BookingHold_live_request_date_key"
  ON "BookingHold"("bookingRequestId", "calendarId", "date")
  WHERE "status" IN ('ACTIVE', 'CHALLENGED');

-- One CONFIRMED hold per line (NFR-002 at line level). The per-row CAS in
-- updateStatus guards the same row; this guards two DIFFERENT rows in one
-- line being confirmed concurrently. The adapter maps this index's P2002 on
-- updateStatus to `booking_hold_line_confirmed`.
CREATE UNIQUE INDEX "BookingHold_confirmed_line_key"
  ON "BookingHold"("calendarId", "date")
  WHERE "status" = 'CONFIRMED';

-- respondBy is the keep-or-release deadline and is meaningful only while
-- CHALLENGED; the adapter nulls it on every other transition and this CHECK
-- backstops that.
ALTER TABLE "BookingHold"
  ADD CONSTRAINT "BookingHold_respondBy_challenged_check"
  CHECK ("respondBy" IS NULL OR "status" = 'CHALLENGED');

-- Calendar FK: Cascade → Restrict.
ALTER TABLE "BookingHold" DROP CONSTRAINT "BookingHold_calendarId_fkey";
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_calendarId_fkey"
  FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- BookingRequestTag: composite primary key replaces the bare unique.
DROP INDEX "BookingRequestTag_bookingRequestId_tagId_key";
ALTER TABLE "BookingRequestTag"
  ADD CONSTRAINT "BookingRequestTag_pkey" PRIMARY KEY ("bookingRequestId", "tagId");
