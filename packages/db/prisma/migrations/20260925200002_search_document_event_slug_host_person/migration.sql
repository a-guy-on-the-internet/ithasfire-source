-- Re-sync the denormalised event slug in search after
-- 20260925200001_event_slug_host_person_rewrite.
--
-- `SearchDocument.slug` is a copy of `Event.slug` (build-search-index writes
-- `event.slug`), and search results build their `/events/{slug}` links from
-- it. The nightly `search.full-reindex` job would rewrite it within a day, but
-- until then a person's name would still be in the links search hands out —
-- so copy the new value now. (The old link would still work: it is in
-- `EventSlugHistory` and redirects.)
--
-- Scoped to person-owned events (`orgId IS NULL`) whose document is out of
-- step with the event row; the value written is exactly what the next reindex
-- would write.
--
-- Single statement. Idempotent: IS DISTINCT FROM matches nothing on a second
-- run.
UPDATE "SearchDocument" d
SET "slug" = e."slug"
FROM "Event" e
WHERE d."type" = 'event'
  AND d."event_id" = e."id"
  AND e."orgId" IS NULL
  AND e."slug" IS NOT NULL
  AND d."slug" IS DISTINCT FROM e."slug";
