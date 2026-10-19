-- Open calls v1 (docs/specs/2026-10-05/open-calls.spec.yaml, `data:` block).
--
-- An EventApplicationForm gains a PURPOSE (ATTEND = the attendee gate form,
-- PERFORM = an open call for performers) and may belong to an event OR a
-- series. Submissions are keyed by formId from here on, so one person can
-- hold an attendee application and a performer application on the same
-- event; the "one open application" partial unique indexes are re-keyed
-- eventId → formId (FR-011). New tables: date choices, votes, notes and the
-- applicant thread.
--
-- Every pre-existing form is an attendee form (ATTEND, the column default),
-- so submissions backfill their formId from their event's single form.

-- ── 1. Enums ───────────────────────────────────────────────────────────────
CREATE TYPE "ApplicationFormPurpose" AS ENUM ('ATTEND', 'PERFORM');

CREATE TYPE "OpenCallPayKind" AS ENUM ('FIXED', 'DOOR_SPLIT', 'TICKET_SHARE', 'TICKET_QUOTA', 'UNPAID', 'DISCUSSED_AFTER');

CREATE TYPE "ApplicationVoteValue" AS ENUM ('YES', 'MAYBE', 'NO');

CREATE TYPE "ApplicationMessageAuthorSide" AS ENUM ('ORGANIZER', 'APPLICANT');

-- ── 2. EventApplicationForm ────────────────────────────────────────────────
DROP INDEX "EventApplicationForm_eventId_key";

ALTER TABLE "EventApplicationForm" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedByHumanId" TEXT,
ADD COLUMN     "postedAt" TIMESTAMP(3),
ADD COLUMN     "postedByHumanId" TEXT,
ADD COLUMN     "payDetails" TEXT,
ADD COLUMN     "payKind" "OpenCallPayKind",
ADD COLUMN     "publicId" TEXT,
ADD COLUMN     "purpose" "ApplicationFormPurpose" NOT NULL DEFAULT 'ATTEND',
ADD COLUMN     "seriesId" TEXT,
ALTER COLUMN "eventId" DROP NOT NULL;

-- publicId backfill: 10-char base-36, the same shape as Event.shortId
-- (packages/core/src/lib/slug-utils.ts SHORT_ID_LENGTH). Bytes come from
-- gen_random_uuid() (core since PG13, no extension), skipping bytes 6 and 8,
-- which carry the fixed UUID version / variant bits. The subquery references
-- the outer row ("f"."id") so Postgres re-evaluates it per row instead of
-- hoisting it into a single InitPlan (which would give every row the same
-- id and fail the unique index below).
UPDATE "EventApplicationForm" AS f
SET "publicId" = (
  SELECT string_agg(
           substr('0123456789abcdefghijklmnopqrstuvwxyz', (get_byte(r.b, p.i) % 36) + 1, 1),
           '' ORDER BY p.ord
         )
  FROM (SELECT uuid_send(gen_random_uuid()) AS b WHERE f."id" IS NOT NULL) AS r,
       unnest(ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11]) WITH ORDINALITY AS p(i, ord)
)
WHERE f."publicId" IS NULL;

ALTER TABLE "EventApplicationForm" ALTER COLUMN "publicId" SET NOT NULL;

CREATE UNIQUE INDEX "EventApplicationForm_publicId_key" ON "EventApplicationForm"("publicId");

CREATE INDEX "EventApplicationForm_closedByHumanId_idx" ON "EventApplicationForm"("closedByHumanId");

CREATE INDEX "EventApplicationForm_postedByHumanId_idx" ON "EventApplicationForm"("postedByHumanId");

CREATE UNIQUE INDEX "EventApplicationForm_eventId_purpose_key" ON "EventApplicationForm"("eventId", "purpose");

CREATE UNIQUE INDEX "EventApplicationForm_seriesId_purpose_key" ON "EventApplicationForm"("seriesId", "purpose");

-- A form belongs to exactly one of an event or a series.
ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_one_owner_check"
  CHECK (num_nonnulls("eventId", "seriesId") = 1);

