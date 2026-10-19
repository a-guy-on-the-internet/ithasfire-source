-- Venue track record (docs/specs/2026-09-24/venue-track-record-and-review-switch,
-- FR-008 / FR-009 / NFR-005). A venue page gets a block computed from things
-- that HAPPENED at the place — shows hosted, people checked in at the door —
-- never from testimony. Until now PlaceStats carried NO scan data
-- (`avgAttendance` is tickets SOLD per show), so the six columns below are the
-- first door-derived figures on the row.
--
-- The columns (all written by recalculatePlaceStats, read by the block loader):
--   · showsHosted        past PUBLISHED PUBLIC venue-confirmed events at the
--                        place — `totalEventCount`'s basis, RSVP-only included
--   · firstShowAt        startsAt of the earliest such show (null when none)
--   · lastShowAt         startsAt of the latest such show (null when none)
--   · scannedEventCount  shows with at least ONE ticket where
--                        Ticket."scannedAt" IS NOT NULL
--   · checkedInTotal     scanned tickets summed across those shows
--   · checkedInAvg       checkedInTotal / scannedEventCount, NULL when
--                        scannedEventCount = 0. A show with zero scans is
--                        EXCLUDED from the mean, never counted as 0 (R4).
--
-- `avgAttendance` (tickets-sold basis) is left exactly as it is for its
-- existing readers; the track record never surfaces it.
--
-- ADDITIVE ONLY, DEFAULTS 0 / NULL, NO BACKFILL. A backfill here would be a
-- second, hand-written copy of the computation in recalculatePlaceStats, and
-- it is unnecessary: FR-008 broadens `listStalePlaceIds` so a place is stale
-- whenever a published event ended, a ticket was scanned, or an eligible order
-- changed since `lastCalculatedAt` — and ALWAYS when no PlaceStats row exists.
-- Every place with any history is therefore recomputed on the next
-- `*/15 * * * *` run, and a place with no history correctly reads 0 / NULL.
--
-- INDEXES (NFR-005 — the stale query and the scan count must be index-backed):
--   · Event (placeId, endsAt)     the "a PUBLISHED event at this place ENDED
--                                 since lastCalculatedAt" arm — per place, a
--                                 bounded range scan on endsAt. Event had
--                                 (placeId) and (placeId, venueConfirmedAt);
--                                 neither serves a range on endsAt.
--   · Ticket (eventId, scannedAt) TicketsRepo.countScannedByEvent and the
--                                 "a ticket at this place was scanned since
--                                 lastCalculatedAt" arm. Ticket had only
--                                 (eventId) — the existing (eventId, scannedAt)
--                                 index is on TicketScan, the append-only scan
--                                 LOG, not on the ticket's own checked-in stamp.
--
-- Plain CREATE INDEX (not CONCURRENTLY): prisma migrate deploy runs inside a
-- transaction, and both tables are small enough at this stage that the brief
-- share lock is the cheaper choice over a non-transactional migration.
--
-- Reversible: DROP INDEX × 2, then ALTER TABLE "PlaceStats" DROP COLUMN × 6.
-- Nothing else reads the columns until the core/adapter steps that follow.

ALTER TABLE "PlaceStats"
  ADD COLUMN "showsHosted"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "firstShowAt"       TIMESTAMP(3),
  ADD COLUMN "lastShowAt"        TIMESTAMP(3),
  ADD COLUMN "scannedEventCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkedInTotal"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkedInAvg"      INTEGER;

CREATE INDEX "Event_placeId_endsAt_idx" ON "Event"("placeId", "endsAt");

CREATE INDEX "Ticket_eventId_scannedAt_idx" ON "Ticket"("eventId", "scannedAt");
