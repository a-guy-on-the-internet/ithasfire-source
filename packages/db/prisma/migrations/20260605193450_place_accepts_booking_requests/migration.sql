-- AlterTable
-- Verified venues opt in to inbound performer booking requests.
-- Additive and default-false; existing rows are unaffected.
ALTER TABLE "Place" ADD COLUMN     "accepts_booking_requests" BOOLEAN NOT NULL DEFAULT false;
