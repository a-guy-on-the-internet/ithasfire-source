-- Carry the full event render payload on the search index so a later step can
-- serve the embed calendar/widget without a Postgres hydrate. Both columns are
-- nullable adds, which are metadata-only in Postgres (no table rewrite, no lock
-- beyond a brief ACCESS EXCLUSIVE for the catalog update) — no CONCURRENTLY needed.
ALTER TABLE "SearchDocument" ADD COLUMN "ends_at" TIMESTAMPTZ;
ALTER TABLE "SearchDocument" ADD COLUMN "address_text" TEXT;
