-- Backfill for 20260925180000_event_venue_confirmed_starts_at.
--
-- Every event carrying a live (not withdrawn) venue stamp gets
-- `venueConfirmedStartsAt = startsAt`: the best record of the date the venue
-- vouched for that exists. Includes a stamp that is dormant because the event
-- moved to another place (`venueConfirmedPlaceId <> placeId`) — moving it
-- back revives that stamp, and it must come back with its date.
--
-- A withdrawn stamp is left NULL: withdrawal clears the column (the stamp
-- arm does not hold for it), and a re-confirm writes a fresh one.
--
-- A stamped row that is still NULL after this (none should exist) reads as
-- "no recorded date" and core falls back to the live start — the behaviour
-- before this change, never a wider window.
--
-- Single statement. Idempotent: the `IS NULL` guard means a second run
-- matches nothing.
UPDATE "Event"
SET "venueConfirmedStartsAt" = "startsAt"
WHERE "venueConfirmedAt" IS NOT NULL
  AND "venueConfirmationWithdrawnAt" IS NULL
  AND "venueConfirmedStartsAt" IS NULL;
