-- CreateEnum
CREATE TYPE "SmsConsentStatus" AS ENUM ('OPTED_OUT', 'OPTED_IN', 'UNKNOWN');

-- CreateTable
CREATE TABLE "SmsConsent" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "status" "SmsConsentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "reasonKeyword" TEXT,
    "providerMessageId" TEXT,
    "actorHumanId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "optedOutAt" TIMESTAMP(3),
    "optedInAt" TIMESTAMP(3),

    CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsentEvent" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "payloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SmsConsent_phoneE164_key" ON "SmsConsent"("phoneE164");

-- CreateIndex
CREATE INDEX "SmsConsent_status_updatedAt_idx" ON "SmsConsent"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SmsConsentEvent_phoneE164_createdAt_idx" ON "SmsConsentEvent"("phoneE164", "createdAt");
