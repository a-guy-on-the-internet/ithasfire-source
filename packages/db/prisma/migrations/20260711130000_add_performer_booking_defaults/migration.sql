-- Performer booking defaults (2026-07-11). Saved prefill values for the
-- booking-request pitch form. SEPARATE store from PerformerProfile (which is a
-- content-free opt-in gate). All fields additive + nullable — a save clears a
-- field by nulling it. NOTE: no `genre` column — genre comes from
-- Human.genreTags (see create-booking-request.ts). Reuses the existing
-- "BookingFeeType" enum (added in 20260711120000_add_booking_request_pitch_fields).

CREATE TABLE "PerformerBookingDefaults" (
  "id"                   TEXT NOT NULL,
  "ownerType"            TEXT NOT NULL,
  "ownerId"              TEXT NOT NULL,
  "actName"              TEXT,
  "lineupSize"           INTEGER,
  "setLengthMinutes"     INTEGER,
  "techNeeds"            TEXT,
  "contactPhone"         TEXT,
  "feeType"              "BookingFeeType",
  "feeAmountCents"       INTEGER,
  "feeCurrency"          VARCHAR(3),
  "messageTemplate"      TEXT,
  "includeVerifiedStats" BOOLEAN,
  "linkMusic"            TEXT,
  "linkVideo"            TEXT,
  "linkSocial"           TEXT,
  "linkEpk"              TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PerformerBookingDefaults_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PerformerBookingDefaults_ownerType_ownerId_key"
  ON "PerformerBookingDefaults" ("ownerType", "ownerId");
