-- CreateEnum
CREATE TYPE "TicketTypePricingMode" AS ENUM ('FIXED', 'ADJUSTABLE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "nonRefundable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "minimumCents" INTEGER,
ADD COLUMN     "pricingMode" "TicketTypePricingMode" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "suggestedCents" INTEGER;
