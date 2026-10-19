-- Application-driven events, Phase 2 (docs/specs/2026-08-10/
-- application-driven-events.spec.md, item 2): the submission status enum
-- grows lifecycle values.
--
--   WITHDRAWN  — applicant pulled back their own PENDING submission.
--   EXPIRED    — nightly sweep: PENDING past the form's closesAt + grace.
--   WAITLISTED — reviewer parked the application on the event waitlist
--                (writes an EventWaitlistEntry with source: APPLICATION).
--
-- These ALTER TYPEs live in their OWN migration (no column changes, no
-- backfill): Postgres cannot USE a newly-added enum value inside the same
-- transaction that adds it, and Prisma wraps each migration in a single
-- transaction — same split as 20260805120000_promo_scope_human_enum.
-- IF NOT EXISTS makes re-application (db-push-managed dev DBs) a no-op.

-- AlterEnum
ALTER TYPE "ApplicationSubmissionStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';
ALTER TYPE "ApplicationSubmissionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "ApplicationSubmissionStatus" ADD VALUE IF NOT EXISTS 'WAITLISTED';
