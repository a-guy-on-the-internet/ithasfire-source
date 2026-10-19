-- Floor-0 pay-what-you-want (PWYW) tiers never read "Free" on a listing
-- (docs/decisions/listing-pay-what-you-want-never-free.md). The search
-- document gained `has_pay_what_you_want_tier` in 20261006150000 with default
-- false, so every already-indexed event with such a tier still reads "Free"
-- until its document is rewritten.
--
-- Mark those events for reindex in the existing edit-triggered list; the next
-- `search.drain-reindex-pending` run refreshes them. A migration cannot
-- schedule the drain itself.
--
-- Affected: an ACTIVE ticket type with ADJUSTABLE pricing and a floor of 0
-- (`minimumCents` null or 0). The sales window is ignored on purpose: that
-- over-marks an event whose only such tier is off sale, and a reindex rewrites
-- the document from source rows, so an extra mark costs one rewrite.
--
-- Mirrors `SearchReindexPendingRepo.mark` (same as
-- 20261001230000_absorb_removed_mark_search_reindex): insert, or bump
-- `generation` so a drain that read the row before this commit cannot clear
-- it, and reset the failure count. The uuid guard keeps a non-uuid id from
-- failing the cast.
--
-- Single statement. Safe to re-run.
INSERT INTO "SearchReindexPending" ("entity_type", "entity_id", "marked_at")
SELECT DISTINCT 'event', e."id"::uuid, CURRENT_TIMESTAMP
FROM "Event" e
JOIN "TicketType" tt ON tt."eventId" = e."id"
WHERE e."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND tt."status" = 'ACTIVE'
  AND tt."pricingMode" = 'ADJUSTABLE'
  AND COALESCE(tt."minimumCents", 0) = 0
ON CONFLICT ("entity_type", "entity_id") DO UPDATE
SET "generation" = "SearchReindexPending"."generation" + 1,
    "marked_at" = EXCLUDED."marked_at",
    "attempts" = 0,
    "last_error" = NULL;
