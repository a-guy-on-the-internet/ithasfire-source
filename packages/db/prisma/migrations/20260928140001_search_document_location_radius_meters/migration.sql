-- The published approximate-area radius (metres) for a non-exact document —
-- the circle the search map draws instead of a pin. Null unless the redacted
-- projection publishes a circle. Nullable add: metadata-only, no rewrite.
ALTER TABLE "SearchDocument" ADD COLUMN "location_radius_meters" INTEGER;
