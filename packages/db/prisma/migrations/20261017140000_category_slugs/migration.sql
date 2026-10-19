-- spanish-seo FR-007: category URL slugs per locale, current and old.
-- One current row per (categoryId, locale) is enforced by the category use
-- cases inside categories.lockNaming(), not by a partial index (owner KISS
-- ruling; Prisma cannot model one and it would show as drift).

-- CreateTable
CREATE TABLE "CategorySlug" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategorySlug_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategorySlug_categoryId_locale_idx" ON "CategorySlug"("categoryId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "CategorySlug_locale_slug_key" ON "CategorySlug"("locale", "slug");

-- AddForeignKey
ALTER TABLE "CategorySlug" ADD CONSTRAINT "CategorySlug_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one current `en` row per existing category from Category.slug
-- (unique, so the (locale, slug) index cannot collide). `id` has no database
-- default (Prisma generates it), hence gen_random_uuid(). `es` rows are not
-- backfilled here: they need deriveCategorySlug + collision handling, done
-- in code by the category use case and its backfill script.
INSERT INTO "CategorySlug" ("id", "categoryId", "locale", "slug", "isCurrent", "createdAt")
SELECT gen_random_uuid()::text, "id", 'en', "slug", true, now() AT TIME ZONE 'UTC'
FROM "Category";
