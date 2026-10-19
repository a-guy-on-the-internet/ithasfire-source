-- Venue confirmation + booking intents — Phase 1, Step 1 (data layer).
-- Spec: docs/specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md
-- (§Data Model, §Locked decisions). Three things land here, in order:
--
--   1. SCHEMA. Enums BookingIntent / RentalMode; Calendar becomes the booking
--      CONFIG layer (accepted intents, flat rental rate, rate visibility,
--      rentalMode); BookingRequest gains intent + the room + the window +
--      the event-first origin + the unclaimed-venue parking stamp; Event
--      gains the per-event venue-confirmation columns; PlaceBookingGrant is
--      new (model + authz hook only — no granting UI in this spec).
--   2. BACKFILL the venue hierarchy invariant every Place must now satisfy:
--      ≥1 Space, exactly one default Calendar, and ≥1 CalendarSpace per
--      Calendar. Mirrors apps/api/src/scripts/backfill-venue-defaults.ts
--      (same names, same reuse-before-create rules) so a venue that script
--      already touched is a no-op here.
--   3. STAMP venueConfirmedAt on every event whose owner is a verified,
--      unrevoked owner of its place. The derivation in core treats venue-
--      owned events as confirmed regardless, so this is belt-and-braces
--      for confirmed-only SQL reads (the (placeId, venueConfirmedAt) index).
--
-- Every statement is re-applicable (IF NOT EXISTS / DO … duplicate_object /
-- NOT EXISTS guards) because the dev databases are db-push-managed and
-- replay migrations on top of an already-pushed schema (house precedent:
-- 20260902090000_early_fraud_warnings).
--
-- NOT in this migration (Phase 3 / §Migrations step 4): RentalPayment,
-- Payee.stripeRentalProductId, and the per-event PERFORM request + 14-day
-- address-only grace window for existing third-party published events. That
-- last one needs notifications and a scheduled job, so it ships as a script
-- with the use cases, not as DDL.
--
-- DDL assembled from `prisma migrate diff --from-config-datasource
-- --to-schema packages/db/prisma --script` against a throwaway Postgres with
-- every prior migration applied, EXCLUDING the same pre-existing intentional
-- drift 20260818120000_venue_hierarchy_rooms_calendars documents
-- (EventCategoryRequestKind residual, search_doc_* raw indexes, SearchDocument
-- generated-column defaults, AcceptanceRecord raw partial key).

