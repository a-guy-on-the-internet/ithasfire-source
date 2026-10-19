-- Organiser share of every resale, step B1 follow-up (B1 review warnings).
-- Spec: docs/specs/2026-10-12/organiser-resale-share.spec.yaml FR-001, FR-003.
--
-- 20261012190000_resale_share_clause is applied on shared databases and must
-- not change, so the tightening is its own migration.
--
-- One new constraint on the FR-003 record on OrderItem:
--   * a set clause always carries the ticket's original price (FR-007 reads it);
--   * a terms id / version is only recorded with a set clause. A sale made
--     while the event's clause was unset records nothing: resale cannot be
--     switched on without a clause (FR-001), so there is nothing to carry.
-- Every existing row has all of these columns NULL, so it validates.

-- Fail fast instead of queueing behind a long-running transaction on
-- "OrderItem" (and blocking every writer queued behind this ALTER).
SET lock_timeout = '5s';

-- NOT VALID + VALIDATE here does NOT shorten the lock: Prisma runs one
-- migration file in one transaction, so the ACCESS EXCLUSIVE lock taken by
-- ADD CONSTRAINT is held through VALIDATE's scan. The split only helps when
-- VALIDATE sits in its own (later) migration. At today's table sizes the scan
-- is short; the form is kept so the pattern reads the same as its siblings.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_resale_clause_complete_check" CHECK (
  ("resaleClauseType" IS NULL OR "originalUnitPriceCents" IS NOT NULL)
  AND (
    "resaleClauseType" IS NOT NULL
    OR ("resaleClauseTermsId" IS NULL AND "resaleClauseTermsVersion" IS NULL)
  )
) NOT VALID;

ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_resale_clause_complete_check";
