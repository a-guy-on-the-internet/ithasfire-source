-- Enable required PostgreSQL extensions for spatial and fuzzy search locally
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add a geometry column to Place for spatial queries
ALTER TABLE "Place"
  ADD COLUMN IF NOT EXISTS "geom" geometry(Point, 4326);

-- Backfill existing geometry values when latitude/longitude are present
UPDATE "Place"
SET "geom" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)
WHERE "geom" IS NULL
  AND "lat" IS NOT NULL
  AND "lng" IS NOT NULL;

-- Spatial index for fast geo queries
CREATE INDEX IF NOT EXISTS "place_geom_gix"
  ON "Place"
  USING GIST ("geom");

-- Trigram indexes to support fuzzy search
CREATE INDEX IF NOT EXISTS "event_title_trgm"
  ON "Event"
  USING GIN ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "place_name_trgm"
  ON "Place"
  USING GIN ("name" gin_trgm_ops);
