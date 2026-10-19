-- =============================================================================
-- FIX: Create missing Place-related tables in prod database
-- =============================================================================
-- Root cause: The consolidated baseline migration (20260407000000) was resolved
-- (applied_steps_count=0) without executing its SQL. Place tables were new in
-- the baseline and never existed in pre-consolidation migrations.
--
-- This script creates all missing Place tables + GenreTag, adds baseline indexes,
-- adds FK constraints (including from existing tables like Event, SavedLocation),
-- and applies column additions from place_review_v3 and add_place_phone_website.
--
-- All Place-related ENUM types already exist (created by pre-consolidation
-- migrations and place_review_v3). They are NOT recreated here.
-- =============================================================================

BEGIN;

-- Pre-flight: abort if Place table already exists (prevents double-application)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Place' AND relkind = 'r') THEN
    RAISE EXCEPTION 'Place table already exists — aborting';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CREATE TABLES (from consolidated baseline)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "address" TEXT NOT NULL,
    "addrLine1" TEXT,
    "addrLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "country" TEXT,
    "addressHash" TEXT,
    "capacity" INTEGER,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "PlaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "verificaion" "PlaceVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "listed_in_directory" BOOLEAN NOT NULL DEFAULT false,
    "default_primary_payout_terms_id" TEXT,
    "default_resale_payout_terms_id" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceReview" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "humanId" TEXT,
    "anonymousName" TEXT,
    "anonymousEmail" TEXT,
    "payoutCents" INTEGER,
    "paymentMethod" "PlaceReviewPaymentMethod" NOT NULL,
    "paymentDetail" VARCHAR(500),
    "venuePromoted" "PlaceReviewPromotionLevel" NOT NULL,
    "promotionDetail" VARCHAR(500),
    "soundQuality" "PlaceReviewSoundQuality" NOT NULL,
    "soundDetail" VARCHAR(500),
    "stageEquipment" "PlaceReviewStageEquipment" NOT NULL,
    "stageEquipmentDetail" VARCHAR(500),
    "audienceFit" "PlaceReviewAudienceFit" NOT NULL,
    "audienceDetail" VARCHAR(500),
    "parkingLoadIn" "PlaceReviewParking" NOT NULL,
    "parkingDetail" VARCHAR(500),
    "bookerRating" "PlaceReviewBookerRating" NOT NULL,
    "bookerDetail" VARCHAR(500),
    "wouldPlayAgain" "PlaceReviewPlayAgain" NOT NULL,
    "comment" VARCHAR(1000),
    "genre" VARCHAR(200),
    "estimatedDraw" INTEGER,
    "source" "PlaceReviewSource" NOT NULL DEFAULT 'SURVEY',
    "eventId" TEXT,
    "responseText" VARCHAR(500),
    "responseById" TEXT,
    "respondedAt" TIMESTAMP(3),
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "genreTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dayOfWeek" INTEGER,
    "merchAllowed" "PlaceReviewMerchPolicy",
    "merchCutPct" INTEGER,
    "staffSupport" "PlaceReviewStaffSupport",
    "photoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "independentVenue" "PlaceReviewIndependentVenue",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceStats" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCountPublic" INTEGER NOT NULL DEFAULT 0,
    "payoutMeanCents" INTEGER,
    "payoutMedianCents" INTEGER,
    "payoutMinCents" INTEGER,
    "payoutMaxCents" INTEGER,
    "payoutStdDevCents" INTEGER,
    "payoutSampleSize" INTEGER NOT NULL DEFAULT 0,
    "payoutGuaranteePct" DOUBLE PRECISION,
    "payoutDoorSplitPct" DOUBLE PRECISION,
    "payoutTicketSalesPct" DOUBLE PRECISION,
    "payoutTipsPct" DOUBLE PRECISION,
    "payoutPayToPlayPct" DOUBLE PRECISION,
    "payoutUnpaidPct" DOUBLE PRECISION,
    "promotionScore" DOUBLE PRECISION,
    "soundScore" DOUBLE PRECISION,
    "audienceFitScore" DOUBLE PRECISION,
    "wouldPlayAgainPct" DOUBLE PRECISION,
    "bookerScore" DOUBLE PRECISION,
    "parkingScore" DOUBLE PRECISION,
    "stageEquipmentScore" DOUBLE PRECISION,
    "drawMean" INTEGER,
    "drawMedian" INTEGER,
    "drawMin" INTEGER,
    "drawMax" INTEGER,
    "drawSampleSize" INTEGER NOT NULL DEFAULT 0,
    "payToPlayFlagged" BOOLEAN NOT NULL DEFAULT false,
    "equipmentLiedFlagged" BOOLEAN NOT NULL DEFAULT false,
    "noPromotionFlagged" BOOLEAN NOT NULL DEFAULT false,
    "genreCloud" JSONB NOT NULL DEFAULT '[]',
    "totalEventCount" INTEGER NOT NULL DEFAULT 0,
    "totalTicketsSold" INTEGER NOT NULL DEFAULT 0,
    "avgTicketPriceCents" INTEGER,
    "avgAttendance" INTEGER,
    "lastCalculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merchAllowedPct" DOUBLE PRECISION,
    "avgMerchCutPct" DOUBLE PRECISION,
    "dayOfWeekDistribution" JSONB NOT NULL DEFAULT '[]',
    "staffSupportScore" DOUBLE PRECISION,
    "independentVenuePct" DOUBLE PRECISION,

    CONSTRAINT "PlaceStats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceSlugHistory" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceSlugHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "place_layouts" (
    "id" TEXT NOT NULL,
    "place_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "checksum" TEXT NOT NULL,
    "glyph_snapshot_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "seat_index" JSONB NOT NULL DEFAULT '{}',
    "stage" JSONB NOT NULL DEFAULT '{}',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "created_by_human_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "place_layouts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceOwnership" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "ownerType" "PlaceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "reviewerHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "proof" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceOwnership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceVerificationRequest" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "status" "PlaceVerificationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerNotes" TEXT,
    "reviewerHumanId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceVerificationRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceVerificationDocument" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceVerificationDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceWaiver" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceWaiver_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaceAvailability" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "date" TIMESTAMP(3),
    "startTime" TEXT,
    "endTime" TEXT,
    "note" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaceAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GenreTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenreTag_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CREATE INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- Place
CREATE UNIQUE INDEX "Place_slug_key" ON "Place"("slug");
CREATE INDEX "Place_slug_idx" ON "Place"("slug");

-- PlaceReview
CREATE INDEX "PlaceReview_placeId_createdAt_idx" ON "PlaceReview"("placeId", "createdAt");
CREATE INDEX "PlaceReview_humanId_idx" ON "PlaceReview"("humanId");
CREATE INDEX "PlaceReview_eventId_idx" ON "PlaceReview"("eventId");
CREATE INDEX "PlaceReview_source_idx" ON "PlaceReview"("source");

-- PlaceStats
CREATE UNIQUE INDEX "PlaceStats_placeId_key" ON "PlaceStats"("placeId");
CREATE INDEX "PlaceStats_placeId_idx" ON "PlaceStats"("placeId");
CREATE INDEX "PlaceStats_reviewCountPublic_idx" ON "PlaceStats"("reviewCountPublic");

-- PlaceSlugHistory
CREATE UNIQUE INDEX "PlaceSlugHistory_slug_key" ON "PlaceSlugHistory"("slug");
CREATE INDEX "PlaceSlugHistory_placeId_recordedAt_idx" ON "PlaceSlugHistory"("placeId", "recordedAt");

-- place_layouts
CREATE INDEX "place_layouts_place_id_idx" ON "place_layouts"("place_id");
CREATE INDEX "place_layouts_created_by_human_id_idx" ON "place_layouts"("created_by_human_id");
CREATE UNIQUE INDEX "place_layouts_place_id_name_key" ON "place_layouts"("place_id", "name");

-- PlaceOwnership
CREATE INDEX "PlaceOwnership_placeId_idx" ON "PlaceOwnership"("placeId");
CREATE UNIQUE INDEX "PlaceOwnership_placeId_ownerType_ownerId_key" ON "PlaceOwnership"("placeId", "ownerType", "ownerId");

-- PlaceVerificationRequest
CREATE INDEX "PlaceVerificationRequest_placeId_idx" ON "PlaceVerificationRequest"("placeId");
CREATE INDEX "PlaceVerificationRequest_status_idx" ON "PlaceVerificationRequest"("status");

-- PlaceVerificationDocument
CREATE INDEX "PlaceVerificationDocument_requestId_idx" ON "PlaceVerificationDocument"("requestId");

-- PlaceWaiver
CREATE INDEX "PlaceWaiver_placeId_isActive_idx" ON "PlaceWaiver"("placeId", "isActive");

-- PlaceAvailability
CREATE INDEX "PlaceAvailability_placeId_isOpen_idx" ON "PlaceAvailability"("placeId", "isOpen");
CREATE INDEX "PlaceAvailability_placeId_dayOfWeek_idx" ON "PlaceAvailability"("placeId", "dayOfWeek");
CREATE INDEX "PlaceAvailability_placeId_date_idx" ON "PlaceAvailability"("placeId", "date");

-- GenreTag
CREATE UNIQUE INDEX "GenreTag_name_key" ON "GenreTag"("name");
CREATE INDEX "GenreTag_name_idx" ON "GenreTag"("name");
CREATE INDEX "GenreTag_usageCount_idx" ON "GenreTag"("usageCount");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FOREIGN KEY CONSTRAINTS
-- ─────────────────────────────────────────────────────────────────────────────

-- Place self-references
ALTER TABLE "Place" ADD CONSTRAINT "Place_default_primary_payout_terms_id_fkey"
  FOREIGN KEY ("default_primary_payout_terms_id") REFERENCES "PayoutTerms"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Place" ADD CONSTRAINT "Place_default_resale_payout_terms_id_fkey"
  FOREIGN KEY ("default_resale_payout_terms_id") REFERENCES "PayoutTerms"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- PlaceReview FKs
ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_humanId_fkey"
  FOREIGN KEY ("humanId") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_responseById_fkey"
  FOREIGN KEY ("responseById") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PlaceReview" ADD CONSTRAINT "PlaceReview_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- PlaceStats FK
ALTER TABLE "PlaceStats" ADD CONSTRAINT "PlaceStats_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- PlaceSlugHistory FK
ALTER TABLE "PlaceSlugHistory" ADD CONSTRAINT "PlaceSlugHistory_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- place_layouts FKs
ALTER TABLE "place_layouts" ADD CONSTRAINT "place_layouts_place_id_fkey"
  FOREIGN KEY ("place_id") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "place_layouts" ADD CONSTRAINT "place_layouts_created_by_human_id_fkey"
  FOREIGN KEY ("created_by_human_id") REFERENCES "Human"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- PlaceOwnership FKs
ALTER TABLE "PlaceOwnership" ADD CONSTRAINT "PlaceOwnership_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceOwnership" ADD CONSTRAINT "PlaceOwnership_reviewerHumanId_fkey"
  FOREIGN KEY ("reviewerHumanId") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- PlaceVerificationRequest FKs
ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "Human"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlaceVerificationRequest" ADD CONSTRAINT "PlaceVerificationRequest_reviewerHumanId_fkey"
  FOREIGN KEY ("reviewerHumanId") REFERENCES "Human"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- PlaceVerificationDocument FK
ALTER TABLE "PlaceVerificationDocument" ADD CONSTRAINT "PlaceVerificationDocument_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "PlaceVerificationRequest"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- PlaceWaiver FK
ALTER TABLE "PlaceWaiver" ADD CONSTRAINT "PlaceWaiver_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- PlaceAvailability FK
ALTER TABLE "PlaceAvailability" ADD CONSTRAINT "PlaceAvailability_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FKs FROM existing tables TO Place / place_layouts
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Event" ADD CONSTRAINT "Event_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Event" ADD CONSTRAINT "Event_place_layout_id_fkey"
  FOREIGN KEY ("place_layout_id") REFERENCES "place_layouts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SavedLocation" ADD CONSTRAINT "SavedLocation_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SeatSection" ADD CONSTRAINT "SeatSection_place_layout_id_fkey"
  FOREIGN KEY ("place_layout_id") REFERENCES "place_layouts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SEED GenreTag defaults (from place_review_v3 migration)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "GenreTag" ("id", "name", "displayName", "usageCount", "isDefault", "createdAt")
VALUES
  (gen_random_uuid(), 'rock',              'Rock',              0, true, now()),
  (gen_random_uuid(), 'indie',             'Indie',             0, true, now()),
  (gen_random_uuid(), 'pop',               'Pop',               0, true, now()),
  (gen_random_uuid(), 'hip-hop',           'Hip-Hop',           0, true, now()),
  (gen_random_uuid(), 'r&b',              'R&B',               0, true, now()),
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

COMMIT;
