-- Place Review v3: GenreTag model, new PlaceReview/PlaceStats columns, new enums,
-- deprecate LIED_ABOUT_IT enum values, seed default genre tags.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. New enum types
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "PlaceReviewMerchPolicy" AS ENUM ('ALLOWED_FREELY', 'ALLOWED_WITH_CUT', 'NOT_ALLOWED');
CREATE TYPE "PlaceReviewStaffSupport" AS ENUM ('YES', 'SOMEWHAT', 'NO');
CREATE TYPE "PlaceReviewIndependentVenue" AS ENUM ('YES', 'NO', 'NOT_SURE');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. GenreTag table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "GenreTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenreTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GenreTag_name_key" ON "GenreTag"("name");
CREATE INDEX "GenreTag_name_idx" ON "GenreTag"("name");
CREATE INDEX "GenreTag_usageCount_idx" ON "GenreTag"("usageCount");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PlaceReview — new v3 columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "PlaceReview" ADD COLUMN "genreTags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PlaceReview" ADD COLUMN "dayOfWeek" INTEGER;
ALTER TABLE "PlaceReview" ADD COLUMN "merchAllowed" "PlaceReviewMerchPolicy";
ALTER TABLE "PlaceReview" ADD COLUMN "merchCutPct" INTEGER;
ALTER TABLE "PlaceReview" ADD COLUMN "staffSupport" "PlaceReviewStaffSupport";
ALTER TABLE "PlaceReview" ADD COLUMN "photoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PlaceReview" ADD COLUMN "independentVenue" "PlaceReviewIndependentVenue";

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PlaceStats — new v3 aggregation columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "PlaceStats" ADD COLUMN "merchAllowedPct" DOUBLE PRECISION;
ALTER TABLE "PlaceStats" ADD COLUMN "avgMerchCutPct" DOUBLE PRECISION;
ALTER TABLE "PlaceStats" ADD COLUMN "dayOfWeekDistribution" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "PlaceStats" ADD COLUMN "staffSupportScore" DOUBLE PRECISION;
ALTER TABLE "PlaceStats" ADD COLUMN "independentVenuePct" DOUBLE PRECISION;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Remove deprecated LIED_ABOUT_IT values from existing enums
--    Note: Postgres does not support DROP VALUE from an enum type directly.
--    If any rows reference LIED_ABOUT_IT, migrate them first. Since the app
--    never wrote this value in production (only in the baseline DDL), we can
--    safely replace it with the nearest value, then recreate the enum.
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a. PlaceReviewSoundQuality: LIED_ABOUT_IT → BAD
UPDATE "PlaceReview"
   SET "soundQuality" = 'BAD'::"PlaceReviewSoundQuality"
 WHERE "soundQuality" = 'LIED_ABOUT_IT'::"PlaceReviewSoundQuality";

-- Rename old type, create new type, convert column, drop old type
ALTER TYPE "PlaceReviewSoundQuality" RENAME TO "PlaceReviewSoundQuality_old";
CREATE TYPE "PlaceReviewSoundQuality" AS ENUM ('GREAT', 'ADEQUATE', 'BAD', 'NONEXISTENT');
ALTER TABLE "PlaceReview"
  ALTER COLUMN "soundQuality" TYPE "PlaceReviewSoundQuality"
  USING ("soundQuality"::text::"PlaceReviewSoundQuality");
DROP TYPE "PlaceReviewSoundQuality_old";

-- 5b. PlaceReviewStageEquipment: LIED_ABOUT_IT → NONE
UPDATE "PlaceReview"
   SET "stageEquipment" = 'NONE'::"PlaceReviewStageEquipment"
 WHERE "stageEquipment" = 'LIED_ABOUT_IT'::"PlaceReviewStageEquipment";

ALTER TYPE "PlaceReviewStageEquipment" RENAME TO "PlaceReviewStageEquipment_old";
CREATE TYPE "PlaceReviewStageEquipment" AS ENUM ('FULL', 'PARTIAL', 'NONE');
ALTER TABLE "PlaceReview"
  ALTER COLUMN "stageEquipment" TYPE "PlaceReviewStageEquipment"
  USING ("stageEquipment"::text::"PlaceReviewStageEquipment");
DROP TYPE "PlaceReviewStageEquipment_old";

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Seed default genre tags (~20 genres for the genre multi-select)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "GenreTag" ("id", "name", "displayName", "usageCount", "isDefault", "createdAt")
VALUES
  (gen_random_uuid(), 'rock',              'Rock',              0, true, now()),
  (gen_random_uuid(), 'indie',             'Indie',             0, true, now()),
  (gen_random_uuid(), 'pop',               'Pop',               0, true, now()),
  (gen_random_uuid(), 'hip-hop',           'Hip-Hop',           0, true, now()),
  (gen_random_uuid(), 'r&b',               'R&B',               0, true, now()),
  (gen_random_uuid(), 'jazz',              'Jazz',              0, true, now()),
  (gen_random_uuid(), 'blues',             'Blues',              0, true, now()),
  (gen_random_uuid(), 'country',           'Country',           0, true, now()),
  (gen_random_uuid(), 'folk',              'Folk',              0, true, now()),
  (gen_random_uuid(), 'punk',              'Punk',              0, true, now()),
  (gen_random_uuid(), 'metal',             'Metal',             0, true, now()),
  (gen_random_uuid(), 'electronic',        'Electronic',        0, true, now()),
  (gen_random_uuid(), 'singer-songwriter', 'Singer-Songwriter', 0, true, now()),
  (gen_random_uuid(), 'latin',             'Latin',             0, true, now()),
  (gen_random_uuid(), 'reggae',            'Reggae',            0, true, now()),
  (gen_random_uuid(), 'funk',              'Funk',              0, true, now()),
  (gen_random_uuid(), 'soul',              'Soul',              0, true, now()),
  (gen_random_uuid(), 'classical',         'Classical',         0, true, now()),
  (gen_random_uuid(), 'americana',         'Americana',         0, true, now()),
  (gen_random_uuid(), 'world',             'World',             0, true, now());
