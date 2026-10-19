-- DB backstop for the acceptance ledger's find-then-create
-- (recordAcceptance in packages/core/src/lib/legal/acceptance.ts). The
-- pre-check races under concurrency: two first purchases by the same human
-- can both miss findCurrent and insert duplicate forensic rows. This unique
-- index makes the ledger duplicate-proof; the adapter inserts with
-- ON CONFLICT DO NOTHING (createMany skipDuplicates) so the race loser
-- silently adopts the winner's row instead of aborting its transaction.
--
-- NULLS NOT DISTINCT (Postgres 15+; local dev + CI run PG 15, Neon runs 16)
-- is required because scopeId is nullable and every GLOBAL-scope row —
-- the buyer ToS / refund-policy rows, i.e. the main case — has scopeId
-- NULL. With default NULL semantics those rows would be unprotected.
-- Prisma cannot express NULLS NOT DISTINCT, so this index is SQL-only
-- (noted on the AcceptanceRecord model in acceptance.prisma).

-- 1) Dedupe rows that predate the constraint. For each
--    (humanId, documentType, documentVersion, scopeType, scopeId) key —
--    NULL-safe via IS NOT DISTINCT FROM — keep the EARLIEST acceptedAt
--    (lowest id as tiebreaker): the first acceptance is the forensically
--    meaningful one. A row is deleted iff a strictly-earlier sibling exists.
DELETE FROM "AcceptanceRecord" AS dup
USING "AcceptanceRecord" AS keep
WHERE dup."humanId" = keep."humanId"
  AND dup."documentType" = keep."documentType"
  AND dup."documentVersion" = keep."documentVersion"
  AND dup."scopeType" = keep."scopeType"
  AND dup."scopeId" IS NOT DISTINCT FROM keep."scopeId"
  AND (
    keep."acceptedAt" < dup."acceptedAt"
    OR (keep."acceptedAt" = dup."acceptedAt" AND keep."id" < dup."id")
  );

-- 2) The constraint itself.
CREATE UNIQUE INDEX "AcceptanceRecord_human_doc_version_scope_key"
  ON "AcceptanceRecord" ("humanId", "documentType", "documentVersion", "scopeType", "scopeId")
  NULLS NOT DISTINCT;
