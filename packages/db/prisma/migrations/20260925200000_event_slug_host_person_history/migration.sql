-- A person's name never goes in an event URL (owner ruling 2026-09-25).
--
-- Event slugs are `{host}/{country}/{region}/{title}-{date}--{shortId}`. For an
-- event owned by a PERSON (no org) the host segment used to be the account's
-- real `Human.name` — and name + city + date in a public URL is a
-- people-search lead to a home address. `generateEventSlug` now uses the
-- neutral `event` for every event without an org; the next migration
-- (20260925200001_event_slug_host_person_rewrite) moves the existing rows.
--
-- THIS step files each affected event's CURRENT slug in `EventSlugHistory`
-- first, so `resolveBySlug` keeps resolving the old URL and the web route
-- redirects it to the new one. It MUST run before the rewrite.
--
-- "Affected" is exactly what the new code changes:
--   * `orgId IS NULL` — the adapter's host was `org.name ?? human.name`, so
--     only an event with no org ever took a person's name. Includes events
--     whose human was since deleted (`humanId` is ON DELETE SET NULL; the old
--     slug still carries the name), in EVERY status — DRAFT, CANCELLED,
--     COMPLETED and ARCHIVED included (their old URLs exist in the wild).
--   * the slug has the generator's four-segment `…--{shortId}` shape — legacy
--     flat slugs (`{region}-{title}`) carry no host segment and are left alone.
--   * the host segment is not already `event`.
--   * the rewritten slug is not already another event's current slug (it ends
--     in the event's unique shortId, so none should be; the guard keeps the
--     rewrite from ever hitting `Event_slug_key`). Same predicate as the
--     rewrite, so history is filed only for rows that actually move.
--
-- `recordedAt` / `createdAt` are written as naive UTC like Prisma writes them.
-- `id` has no database default (Prisma generates it), hence gen_random_uuid().
--
-- Single statement. Idempotent: ON CONFLICT skips a slug already in history
-- (publish files the current slug at publish time, so many already are), and
-- once the rewrite has run the `<> 'event'` guard matches nothing.
INSERT INTO "EventSlugHistory" ("id", "eventId", "slug", "recordedAt", "createdAt")
SELECT
  gen_random_uuid()::text,
  e."id",
  e."slug",
  now() AT TIME ZONE 'UTC',
  now() AT TIME ZONE 'UTC'
FROM "Event" e
WHERE e."orgId" IS NULL
  AND e."slug" ~ '^[^/]+/[^/]+/[^/]+/[^/]+--[a-z0-9]+$'
  AND split_part(e."slug", '/', 1) <> 'event'
  AND NOT EXISTS (
    SELECT 1
    FROM "Event" o
    WHERE o."slug" = 'event' || substr(e."slug", strpos(e."slug", '/'))
  )
ON CONFLICT ("slug") DO NOTHING;
