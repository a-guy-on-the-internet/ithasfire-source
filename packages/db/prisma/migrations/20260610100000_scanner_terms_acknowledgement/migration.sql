-- AlterTable
ALTER TABLE "Human"
  ADD COLUMN "scannerTermsAckAt" TIMESTAMP(3),
  ADD COLUMN "scannerTermsAckVersion" TEXT,
  ADD COLUMN "scannerTermsAckIp" TEXT,
  ADD COLUMN "scannerTermsAckUserAgent" TEXT;
