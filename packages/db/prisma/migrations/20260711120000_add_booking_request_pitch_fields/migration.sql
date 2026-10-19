-- Expanded booking-request pitch fields (2026-07-11). All additive + nullable;
-- no backfill — existing rows stay NULL. The generic `links` column is retained
-- (pre-expansion rows may hold data) but superseded on the create path by the
-- typed link* columns below.

-- Fee ask type. NEGOTIABLE carries no amount; GUARANTEE/DOOR_SPLIT may.
CREATE TYPE "BookingFeeType" AS ENUM ('GUARANTEE', 'DOOR_SPLIT', 'NEGOTIABLE');

ALTER TABLE "BookingRequest"
  ADD COLUMN "actName" TEXT,
  ADD COLUMN "lineupSize" INTEGER,
  ADD COLUMN "setLengthMinutes" INTEGER,
  ADD COLUMN "contactPhone" TEXT,
  ADD COLUMN "techNeeds" TEXT,
  ADD COLUMN "feeType" "BookingFeeType",
  ADD COLUMN "feeAmountCents" INTEGER,
  ADD COLUMN "feeCurrency" VARCHAR(3),
  ADD COLUMN "linkMusic" TEXT,
  ADD COLUMN "linkVideo" TEXT,
  ADD COLUMN "linkSocial" TEXT,
  ADD COLUMN "linkEpk" TEXT;
