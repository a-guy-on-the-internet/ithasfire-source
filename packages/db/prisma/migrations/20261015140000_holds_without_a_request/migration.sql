-- Holds without a request, and the booking grant made real
-- (spec docs/specs/2026-09-30/holds-without-a-request.spec.yaml, plan step 1).
--
-- EXPAND ONLY. This migration adds; it drops nothing. The running revision
-- still selects PlaceBookingGrant."humanId" / "canPlaceHolds" /
-- "canCreateEvents" during rollout, so they stay (humanId becomes nullable);
-- a later contract migration (plan step 18) drops them.
--
-- Changes:
--   1. BookingHold.ownerKind REQUEST | BOOKER | PLACE; bookingRequestId
--      nullable; grantId, holderOrgId, holderHumanId, eventId (FR-001).
--   2. One shared note (note / noteUpdatedByHumanId / noteUpdatedAt) on
--      BookingHold, BookingRequest and Event (FR-012).
--   3. PlaceBookingGrant: granteeOrgId / granteeHumanId, acceptedAt,
--      declinedAt, expiryWarnedAt (FR-002, FR-003, FR-004).
--   4. BookingHoldReleaseReason.GRANT_ENDED (FR-004).
--   5. Backfill, then the SQL-only CHECKs and partial uniques Prisma can't
--      express (documented on the models in agreement.prisma / place.prisma).
--
-- The DDL in sections 1–4 below is `prisma migrate diff` output for exactly
-- these schema edits, unmodified.

-- CreateEnum
CREATE TYPE "BookingHoldOwnerKind" AS ENUM ('REQUEST', 'BOOKER', 'PLACE');

-- AlterEnum
ALTER TYPE "BookingHoldReleaseReason" ADD VALUE 'GRANT_ENDED';

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "note" VARCHAR(2000),
ADD COLUMN     "noteUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "noteUpdatedByHumanId" TEXT;

-- AlterTable
ALTER TABLE "BookingHold" ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "grantId" TEXT,
ADD COLUMN     "holderHumanId" TEXT,
ADD COLUMN     "holderOrgId" TEXT,
ADD COLUMN     "note" VARCHAR(2000),
ADD COLUMN     "noteUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "noteUpdatedByHumanId" TEXT,
ADD COLUMN     "ownerKind" "BookingHoldOwnerKind" NOT NULL DEFAULT 'REQUEST',
ALTER COLUMN "bookingRequestId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "note" VARCHAR(2000),
ADD COLUMN     "noteUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "noteUpdatedByHumanId" TEXT;

-- AlterTable
ALTER TABLE "PlaceBookingGrant" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "declinedAt" TIMESTAMP(3),
ADD COLUMN     "expiryWarnedAt" TIMESTAMP(3),
ADD COLUMN     "granteeHumanId" TEXT,
ADD COLUMN     "granteeOrgId" TEXT,
ALTER COLUMN "humanId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "BookingHold_holderOrgId_status_idx" ON "BookingHold"("holderOrgId", "status");

-- CreateIndex
CREATE INDEX "BookingHold_holderHumanId_status_idx" ON "BookingHold"("holderHumanId", "status");

-- CreateIndex
CREATE INDEX "BookingHold_grantId_idx" ON "BookingHold"("grantId");

-- CreateIndex
CREATE INDEX "BookingHold_eventId_idx" ON "BookingHold"("eventId");

-- CreateIndex
CREATE INDEX "PlaceBookingGrant_placeId_revokedAt_idx" ON "PlaceBookingGrant"("placeId", "revokedAt");

-- CreateIndex
CREATE INDEX "PlaceBookingGrant_granteeOrgId_revokedAt_idx" ON "PlaceBookingGrant"("granteeOrgId", "revokedAt");

