-- Volunteer comp-ticket rewards — COMP-only reward policy attached to an ask
-- (or a role within it), plus the per-grant idempotency + audit ledger.
-- See docs/specs/2026-06-29/volunteer-comp-tickets.spec.yaml (+ 2026-07-01
-- resolutions: COMP-only, EVENT-subject asks only, revoke on WITHDRAWN + manual).
--
-- Additive DDL only — 2 new enums, 2 new tables, their FKs / indexes, plus a
-- raw partial unique index that Prisma's schema language can't express. No
-- backfill: rewards are opt-in config an owner attaches after the fact.
--
-- Assembled from `prisma migrate diff --from-config-datasource --to-schema`,
-- EXCLUDING the following pre-existing drift already documented by the A1
-- (20260701120000_add_community_listings) migration and the search_documents
-- raw-index precedent — these are intentional Prisma-inexpressible constructs,
-- NOT part of this change and deliberately left out here:
--   * AlterEnum "EventCategoryRequestKind" (EVENT_TYPE value retained in DB)
--   * DropIndex "AcceptanceRecord_human_doc_version_scope_key" (raw partial key)
--   * DropIndex "search_doc_*" (6 raw GIN/GiST/trigram indexes)
--   * AlterTable "SearchDocument" DROP DEFAULT (generated-column raw defaults)

-- CreateEnum
CREATE TYPE "VolunteerRewardTrigger" AS ENUM ('ON_APPROVAL', 'ON_CHECK_IN');

-- CreateEnum
CREATE TYPE "VolunteerRewardGrantStatus" AS ENUM ('GRANTED', 'REDEEMED', 'REVOKED');

-- CreateTable
CREATE TABLE "VolunteerReward" (
    "id" TEXT NOT NULL,
    "askId" TEXT NOT NULL,
    "roleId" TEXT,
    "ticketTypeId" TEXT NOT NULL,
    "trigger" "VolunteerRewardTrigger" NOT NULL DEFAULT 'ON_CHECK_IN',
    "maxGrants" INTEGER,
    "grantsUsed" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerRewardGrant" (
    "id" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "humanId" TEXT,
    "contactEmail" TEXT NOT NULL,
    "status" "VolunteerRewardGrantStatus" NOT NULL DEFAULT 'GRANTED',
    "compOrderId" TEXT,
    "ticketId" TEXT,
    "faceValueCents" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "VolunteerRewardGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VolunteerReward_askId_idx" ON "VolunteerReward"("askId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerReward_askId_roleId_key" ON "VolunteerReward"("askId", "roleId");

-- CreateIndex
CREATE INDEX "VolunteerRewardGrant_signupId_idx" ON "VolunteerRewardGrant"("signupId");

-- CreateIndex
CREATE INDEX "VolunteerRewardGrant_rewardId_status_idx" ON "VolunteerRewardGrant"("rewardId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerRewardGrant_rewardId_signupId_key" ON "VolunteerRewardGrant"("rewardId", "signupId");

-- CreateIndex (raw SQL — Prisma's schema language can't express partial
-- indexes, following the "VolunteerAsk_event_subject_key" /
-- 20260512_search_documents precedent). Postgres treats NULLs as distinct in
-- the @@unique([askId, roleId]) above, so the ask-level (roleId IS NULL) case
-- would otherwise allow multiple whole-ask rewards. This enforces "at most one
-- ask-level reward per ask". Intentionally absent from the Prisma schema and
-- will show up as expected drift.
CREATE UNIQUE INDEX "VolunteerReward_ask_level_key" ON "VolunteerReward"("askId") WHERE "roleId" IS NULL;

-- AddForeignKey
ALTER TABLE "VolunteerReward" ADD CONSTRAINT "VolunteerReward_askId_fkey" FOREIGN KEY ("askId") REFERENCES "VolunteerAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerReward" ADD CONSTRAINT "VolunteerReward_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "EventVolunteerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerReward" ADD CONSTRAINT "VolunteerReward_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerRewardGrant" ADD CONSTRAINT "VolunteerRewardGrant_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "VolunteerReward"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerRewardGrant" ADD CONSTRAINT "VolunteerRewardGrant_signupId_fkey" FOREIGN KEY ("signupId") REFERENCES "VolunteerSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerRewardGrant" ADD CONSTRAINT "VolunteerRewardGrant_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerRewardGrant" ADD CONSTRAINT "VolunteerRewardGrant_compOrderId_fkey" FOREIGN KEY ("compOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerRewardGrant" ADD CONSTRAINT "VolunteerRewardGrant_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
