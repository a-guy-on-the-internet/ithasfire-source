-- Waiver template audience discriminator (ATTENDEE | VOLUNTEER).
--
-- Why: two platform templates carried isDefault=true — the General Event
-- Waiver (attendee-facing) and the Standard Volunteer Waiver — so "the
-- default" was ambiguous and the ask editor worked around it by hardcoding
-- the volunteer template's id (AskWaiverSection). `kind` makes the
-- distinction honest and a partial unique index makes isDefault unique per
-- kind among platform templates.
--
-- Backfill covers prod: the ONLY volunteer template that exists outside dev
-- seeds is the migration-created platform row with the fixed id
-- PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID (see
-- 20260707150000_add_ask_waiver_template and
-- packages/core/src/use-cases/waivers/constants.ts). Every other existing
-- template is attendee-facing and keeps the ATTENDEE column default.

-- CreateEnum
CREATE TYPE "WaiverTemplateKind" AS ENUM ('ATTENDEE', 'VOLUNTEER');

-- AlterTable
ALTER TABLE "WaiverTemplate"
  ADD COLUMN "kind" "WaiverTemplateKind" NOT NULL DEFAULT 'ATTENDEE';

-- Backfill: the platform Standard Volunteer Waiver (fixed id, inserted by
-- migration 20260707150000 in prod and by the dev seed locally).
UPDATE "WaiverTemplate"
SET "kind" = 'VOLUNTEER'
WHERE "id" = '00000000-0000-4000-8000-000000000001';

-- At most one platform default per kind. Scoped to platform templates
-- (orgId + humanId null): org/human owners keep their own single default via
-- the existing clearOrgDefault/clearHumanDefault application logic.
-- (Partial indexes are raw SQL — Prisma schema can't express them; precedent:
-- VolunteerAsk_event_subject_key, VolunteerRoleTemplate_platform_pack_name_key.)
CREATE UNIQUE INDEX "WaiverTemplate_platform_default_kind_key"
  ON "WaiverTemplate"("kind")
  WHERE "isDefault" = true AND "orgId" IS NULL AND "humanId" IS NULL;
