-- Deal terms and the settlement sheet (deal-terms-and-settlement stage 1, P4b).
-- docs/specs/2026-09-29/deal-terms-and-settlement.spec.yaml FR-001, FR-004.
--
-- Additive except one relaxation: PayoutTermsLine.percent becomes NULLABLE
-- (a FIXED clause has no percent). Every existing row keeps its percent and
-- takes the column defaults amountType = PERCENT, basis = GROSS — exactly the
-- line the per-order engine pays today (FR-005). The shape CHECK below holds
-- for every existing row as long as its percent is within 0..100, which every
-- line editor has enforced since lines existed. PRE-DEPLOY CHECK (must return
-- 0 on the target database or this migration fails, by design):
--   SELECT count(*) FROM "PayoutTermsLine" WHERE "percent" < 0 OR "percent" > 100;
--
-- No backfill: PayoutTerms.remainderPayeeId stays NULL on existing rows and
-- the read side derives one by the legacy rule (core
-- `resolveDealRemainder`), labelled as derived; the first deal write stores
-- an explicit one. Nothing here moves money.

-- CreateEnum
CREATE TYPE "DealClauseAmountType" AS ENUM ('FIXED', 'PERCENT', 'FIXED_AND_PERCENT');

-- CreateEnum
CREATE TYPE "DealBasisKind" AS ENUM ('GROSS', 'NET_POOL');

-- CreateEnum
CREATE TYPE "DealClauseResolution" AS ENUM ('SUM', 'GREATER_OF');

-- CreateEnum
CREATE TYPE "DealDeductionKind" AS ENUM ('RENTAL', 'EXPENSE', 'HOUSE_NUT');

-- CreateEnum
CREATE TYPE "OffPlatformAmountKind" AS ENUM ('DOOR_CASH', 'BAR_SHARE', 'OTHER');

-- CreateEnum
CREATE TYPE "SettlementSheetStatus" AS ENUM ('DRAFT', 'SETTLED');

-- AlterTable
ALTER TABLE "PayoutTerms" ADD COLUMN     "remainderPayeeId" TEXT;

-- AlterTable
ALTER TABLE "PayoutTermsLine" ADD COLUMN     "amountCents" INTEGER,
ADD COLUMN     "amountType" "DealClauseAmountType" NOT NULL DEFAULT 'PERCENT',
ADD COLUMN     "basis" "DealBasisKind" NOT NULL DEFAULT 'GROSS',
ADD COLUMN     "displayLabel" VARCHAR(200),
ADD COLUMN     "resolution" "DealClauseResolution",
ALTER COLUMN "percent" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PayoutTermsDeduction" (
    "id" TEXT NOT NULL,
    "payoutTermsId" TEXT NOT NULL,
    "kind" "DealDeductionKind" NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "amountCents" INTEGER,
    "percent" INTEGER,
    "creditedPayeeId" TEXT NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutTermsDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementSheet" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "SettlementSheetStatus" NOT NULL DEFAULT 'DRAFT',
    "settledByHumanId" TEXT,
    "settledAt" TIMESTAMP(3),
    "engineVersion" INTEGER,
    "snapshot" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "reopenedAt" TIMESTAMP(3),
    "reopenedByHumanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementSheetOffPlatformAmount" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "kind" "OffPlatformAmountKind" NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "amountCents" INTEGER,
    "heldByPayeeId" TEXT NOT NULL,
    "ownerPayeeId" TEXT,
    "enteredByHumanId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementSheetOffPlatformAmount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementSheetDeductionActual" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "deductionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "enteredByHumanId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementSheetDeductionActual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementSheetDirectPayment" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "fromPayeeId" TEXT NOT NULL,
    "toPayeeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "note" VARCHAR(1000),
    "enteredByHumanId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementSheetDirectPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutTerms_remainderPayeeId_idx" ON "PayoutTerms"("remainderPayeeId");

-- CreateIndex
CREATE INDEX "PayoutTermsLine_payoutTermsId_amountType_basis_idx" ON "PayoutTermsLine"("payoutTermsId", "amountType", "basis");

