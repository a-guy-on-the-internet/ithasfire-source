-- Application-driven events, Phase 3 (docs/specs/2026-08-10/
-- application-driven-events.spec.md, item 2 + decision D5): one OPEN
-- application per applicant per event, DB-enforced.
--
-- "Open" = PENDING | APPROVED | WAITLISTED. WITHDRAWN, REJECTED and EXPIRED
-- deliberately do NOT block, so an applicant who withdrew, was turned down, or
-- was swept by the nightly expiry can apply again.
--
-- Two partial unique indexes, the exact trick BookingRequest uses
-- ("BookingRequest_open_pair_key" / "BookingRequest_open_anon_pair_key",
-- migrations 20260610120000 / 20260713120000):
--   * guests  → (eventId, lower(contactEmail)) WHERE humanId IS NULL
--   * signed-in → (eventId, humanId)           WHERE humanId IS NOT NULL
-- Partial + expression indexes are not expressible in the Prisma schema, so
-- both are SQL-only (noted on the model in application.prisma). The use case
-- pre-checks; these indexes are the race backstop, and the adapter maps their
-- P2002 to the `duplicate_open_application` domain error.

-- KNOWN LEGACY EDGES (accepted, not fixed here): where a partition held TWO
-- APPROVED rows, the loser is withdrawn and its already-emailed claim link
-- stops working (the token is not cleared, but redeem requires status
-- APPROVED); and EventUnlock is keyed (eventId, humanId) while
-- revokeBySubmission matches applicationSubmissionId, so a withdrawn loser's
-- unlock row is not revoked here — deliberate, since the winner grants the
-- same access anyway.

-- ── 1. Collapse pre-existing duplicate OPEN submissions ────────────────────
-- Migrate the debt BEFORE installing the gate: a legacy pair would otherwise
-- fail the CREATE UNIQUE INDEX and break the deploy. No-op on clean data.
--
-- Ranking keeps ACCESS: an APPROVED row always outranks WAITLISTED, which
-- outranks PENDING, with the most recent row winning inside a status tier —
-- so this can never revoke an unlock that was already granted. Losers become
-- WITHDRAWN (the only lifecycle status that means "no longer in the queue,
-- may re-apply") and carry a `dedupedByMigration` metadata marker so the
-- organizer queue / an operator can tell them from a real withdrawal.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "eventId", "humanId"
      ORDER BY
        ("status" = 'APPROVED') DESC,
        ("status" = 'WAITLISTED') DESC,
        "createdAt" DESC,
        "id" DESC
    ) AS rn
  FROM "EventApplicationSubmission"
  WHERE "humanId" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED')
)
UPDATE "EventApplicationSubmission" AS s
SET "status" = 'WITHDRAWN',
    "metadata" = COALESCE(s."metadata", '{}'::jsonb) || '{"dedupedByMigration":true}'::jsonb,
    "updatedAt" = now()
FROM ranked
WHERE s."id" = ranked."id" AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "eventId", lower("contactEmail")
      ORDER BY
        ("status" = 'APPROVED') DESC,
        ("status" = 'WAITLISTED') DESC,
        "createdAt" DESC,
        "id" DESC
    ) AS rn
  FROM "EventApplicationSubmission"
  WHERE "humanId" IS NULL
    AND "contactEmail" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED')
)
UPDATE "EventApplicationSubmission" AS s
SET "status" = 'WITHDRAWN',
    "metadata" = COALESCE(s."metadata", '{}'::jsonb) || '{"dedupedByMigration":true}'::jsonb,
    "updatedAt" = now()
FROM ranked
WHERE s."id" = ranked."id" AND ranked.rn > 1;

-- ── 2. Normalize guest emails to lowercase at rest ─────────────────────────
-- The guest index matches on lower("contactEmail") and the app writes the
-- column lowercased from here on (submit-event-application.ts), exactly like
-- BookingRequest.contactEmail. Fold the legacy rows so the stored value and
-- the indexed expression agree.
UPDATE "EventApplicationSubmission"
SET "contactEmail" = lower("contactEmail")
WHERE "contactEmail" IS NOT NULL AND "contactEmail" <> lower("contactEmail");

-- ── 3. Dedupe lookup index (pre-check path) ────────────────────────────────
-- The use-case pre-check reads by (eventId, lower(contactEmail)); emails are
-- lowercased at rest, so plain equality matches the stored value.
CREATE INDEX IF NOT EXISTS "EventApplicationSubmission_eventId_contactEmail_idx"
  ON "EventApplicationSubmission" ("eventId", "contactEmail");

-- ── 4. The gates ───────────────────────────────────────────────────────────
-- Guest rows: one open application per (event, lower(email)). contactEmail is
-- NULL-guarded because expression-index entries over NULL are all distinct —
-- a NULL-email guest row would slip the gate entirely. That combination is
-- already impossible app-side (submit-event-application requires a contact,
-- and a submission with no humanId has no other identity), so the partial
-- predicate documents rather than weakens the rule.
-- IF NOT EXISTS throughout: dev DBs here are db-push-managed, so a migration
-- can legitimately be re-applied over a schema that already has the index
-- (same reasoning as 20260811120000_application_submission_lifecycle_statuses).
CREATE UNIQUE INDEX IF NOT EXISTS "EventApplicationSubmission_open_guest_key"
  ON "EventApplicationSubmission" ("eventId", lower("contactEmail"))
  WHERE "humanId" IS NULL
    AND "contactEmail" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');

-- Signed-in rows: one open application per (event, human).
CREATE UNIQUE INDEX IF NOT EXISTS "EventApplicationSubmission_open_human_key"
  ON "EventApplicationSubmission" ("eventId", "humanId")
  WHERE "humanId" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');
