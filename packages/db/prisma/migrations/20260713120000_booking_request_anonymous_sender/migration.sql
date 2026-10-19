-- Anonymous embed booking inquiries (booking-request-embed-button FR-005).
-- The performer owner pair becomes nullable; anonymous rows carry
-- contactName/contactEmail instead (contactEmail stored LOWERCASED app-side)
-- plus provenance (source/embedId) and the invite-to-claim token fields
-- (FR-007: hashed at rest, single use, expiring). All additive; existing rows
-- keep their owner pair and default to source = PLATFORM.

CREATE TYPE "BookingRequestSource" AS ENUM ('PLATFORM', 'EMBED');

ALTER TABLE "BookingRequest"
  ALTER COLUMN "performerOwnerType" DROP NOT NULL,
  ALTER COLUMN "performerOwnerId" DROP NOT NULL,
  ADD COLUMN "contactName" TEXT,
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "source" "BookingRequestSource" NOT NULL DEFAULT 'PLATFORM',
  ADD COLUMN "embedId" TEXT,
  ADD COLUMN "claimTokenHash" TEXT,
  ADD COLUMN "claimTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "claimedAt" TIMESTAMP(3);

-- Sender-identity invariant, DB-enforced: the owner pair is all-or-nothing,
-- and a row without an owner MUST carry both contact fields. Without this an
-- anonymous row with NULL contactEmail would bypass the dedupe partial index
-- entirely (expression-index entries over NULL are all distinct). A CLAIMED
-- anonymous row (owner backfilled, contact fields retained) still passes.
-- Existing rows all have a full owner pair, so this validates with no backfill.
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_sender_identity_check" CHECK (
  (("performerOwnerType" IS NOT NULL) = ("performerOwnerId" IS NOT NULL))
  AND ("performerOwnerId" IS NOT NULL OR ("contactName" IS NOT NULL AND "contactEmail" IS NOT NULL))
);

-- Claim tokens are single-use lookups: unique on the hash.
CREATE UNIQUE INDEX "BookingRequest_claimTokenHash_key" ON "BookingRequest"("claimTokenHash");

-- Inbox/dedupe lookups for anonymous inquiries.
CREATE INDEX "BookingRequest_placeId_contactEmail_idx" ON "BookingRequest"("placeId", "contactEmail");

-- DB backstop for the one-open-anonymous-request-per-(place, email) rule —
-- the anonymous analogue of "BookingRequest_open_pair_key" (migration
-- 20260610120000). The use-case pre-check races under concurrency; the loser
-- fails with P2002, which the adapter maps to `duplicate_open_request`.
-- Partial + expression indexes are not expressible in the Prisma schema —
-- SQL-only (noted on the BookingRequest model in agreement.prisma).
CREATE UNIQUE INDEX "BookingRequest_open_anon_pair_key" ON "BookingRequest" ("placeId", lower("contactEmail")) WHERE status IN ('PENDING','VIEWED') AND "performerOwnerId" IS NULL;