-- CreateIndex
CREATE INDEX "PayoutTermsDeduction_creditedPayeeId_idx" ON "PayoutTermsDeduction"("creditedPayeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutTermsDeduction_payoutTermsId_sortOrder_key" ON "PayoutTermsDeduction"("payoutTermsId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementSheet_eventId_key" ON "SettlementSheet"("eventId");

-- CreateIndex
CREATE INDEX "SettlementSheetOffPlatformAmount_sheetId_createdAt_idx" ON "SettlementSheetOffPlatformAmount"("sheetId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementSheetOffPlatformAmount_heldByPayeeId_idx" ON "SettlementSheetOffPlatformAmount"("heldByPayeeId");

-- CreateIndex
CREATE INDEX "SettlementSheetOffPlatformAmount_ownerPayeeId_idx" ON "SettlementSheetOffPlatformAmount"("ownerPayeeId");

-- CreateIndex
CREATE INDEX "SettlementSheetDeductionActual_deductionId_idx" ON "SettlementSheetDeductionActual"("deductionId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementSheetDeductionActual_sheetId_deductionId_key" ON "SettlementSheetDeductionActual"("sheetId", "deductionId");

-- CreateIndex
CREATE INDEX "SettlementSheetDirectPayment_sheetId_createdAt_idx" ON "SettlementSheetDirectPayment"("sheetId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementSheetDirectPayment_fromPayeeId_idx" ON "SettlementSheetDirectPayment"("fromPayeeId");

-- CreateIndex
CREATE INDEX "SettlementSheetDirectPayment_toPayeeId_idx" ON "SettlementSheetDirectPayment"("toPayeeId");

-- AddForeignKey
ALTER TABLE "PayoutTerms" ADD CONSTRAINT "PayoutTerms_remainderPayeeId_fkey" FOREIGN KEY ("remainderPayeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTermsDeduction" ADD CONSTRAINT "PayoutTermsDeduction_payoutTermsId_fkey" FOREIGN KEY ("payoutTermsId") REFERENCES "PayoutTerms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTermsDeduction" ADD CONSTRAINT "PayoutTermsDeduction_creditedPayeeId_fkey" FOREIGN KEY ("creditedPayeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheet" ADD CONSTRAINT "SettlementSheet_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetOffPlatformAmount" ADD CONSTRAINT "SettlementSheetOffPlatformAmount_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "SettlementSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetOffPlatformAmount" ADD CONSTRAINT "SettlementSheetOffPlatformAmount_heldByPayeeId_fkey" FOREIGN KEY ("heldByPayeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetOffPlatformAmount" ADD CONSTRAINT "SettlementSheetOffPlatformAmount_ownerPayeeId_fkey" FOREIGN KEY ("ownerPayeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetDeductionActual" ADD CONSTRAINT "SettlementSheetDeductionActual_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "SettlementSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetDeductionActual" ADD CONSTRAINT "SettlementSheetDeductionActual_deductionId_fkey" FOREIGN KEY ("deductionId") REFERENCES "PayoutTermsDeduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetDirectPayment" ADD CONSTRAINT "SettlementSheetDirectPayment_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "SettlementSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetDirectPayment" ADD CONSTRAINT "SettlementSheetDirectPayment_fromPayeeId_fkey" FOREIGN KEY ("fromPayeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSheetDirectPayment" ADD CONSTRAINT "SettlementSheetDirectPayment_toPayeeId_fkey" FOREIGN KEY ("toPayeeId") REFERENCES "Payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SQL-only CHECKs (Prisma cannot declare them) ────────────────────────────
-- They mirror the calculator's shape rules (`assertDealTermsShape`,
-- `dealDeductionSchema`, `dealSettlementInputsSchema`) so a bad adapter write
-- fails in the database, not on the next sheet render. Rules that span rows
-- (percent total ≤ 100, at most one per-order line per payee, participants)
-- stay in the use cases: Postgres CHECKs see one row.

-- A clause's shape. CASE has an explicit ELSE FALSE: a CASE that falls
-- through yields NULL, and a CHECK treats NULL as passing.
ALTER TABLE "PayoutTermsLine" ADD CONSTRAINT "PayoutTermsLine_deal_clause_shape_check" CHECK (
  CASE "amountType"
    WHEN 'FIXED' THEN
      "amountCents" IS NOT NULL AND "amountCents" > 0
      AND "percent" IS NULL AND "resolution" IS NULL
    WHEN 'PERCENT' THEN
      "percent" IS NOT NULL AND "percent" BETWEEN 0 AND 100
      AND "amountCents" IS NULL AND "resolution" IS NULL
    WHEN 'FIXED_AND_PERCENT' THEN
      "amountCents" IS NOT NULL AND "amountCents" > 0
      AND "percent" IS NOT NULL AND "percent" BETWEEN 1 AND 100
      AND "resolution" IS NOT NULL
    ELSE FALSE
  END
);

-- A cost off the top: exactly one of amount / percent, both in range.
ALTER TABLE "PayoutTermsDeduction" ADD CONSTRAINT "PayoutTermsDeduction_amount_or_percent_check" CHECK (
  num_nonnulls("amountCents", "percent") = 1
  AND ("amountCents" IS NULL OR "amountCents" >= 0)
  AND ("percent" IS NULL OR "percent" BETWEEN 0 AND 100)
  AND "sortOrder" >= 0
  AND char_length("label") > 0
);

-- A settled sheet carries who, when, which engine and the frozen copy; a
-- draft carries none of them.
ALTER TABLE "SettlementSheet" ADD CONSTRAINT "SettlementSheet_settled_shape_check" CHECK (
  CASE "status"
    WHEN 'SETTLED' THEN
      "settledAt" IS NOT NULL AND "settledByHumanId" IS NOT NULL
      AND "engineVersion" IS NOT NULL AND "snapshot" IS NOT NULL
    WHEN 'DRAFT' THEN
      "settledAt" IS NULL AND "settledByHumanId" IS NULL
      AND "engineVersion" IS NULL AND "snapshot" IS NULL
    ELSE FALSE
  END
);

-- Off-platform money: NULL is "Not entered" (never $0); entered is >= 0.
ALTER TABLE "SettlementSheetOffPlatformAmount" ADD CONSTRAINT "SettlementSheetOffPlatformAmount_amount_check" CHECK (
  ("amountCents" IS NULL OR "amountCents" >= 0)
  AND char_length("label") > 0
);

ALTER TABLE "SettlementSheetDeductionActual" ADD CONSTRAINT "SettlementSheetDeductionActual_amount_check" CHECK (
  "amountCents" >= 0
);

-- Money that changed hands: a positive amount between two different parties.
ALTER TABLE "SettlementSheetDirectPayment" ADD CONSTRAINT "SettlementSheetDirectPayment_shape_check" CHECK (
  "amountCents" > 0
  AND "fromPayeeId" <> "toPayeeId"
  AND char_length("label") > 0
);
