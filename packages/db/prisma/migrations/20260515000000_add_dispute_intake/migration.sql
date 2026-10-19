CREATE TYPE "DisputeStatus" AS ENUM (
  'NEEDS_TRIAGE',
  'OPEN',
  'UNDER_REVIEW',
  'WON',
  'LOST',
  'WARNING_OPEN',
  'WARNING_UNDER_REVIEW',
  'WARNING_CLOSED'
);

ALTER TABLE "Order"
  ADD COLUMN "disputedAt" TIMESTAMP(3),
  ADD COLUMN "disputeStatus" "DisputeStatus",
  ADD COLUMN "checkoutIp" VARCHAR(128);

CREATE TABLE "Dispute" (
  "id" TEXT NOT NULL,
  "stripeDisputeId" TEXT NOT NULL,
  "stripeChargeId" TEXT,
  "paymentIntentId" TEXT,
  "orderId" TEXT,
  "ownerSubjectType" "PayeeSubjectType",
  "ownerSubjectId" TEXT,
  "ownerOrgId" TEXT,
  "ownerHumanId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "DisputeStatus" NOT NULL,
  "triageReason" TEXT,
  "linkedAt" TIMESTAMP(3),
  "evidenceDueBy" TIMESTAMP(3),
  "fundsWithdrawnAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "outcome" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Dispute_stripeDisputeId_key" ON "Dispute"("stripeDisputeId");
CREATE INDEX "Dispute_orderId_idx" ON "Dispute"("orderId");
CREATE INDEX "Dispute_stripeChargeId_idx" ON "Dispute"("stripeChargeId");
CREATE INDEX "Dispute_paymentIntentId_idx" ON "Dispute"("paymentIntentId");
CREATE INDEX "Dispute_ownerSubjectType_ownerSubjectId_status_idx" ON "Dispute"("ownerSubjectType", "ownerSubjectId", "status");
CREATE INDEX "Dispute_ownerOrgId_status_idx" ON "Dispute"("ownerOrgId", "status");
CREATE INDEX "Dispute_ownerHumanId_status_idx" ON "Dispute"("ownerHumanId", "status");
CREATE INDEX "Dispute_status_evidenceDueBy_idx" ON "Dispute"("status", "evidenceDueBy");

ALTER TABLE "Dispute"
  ADD CONSTRAINT "Dispute_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Dispute"
  ADD CONSTRAINT "Dispute_ownerOrgId_fkey"
  FOREIGN KEY ("ownerOrgId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Dispute"
  ADD CONSTRAINT "Dispute_ownerHumanId_fkey"
  FOREIGN KEY ("ownerHumanId") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;