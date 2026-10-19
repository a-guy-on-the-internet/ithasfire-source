-- CreateEnum
CREATE TYPE "AcceptanceDocumentType" AS ENUM ('CHARGEBACK_TERMS_ORGANIZER', 'BUYER_TERMS', 'REFUND_POLICY', 'ORGANIZER_TERMS', 'PRIVACY_POLICY', 'AGE_VERIFICATION');

-- CreateEnum
CREATE TYPE "AcceptanceScope" AS ENUM ('GLOBAL', 'ORGANIZATION', 'EVENT');

-- CreateTable
CREATE TABLE "AcceptanceRecord" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "documentType" "AcceptanceDocumentType" NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "documentTextSnapshot" TEXT NOT NULL,
    "scopeType" "AcceptanceScope" NOT NULL DEFAULT 'GLOBAL',
    "scopeId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,

    CONSTRAINT "AcceptanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcceptanceRecord_humanId_documentType_documentVersion_idx" ON "AcceptanceRecord"("humanId", "documentType", "documentVersion");

-- CreateIndex
CREATE INDEX "AcceptanceRecord_scopeType_scopeId_documentType_idx" ON "AcceptanceRecord"("scopeType", "scopeId", "documentType");

-- CreateIndex
CREATE INDEX "AcceptanceRecord_documentType_documentVersion_idx" ON "AcceptanceRecord"("documentType", "documentVersion");

-- AddForeignKey
ALTER TABLE "AcceptanceRecord" ADD CONSTRAINT "AcceptanceRecord_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
