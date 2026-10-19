import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

/**
 * Whose access to a place is being asserted: the event's owning org or its
 * owning human. Mirrors `OwnerContext` on the save path.
 */
export type PlaceAccessOwner =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

/**
 * The ONE place-access rule for attaching an event to a venue, on an
 * already-loaded row: the owner must be in the place's access list and the
 * place must be ACTIVE. `ensurePlaceAccessibleForOrg` / `…ForHuman`
 * (save-event-shared) are this after a `getById`; the held-dates settle
 * re-asserts it on the place it has already loaded before it writes to the
 * venue's hold lines.
 *
 * Owners can use their own unverified places — verification gates public
 * discoverability (slug pages, search index), not event creation.
 *
 * @throws PLACE_NOT_FOUND when the row is missing OR the owner has no access
 *   (deliberately the same code: an inaccessible place is not enumerable).
 * @throws PLACE_NOT_ACTIVE when the place is suspended / retired.
 */
export function ensureLoadedPlaceAccessible(
  place: PlaceRecord | null,
  owner: PlaceAccessOwner,
): PlaceRecord {
  const hasAccess =
    place !== null &&
    (owner.kind === "org"
      ? place.orgIdsWithAccess.includes(owner.orgId)
      : place.humanIdsWithAccess.includes(owner.humanId));
  if (!place || !hasAccess) {
    throw fail("PLACE_NOT_FOUND");
  }
  return ensurePlaceActive(place);
}

/**
 * The liveness half of {@link ensureLoadedPlaceAccessible} on its own: a
 * suspended / retired place takes no new events, whoever the owner is. For
 * the paths where the owner's access list is deliberately NOT the gate — a
 * requester-owned booking mint (the venue is the authority and the requester
 * is never on the list) and a venue-confirmed third-party event taking a
 * hold line — this is the half that still applies.
 *
 * @throws PLACE_NOT_ACTIVE when the place is suspended / retired.
 */
export function ensurePlaceActive(place: PlaceRecord): PlaceRecord {
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_ACTIVE");
  }
  return place;
}

/**
 * The attach rule for the BUILDER (venue-confirmation-and-booking-intents
 * spec, docs/specs/2026-08-27 "Two entry paths, one request"): an owner
 * attaches its own place under {@link ensureLoadedPlaceAccessible}; anyone
 * else may name any ACTIVE place as a THIRD PARTY. A third-party event is
 * address-only in public, counts for neither availability nor conflicts,
 * shows on the venue's own calendar as unconfirmed, and — when the builder
 * also names a calendar that accepts the intent — auto-creates the booking
 * request the venue confirms (`createBookingRequestFromEvent`). Unclaimed
 * places are attachable too (the request parks; spec "Unclaimed venues").
 *
 * Before this rule the save path refused every place the owner had no
 * access to (`PLACE_NOT_FOUND`), which made a third-party event impossible
 * to create anywhere but a raw seed patch. The owner branch is unchanged.
 *
 * @throws PLACE_NOT_FOUND when the row is missing.
 * @throws PLACE_NOT_ACTIVE when the place is suspended / retired (owner or
 *   not — a place's existence is public, only its owner list is not).
 */
export function ensureLoadedPlaceAttachable(
  place: PlaceRecord | null,
  owner: PlaceAccessOwner,
): PlaceRecord {
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const hasAccess =
    owner.kind === "org"
      ? place.orgIdsWithAccess.includes(owner.orgId)
      : place.humanIdsWithAccess.includes(owner.humanId);
  if (hasAccess) {
    return ensureLoadedPlaceAccessible(place, owner);
  }
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_ACTIVE");
  }
  return place;
}
