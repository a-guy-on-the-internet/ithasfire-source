-- Adds the orthogonal content-classification columns to EntityPage
-- (entity-page-templates.spec.yaml FR-001 / FR-006):
--   `category`                  — the page's CURRENT content classification
--   `templateAppliedCategories` — every category ever template-seeded
--
-- The backfill marks every EXISTING page as already-seeded for its default
-- category ("venue" for PLACE, "generic" otherwise) so no pre-existing page is
-- ever retroactively bulk-seeded with template blocks its owner never asked for
-- (FR-006 / NFR-002). `category` backfills to the same value for
-- display/filtering. Newly-provisioned pages get category=NULL and an empty
-- templateAppliedCategories, so they seed lazily on first editor load.
--
-- Backfill is a single flat UPDATE (no per-row business logic) — same additive
-- pattern as other column migrations here; no chunking needed.
--
-- NOTE: this repo's dev DB is db-push-managed, not migrate-deploy-managed.
-- This migration file was written but is NOT auto-applied locally — apply via
-- `pnpm -F @th/db prisma db push` (dev) or the normal migrate-deploy path
-- (prod).

-- AlterTable
ALTER TABLE "EntityPage" ADD COLUMN "category" TEXT;
ALTER TABLE "EntityPage" ADD COLUMN "templateAppliedCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill existing rows (FR-006): default category by owner type, marked as
-- already-applied so seeding never fires retroactively.
UPDATE "EntityPage"
SET "category" = CASE WHEN "ownerType"::text = 'PLACE' THEN 'venue' ELSE 'generic' END,
    "templateAppliedCategories" =
      CASE WHEN "ownerType"::text = 'PLACE' THEN ARRAY['venue'] ELSE ARRAY['generic'] END;
