-- CreateEnum
CREATE TYPE "WaiverClauseCategory" AS ENUM ('STRUCTURAL', 'VENUE', 'ACTIVITY', 'SUBSTANCE', 'LEGAL', 'GENERAL');

-- CreateEnum
CREATE TYPE "WaiverClauseLayer" AS ENUM ('STRUCTURAL', 'RISK_SPECIFIC');

-- CreateEnum
CREATE TYPE "WaiverTemplateSource" AS ENUM ('FREEFORM', 'ASSEMBLED', 'PLATFORM');

-- AlterTable
ALTER TABLE "WaiverAcceptance" ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "WaiverTemplate" ADD COLUMN     "assembledFromClauses" JSONB,
ADD COLUMN     "jurisdictionState" VARCHAR(2),
ADD COLUMN     "source" "WaiverTemplateSource" NOT NULL DEFAULT 'FREEFORM';

-- CreateTable
CREATE TABLE "WaiverClause" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "WaiverClauseCategory" NOT NULL,
    "layer" "WaiverClauseLayer" NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "voidInStates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredInStates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaiverClause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaiverClauseAutoRule" (
    "id" TEXT NOT NULL,
    "clauseId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaiverClauseAutoRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaiverClause_slug_key" ON "WaiverClause"("slug");

-- CreateIndex
CREATE INDEX "WaiverClause_category_active_sortOrder_idx" ON "WaiverClause"("category", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "WaiverClause_layer_active_idx" ON "WaiverClause"("layer", "active");

-- CreateIndex
CREATE INDEX "WaiverClauseAutoRule_clauseId_idx" ON "WaiverClauseAutoRule"("clauseId");

-- AddForeignKey
ALTER TABLE "WaiverClauseAutoRule" ADD CONSTRAINT "WaiverClauseAutoRule_clauseId_fkey" FOREIGN KEY ("clauseId") REFERENCES "WaiverClause"("id") ON DELETE CASCADE ON UPDATE CASCADE;
