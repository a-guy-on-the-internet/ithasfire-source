-- musician-epk FR-009: server-sourced verified-stats snapshot on a booking
-- request. Nullable JSONB, no backfill — existing rows stay NULL.
ALTER TABLE "BookingRequest" ADD COLUMN "verifiedStatsSnapshot" JSONB;
