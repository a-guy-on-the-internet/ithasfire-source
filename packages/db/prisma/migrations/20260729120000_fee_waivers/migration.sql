-- Fee waivers — a consumable allowance that zeroes the Ithas Fire platform fee
-- on a fixed number of tickets.
--
-- This is deliberately NOT a FeePolicy scope. FeePolicy is a declarative,
-- time-versioned rate card resolved EVENT -> ORG -> GLOBAL; nothing about it is
-- stateful. A waiver depletes as tickets sell, so it needs its own row with a
-- counter and its own redemption ledger.
--
-- Only the platform fee is waived. Stripe's processing fee still passes through
-- to the buyer — we cannot waive a cost the processor charges us.
--
-- "ticketsUsed" counts RESERVED + SETTLED redemptions. The CHECK constraint is
-- the last line of defence: the repo's reserve is a single atomic UPDATE with a
-- "ticketsUsed + n <= ticketsGranted" guard, but a hand-written UPDATE or a
-- future code path must not be able to oversell an allowance.

-- CreateEnum
CREATE TYPE "FeeWaiverSubjectType" AS ENUM ('HUMAN', 'ORG');

-- CreateEnum
CREATE TYPE "FeeWaiverSide" AS ENUM ('ORGANIZER', 'BUYER');

-- CreateEnum
CREATE TYPE "FeeWaiverStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FeeWaiverRedemptionStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

-- CreateTable
CREATE TABLE "FeeWaiver" (
    "id" TEXT NOT NULL,
    "subjectType" "FeeWaiverSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "side" "FeeWaiverSide" NOT NULL,
    "ticketsGranted" INTEGER NOT NULL,
    "ticketsUsed" INTEGER NOT NULL DEFAULT 0,
    "status" "FeeWaiverStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeWaiver_pkey" PRIMARY KEY ("id")
);

-- An allowance can never be oversold, and can never be granted as a no-op.
ALTER TABLE "FeeWaiver"
  ADD CONSTRAINT "FeeWaiver_tickets_within_grant"
  CHECK ("ticketsUsed" >= 0 AND "ticketsUsed" <= "ticketsGranted");

ALTER TABLE "FeeWaiver"
  ADD CONSTRAINT "FeeWaiver_grant_positive"
  CHECK ("ticketsGranted" > 0);

-- CreateTable
CREATE TABLE "FeeWaiverRedemption" (
    "id" TEXT NOT NULL,
    "waiverId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ticketsReserved" INTEGER NOT NULL,
    "feeWaivedCents" INTEGER NOT NULL,
    "status" "FeeWaiverRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "releasedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeWaiverRedemption_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FeeWaiverRedemption"
  ADD CONSTRAINT "FeeWaiverRedemption_amounts_nonneg"
  CHECK ("ticketsReserved" > 0 AND "feeWaivedCents" >= 0);

-- CreateIndex
CREATE INDEX "FeeWaiver_subjectType_subjectId_side_status_idx" ON "FeeWaiver"("subjectType", "subjectId", "side", "status");

-- CreateIndex
CREATE INDEX "FeeWaiver_status_effectiveFrom_idx" ON "FeeWaiver"("status", "effectiveFrom");

-- One redemption per order per waiver — makes reserve idempotent under
-- checkout retries.
-- CreateIndex
CREATE UNIQUE INDEX "FeeWaiverRedemption_waiverId_orderId_key" ON "FeeWaiverRedemption"("waiverId", "orderId");

-- CreateIndex
CREATE INDEX "FeeWaiverRedemption_orderId_idx" ON "FeeWaiverRedemption"("orderId");

-- CreateIndex
CREATE INDEX "FeeWaiverRedemption_status_idx" ON "FeeWaiverRedemption"("status");

-- AddForeignKey
ALTER TABLE "FeeWaiverRedemption" ADD CONSTRAINT "FeeWaiverRedemption_waiverId_fkey" FOREIGN KEY ("waiverId") REFERENCES "FeeWaiver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
