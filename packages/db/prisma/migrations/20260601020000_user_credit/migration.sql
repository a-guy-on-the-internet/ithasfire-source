-- CreateEnum
CREATE TYPE "UserCreditStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "UserCreditSourceType" AS ENUM ('SIGNUP_BONUS', 'REFERRAL', 'REFUND_GOODWILL', 'PLATFORM_CAMPAIGN', 'PARTNER_SPIFF', 'MANUAL_STAFF_GRANT');

-- CreateTable
CREATE TABLE "UserCredit" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "balanceCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" "UserCreditSourceType" NOT NULL,
    "grantedByHumanId" TEXT,
    "sourceRef" TEXT,
    "status" "UserCreditStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCreditRedemption" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "UserCreditRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserCredit_humanId_status_idx" ON "UserCredit"("humanId", "status");

-- CreateIndex
CREATE INDEX "UserCredit_expiresAt_idx" ON "UserCredit"("expiresAt");

-- CreateIndex
CREATE INDEX "UserCredit_sourceType_sourceRef_idx" ON "UserCredit"("sourceType", "sourceRef");

-- CreateIndex (partial unique velocity guard)
-- A given (humanId, sourceType, sourceRef) may grant a human at most once when
-- a sourceRef is supplied (campaign id, referral pair, etc.). The partial WHERE
-- lets system grants without a sourceRef (signup bonuses, ad-hoc staff grants)
-- be issued freely. This is the race-safe backstop for grantCredit's
-- check-then-insert: concurrent duplicate grants collide on this index (P2002)
-- instead of both inserting. Prisma cannot express a partial unique index in
-- the schema, so it lives here as raw SQL (see packages/db/prisma/credit.prisma).
CREATE UNIQUE INDEX "UserCredit_humanId_sourceType_sourceRef_key"
    ON "UserCredit"("humanId", "sourceType", "sourceRef")
    WHERE "sourceRef" IS NOT NULL;

-- CreateIndex
CREATE INDEX "UserCreditRedemption_orderId_idx" ON "UserCreditRedemption"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCreditRedemption_creditId_orderId_key" ON "UserCreditRedemption"("creditId", "orderId");

-- AddForeignKey
ALTER TABLE "UserCredit" ADD CONSTRAINT "UserCredit_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCredit" ADD CONSTRAINT "UserCredit_grantedByHumanId_fkey" FOREIGN KEY ("grantedByHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCreditRedemption" ADD CONSTRAINT "UserCreditRedemption_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "UserCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCreditRedemption" ADD CONSTRAINT "UserCreditRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
