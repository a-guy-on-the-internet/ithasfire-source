-- Open calls v1, owner ruling 2026-10-07: store the language an applicant
-- applied in, so a GUEST's later emails (picked, not this time, messages...)
-- are written in it. Nullable: null = unknown, the platform default ("en").
-- Values are core's NOTIFICATION_LOCALES; the CHECK keeps garbage out and
-- must be widened (a new migration) when a locale is added there.
--
-- 20261005120000_open_calls and 20261006120000_open_calls_entity_dedupe are
-- already applied and must not change, so this is its own migration.
-- Additive only: no existing row is touched (they all read null).

ALTER TABLE "EventApplicationSubmission" ADD COLUMN "contactLocale" TEXT;

-- NOT VALID first (no full-table scan under the ACCESS EXCLUSIVE lock the
-- ADD takes), then VALIDATE (scans under SHARE UPDATE EXCLUSIVE, so reads
-- and writes continue). Every existing row is null, so it validates.
ALTER TABLE "EventApplicationSubmission"
  ADD CONSTRAINT "EventApplicationSubmission_contactLocale_check"
  CHECK ("contactLocale" IS NULL OR "contactLocale" IN ('en', 'es')) NOT VALID;

ALTER TABLE "EventApplicationSubmission"
  VALIDATE CONSTRAINT "EventApplicationSubmission_contactLocale_check";
