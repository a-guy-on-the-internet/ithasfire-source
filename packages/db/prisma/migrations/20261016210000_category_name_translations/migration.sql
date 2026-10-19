-- Category name translations (category-translations spec, 2026-10-16).
--
-- Category gains a JSON map of non-English names keyed by locale, e.g.
-- {"es":"Música"}. English stays in "name" and remains the slug source.
-- Uniqueness per locale is enforced by the use cases inside the naming lock,
-- not by an index (Prisma cannot model a JSON expression index).
--
-- EventCategoryRequest records the requester's UI locale; NULL on existing
-- rows means English.
--
-- Additive only: a NOT NULL column with a constant default and a nullable
-- column. Existing rows stay valid; no backfill.

-- AlterTable
ALTER TABLE "Category"
  ADD COLUMN "nameTranslations" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- AlterTable
ALTER TABLE "EventCategoryRequest"
  ADD COLUMN "locale" TEXT;