-- CreateIndex
CREATE INDEX "PlaceBookingGrant_granteeHumanId_revokedAt_idx" ON "PlaceBookingGrant"("granteeHumanId", "revokedAt");

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PlaceBookingGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_holderOrgId_fkey" FOREIGN KEY ("holderOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceBookingGrant" ADD CONSTRAINT "PlaceBookingGrant_granteeOrgId_fkey" FOREIGN KEY ("granteeOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Backfill ────────────────────────────────────────────────────────────────

-- Every existing BookingHold is a REQUEST hold: the column was added NOT NULL
-- DEFAULT 'REQUEST' above, which fills every pre-existing row, and every
-- pre-existing row has a bookingRequestId (the column was NOT NULL until this
-- migration), so all of them satisfy the REQUEST arm of the CHECK below.
-- No UPDATE needed.

-- Grant rows exist only in fixtures and seeds (no grant UI shipped). Each was
-- a person grant, and existing grants count as accepted: the grantee is the
-- old humanId, accepted when the grant was made.
UPDATE "PlaceBookingGrant"
   SET "granteeHumanId" = "humanId",
       "acceptedAt"     = "createdAt"
 WHERE "granteeHumanId" IS NULL
   AND "granteeOrgId" IS NULL;

-- ── CHECKs ──────────────────────────────────────────────────────────────────

-- FR-001: the column shape per owner kind.
--   REQUEST ⇒ a request; no grant; no holder (the request carries the party).
--   BOOKER  ⇒ no request; a grant; exactly one holder (the grantee).
--   PLACE   ⇒ no request; no grant; at most one holder (a named party, or
--             unassigned).
ALTER TABLE "BookingHold"
  ADD CONSTRAINT "BookingHold_owner_kind_shape"
  CHECK (
    ("ownerKind" = 'REQUEST'
       AND "bookingRequestId" IS NOT NULL
       AND "grantId" IS NULL
       AND "holderOrgId" IS NULL
       AND "holderHumanId" IS NULL)
    OR
    ("ownerKind" = 'BOOKER'
       AND "bookingRequestId" IS NULL
       AND "grantId" IS NOT NULL
       AND num_nonnulls("holderOrgId", "holderHumanId") = 1)
    OR
    ("ownerKind" = 'PLACE'
       AND "bookingRequestId" IS NULL
       AND "grantId" IS NULL
       AND num_nonnulls("holderOrgId", "holderHumanId") <= 1)
  );

-- FR-002: a grant goes to exactly one grantee, an org or a person. Added after
-- the backfill above, which gives every existing row a granteeHumanId.
ALTER TABLE "PlaceBookingGrant"
  ADD CONSTRAINT "PlaceBookingGrant_grantee_xor"
  CHECK (num_nonnulls("granteeOrgId", "granteeHumanId") = 1);

-- FR-003: the grantee accepts or declines, never both.
ALTER TABLE "PlaceBookingGrant"
  ADD CONSTRAINT "PlaceBookingGrant_accept_decline_check"
  CHECK ("acceptedAt" IS NULL OR "declinedAt" IS NULL);

-- ── Partial uniques ─────────────────────────────────────────────────────────

-- FR-001: one LIVE hold per holder per line, for BOOKER holds and named PLACE
-- holds. "Live" is the same predicate as "BookingHold_live_request_date_key"
-- (20260825130000): status IN ('ACTIVE','CHALLENGED'). REQUEST holds have no
-- holder and fall outside both (their per-request unique stays as is);
-- unassigned PLACE holds (both holder columns null) are unlimited. One index
-- per holder column, since an org and a person never share an id space.
CREATE UNIQUE INDEX "BookingHold_live_holder_org_line_key"
  ON "BookingHold"("calendarId", "date", "holderOrgId")
  WHERE "holderOrgId" IS NOT NULL AND "status" IN ('ACTIVE', 'CHALLENGED');

CREATE UNIQUE INDEX "BookingHold_live_holder_human_line_key"
  ON "BookingHold"("calendarId", "date", "holderHumanId")
  WHERE "holderHumanId" IS NOT NULL AND "status" IN ('ACTIVE', 'CHALLENGED');
