-- ═══════════════════════════════════════════════════════════════════════════
-- One cap for every booking reason (docs/specs/2026-09-25/
-- booking-the-night.spec.yaml: FR-013, decision N18): every reason field
-- accepts up to 1000 characters except an act's pass (240).
-- withdrawVenueConfirmation's cap moves from 500 to BOOKING_REASON_MAX (1000),
-- so the column that stores the reason widens to match.
--
-- Widening a VARCHAR is a catalog-only change in Postgres (no table rewrite,
-- no data touched) and every existing value already fits. Re-applying it is a
-- no-op.
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "Event" ALTER COLUMN "venueConfirmationWithdrawnReason" SET DATA TYPE VARCHAR(1000);
