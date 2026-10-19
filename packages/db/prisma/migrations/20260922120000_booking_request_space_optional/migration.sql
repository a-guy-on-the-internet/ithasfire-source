-- The room comes off the REQUEST — owner ruling 2026-09-22.
--
-- Migration 20260902120000_venue_confirmation_and_booking_intents made a room
-- mandatory for RENT/USE:
--   RENT | USE ⇒ spaceId NOT NULL ∧ requestedStartsAt NOT NULL ∧ requestedEndsAt NOT NULL
-- This drops the `spaceId` half and keeps the window half, verbatim.
--
-- WHY. The ruling extends the 2026-08-31 holds ruling (documented atop
-- apps/web/src/components/bookings/HoldDatePicker.tsx, "THE SPACE PICKER IS
-- GONE"): a request, like a hold, is a place in line for a DATE on a
-- CALENDAR. Nothing downstream reads a room off a request — no repo join, no
-- DTO, no email surfaces it — and the accept/mint path already tolerates a
-- null room (`accept-mint.ts` falls back to the calendar's default space and,
-- finding none, reports a spaceless mint rather than refusing). Demanding a
-- room here promised a reservation the system never made. The room is chosen
-- at accept/confirm, on the draft event, where it is real.
--
-- A `spaceId` stays LEGAL and the use case still asserts a supplied room is
-- on the ROUTED calendar. The WINDOW stays REQUIRED for RENT/USE, here and in
-- the use case.
--
-- Re-applicable (DROP ... IF EXISTS, then a duplicate_object-guarded ADD)
-- because the dev databases are db-push-managed and replay migrations on top
-- of an already-pushed schema. Re-added under the SAME name so the
-- constraint-exists assertion in
-- packages/adapters/test/integration/venue-confirmation.test.ts keeps
-- passing. Relaxing a CHECK can never fail on existing rows.

ALTER TABLE "BookingRequest" DROP CONSTRAINT IF EXISTS "BookingRequest_intent_shape_check";

DO $$ BEGIN
  ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_intent_shape_check" CHECK (
    "intent" NOT IN ('RENT', 'USE')
    OR (
      "requestedStartsAt" IS NOT NULL
      AND "requestedEndsAt" IS NOT NULL
    )
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
