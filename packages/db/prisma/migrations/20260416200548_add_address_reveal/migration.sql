-- CreateEnum
CREATE TYPE "AddressRevealPreset" AS ENUM ('IMMEDIATELY', 'ONE_HOUR_BEFORE', 'DAY_BEFORE', 'WEEK_BEFORE', 'CUSTOM');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "address_reveal_at" TIMESTAMP(3),
ADD COLUMN     "address_reveal_preset" "AddressRevealPreset";
