-- Add BookingHoldReleaseReason.EVENT_SCHEDULED (booking-holds FR-018).
--
-- A hold leaves its line when an event on the same calendar+date becomes
-- PUBLISHED and the hold is not the publishing event's own booking request.
--
-- This ALTER TYPE must live in its OWN migration: Postgres cannot USE a
-- newly-added enum value inside the same transaction that adds it, and
-- Prisma wraps each migration in a single transaction.

-- AlterEnum
ALTER TYPE "BookingHoldReleaseReason" ADD VALUE IF NOT EXISTS 'EVENT_SCHEDULED';
