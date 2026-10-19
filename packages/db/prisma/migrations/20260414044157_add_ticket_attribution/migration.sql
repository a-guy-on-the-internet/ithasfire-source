-- CreateEnum
CREATE TYPE "TicketAttributionSource" AS ENUM ('REF_LINK', 'CHECKOUT_SELECT', 'NONE');

-- CreateEnum
CREATE TYPE "AttributionConsentStatus" AS ENUM ('GRANTED', 'DENIED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "termsAcceptedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PlaceReview" ALTER COLUMN "genreTags" DROP DEFAULT,
ALTER COLUMN "photoKeys" DROP DEFAULT;

-- CreateTable
CREATE TABLE "TicketAttribution" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attributedToEventHumanId" TEXT,
    "attributedToHumanId" TEXT,
    "source" "TicketAttributionSource" NOT NULL,
    "trackingConsent" "AttributionConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "refRaw" TEXT,
    "refEventHumanId" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "fanHumanId" TEXT,
    "fanCity" TEXT,
    "fanState" TEXT,
    "fanCountry" VARCHAR(2),
    "checkoutArtistSelection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketAttribution_eventId_idx" ON "TicketAttribution"("eventId");

-- CreateIndex
CREATE INDEX "TicketAttribution_attributedToHumanId_idx" ON "TicketAttribution"("attributedToHumanId");

-- CreateIndex
CREATE INDEX "TicketAttribution_attributedToEventHumanId_idx" ON "TicketAttribution"("attributedToEventHumanId");

-- CreateIndex
CREATE INDEX "TicketAttribution_fanHumanId_idx" ON "TicketAttribution"("fanHumanId");

-- CreateIndex
CREATE INDEX "TicketAttribution_eventId_attributedToHumanId_idx" ON "TicketAttribution"("eventId", "attributedToHumanId");

-- CreateIndex
CREATE INDEX "TicketAttribution_fanHumanId_eventId_idx" ON "TicketAttribution"("fanHumanId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketAttribution_eventId_orderId_key" ON "TicketAttribution"("eventId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketAttribution_idempotencyKey_key" ON "TicketAttribution"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "TicketAttribution" ADD CONSTRAINT "TicketAttribution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttribution" ADD CONSTRAINT "TicketAttribution_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttribution" ADD CONSTRAINT "TicketAttribution_attributedToEventHumanId_fkey" FOREIGN KEY ("attributedToEventHumanId") REFERENCES "EventHuman"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttribution" ADD CONSTRAINT "TicketAttribution_attributedToHumanId_fkey" FOREIGN KEY ("attributedToHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttribution" ADD CONSTRAINT "TicketAttribution_fanHumanId_fkey" FOREIGN KEY ("fanHumanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
