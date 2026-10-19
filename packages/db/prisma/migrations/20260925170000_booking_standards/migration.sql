-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT A VENUE EXPECTS IN A PITCH
-- (venue-booking-standards, docs/specs/2026-09-25, FR-001 / FR-002, D1 / D2 /
-- D2a / D4)
--
-- A venue's expectations for a pitch lived nowhere the requester could see
-- them while writing one. Two new tables hold them, per intent (PERFORM |
-- RENT | USE):
--
--   BookingStandardItem  — an ordered checklist. Each item points at a KNOWN
--                          pitch field (or CUSTOM, a free-text line) and is
--                          REQUIRED (blocks submit, with the venue's label)
--                          or SUGGESTED (a prompt).
--   BookingPitchExample  — up to three venue-written example pitches.
--
-- D1: the owner is a CALENDAR (its own list) or a PLACE (the default every
-- calendar without rows for that intent inherits). With neither, core falls
-- back to platform defaults, which are code constants — not rows — and are
-- SUGGESTED-only, so nothing newly blocks submit anywhere (NFR-002).
--
-- The owner pair is POLYMORPHIC with no FK (EntityPage / InviteList
-- precedent), so there is no ON DELETE CASCADE: see the model comment in
-- venue.prisma for why orphan rows are harmless and what a future hard-delete
-- of a Calendar or Place must do.
--
-- Caps (≤ 12 items, ≤ 3 examples per owner + intent) are enforced in core.
-- Writes are replace-all per (owner, intent). Additive only; no backfill.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "BookingStandardOwnerType" AS ENUM ('PLACE', 'CALENDAR');

-- CreateEnum
CREATE TYPE "BookingStandardField" AS ENUM ('MESSAGE', 'PREFERRED_DATES', 'EXPECTED_DRAW', 'GENRE', 'LINEUP_SIZE', 'SET_LENGTH', 'TECH_NEEDS', 'FEE', 'LINK_MUSIC', 'LINK_VIDEO', 'LINK_SOCIAL', 'LINK_EPK', 'BILL', 'PURPOSE', 'EXPECTED_ATTENDANCE', 'REQUESTED_WINDOW', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BookingStandardRequirement" AS ENUM ('REQUIRED', 'SUGGESTED');

-- CreateTable
CREATE TABLE "BookingStandardItem" (
    "id" TEXT NOT NULL,
    "ownerType" "BookingStandardOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "intent" "BookingIntent" NOT NULL,
    "field" "BookingStandardField" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "hint" VARCHAR(240),
    "requirement" "BookingStandardRequirement" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingStandardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPitchExample" (
    "id" TEXT NOT NULL,
    "ownerType" "BookingStandardOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "intent" "BookingIntent" NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(1500) NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPitchExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingStandardItem_ownerType_ownerId_intent_sortOrder_idx" ON "BookingStandardItem"("ownerType", "ownerId", "intent", "sortOrder");

-- CreateIndex
CREATE INDEX "BookingPitchExample_ownerType_ownerId_intent_sortOrder_idx" ON "BookingPitchExample"("ownerType", "ownerId", "intent", "sortOrder");

-- ── SQL-only CHECK (Prisma cannot express it; `db push` leaves it be) ──────
--
-- D2a: only a KNOWN pitch field can be REQUIRED — one the form has and the
-- server can check. A CUSTOM line ("send a stage plot") is guidance only: a
-- required custom item could only be met by a self-attested checkbox, which
-- proves nothing. Core's write schema refuses it with a typed error first;
-- this is the backstop for every other writer.
ALTER TABLE "BookingStandardItem" ADD CONSTRAINT "BookingStandardItem_custom_is_suggested_check" CHECK (
  "field" <> 'CUSTOM' OR "requirement" = 'SUGGESTED'
);
