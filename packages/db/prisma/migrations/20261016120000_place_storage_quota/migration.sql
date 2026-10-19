-- A place holds the storage quota of the page images community moderators
-- upload to its page while nobody owns it (moderator place page spec
-- docs/specs/2026-10-14/moderator-place-page.spec.yaml, R5): the uploads stop
-- charging the moderator's own STORAGE_BYTES_HUMAN.
--
-- Additive only. No DefaultResourceLimit row is written: the built-in
-- fallback (DEFAULT_RESOURCE_LIMITS.STORAGE_BYTES_PLACE, 512 MiB, the human
-- default) applies until a platform admin sets one on /platform/quotas.
-- Existing moderator charges stay on the moderators' human quota (no
-- backfill).

-- AlterEnum
ALTER TYPE "QuotaSubjectType" ADD VALUE 'PLACE';

-- AlterEnum
ALTER TYPE "ResourceLimitKind" ADD VALUE 'STORAGE_BYTES_PLACE';
