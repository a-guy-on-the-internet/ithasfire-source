-- The event's IANA zone on its search document, so search-backed cards stamp
-- the time in the event's zone instead of the platform default. Additive and
-- nullable: existing rows read null (fallback) until the next reindex.
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "timezone" TEXT;
