-- Performer mode (performer-mode.spec.yaml) + polymorphic BookingRequest sender
-- (booking-request-and-agreement-editor.spec.yaml).
--
-- 1. New PerformerProfile table — the explicit opt-in gate for performer
--    surfaces. ownerType is "human" | "organization" (app-enforced).
-- 2. BookingRequest sender goes polymorphic: artistHumanId (Human FK) is
--    replaced by performerOwnerType + performerOwnerId. Existing rows are
--    migrated as human senders before the old column is dropped.

-- CreateTable
CREATE TABLE "PerformerProfile" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PerformerProfile_ownerType_ownerId_key" ON "PerformerProfile"("ownerType", "ownerId");

-- AlterTable: add the polymorphic sender columns (nullable first so existing
-- rows can be backfilled before the NOT NULL constraint lands).
ALTER TABLE "BookingRequest" ADD COLUMN "performerOwnerType" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "performerOwnerId" TEXT;

-- DataMigration: every pre-existing request was sent by a Human.
UPDATE "BookingRequest"
SET "performerOwnerType" = 'human',
    "performerOwnerId" = "artistHumanId";

ALTER TABLE "BookingRequest" ALTER COLUMN "performerOwnerType" SET NOT NULL;
ALTER TABLE "BookingRequest" ALTER COLUMN "performerOwnerId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "BookingRequest" DROP CONSTRAINT "BookingRequest_artistHumanId_fkey";

-- DropIndex
DROP INDEX "BookingRequest_artistHumanId_status_idx";

-- AlterTable
ALTER TABLE "BookingRequest" DROP COLUMN "artistHumanId";

-- CreateIndex
CREATE INDEX "BookingRequest_performerOwnerType_performerOwnerId_status_idx" ON "BookingRequest"("performerOwnerType", "performerOwnerId", "status");
