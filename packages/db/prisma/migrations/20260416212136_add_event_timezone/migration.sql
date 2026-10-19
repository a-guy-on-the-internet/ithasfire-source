-- Add column with default so existing rows are backfilled atomically.
ALTER TABLE "Event" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Chicago';

-- Prefer the linked EventSeries timezone where available, so series-linked
-- events inherit their series tz instead of the generic default.
UPDATE "Event" e
SET "timezone" = s."timezone"
FROM "EventSeriesOccurrence" o
JOIN "EventSeries" s ON s."id" = o."seriesId"
WHERE o."eventId" = e."id";
