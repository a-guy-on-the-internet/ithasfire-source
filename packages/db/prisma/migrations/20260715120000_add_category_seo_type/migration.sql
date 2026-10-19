-- Data-driven schema.org Event @type per category (music-event-schema spec).
-- Music categories emit `MusicEvent` (a schema.org/Event subtype — strictly
-- additive for SEO, gaining music-event rich results); everything else keeps
-- the plain `Event`. Admins edit the mapping in the platform category editor.
--
-- Plain TEXT column (NOT a Postgres enum) so the supported set can evolve in
-- code: the code-side allowlist (EVENT_SCHEMA_TYPES in @th/types) is the only
-- validation gate, and the SEO builder falls back to `Event` for any value it
-- doesn't recognise.

-- AlterTable: additive, non-null with a default so existing rows are valid.
ALTER TABLE "Category"
  ADD COLUMN "seoType" TEXT NOT NULL DEFAULT 'Event';

-- Backfill: the music-adjacent seed categories emit MusicEvent. Slug-scoped so
-- re-running on a DB missing some of these slugs is a no-op for the rest.
UPDATE "Category"
SET "seoType" = 'MusicEvent'
WHERE "slug" IN ('music', 'open-mics', 'nightlife');
