-- Chargeback evidence package (dispute desk, step 2).
--
-- Adds the staff-assembled evidence package as its own 1:1 table
-- (DisputeEvidence), mirrors Stripe's `evidence_details` hash onto Dispute so
-- the desk can list "has evidence / past due / submission count" without a
-- live processor read, and snapshots the card AVS/CVC checks onto Order at
-- `payment_intent.succeeded` — the one evidence source that was not
-- persisted anywhere before this.
--
-- Fully additive. No backfill: `paymentCardChecks` is going-forward only
-- (the charge is not re-read for historical orders) and the Dispute mirror
-- columns stay NULL until the next webhook for that dispute refreshes them.
-- Every statement is re-applicable (IF NOT EXISTS) because the dev databases
-- are db-push-managed and replay migrations on top of an already-pushed schema.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DisputeEvidenceStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUBMITTED', 'SUBMIT_FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable: Dispute — Stripe evidence_details mirror + our submit stamp
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "evidenceHasEvidence" BOOLEAN;
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "evidencePastDue" BOOLEAN;
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "evidenceSubmissionCount" INTEGER;
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "evidenceSubmittedAt" TIMESTAMP(3);

-- AlterTable: Order — card AVS/CVC checks snapshot
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "paymentCardChecks" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DisputeEvidence" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "status" "DisputeEvidenceStatus" NOT NULL DEFAULT 'DRAFT',
    "fields" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "assembledAt" TIMESTAMP(3) NOT NULL,
    "assembledVersion" INTEGER NOT NULL DEFAULT 1,
    "reviewedByHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedByHumanId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submitError" TEXT,
    "processorSubmissionCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisputeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DisputeEvidence_disputeId_key" ON "DisputeEvidence"("disputeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DisputeEvidence_status_idx" ON "DisputeEvidence"("status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "DisputeEvidence"
    ADD CONSTRAINT "DisputeEvidence_disputeId_fkey"
    FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
