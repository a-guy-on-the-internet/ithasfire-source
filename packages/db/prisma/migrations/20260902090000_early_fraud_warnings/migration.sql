-- Radar early fraud warnings (EFW).
--
-- Stripe fires `radar.early_fraud_warning.created` when a card issuer flags a
-- charge as likely fraud — typically days BEFORE the chargeback lands. A refund
-- inside that window means no dispute, no dispute fee and no dispute-ratio hit.
-- This table persists the warning, links it to the order/owner the same way
-- Dispute does, and records how it stopped mattering (refunded / disputed /
-- ignored) so the desk can show "we were warned" next to a later chargeback.
--
-- Fully additive. No backfill: warnings received before this migration were
-- never stored anywhere. Every statement is re-applicable (IF NOT EXISTS)
-- because the dev databases are db-push-managed and replay migrations on top
-- of an already-pushed schema.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EarlyFraudWarningResolution" AS ENUM ('REFUNDED', 'DISPUTED', 'IGNORED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "EarlyFraudWarning" (
    "id" TEXT NOT NULL,
    "stripeEfwId" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "orderId" TEXT,
    "ownerOrgId" TEXT,
    "ownerHumanId" TEXT,
    "fraudType" TEXT NOT NULL,
    "actionable" BOOLEAN NOT NULL,
    "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolution" "EarlyFraudWarningResolution",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarlyFraudWarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EarlyFraudWarning_stripeEfwId_key" ON "EarlyFraudWarning"("stripeEfwId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyFraudWarning_orderId_idx" ON "EarlyFraudWarning"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyFraudWarning_stripeChargeId_idx" ON "EarlyFraudWarning"("stripeChargeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyFraudWarning_actionable_resolvedAt_stripeCreatedAt_idx" ON "EarlyFraudWarning"("actionable", "resolvedAt", "stripeCreatedAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "EarlyFraudWarning"
    ADD CONSTRAINT "EarlyFraudWarning_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
