-- CreateEnum
CREATE TYPE "ResaleOrderItemPayoutStatus" AS ENUM ('PENDING', 'HELD', 'READY', 'PAID', 'BLOCKED');

-- AlterTable
ALTER TABLE "Payee"
ADD COLUMN     "resaleNegativeBalanceCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resaleNegativeBalanceOpenedAt" TIMESTAMP(3),
ADD COLUMN     "resaleNegativeBalanceAgingStartsAt" TIMESTAMP(3),
ADD COLUMN     "resalePayoutBlockReason" TEXT,
ADD COLUMN     "resalePayoutBlockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payee"
ADD CONSTRAINT "Payee_resalePayoutBlock_pair_check"
CHECK (("resalePayoutBlockedAt" IS NULL) = ("resalePayoutBlockReason" IS NULL)),
ADD CONSTRAINT "Payee_resaleNegativeBalanceCents_nonnegative_check"
CHECK ("resaleNegativeBalanceCents" >= 0);

-- AlterTable
ALTER TABLE "PayoutTerms"
ADD COLUMN     "resaleSellerMarkupShareBps" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "resaleProcessingFeeConfigRef" TEXT,
ADD COLUMN     "resalePayoutReleaseDays" INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE "PayoutTerms"
ADD CONSTRAINT "PayoutTerms_resaleSellerMarkupShareBps_range_check"
CHECK ("resaleSellerMarkupShareBps" >= 0 AND "resaleSellerMarkupShareBps" <= 10000),
ADD CONSTRAINT "PayoutTerms_resalePayoutReleaseDays_nonnegative_check"
CHECK ("resalePayoutReleaseDays" >= 0);

-- AlterTable
ALTER TABLE "Event"
ADD COLUMN     "resalePayoutReleaseDaysOverride" INTEGER;

-- AlterTable
ALTER TABLE "Event"
ADD CONSTRAINT "Event_resalePayoutReleaseDaysOverride_nonnegative_check"
CHECK ("resalePayoutReleaseDaysOverride" IS NULL OR "resalePayoutReleaseDaysOverride" >= 0);

-- AlterTable
ALTER TABLE "TicketType"
ADD COLUMN     "resaleSellerMarkupShareBpsOverride" INTEGER;

-- AlterTable
ALTER TABLE "TicketType"
ADD CONSTRAINT "TicketType_resaleSellerMarkupShareBpsOverride_range_check"
CHECK (
  "resaleSellerMarkupShareBpsOverride" IS NULL
  OR (
    "resaleSellerMarkupShareBpsOverride" >= 0
    AND "resaleSellerMarkupShareBpsOverride" <= 10000
  )
);

-- AlterTable
ALTER TABLE "Listing"
ADD COLUMN     "faceValueCents" INTEGER,
ADD COLUMN     "positiveMarkupCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sellerMarkupShareCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "venueMarkupShareCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingPassThroughCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingFeeConfigRef" TEXT,
ADD COLUMN     "saleCutoffAt" TIMESTAMP(3),
ADD COLUMN     "payoutReleaseAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Listing"
ADD CONSTRAINT "Listing_resale_nonnegative_amounts_check"
CHECK (
  ("faceValueCents" IS NULL OR "faceValueCents" >= 0)
  AND "positiveMarkupCents" >= 0
  AND "sellerMarkupShareCents" >= 0
  AND "venueMarkupShareCents" >= 0
  AND "processingPassThroughCents" >= 0
),
ADD CONSTRAINT "Listing_markup_shares_sum_check"
CHECK ("positiveMarkupCents" = "sellerMarkupShareCents" + "venueMarkupShareCents");

-- AlterTable
ALTER TABLE "OrderItem"
ADD COLUMN     "resaleListingId" TEXT,
ADD COLUMN     "resaleFaceValueCents" INTEGER,
ADD COLUMN     "resalePositiveMarkupCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resaleSellerMarkupShareCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resaleVenueMarkupShareCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resaleProcessingPassThroughCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resaleProcessingFeeConfigRef" TEXT,
ADD COLUMN     "resaleSaleCutoffAt" TIMESTAMP(3),
ADD COLUMN     "resalePayoutReleaseAt" TIMESTAMP(3),
ADD COLUMN     "resalePayoutStatus" "ResaleOrderItemPayoutStatus",
ADD COLUMN     "resalePayoutHeldAt" TIMESTAMP(3),
ADD COLUMN     "resalePayoutHoldReason" TEXT,
ADD COLUMN     "resalePayoutNoticeSentAt" TIMESTAMP(3),
ADD COLUMN     "resalePayoutReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "resalePayoutFinalNoticeSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderItem"
ADD CONSTRAINT "OrderItem_resale_nonnegative_amounts_check"
CHECK (
  ("resaleFaceValueCents" IS NULL OR "resaleFaceValueCents" >= 0)
  AND "resalePositiveMarkupCents" >= 0
  AND "resaleSellerMarkupShareCents" >= 0
  AND "resaleVenueMarkupShareCents" >= 0
  AND "resaleProcessingPassThroughCents" >= 0
),
ADD CONSTRAINT "OrderItem_resale_markup_shares_sum_check"
CHECK ("resalePositiveMarkupCents" = "resaleSellerMarkupShareCents" + "resaleVenueMarkupShareCents"),
ADD CONSTRAINT "OrderItem_resalePayoutHold_pair_check"
CHECK (("resalePayoutHeldAt" IS NULL) = ("resalePayoutHoldReason" IS NULL)),
ADD CONSTRAINT "OrderItem_resalePayoutHeldStatus_requires_hold_metadata_check"
CHECK (
  "resalePayoutStatus" IS NULL
  OR "resalePayoutStatus" NOT IN ('HELD'::"ResaleOrderItemPayoutStatus", 'BLOCKED'::"ResaleOrderItemPayoutStatus")
  OR ("resalePayoutHeldAt" IS NOT NULL AND "resalePayoutHoldReason" IS NOT NULL)
);

-- Backfill canonical resale listing references from legacy order-item metadata before FK validation.
UPDATE "OrderItem" AS oi
SET "resaleListingId" = oi."meta"->>'resaleListingId'
FROM "Listing" AS l
WHERE oi."resaleListingId" IS NULL
  AND jsonb_typeof(oi."meta") = 'object'
  AND (oi."meta"->>'resaleListingId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND l."id" = oi."meta"->>'resaleListingId';

-- CreateIndex
CREATE INDEX "OrderItem_resaleListingId_idx" ON "OrderItem"("resaleListingId");

-- CreateIndex
CREATE INDEX "Payee_resalePayoutBlockedAt_idx" ON "Payee"("resalePayoutBlockedAt") WHERE "resalePayoutBlockedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Payee_resaleNegativeBalanceAgingStartsAt_idx" ON "Payee"("resaleNegativeBalanceAgingStartsAt") WHERE "resaleNegativeBalanceAgingStartsAt" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_resaleListingId_fkey" FOREIGN KEY ("resaleListingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;