-- ── 1. Schema ────────────────────────────────────────────────────────────────

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BookingIntent" AS ENUM ('PERFORM', 'RENT', 'USE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (INSTANT is RESERVED — own spec, never selectable in UI)
DO $$ BEGIN
  CREATE TYPE "RentalMode" AS ENUM ('REQUEST', 'INSTANT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable: Calendar is the booking config layer. Defaults preserve today
-- (PERFORM accepted, nothing else; no rate; REQUEST mode).
ALTER TABLE "Calendar"
  ADD COLUMN IF NOT EXISTS "acceptsPerform" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "acceptsRent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "acceptsUse" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rentalMode" "RentalMode" NOT NULL DEFAULT 'REQUEST',
  ADD COLUMN IF NOT EXISTS "rentalRateCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "rentalRateCurrency" VARCHAR(3),
  ADD COLUMN IF NOT EXISTS "rentalRateVisible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: BookingRequest intent + room + window + origin + parking.
-- Existing rows take `intent = 'PERFORM'` from the column default.
ALTER TABLE "BookingRequest"
  ADD COLUMN IF NOT EXISTS "intent" "BookingIntent" NOT NULL DEFAULT 'PERFORM',
  ADD COLUMN IF NOT EXISTS "spaceId" TEXT,
  ADD COLUMN IF NOT EXISTS "requestedStartsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "requestedEndsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "purpose" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "expectedAttendance" INTEGER,
  ADD COLUMN IF NOT EXISTS "originEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "parkedUnclaimedAt" TIMESTAMP(3);

-- AlterTable: venue confirmation is a fact on the Event, BOUND TO THE PLACE.
-- `placeId` is ALWAYS retained regardless of confirmation; withdrawal sets
-- the withdrawn pair and leaves venueConfirmedAt as history.
-- venueConfirmedPlaceId is the place the venue vouched for: the stamp is live
-- ONLY while placeId = venueConfirmedPlaceId, so an organizer moving a
-- confirmed event to another venue voids the stamp without any write (the
-- row-bound stamp would otherwise travel to a venue that never saw it).
-- venueConfirmationRequestId is a plain id on purpose (no FK):
-- BookingRequest.originEventId already points at Event, and a second FK back
-- would form a relation cycle.
ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "venueConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "venueConfirmedByHumanId" TEXT,
  ADD COLUMN IF NOT EXISTS "venueConfirmedPlaceId" TEXT,
  ADD COLUMN IF NOT EXISTS "venueConfirmationRequestId" TEXT,
  ADD COLUMN IF NOT EXISTS "venueConfirmationWithdrawnAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "venueConfirmationWithdrawnReason" VARCHAR(500);

-- CreateTable: standalone per-place trust grant (model + hook only; granting
-- UI ships with instant-book). NOT an org role.
CREATE TABLE IF NOT EXISTS "PlaceBookingGrant" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "calendarId" TEXT,
    "humanId" TEXT NOT NULL,
    "canPlaceHolds" BOOLEAN NOT NULL DEFAULT true,
    "canCreateEvents" BOOLEAN NOT NULL DEFAULT true,
    "grantedByHumanId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaceBookingGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (findActiveForHuman: (placeId, humanId) then revokedAt IS NULL)
CREATE INDEX IF NOT EXISTS "PlaceBookingGrant_placeId_humanId_revokedAt_idx" ON "PlaceBookingGrant"("placeId", "humanId", "revokedAt");

-- CreateIndex (FK maintenance on calendar deletion — Cascade scans by calendarId)
CREATE INDEX IF NOT EXISTS "PlaceBookingGrant_calendarId_idx" ON "PlaceBookingGrant"("calendarId");

-- CreateIndex (event-first: one origin request per event)
CREATE UNIQUE INDEX IF NOT EXISTS "BookingRequest_originEventId_key" ON "BookingRequest"("originEventId");

-- CreateIndex (intent-filtered inbox tabs)
CREATE INDEX IF NOT EXISTS "BookingRequest_intent_status_idx" ON "BookingRequest"("intent", "status");

-- CreateIndex (FK maintenance on space deletion — SetNull scans by spaceId)
CREATE INDEX IF NOT EXISTS "BookingRequest_spaceId_idx" ON "BookingRequest"("spaceId");

-- CreateIndex (confirmed-only calendar/availability reads at a place)
CREATE INDEX IF NOT EXISTS "Event_placeId_venueConfirmedAt_idx" ON "Event"("placeId", "venueConfirmedAt");

-- AddForeignKey: deleting a room never deletes the request.
DO $$ BEGIN
  ALTER TABLE "BookingRequest"
    ADD CONSTRAINT "BookingRequest_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey: deleting the origin event leaves the request (SetNull).
DO $$ BEGIN
  ALTER TABLE "BookingRequest"
    ADD CONSTRAINT "BookingRequest_originEventId_fkey"
    FOREIGN KEY ("originEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey: a grant dies with its place.
DO $$ BEGIN
  ALTER TABLE "PlaceBookingGrant"
    ADD CONSTRAINT "PlaceBookingGrant_placeId_fkey"
    FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey: a calendar-scoped grant dies with its calendar.
DO $$ BEGIN
  ALTER TABLE "PlaceBookingGrant"
    ADD CONSTRAINT "PlaceBookingGrant_calendarId_fkey"
    FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Intent shape invariant, DB-enforced (spec §Data Model), added AFTER the
-- column default landed so every existing row passes — every pre-existing
-- request is PERFORM, for which the CHECK is vacuous:
--   RENT | USE ⇒ spaceId NOT NULL ∧ requestedStartsAt NOT NULL ∧ requestedEndsAt NOT NULL
-- (PERFORM keeps `preferredDates`; its space stays optional.) SQL-only, noted
-- on the BookingRequest model in agreement.prisma next to the direction CHECK.
DO $$ BEGIN
  ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_intent_shape_check" CHECK (
    "intent" NOT IN ('RENT', 'USE')
    OR (
      "spaceId" IS NOT NULL
      AND "requestedStartsAt" IS NOT NULL
      AND "requestedEndsAt" IS NOT NULL
    )
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Backfill the venue hierarchy invariant ────────────────────────────────
-- Mirrors apps/api/src/scripts/backfill-venue-defaults.ts; the four steps are
-- ordered so each later step can rely on the earlier one's rows.

-- 2a. Every Place gets ≥1 Space: a "Main Space" (sortOrder 0, ACTIVE) for any
--     place that has none. Places with any space (even RETIRED) are left alone
--     — the script reuses an existing space rather than adding a sibling.
INSERT INTO "Space" ("id", "placeId", "name", "capacity", "sortOrder", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."id", 'Main Space', NULL, 0, 'ACTIVE', now(), now()
FROM "Place" p
WHERE NOT EXISTS (SELECT 1 FROM "Space" s WHERE s."placeId" = p."id");

-- 2b. A place whose owner already made a calendar slugged "main" (possible
--     via createCalendar, which never sets isDefault) gets it PROMOTED —
--     keeping its owner-chosen name — instead of a duplicate-slug insert.
--     Guarded on "no default yet" so the SQL-only partial unique
--     "Calendar_placeId_default_key" (one default per place) cannot fire.
UPDATE "Calendar" c
SET "isDefault" = true, "updatedAt" = now()
WHERE c."slug" = 'main'
  AND c."isDefault" = false
  AND NOT EXISTS (
    SELECT 1 FROM "Calendar" d WHERE d."placeId" = c."placeId" AND d."isDefault"
  );

-- 2c. Every remaining Place without a default Calendar gets "Main Calendar"
--     (slug "main", isDefault). After 2b any surviving "main" slug IS the
--     default, so the (placeId, slug) unique cannot collide here either.
INSERT INTO "Calendar" ("id", "placeId", "name", "slug", "description", "isDefault", "defaultStartTime", "defaultCategoryId", "eventTemplate", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."id", 'Main Calendar', 'main', NULL, true, NULL, NULL, NULL, now(), now()
FROM "Place" p
WHERE NOT EXISTS (
  SELECT 1 FROM "Calendar" c WHERE c."placeId" = p."id" AND c."isDefault"
);

-- 2d. Every Calendar with zero CalendarSpace joins gets the place's lowest-
--     sortOrder ACTIVE space (any space if none is ACTIVE — a RETIRED join is
--     still a join, and the app tolerates it). Every place has ≥1 space after
--     2a, so the lateral subquery always yields a row. Idempotent on the
--     (calendarId, spaceId) unique via the NOT EXISTS guard.
INSERT INTO "CalendarSpace" ("id", "calendarId", "spaceId", "createdAt")
SELECT gen_random_uuid(), c."id", first_space."id", now()
FROM "Calendar" c
CROSS JOIN LATERAL (
  SELECT s."id"
  FROM "Space" s
  WHERE s."placeId" = c."placeId"
  ORDER BY (s."status" <> 'ACTIVE'), s."sortOrder" ASC, s."createdAt" ASC, s."id" ASC
  LIMIT 1
) AS first_space
WHERE NOT EXISTS (
  SELECT 1 FROM "CalendarSpace" cs WHERE cs."calendarId" = c."id"
);

-- ── 3. Stamp confirmation on venue-owned events ──────────────────────────────
-- An event whose owner (org via orgId, human via humanId) holds a verified,
-- unrevoked PlaceOwnership on its place is confirmed by construction. Stamp
-- venueConfirmedAt (no confirmer human, no request — it was never asked)
-- AND bind the stamp to the place it is at (venueConfirmedPlaceId) so
-- confirmed-only SQL reads see it — at THIS place only. Idempotent on the
-- IS NULL guard. PlaceOwnership.revokedAt is @map("revoked_at");
-- PlaceOwnerType is HUMAN | ORGANIZATION.
UPDATE "Event" e
SET "venueConfirmedAt" = now(),
    "venueConfirmedPlaceId" = e."placeId"
FROM "PlaceOwnership" po
WHERE e."placeId" = po."placeId"
  AND po."verified" = true
  AND po."revoked_at" IS NULL
  AND (
    (po."ownerType" = 'ORGANIZATION' AND po."ownerId" = e."orgId")
    OR (po."ownerType" = 'HUMAN' AND po."ownerId" = e."humanId")
  )
  AND e."venueConfirmedAt" IS NULL;
