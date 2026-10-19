-- ═══════════════════════════════════════════════════════════════════════════
-- A BOOKING REQUEST CARRIES A BILL
-- (lineup-booking-requests v2, docs/specs/2026-09-25, FR-001 + D3/D3b)
--
-- Until now a booking request modelled exactly one performer, and that
-- performer WAS the sender (`BookingRequest.performerOwnerType/Id`). A
-- promoter pitching a three-band night had nowhere to say who was playing.
--
-- D3b: the request's owner pair keeps its column names, its CHECKs and its
-- open-pair uniqueness indexes, but its MEANING becomes "the sender" — the
-- organizer of the ask. The acts move to this child table, ordered by
-- `sortOrder` (0 = headliner). No column on BookingRequest changes; the
-- schema comment carries the new meaning.
--
-- Three kinds of row (`source`):
--   SELF     — the sender's own act ("I'm on the bill"). Carries the sender
--              pair, which may be a human OR an organization.
--   TAGGED   — a platform artist the sender tagged. Always a human; notified
--              and asked to confirm or decline, so it starts PENDING.
--   EXTERNAL — a free-text act with no platform identity.
--
-- Existing rows need no backfill: a request with no act rows is read as a
-- pre-bill request by the app. Additive only.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "BookingRequestActSource" AS ENUM ('SELF', 'TAGGED', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "BookingRequestActConfirmation" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED');

-- CreateTable
CREATE TABLE "BookingRequestAct" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "source" "BookingRequestActSource" NOT NULL,
    "actOwnerType" TEXT,
    "actOwnerId" TEXT,
    "externalName" VARCHAR(120),
    "externalUrl" TEXT,
    "role" "EventHumanRole" NOT NULL DEFAULT 'PERFORMER',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "confirmation" "BookingRequestActConfirmation" NOT NULL DEFAULT 'PENDING',
    "invitedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "declineReason" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequestAct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingRequestAct_bookingRequestId_sortOrder_idx" ON "BookingRequestAct"("bookingRequestId", "sortOrder");

-- CreateIndex
CREATE INDEX "BookingRequestAct_actOwnerType_actOwnerId_idx" ON "BookingRequestAct"("actOwnerType", "actOwnerId");

-- CreateIndex
-- One row per platform act per request. EXTERNAL rows carry NULL owner
-- columns and NULLs are distinct in a Postgres unique, so any number of
-- free-text acts share a request freely. Also what makes DECLINED terminal:
-- the declined human's row keeps the key, so they cannot be re-tagged on the
-- same request (the adapter maps the P2002 to `booking_request_act_duplicate`).
CREATE UNIQUE INDEX "BookingRequestAct_bookingRequestId_actOwnerType_actOwnerId_key" ON "BookingRequestAct"("bookingRequestId", "actOwnerType", "actOwnerId");

-- AddForeignKey
ALTER TABLE "BookingRequestAct" ADD CONSTRAINT "BookingRequestAct_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── SQL-only CHECKs (Prisma cannot express them; `db push` leaves them be) ──
--
-- The row shape by source. Without it, the unique above is hollow: a TAGGED
-- row with a NULL owner would escape the one-per-request rule (NULLs are
-- distinct), and an EXTERNAL row carrying an owner id would be counted as a
-- platform act by every reader keyed on the owner pair.
ALTER TABLE "BookingRequestAct" ADD CONSTRAINT "BookingRequestAct_source_shape_check" CHECK (
  (
    "source" IN ('SELF', 'TAGGED')
    AND "actOwnerType" IS NOT NULL
    AND "actOwnerId" IS NOT NULL
    AND "externalName" IS NULL
    AND "actOwnerType" IN ('human', 'organization')
    -- Tagging is human-only (spec FR-002: taggable = a human search result).
    AND ("source" <> 'TAGGED' OR "actOwnerType" = 'human')
  )
  OR (
    "source" = 'EXTERNAL'
    AND "externalName" IS NOT NULL
    AND "actOwnerType" IS NULL
    AND "actOwnerId" IS NULL
  )
);

-- Consent only exists for tagged artists. The sender speaks for their own
-- act and a free-text act has no one to ask, so neither may ever sit PENDING
-- — a PENDING SELF/EXTERNAL row would render as "invited" forever and never
-- flow to the event (FR-006 flows CONFIRMED rows only).
ALTER TABLE "BookingRequestAct" ADD CONSTRAINT "BookingRequestAct_pending_only_tagged_check" CHECK (
  "source" = 'TAGGED' OR "confirmation" <> 'PENDING'
);
