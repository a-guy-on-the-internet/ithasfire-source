-- Organizer-initiated booking requests (organizer-booking-requests FR-001).
-- Inverts the flow: an organizer ORG sends a request TO a performer. The
-- performer owner pair keeps identifying the ACT in both directions — no
-- column role-swapping. All additive; existing rows backfill to TO_VENUE via
-- the column default and keep their required placeId.

CREATE TYPE "BookingRequestDirection" AS ENUM ('TO_VENUE', 'TO_PERFORMER');

ALTER TABLE "BookingRequest"
  ADD COLUMN "direction" "BookingRequestDirection" NOT NULL DEFAULT 'TO_VENUE',
  ALTER COLUMN "placeId" DROP NOT NULL,
  ADD COLUMN "organizerOrgId" TEXT,
  ADD COLUMN "attachedEventId" TEXT;

-- Sender org (TO_PERFORMER): the request dies with the org.
ALTER TABLE "BookingRequest"
  ADD CONSTRAINT "BookingRequest_organizerOrgId_fkey"
  FOREIGN KEY ("organizerOrgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Optional existing-event attach (TO_PERFORMER only): deleting the event
-- detaches it, never the request.
ALTER TABLE "BookingRequest"
  ADD CONSTRAINT "BookingRequest_attachedEventId_fkey"
  FOREIGN KEY ("attachedEventId") REFERENCES "Event"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Organizer "sent to acts" list (scope: "organizer").
CREATE INDEX "BookingRequest_organizerOrgId_status_idx"
  ON "BookingRequest"("organizerOrgId", "status");

-- FK maintenance on event deletion (SetNull scans by attachedEventId).
CREATE INDEX "BookingRequest_attachedEventId_idx"
  ON "BookingRequest"("attachedEventId");

-- DB backstop for the one-open-request-per-(organizer org, act) rule —
-- the TO_PERFORMER analogue of "BookingRequest_open_pair_key" (migration
-- 20260610120000). The use-case pre-check races under concurrency; the loser
-- fails with P2002, which the adapter maps to `duplicate_open_request`.
-- Partial indexes are not expressible in the Prisma schema — SQL-only
-- (noted on the BookingRequest model in agreement.prisma).
CREATE UNIQUE INDEX "BookingRequest_open_organizer_pair_key"
  ON "BookingRequest"("organizerOrgId", "performerOwnerType", "performerOwnerId")
  WHERE status IN ('PENDING', 'VIEWED') AND direction = 'TO_PERFORMER';

-- Direction shape invariant, DB-enforced (FR-001), added AFTER the backfill
-- default landed so every existing row (TO_VENUE with a placeId) passes:
--   TO_VENUE      ⇒ placeId NOT NULL ∧ organizerOrgId NULL ∧ attachedEventId NULL
--   TO_PERFORMER  ⇒ placeId NULL ∧ organizerOrgId NOT NULL ∧ performer owner pair NOT NULL
-- (TO_PERFORMER rows are always OWNED — the existing
-- "BookingRequest_sender_identity_check" continues to hold for both.)
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_direction_shape_check" CHECK (
  (
    "direction" = 'TO_VENUE'
    AND "placeId" IS NOT NULL
    AND "organizerOrgId" IS NULL
    AND "attachedEventId" IS NULL
  ) OR (
    "direction" = 'TO_PERFORMER'
    AND "placeId" IS NULL
    AND "organizerOrgId" IS NOT NULL
    AND "performerOwnerType" IS NOT NULL
    AND "performerOwnerId" IS NOT NULL
  )
);

-- Performer opt-in gate for receiving organizer requests (FR-002) — a GATE
-- like enabledAt, not content (PerformerProfile stays content-free).
ALTER TABLE "PerformerProfile"
  ADD COLUMN "acceptsBookingRequests" BOOLEAN NOT NULL DEFAULT false;
