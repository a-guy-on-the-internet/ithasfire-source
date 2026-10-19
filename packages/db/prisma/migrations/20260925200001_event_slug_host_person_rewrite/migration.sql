-- A person's name never goes in an event URL (owner ruling 2026-09-25).
--
-- Rewrites the host (first) path segment of every person-owned event's slug
-- to the neutral `event`, matching what `generateEventSlug` now produces.
-- Everything after the first `/` — country, region, title, date, shortId — is
-- kept byte-for-byte, so `shortId` and the slug suffix stay in agreement.
--
-- 20260925200000_event_slug_host_person_history filed the current slugs in
-- `EventSlugHistory` first; old links resolve through it and redirect here.
-- The predicate is IDENTICAL to that migration's — see it for why each clause
-- exists (orgId IS NULL, generator shape, not already `event`, no collision
-- with another event's current slug).
--
-- `updatedAt` is deliberately untouched: nothing about the event changed, and
-- the sitemap reads the slug live from this row.
--
-- Single statement. Idempotent: the `<> 'event'` guard matches nothing on a
-- second run.
UPDATE "Event" e
SET "slug" = 'event' || substr(e."slug", strpos(e."slug", '/'))
WHERE e."orgId" IS NULL
  AND e."slug" ~ '^[^/]+/[^/]+/[^/]+/[^/]+--[a-z0-9]+$'
  AND split_part(e."slug", '/', 1) <> 'event'
  AND NOT EXISTS (
    SELECT 1
    FROM "Event" o
    WHERE o."slug" = 'event' || substr(e."slug", strpos(e."slug", '/'))
  );
