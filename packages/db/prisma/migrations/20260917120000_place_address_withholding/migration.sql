-- Place address withholding.
--
-- Gives a Place the SAME three-state location-privacy model an Event already
-- has, so a DIY house can list as a venue without ever publishing where it is.
-- Reuses the existing "EventLocationMode" enum on purpose: an event INHERITS
-- its place's obscurity as a hard floor, and a parallel enum would let the two
-- axes drift apart.
--
-- ADDITIVE ONLY. Every existing row keeps its current behaviour:
--   · location_mode defaults to 'EXACT' → all pre-existing venues are unchanged
--     and are NOT backfilled;
--   · location_radius_meters defaults to NULL, which under OBSCURED is the
--     documented FULLY-HIDDEN sentinel (fail-closed: a venue flipped to
--     OBSCURED without choosing a radius is hidden, never approximated);
--   · location_label defaults to NULL → the redactor falls back to
--     "city, region".
--
-- The PUBLIC "add a venue" flow defaults NEW places to OBSCURED + NULL radius.
-- That is deliberately NOT a column default: a column default cannot tell a
-- public submission from a staff/bulk import, so the choice lives in
-- `upsertPlace`.

ALTER TABLE "Place"
  ADD COLUMN "location_mode" "EventLocationMode" NOT NULL DEFAULT 'EXACT',
  ADD COLUMN "location_radius_meters" INTEGER,
  ADD COLUMN "location_label" TEXT;

-- A withheld place's public map circle must be a sane size when it exists at
-- all. Mirrors the 100..50_000 m bound `baseSaveEventInputSchema` already
-- enforces for events, but at the DATA layer so no future writer can bypass
-- it. NULL (fully hidden) always passes.
ALTER TABLE "Place"
  ADD CONSTRAINT "place_location_radius_meters_range_check"
  CHECK (
    "location_radius_meters" IS NULL
    OR ("location_radius_meters" >= 100 AND "location_radius_meters" <= 50000)
  );

-- `NEVER` makes "this address is never revealed, to anyone" a state an
-- organizer can CHOOSE rather than a data-integrity anomaly.
--
-- Before this, a NULL `address_reveal_at` on an OBSCURED event could only mean
-- the row was broken, and both redactors fail-close on it. That fail-closed
-- behaviour is CORRECT and does not change here — a NEVER event stays locked
-- forever, including for ticket holders, past any date. What changes is that
-- the intent is now legible: (OBSCURED, NEVER, NULL) is a choice,
-- (OBSCURED, NULL, NULL) is still a defect.
ALTER TYPE "AddressRevealPreset" ADD VALUE IF NOT EXISTS 'NEVER';