-- A series form is always an open call: the attendee gate is per event.
ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_series_perform_check"
  CHECK ("seriesId" IS NULL OR "purpose" = 'PERFORM');

ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "EventSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_closedByHumanId_fkey" FOREIGN KEY ("closedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_postedByHumanId_fkey" FOREIGN KEY ("postedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. EventApplicationSubmission ──────────────────────────────────────────
ALTER TABLE "EventApplicationSubmission" ADD COLUMN     "applyingAsOrgId" TEXT,
ADD COLUMN     "droppedOutAt" TIMESTAMP(3),
ADD COLUMN     "formId" TEXT,
ADD COLUMN     "guestName" TEXT,
ADD COLUMN     "guestUrl" TEXT,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openedAt" TIMESTAMP(3),
ADD COLUMN     "removedFromLineupAt" TIMESTAMP(3),
ADD COLUMN     "statusTokenHash" TEXT,
ALTER COLUMN "eventId" DROP NOT NULL;

-- An event can hold submissions without ever having had a form row: setting
-- gateType APPLICATION never created one, and the organizer only creates it
-- by opening the question builder or the gate settings. Give each such event
-- the default ATTEND form first — exactly what core's `ensureForm` creates
-- at submit time from now on (no questions, no window, no cap,
-- updatedByHumanId NULL, the same `defaults` JSON) — so every submission can
-- be keyed below. The publicId uses the same per-row expression as the
-- backfill above (the subquery references the outer row so Postgres
-- evaluates it per row instead of once).
INSERT INTO "EventApplicationForm"
  ("id", "eventId", "purpose", "publicId", "defaults", "autoApprove",
   "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."eventId",
  'ATTEND',
  (
    SELECT string_agg(
             substr('0123456789abcdefghijklmnopqrstuvwxyz', (get_byte(r.b, p.i) % 36) + 1, 1),
             '' ORDER BY p.ord
           )
    FROM (SELECT uuid_send(gen_random_uuid()) AS b WHERE e."eventId" IS NOT NULL) AS r,
         unnest(ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11]) WITH ORDINALITY AS p(i, ord)
  ),
  '{"includeName": false, "includeReason": false, "includeSocialLinks": false}'::jsonb,
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT s."eventId"
  FROM "EventApplicationSubmission" AS s
  WHERE s."eventId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "EventApplicationForm" AS f WHERE f."eventId" = s."eventId"
    )
) AS e;

-- Backfill formId from the event's form. Before this migration an event had
-- at most one form (eventId was @unique) and every form is ATTEND.
UPDATE "EventApplicationSubmission" AS s
SET "formId" = f."id"
FROM "EventApplicationForm" AS f
WHERE f."eventId" = s."eventId"
  AND f."purpose" = 'ATTEND'
  AND s."formId" IS NULL;

-- Final safety check: after the insert above every submission has a form, so
-- this should never fire. If it does, fail the deploy loudly rather than
-- delete rows; an operator decides what those rows are.
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM "EventApplicationSubmission"
  WHERE "formId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'open_calls migration: % EventApplicationSubmission row(s) have no EventApplicationForm for their event; refusing to continue', orphan_count;
  END IF;
END $$;

ALTER TABLE "EventApplicationSubmission" ALTER COLUMN "formId" SET NOT NULL;

-- A submission's eventId must equal its form's eventId. MATCH SIMPLE skips
-- the check when submission.eventId is NULL (series-call submissions), and a
-- series form has eventId NULL, so a series submission can never carry an
-- eventId. The single-column formId FK below still carries the cascade.
CREATE UNIQUE INDEX "EventApplicationForm_id_eventId_key" ON "EventApplicationForm"("id", "eventId");

ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_formId_eventId_fkey" FOREIGN KEY ("formId", "eventId") REFERENCES "EventApplicationForm"("id", "eventId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Pay terms exist only on open calls (PERFORM forms).
ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_pay_perform_only_check" CHECK ("purpose" = 'PERFORM' OR ("payKind" IS NULL AND "payDetails" IS NULL));

-- Only an open call is ever posted (owner ruling Q41: saving makes a draft
-- call; "Post call" stamps postedAt). The attendee form has no posted state.
ALTER TABLE "EventApplicationForm" ADD CONSTRAINT "EventApplicationForm_posted_perform_only_check" CHECK ("purpose" = 'PERFORM' OR ("postedAt" IS NULL AND "postedByHumanId" IS NULL));

CREATE UNIQUE INDEX "EventApplicationSubmission_statusTokenHash_key" ON "EventApplicationSubmission"("statusTokenHash");

CREATE INDEX "EventApplicationSubmission_formId_status_createdAt_idx" ON "EventApplicationSubmission"("formId", "status", "createdAt");

