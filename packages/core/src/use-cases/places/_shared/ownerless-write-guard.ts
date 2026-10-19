import type { PlaceRecord, TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

/**
 * Why a write WITHOUT an owner (a community moderator's create-correction,
 * archive or restore) may not touch a place, or null when it may. Every
 * reason is read inside the caller's transaction, after
 * `places.lockPlaceForClaim` (which claim submit and review take too), so a
 * claim landing at the same moment is either seen here or waits.
 *
 *  - "OWNED": a non-revoked VERIFIED ownership row, or any org or human with
 *    access on the record. A claimed place is its owner's to change.
 *  - "CLAIM_PENDING": a non-revoked PROVISIONAL ownership row, or the place's
 *    `verificationStatus` is PENDING. A claim in review is judged against the
 *    place as the claimant saw it; a moderator editing the name or address
 *    under it would change what the reviewer is checking.
 *  - "OWNED_EVENTS_AT_PLACE": an organiser's LIVE event points at the place:
 *    stewardship OWNED, status PUBLISHED, not ended (`endsAt > now`).
 *    Organisers' events come first: paid ticket emails read the LIVE place
 *    name and address (`send-ticket-issued-email`), so a moderator's
 *    correction would rewrite the place in an organiser's tickets. Owner
 *    ruling 2026-10-14: drafts do not count (a draft issues no tickets and
 *    could lock a place forever), nor do ended, COMPLETED, CANCELLED or
 *    ARCHIVED events.
 *
 * `now` is the caller's clock reading (the use case's `clock.now()`, or the
 * write's audit time inside `writePlaceInTx`).
 */
export type OwnerlessWriteBlock =
  | "OWNED"
  | "CLAIM_PENDING"
  | "OWNED_EVENTS_AT_PLACE";

export async function findOwnerlessWriteBlock(
  tx: Pick<TxRepos, "places" | "events">,
  place: PlaceRecord,
  now: Date,
): Promise<OwnerlessWriteBlock | null> {
  if (place.orgIdsWithAccess.length > 0 || place.humanIdsWithAccess.length > 0) {
    return "OWNED";
  }
  const ownerships = await tx.places.listActiveOwnershipsForPlace(place.id);
  if (ownerships.some((row) => row.verified)) return "OWNED";
  if (ownerships.length > 0 || place.verificationStatus === "PENDING") {
    return "CLAIM_PENDING";
  }
  if (await tx.events.hasOwnedLiveEventsAtPlace({ placeId: place.id, now })) {
    return "OWNED_EVENTS_AT_PLACE";
  }
  return null;
}

/**
 * Throws PLACE_HAS_OWNER (FORBIDDEN at the transport) with `meta.reason` set
 * to the {@link OwnerlessWriteBlock}, so the form can say which.
 */
export async function assertOwnerlessWriteAllowed(
  tx: Pick<TxRepos, "places" | "events">,
  place: PlaceRecord,
  now: Date,
): Promise<void> {
  const reason = await findOwnerlessWriteBlock(tx, place, now);
  if (reason !== null) {
    throw fail("PLACE_HAS_OWNER", {
      message:
        reason === "OWNED"
          ? "this place has an owner; only its owner can change it"
          : reason === "CLAIM_PENDING"
            ? "this place has a claim in review"
            : "an organiser's live event uses this place",
      meta: { placeId: place.id, reason },
    });
  }
}
