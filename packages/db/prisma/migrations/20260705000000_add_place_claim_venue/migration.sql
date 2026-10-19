-- Self-serve "claim this venue" flow (spec 2026-07-05/claim-venue-flow).
-- A signed-in human or org admin claims an unclaimed/unverified Place. In one
-- motion this creates a PROVISIONAL PlaceOwnership (verified=false), sets
-- Place.verification=PENDING, and opens an OWNERSHIP_CLAIM
-- PlaceVerificationRequest into the existing platform-admin queue. Admin
-- APPROVE flips ownership verified=true; REJECT soft-revokes it. Already-owned
-- venues route to an OWNERSHIP_DISPUTE instead.
--
-- Additive only, EXCEPT PlaceVerificationRequest.orgId becomes NULLABLE (human
-- claims have no org). All pre-existing rows have a non-null orgId so the
-- relaxation is safe. Existing PlaceOwnership rows are verified=true /
-- revokedAt=null so access-gating behavior is unchanged.
--
-- Assembled by hand from the multi-file prisma schema (place.prisma +
-- enums.prisma). The trailing partial-unique index (one active OWNERSHIP_CLAIM
-- per place) is Prisma-inexpressible and lives only here.

-- CreateEnum
CREATE TYPE "PlaceVerificationRequestSource" AS ENUM ('ORG_SUBMISSION', 'OWNERSHIP_CLAIM', 'OWNERSHIP_DISPUTE');

-- CreateEnum
CREATE TYPE "PlaceWebsiteSource" AS ENUM ('TRUSTED_IMPORT', 'USER_STUB', 'UNKNOWN');

-- AlterTable Place: website provenance marker
ALTER TABLE "Place" ADD COLUMN "website_source" "PlaceWebsiteSource" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable PlaceOwnership: soft-revoke marker
ALTER TABLE "PlaceOwnership" ADD COLUMN "revoked_at" TIMESTAMP(3);

-- AlterTable PlaceVerificationRequest: relax orgId + claim provenance columns
ALTER TABLE "PlaceVerificationRequest" ALTER COLUMN "orgId" DROP NOT NULL;
ALTER TABLE "PlaceVerificationRequest" ADD COLUMN "source" "PlaceVerificationRequestSource" NOT NULL DEFAULT 'ORG_SUBMISSION';
ALTER TABLE "PlaceVerificationRequest" ADD COLUMN "claimant_human_id" TEXT;
ALTER TABLE "PlaceVerificationRequest" ADD COLUMN "claim_owner_type" "PlaceOwnerType";
ALTER TABLE "PlaceVerificationRequest" ADD COLUMN "claim_owner_id" TEXT;
ALTER TABLE "PlaceVerificationRequest" ADD COLUMN "ownership_id" TEXT;

-- CreateIndex
CREATE INDEX "PlaceVerificationRequest_source_status_idx" ON "PlaceVerificationRequest"("source", "status");

-- CreateTable
CREATE TABLE "place_claim_email_challenges" (
    "id" TEXT NOT NULL,
    "place_id" TEXT NOT NULL,
    "human_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_claim_email_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "place_claim_email_challenges_place_id_human_id_idx" ON "place_claim_email_challenges"("place_id", "human_id");

-- AddForeignKey
ALTER TABLE "place_claim_email_challenges" ADD CONSTRAINT "place_claim_email_challenges_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most ONE active OWNERSHIP_CLAIM per place (FR-009 race guard). Partial
-- unique index — Prisma can't express the WHERE, so it lives here. The use case
-- also checks this first for a friendly CLAIM_ALREADY_PENDING error; this index
-- is the last-line concurrency backstop.
CREATE UNIQUE INDEX "place_verification_request_one_active_claim"
  ON "PlaceVerificationRequest"("placeId")
  WHERE "source" = 'OWNERSHIP_CLAIM' AND "status" IN ('PENDING', 'IN_REVIEW');

-- NOTE: there is deliberately NO "one verified owner per place" unique index.
-- Co-ownership is a first-class part of the model — a place can hold multiple
-- verified owners (e.g. an org AND a human, or several orgs), unioned into
-- PlaceRecord.orgIdsWithAccess / humanIdsWithAccess (the dev seed's place8 is
-- co-owned by human6 + org4). The FR-010 fast-track race is instead serialized
-- in the use case via pg_advisory_xact_lock(hashtext(placeId)) + an in-tx
-- re-check of the verified owner (see submit-place-claim.ts).
