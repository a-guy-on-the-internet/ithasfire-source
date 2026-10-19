-- Volunteer role packs — platform-curated role templates living in the
-- existing template tables.
--
-- A catalogue row is ("orgId" IS NULL, "isPlatform" = true, "packId" set —
-- the last of those is CHECK-enforced below). An org row is unchanged:
-- "orgId" set, "isPlatform" = false. VolunteerPack holds only pack metadata
-- (name, blurb, targeting, DRAFT/LIVE) — it owns no roles of its own; roles
-- point at it.
--
-- Widening "orgId" to nullable is NOT reversible without data loss once
-- catalogue rows exist. The new shift columns default to
-- (WALL_CLOCK, 0, NULL), which reproduces every existing row's current
-- meaning exactly, so there is no backfill.
--
-- Role-name uniqueness for catalogue rows is PER PACK, not per catalogue:
-- the launch packs deliberately share role names ("Sound" is in both the
-- house-show and DIY packs, "Merch" in both DIY and club-night).

-- CreateEnum
CREATE TYPE "VolunteerPackStatus" AS ENUM ('DRAFT', 'LIVE');

-- CreateEnum
CREATE TYPE "VolunteerShiftAnchor" AS ENUM ('WALL_CLOCK', 'EVENT_START', 'EVENT_END');

-- CreateTable
CREATE TABLE "VolunteerPack" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blurb" TEXT,
    "status" "VolunteerPackStatus" NOT NULL DEFAULT 'DRAFT',
    -- NOT NULL deliberately. Prisma's schema language cannot express array
    -- nullability at all (`String[] @default([])` types as `string[]`, never
    -- `string[] | null`), so a nullable column would be a type LIE the client
    -- can't see. Prisma's drift describer does not inspect array nullability
    -- either, so adding NOT NULL here is drift-neutral. Same shape emitted by
    -- 20260707140000_add_entity_page_category and
    -- 20260704000000_add_event_change_notices.
    "targetCategoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rankFirst" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "curatedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerPack_pkey" PRIMARY KEY ("id")
);

-- Stable slug so the seed path converges (re-seed updates, never duplicates).
CREATE UNIQUE INDEX "VolunteerPack_key_key" ON "VolunteerPack"("key");

-- Organizer picker reads LIVE packs in curation order.
CREATE INDEX "VolunteerPack_status_sortOrder_idx" ON "VolunteerPack"("status", "sortOrder");

-- FK maintenance on curator deletion (SetNull scans by curatedByHumanId).
CREATE INDEX "VolunteerPack_curatedByHumanId_idx" ON "VolunteerPack"("curatedByHumanId");

-- Losing the curator must never remove catalogue content.
ALTER TABLE "VolunteerPack" ADD CONSTRAINT "VolunteerPack_curatedByHumanId_fkey" FOREIGN KEY ("curatedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable — platform rows have no owning org.
ALTER TABLE "VolunteerRoleTemplate" ALTER COLUMN "orgId" DROP NOT NULL;
ALTER TABLE "VolunteerRoleTemplate" ADD COLUMN "isPlatform" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VolunteerRoleTemplate" ADD COLUMN "packId" TEXT;

-- Catalogue-row shape, DB-enforced: a platform row ALWAYS belongs to a pack.
-- Two jobs, both load-bearing:
--   1. It closes the NULL escape hatch under the partial unique index below.
--      That index keys on ("packId", "name") and Postgres indexes NULLs as
--      distinct, so a pack-less platform row would sit outside the constraint
--      entirely and a pack could never be re-derived for it.
--   2. It makes the "deleting a pack deletes its PLATFORM roles" half of the
--      rule enforceable rather than aspirational. The FK below is SET NULL
--      (fork-safe), so deleting a pack that still has platform roles would
--      quietly leave them behind with "packId" NULL — alive, invisible to
--      every organizer read (which requires a LIVE pack relation), and
--      un-garbage-collectable. With this CHECK that DELETE fails loudly
--      instead, forcing the remove-pack use case to do its
--      deleteMany({ packId, isPlatform: true }) first, in the same
--      transaction. Org-owned forks (isPlatform false) SET NULL freely and
--      keep surviving their source pack.
-- Same "an all-NULL row bypasses the partial index" reasoning as
-- "BookingRequest_sender_identity_check" (20260713120000). Every existing row
-- has isPlatform = false, so this validates with no backfill.
ALTER TABLE "VolunteerRoleTemplate" ADD CONSTRAINT "VolunteerRoleTemplate_platform_pack_check" CHECK (
  "isPlatform" = false OR "packId" IS NOT NULL
);

-- CreateIndex (raw SQL — Prisma's schema language can't express partial
-- indexes, following the "VolunteerAsk_event_subject_key" /
-- "VolunteerReward_ask_level_key" / 20260512_search_documents precedent).
-- Postgres treats NULLs as distinct in the existing
-- @@unique([orgId, name]), so once "orgId" is nullable that constraint stops
-- constraining catalogue rows entirely — one pack could list "Door" twice.
-- The invariant is PER PACK, not per catalogue: the launch packs deliberately
-- reuse role names across packs ("Sound" in house-show AND DIY, "Merch" in
-- DIY AND club-night), so a ("name") WHERE "orgId" IS NULL index would make
-- the catalogue unseedable. Intentionally absent from the Prisma schema;
-- shows up as expected drift.
CREATE UNIQUE INDEX "VolunteerRoleTemplate_platform_pack_name_key" ON "VolunteerRoleTemplate"("packId", "name") WHERE "orgId" IS NULL;

-- Pack -> roles fan-out, and FK maintenance for the SetNull below.
CREATE INDEX "VolunteerRoleTemplate_packId_idx" ON "VolunteerRoleTemplate"("packId");

-- Catalogue reads ("all platform rows, in curation order") in the org list
-- union.
CREATE INDEX "VolunteerRoleTemplate_isPlatform_sortOrder_idx" ON "VolunteerRoleTemplate"("isPlatform", "sortOrder");

-- SET NULL, deliberately NOT Cascade: an org's FORK of a catalogue role keeps
-- "packId" as provenance and must outlive the pack it came from. The other
-- half of the rule — "deleting a pack deletes its PLATFORM roles" — cannot be
-- expressed on the same FK (Postgres allows one referential action), so the
-- remove-pack use case deletes ("packId" = $1 AND "isPlatform") explicitly
-- inside the same transaction, before the pack row. That ordering is NOT left
-- to a comment: "VolunteerRoleTemplate_platform_pack_check" above turns the
-- SET NULL of a platform row into a constraint violation, so forgetting it
-- fails the DELETE instead of orphaning rows. See the VolunteerPack doc
-- comment in prisma/volunteer.prisma.
ALTER TABLE "VolunteerRoleTemplate" ADD CONSTRAINT "VolunteerRoleTemplate_packId_fkey" FOREIGN KEY ("packId") REFERENCES "VolunteerPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable — shift anchoring. Defaults reproduce today's behaviour exactly:
-- WALL_CLOCK ignores "offsetMinutes" and uses "startMinuteOfDay" as-is.
ALTER TABLE "VolunteerRoleTemplateShift" ADD COLUMN "anchor" "VolunteerShiftAnchor" NOT NULL DEFAULT 'WALL_CLOCK';
ALTER TABLE "VolunteerRoleTemplateShift" ADD COLUMN "offsetMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VolunteerRoleTemplateShift" ADD COLUMN "notes" TEXT;
