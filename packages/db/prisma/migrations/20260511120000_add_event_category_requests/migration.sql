-- Event-builder category and sub-category suggestion review queue.

-- CreateEnum
CREATE TYPE "EventCategoryRequestKind" AS ENUM ('CATEGORY', 'EVENT_TYPE');

-- CreateEnum
CREATE TYPE "EventCategoryRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "EventCategoryRequest" (
    "id" TEXT NOT NULL,
    "kind" "EventCategoryRequestKind" NOT NULL,
    "status" "EventCategoryRequestStatus" NOT NULL DEFAULT 'PENDING',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "categoryId" TEXT,
    "categorySlug" TEXT,
    "categoryName" TEXT,
    "eventId" TEXT,
    "requesterHumanId" TEXT NOT NULL,
    "reviewedByHumanId" TEXT,
    "reviewNote" TEXT,
    "resolvedCategoryId" TEXT,
    "resolvedEventTypeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "EventCategoryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventCategoryRequest_status_createdAt_idx" ON "EventCategoryRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EventCategoryRequest_kind_slug_idx" ON "EventCategoryRequest"("kind", "slug");

-- CreateIndex
CREATE INDEX "EventCategoryRequest_categoryId_status_idx" ON "EventCategoryRequest"("categoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategoryRequest_pending_root_unique_idx"
ON "EventCategoryRequest"("kind", "slug")
WHERE "status" = 'PENDING' AND "categoryId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "EventCategoryRequest_pending_scoped_unique_idx"
ON "EventCategoryRequest"("kind", "slug", "categoryId")
WHERE "status" = 'PENDING' AND "categoryId" IS NOT NULL;