-- ABSORB is removed (owner ruling 2026-10-01, docs/decisions/absorb-removed.md).
-- Step 1 of 3: mark for search reindex every event whose buyer-facing price
-- changes when its fee mode becomes PASS_THROUGH. Must run BEFORE steps 2 and
-- 3 (20261001230001, 20261001230002): once those land, nothing in the
-- database says which events were ABSORB.
--
-- The search document stores a buyer total (face + fees + tax), and under
-- ABSORB that total left the fees out. These rows go into the existing
-- edit-triggered reindex list; the next `search.drain-reindex-pending` run
-- refreshes them, and the nightly `search.full-reindex` clears the list
-- anyway. A migration cannot schedule the drain itself, so the deploy note in
-- the decision record says how to run it at once.
--
-- An event is marked when ANY of these would have priced it ABSORB:
--   * its PRIMARY terms say ABSORB;
--   * its PRIMARY terms are pinned to an ABSORB fee policy (any status: a
--     pin to an ARCHIVED row still resolves, `getById` does not filter);
--   * an ACTIVE ABSORB fee policy exists at its EVENT or ORG scope, or at
--     GLOBAL scope (checkout resolves EVENT -> ORG -> GLOBAL for unpinned
--     terms; the GLOBAL row is reconciled to PASS_THROUGH, so this arm should
--     match nothing).
-- That over-marks some events (terms that carry their own mode, an EVENT
-- policy shadowing an ORG one). A reindex rewrites the document from source
-- rows, so an extra mark costs one rewrite and changes nothing.
--
-- Mirrors `SearchReindexPendingRepo.mark`: insert, or bump `generation` so a
-- drain that read the row before this commit cannot clear it, and reset the
-- failure count. The uuid guard keeps a non-uuid id from failing the cast.
--
-- Single statement. Safe to re-run: after steps 2 and 3 it matches nothing.
INSERT INTO "SearchReindexPending" ("entity_type", "entity_id", "marked_at")
SELECT DISTINCT 'event', e."id"::uuid, CURRENT_TIMESTAMP
FROM "Event" e
LEFT JOIN "PayoutTerms" pt ON pt."id" = e."payout_terms_id"
LEFT JOIN "FeePolicy" pinned ON pinned."id" = pt."feePolicyId"
WHERE e."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (
    pt."feeMode" = 'ABSORB'
    OR pinned."feeMode" = 'ABSORB'
    OR EXISTS (
      SELECT 1
      FROM "FeePolicy" scoped
      WHERE scoped."feeMode" = 'ABSORB'
        AND scoped."status" = 'ACTIVE'
        AND (
          (scoped."scopeType" = 'EVENT' AND scoped."scopeId" = e."id")
          OR (scoped."scopeType" = 'ORG' AND scoped."scopeId" = e."orgId")
          OR scoped."scopeType" = 'GLOBAL'
        )
    )
  )
ON CONFLICT ("entity_type", "entity_id") DO UPDATE
SET "generation" = "SearchReindexPending"."generation" + 1,
    "marked_at" = EXCLUDED."marked_at",
    "attempts" = 0,
    "last_error" = NULL;
