-- Booking holds — round-3 hardening (spec docs/specs/2026-08-25/
-- booking-holds.spec.yaml, Step 1). The round-2 CHECK was one-directional:
-- it stopped respondBy on a non-CHALLENGED row but still allowed a CHALLENGED
-- row with NULL respondBy — a challenge that could never lapse. Replace it
-- with the biconditional: respondBy is NULL exactly when the row is not
-- CHALLENGED. No rows exist yet; forward-only, no backfill.

ALTER TABLE "BookingHold" DROP CONSTRAINT "BookingHold_respondBy_challenged_check";

ALTER TABLE "BookingHold"
  ADD CONSTRAINT "BookingHold_respondBy_challenged_check"
  CHECK (("respondBy" IS NULL) = ("status" <> 'CHALLENGED'));
