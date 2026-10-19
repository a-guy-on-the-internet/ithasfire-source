-- ═══════════════════════════════════════════════════════════════════════════
-- BOOKING THE NIGHT — the schema for agree-to-book, cancel booking and saved
-- reasons (docs/specs/2026-09-25/booking-the-night.spec.yaml: FR-002, FR-009,
-- FR-013; decisions N10, N13, N18).
--
-- 1. Agreement.sentForReviewByHumanId (FR-002 / N10) — the venue person who
--    sent the terms. When the sender agrees, the draft event is created as
--    this person. Nullable: every existing row predates it. SetNull on human
--    deletion (the mint then fails its authority check and the venue retries
--    with "Create event").
-- 2. BookingHoldReleaseReason.BOOKING_CANCELLED (FR-009 / N13) — the one way
--    a CONFIRMED hold leaves its line: the booked night was cancelled.
-- 3. SavedSnippet (FR-013 / N18) — an owner's reusable reasons (and, later,
--    ask templates). No FK on the owner pair (house style for owner-scoped
--    templates). The "at most 30 per (owner, kind)" limit lives in core.
--
-- Additive only: one nullable column + index + FK, one enum value, two new
-- enums, one new table. No backfill.
--
-- ALTER TYPE ... ADD VALUE runs inside the migration's transaction, which
-- Postgres allows (12+) as long as the new value is not USED in the same
-- transaction — nothing here uses it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 2. Hold release reason ───────────────────────────────────────────────────

-- AlterEnum
ALTER TYPE "BookingHoldReleaseReason" ADD VALUE 'BOOKING_CANCELLED';

-- ── 3. SavedSnippet enums ────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "SavedSnippetOwnerType" AS ENUM ('HUMAN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "SavedSnippetKind" AS ENUM ('DECLINE_REASON', 'ASK');

-- ── 1. Agreement.sentForReviewByHumanId ──────────────────────────────────────

-- AlterTable
ALTER TABLE "Agreement" ADD COLUMN "sentForReviewByHumanId" TEXT;

-- CreateIndex
CREATE INDEX "Agreement_sentForReviewByHumanId_idx" ON "Agreement"("sentForReviewByHumanId");

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_sentForReviewByHumanId_fkey" FOREIGN KEY ("sentForReviewByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. SavedSnippet ──────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "SavedSnippet" (
    "id" TEXT NOT NULL,
    "ownerType" "SavedSnippetOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "SavedSnippetKind" NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isStarter" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSnippet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedSnippet_ownerType_ownerId_kind_sortOrder_idx" ON "SavedSnippet"("ownerType", "ownerId", "kind", "sortOrder");

-- A snippet with an empty label or body is nothing to pick. Core refuses
-- blank text first (after sanitizing); this is the DB's backstop. SQL-only
-- (Prisma cannot express a CHECK) — noted on the model.
ALTER TABLE "SavedSnippet" ADD CONSTRAINT "SavedSnippet_nonempty_check" CHECK (
  char_length("label") > 0 AND char_length("body") > 0
);