CREATE INDEX "EventApplicationSubmission_applyingAsOrgId_idx" ON "EventApplicationSubmission"("applyingAsOrgId");

ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "EventApplicationForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_applyingAsOrgId_fkey" FOREIGN KEY ("applyingAsOrgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Re-key the dedupe indexes eventId → formId ──────────────────────────
-- Created by 20260811140000_application_submission_open_dedupe. Same
-- predicates; only the leading key changes. Existing data cannot collide on
-- the new key: each event had one form, so (formId, x) partitions exactly
-- like (eventId, x) did.
DROP INDEX IF EXISTS "EventApplicationSubmission_open_guest_key";
DROP INDEX IF EXISTS "EventApplicationSubmission_open_human_key";
DROP INDEX IF EXISTS "EventApplicationSubmission_eventId_contactEmail_idx";

-- Pre-check lookup for the guest gate (emails are lowercased at rest).
CREATE INDEX "EventApplicationSubmission_formId_contactEmail_idx" ON "EventApplicationSubmission"("formId", "contactEmail");

-- Guest rows: one open application per (form, lower(email)).
CREATE UNIQUE INDEX "EventApplicationSubmission_open_guest_key"
  ON "EventApplicationSubmission" ("formId", lower("contactEmail"))
  WHERE "humanId" IS NULL
    AND "contactEmail" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');

-- Signed-in rows: one open application per (form, human).
CREATE UNIQUE INDEX "EventApplicationSubmission_open_human_key"
  ON "EventApplicationSubmission" ("formId", "humanId")
  WHERE "humanId" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');

-- ── 5. ApplicationFormTemplate ─────────────────────────────────────────────
ALTER TABLE "ApplicationFormTemplate" ADD COLUMN     "purpose" "ApplicationFormPurpose" NOT NULL DEFAULT 'ATTEND';

-- The seeded platform performer template becomes the PERFORM template
-- (spec FR-001). Name match is the seed's identity
-- (apps/api/src/scripts/seed/application-form-templates.ts).
UPDATE "ApplicationFormTemplate"
SET "purpose" = 'PERFORM'
WHERE "isPlatform" = true
  AND "name" = 'Performer / artist application';

-- ── 6. New tables ──────────────────────────────────────────────────────────
CREATE TABLE "OpenCallDateChoice" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "eventId" TEXT,
    "occurrenceId" TEXT,
    "eventDateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenCallDateChoice_pkey" PRIMARY KEY ("id"),
    -- A date choice points at exactly one date.
    CONSTRAINT "OpenCallDateChoice_one_target_check"
      CHECK (num_nonnulls("eventId", "occurrenceId", "eventDateId") = 1)
);

CREATE TABLE "ApplicationVote" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "vote" "ApplicationVoteValue" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationVote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationNote" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "authorHumanId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationMessage" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "authorSide" "ApplicationMessageAuthorSide" NOT NULL,
    "authorHumanId" TEXT,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OpenCallDateChoice_eventId_idx" ON "OpenCallDateChoice"("eventId");

CREATE INDEX "OpenCallDateChoice_occurrenceId_idx" ON "OpenCallDateChoice"("occurrenceId");

CREATE INDEX "OpenCallDateChoice_eventDateId_idx" ON "OpenCallDateChoice"("eventDateId");

CREATE UNIQUE INDEX "OpenCallDateChoice_submissionId_eventId_key" ON "OpenCallDateChoice"("submissionId", "eventId");

CREATE UNIQUE INDEX "OpenCallDateChoice_submissionId_occurrenceId_key" ON "OpenCallDateChoice"("submissionId", "occurrenceId");

CREATE UNIQUE INDEX "OpenCallDateChoice_submissionId_eventDateId_key" ON "OpenCallDateChoice"("submissionId", "eventDateId");

CREATE INDEX "ApplicationVote_humanId_idx" ON "ApplicationVote"("humanId");

CREATE UNIQUE INDEX "ApplicationVote_submissionId_humanId_key" ON "ApplicationVote"("submissionId", "humanId");

CREATE INDEX "ApplicationNote_submissionId_createdAt_idx" ON "ApplicationNote"("submissionId", "createdAt");

CREATE INDEX "ApplicationNote_authorHumanId_idx" ON "ApplicationNote"("authorHumanId");

CREATE INDEX "ApplicationMessage_submissionId_createdAt_idx" ON "ApplicationMessage"("submissionId", "createdAt");

ALTER TABLE "OpenCallDateChoice" ADD CONSTRAINT "OpenCallDateChoice_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "EventApplicationSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpenCallDateChoice" ADD CONSTRAINT "OpenCallDateChoice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpenCallDateChoice" ADD CONSTRAINT "OpenCallDateChoice_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "EventSeriesOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpenCallDateChoice" ADD CONSTRAINT "OpenCallDateChoice_eventDateId_fkey" FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationVote" ADD CONSTRAINT "ApplicationVote_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "EventApplicationSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationVote" ADD CONSTRAINT "ApplicationVote_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "EventApplicationSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_authorHumanId_fkey" FOREIGN KEY ("authorHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ApplicationMessage" ADD CONSTRAINT "ApplicationMessage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "EventApplicationSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
