import type { Repos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { PlaceOwnershipRecord } from "@th/types/repos/place-verification";

import { fail } from "@th/errors";

/**
 * Shared claimable / disputable predicates for the claim-venue flow. Factored
 * so submit-place-claim, file-place-ownership-dispute, and the claim-scoped
 * doc-upload presign all enforce the SAME preconditions (and throw the SAME
 * error codes in the same order) — no drift between the CTA gate, the mutation,
 * and the upload presign.
 */

export type ClaimEligibilityDeps = {
  repos: Pick<Repos, "places" | "placeVerificationRequests">;
};

/**
 * Whether a place is CLAIMED: someone holds a verified, unrevoked ownership
 * of it, a human or an org. The access lists ARE that projection (the places
 * adapter keeps only `verified AND revokedAt IS NULL` rows in them), so this
 * needs no read.
 *
 * The ONE definition behind "an unclaimed venue takes no booking requests"
 * (venue-confirmation spec, amendment 2026-09-25): `createBookingRequest`,
 * the event-first create (through the shared gate walk), the embed inquiry
 * and the request dialog's options read all ask this, so none of them can
 * disagree about which venues can be asked.
 *
 * Claimed is NOT the same as `verificationStatus === "VERIFIED"`. A place can
 * be VERIFIED with nobody holding it (a staff waiver, or an owner whose
 * ownership was later revoked): it has no one to read a request, so it is
 * unclaimed here. The reverse also holds: a place with an owner whose
 * verification was later moved off VERIFIED is claimed, and the request
 * gates refuse it separately (`PLACE_NOT_VERIFIED`).
 */
export function isClaimedPlace(
  place: Pick<PlaceRecord, "humanIdsWithAccess" | "orgIdsWithAccess">,
): boolean {
  return (
    place.humanIdsWithAccess.length > 0 || place.orgIdsWithAccess.length > 0
  );
}

/**
 * Asserts a place is CLAIMABLE (FR-001 / FR-008 / FR-009) and returns it:
 * not ARCHIVED, verification in {UNVERIFIED, REJECTED}, no verified owner, and
 * no active OWNERSHIP_CLAIM. Throws the friendly domain error otherwise.
 */
export async function assertPlaceClaimable(
  deps: ClaimEligibilityDeps,
  placeId: string,
): Promise<PlaceRecord> {
  const place = await deps.repos.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  if (place.status === "ARCHIVED") {
    throw fail("PLACE_NOT_CLAIMABLE");
  }
  if (place.verificationStatus === "VERIFIED") {
    throw fail("PLACE_ALREADY_CLAIMED");
  }
  if (place.verificationStatus === "PENDING") {
    throw fail("CLAIM_ALREADY_PENDING");
  }
  // A verified owner blocks an instant claim regardless of Place.verification.
  const verifiedOwner =
    await deps.repos.places.getVerifiedOwnershipForPlace(placeId);
  if (verifiedOwner) {
    throw fail("PLACE_ALREADY_CLAIMED");
  }
  const activeClaim =
    await deps.repos.placeVerificationRequests.getActiveClaimForPlace(placeId);
  if (activeClaim) {
    throw fail("CLAIM_ALREADY_PENDING");
  }
  return place;
}

/**
 * Asserts a place is DISPUTABLE (FR-008) — it already has a verified owner (or
 * Place.verification == VERIFIED) — and returns the place + that owner (if any).
 */
export async function assertPlaceDisputable(
  deps: ClaimEligibilityDeps,
  placeId: string,
): Promise<{ place: PlaceRecord; verifiedOwner: PlaceOwnershipRecord | null }> {
  const place = await deps.repos.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const verifiedOwner =
    await deps.repos.places.getVerifiedOwnershipForPlace(placeId);
  // A dispute only makes sense when there IS an owner to contest.
  if (place.verificationStatus !== "VERIFIED" && !verifiedOwner) {
    throw fail("CLAIM_DISPUTE_NOT_APPLICABLE");
  }
  return { place, verifiedOwner };
}
