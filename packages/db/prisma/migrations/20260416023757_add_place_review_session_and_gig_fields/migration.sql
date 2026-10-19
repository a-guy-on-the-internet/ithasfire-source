-- CreateEnum
CREATE TYPE "PlaceReviewTimeOfDay" AS ENUM ('MORNING', 'AFTERNOON', 'EVENING', 'NIGHT');

-- AlterTable
ALTER TABLE "PlaceReview" ADD COLUMN     "gigDate" TIMESTAMP(3),
ADD COLUMN     "gigTimeExact" VARCHAR(10),
ADD COLUMN     "gigTimeOfDay" "PlaceReviewTimeOfDay";

-- CreateTable
CREATE TABLE "PlaceReviewSession" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "humanId" TEXT,
    "placeId" TEXT NOT NULL,
    "email" TEXT,
    "emailCapturedAt" TIMESTAMP(3),
    "lastStepKey" TEXT,
    "lastStepAt" TIMESTAMP(3),
    "pageReached" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3),
    "placeReviewId" TEXT,
    "abandonmentEmailSentAt" TIMESTAMP(3),
    "recoveryUnsubscribedAt" TIMESTAMP(3),
    "incentiveShownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceReviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaceReviewSession_placeReviewId_key" ON "PlaceReviewSession"("placeReviewId");

-- CreateIndex
CREATE INDEX "PlaceReviewSession_sessionToken_idx" ON "PlaceReviewSession"("sessionToken");

-- CreateIndex
CREATE INDEX "PlaceReviewSession_email_idx" ON "PlaceReviewSession"("email");

-- CreateIndex
CREATE INDEX "PlaceReviewSession_placeId_idx" ON "PlaceReviewSession"("placeId");

-- CreateIndex
CREATE INDEX "PlaceReviewSession_humanId_idx" ON "PlaceReviewSession"("humanId");

-- CreateIndex
CREATE INDEX "PlaceReviewSession_completedAt_idx" ON "PlaceReviewSession"("completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlaceReviewSession_sessionToken_placeId_key" ON "PlaceReviewSession"("sessionToken", "placeId");

-- AddForeignKey
ALTER TABLE "PlaceReviewSession" ADD CONSTRAINT "PlaceReviewSession_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceReviewSession" ADD CONSTRAINT "PlaceReviewSession_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceReviewSession" ADD CONSTRAINT "PlaceReviewSession_placeReviewId_fkey" FOREIGN KEY ("placeReviewId") REFERENCES "PlaceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
