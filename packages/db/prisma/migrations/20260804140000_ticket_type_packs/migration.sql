-- Ticket-type packs — platform-curated ticket-type templates living in the
-- existing TicketTypeTemplate table (docs/specs/2026-08-04/
-- ticket-type-packs.spec.yaml, Phase A).
--
-- A catalogue row is ("ownerId" IS NULL, "isPlatform" = true, "packId" set —
-- the last of those is CHECK-enforced below). An owned row is unchanged:
-- "ownerId" set, "isPlatform" = false. TicketPack holds only pack metadata
-- (key, name, blurb, DRAFT/LIVE, sortOrder) — it owns no ticket types of its
-- own; templates point at it. Mirrors 20260728120000_volunteer_role_packs.
--
-- Widening "ownerId" to nullable is NOT reversible without data loss once
-- catalogue rows exist.
--
-- Template-name uniqueness for catalogue rows is PER PACK, not per
-- catalogue: two different packs may both ship a "General admission".

-- CreateEnum
CREATE TYPE "TicketPackStatus" AS ENUM ('DRAFT', 'LIVE');

-- CreateTable
CREATE TABLE "TicketPack" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blurb" TEXT,
    "status" "TicketPackStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "curatedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketPack_pkey" PRIMARY KEY ("id")
);

-- Stable slug so the seed path converges (re-seed updates, never duplicates).
CREATE UNIQUE INDEX "TicketPack_key_key" ON "TicketPack"("key");

-- Organizer-facing reads take LIVE packs in curation order.
CREATE INDEX "TicketPack_status_sortOrder_idx" ON "TicketPack"("status", "sortOrder");

-- FK maintenance on curator deletion (SetNull scans by curatedByHumanId).
CREATE INDEX "TicketPack_curatedByHumanId_idx" ON "TicketPack"("curatedByHumanId");

-- Losing the curator must never remove catalogue content.
ALTER TABLE "TicketPack" ADD CONSTRAINT "TicketPack_curatedByHumanId_fkey" FOREIGN KEY ("curatedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable — platform rows have no owner.
ALTER TABLE "TicketTypeTemplate" ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "TicketTypeTemplate" ADD COLUMN "isPlatform" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TicketTypeTemplate" ADD COLUMN "packId" TEXT;

-- Catalogue-row shape, DB-enforced: a platform row ALWAYS belongs to a pack.
-- Two jobs, both load-bearing (same reasoning as
-- "VolunteerRoleTemplate_platform_pack_check", 20260728120000):
--   1. It closes the NULL escape hatch under the partial unique index below —
--      a pack-less platform row would key on (NULL, name) and sit outside
--      the constraint entirely.
--   2. It makes "deleting a pack deletes its PLATFORM templates" enforceable
--      rather than aspirational: the FK below is SET NULL (fork-safe), so a
--      pack delete that skipped the explicit platform-row delete would
--      violate this CHECK and fail loudly instead of orphaning rows no
--      organizer read can reach.
-- Every existing row has isPlatform = false, so this validates with no
-- backfill.
ALTER TABLE "TicketTypeTemplate" ADD CONSTRAINT "TicketTypeTemplate_platform_pack_check" CHECK (
  "isPlatform" = false OR "packId" IS NOT NULL
);

-- CreateIndex (raw SQL — Prisma's schema language can't express partial
-- indexes; "VolunteerRoleTemplate_platform_pack_name_key" precedent).
-- Postgres treats NULLs as distinct, so once "ownerId" is nullable nothing
-- else constrains two platform templates sharing a name inside one pack.
-- PER PACK, not per catalogue. Intentionally absent from the Prisma schema;
-- shows up as expected drift.
CREATE UNIQUE INDEX "TicketTypeTemplate_platform_pack_name_key" ON "TicketTypeTemplate"("packId", "name") WHERE "ownerId" IS NULL;

-- Pack -> templates fan-out, and FK maintenance for the SetNull below.
CREATE INDEX "TicketTypeTemplate_packId_idx" ON "TicketTypeTemplate"("packId");

-- Catalogue reads ("all platform rows") in the owner list union.
CREATE INDEX "TicketTypeTemplate_isPlatform_idx" ON "TicketTypeTemplate"("isPlatform");

-- SET NULL, deliberately NOT Cascade: an owner's FORK of a catalogue
-- template keeps "packId" as provenance and must outlive the pack it came
-- from. The other half — "deleting a pack deletes its PLATFORM templates" —
-- cannot be expressed on the same FK (Postgres allows one referential
-- action), so the remove-pack use case deletes ("packId" = $1 AND
-- "isPlatform") explicitly inside the same transaction, before the pack row.
-- "TicketTypeTemplate_platform_pack_check" above turns a forgotten ordering
-- into a loud DELETE failure. See the TicketPack doc comment in
-- prisma/ticket.prisma.
ALTER TABLE "TicketTypeTemplate" ADD CONSTRAINT "TicketTypeTemplate_packId_fkey" FOREIGN KEY ("packId") REFERENCES "TicketPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;
