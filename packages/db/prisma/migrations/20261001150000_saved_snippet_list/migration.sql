-- ═══════════════════════════════════════════════════════════════════════════
-- SAVED SNIPPET LIST — the per-(owner, kind) row behind saved reasons
-- (docs/specs/2026-09-25/booking-the-night.spec.yaml: FR-013, decision N18).
--
-- One row per owner list. It carries no text; it has two jobs:
--   1. startersCopiedAt — the platform default reasons were copied into this
--      list. Deleting every reason afterwards never brings them back.
--   2. The LOCK. SavedSnippetsRepo.lockList upserts this row
--      (INSERT … ON CONFLICT DO NOTHING) and takes SELECT … FOR UPDATE on it,
--      so create, copy-starters and reorder on one list serialise and the
--      30-per-list cap cannot be raced.
--
-- No FK on the owner pair (same as SavedSnippet). Rows appear lazily on the
-- first lockList, so there is no backfill.
--
-- Additive only: one new table + its unique index. IF NOT EXISTS so a
-- re-apply by hand (the dev DB is db-push-managed) is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE IF NOT EXISTS "SavedSnippetList" (
    "id" TEXT NOT NULL,
    "ownerType" "SavedSnippetOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "SavedSnippetKind" NOT NULL,
    "startersCopiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedSnippetList_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SavedSnippetList_ownerType_ownerId_kind_key" ON "SavedSnippetList"("ownerType", "ownerId", "kind");
