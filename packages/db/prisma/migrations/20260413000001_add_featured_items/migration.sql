-- CreateEnum
CREATE TYPE "FeaturedItemType" AS ENUM ('EVENT', 'HUMAN', 'ORGANIZATION', 'PLACE');

-- CreateTable
CREATE TABLE "featured_items" (
    "id" TEXT NOT NULL,
    "itemType" "FeaturedItemType" NOT NULL,
    "item_id" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "hero_image_url" TEXT,
    "cta_url" TEXT,
    "cta_label" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "curated_by_human_id" TEXT,
    "curated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "curated_until" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "featured_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "featured_items_active_sort_order_idx" ON "featured_items"("active", "sort_order");

-- CreateIndex
CREATE INDEX "featured_items_curated_by_human_id_idx" ON "featured_items"("curated_by_human_id");

-- CreateIndex
CREATE INDEX "featured_items_curated_until_idx" ON "featured_items"("curated_until");

-- CreateIndex
CREATE UNIQUE INDEX "featured_items_itemType_item_id_key" ON "featured_items"("itemType", "item_id");

-- AddForeignKey
ALTER TABLE "featured_items" ADD CONSTRAINT "featured_items_curated_by_human_id_fkey" FOREIGN KEY ("curated_by_human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
