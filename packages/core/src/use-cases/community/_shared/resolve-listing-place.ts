import type { EventsRepo } from "@th/ports/repos/events";
import type { ExactLocationPrivacyReset } from "@th/types";
import type { PlacesRepo } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { exactPlaceLocationColumns } from "../../../lib/location/place-event-location";

/**
 * The location columns a community listing linked to a place is written
 * with. Every value comes from the place; the four the Event row cannot do
 * without (address, country, pin, geohash) are guaranteed non-null.
 */
export type ListingPlaceLocation = {
  placeId: string;
  addressText: string;
  countryCode: string;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
  geohash6: string;
};

/**
 * The location privacy a listing linked to a place takes: the place's, which
 * is EXACT by the rule below. A community listing has no privacy setting of
 * its own.
 */
export const LINKED_PLACE_PRIVACY: ExactLocationPrivacyReset = {
  locationMode: "EXACT",
  locationRadiusMeters: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  addressRevealNotifiedAt: null,
};

/**
 * THE rule for which place a community listing may be linked to, shared by
 * create and the moderator direct edit so the two cannot disagree. Call it
 * inside the caller's transaction with the tx-scoped repos.
 *
 * LOCK FIRST, THEN READ. It takes the SHARED `place_location` advisory lock
 * (`events.lockLocationsAtPlace`) before reading the place, as every save
 * that copies a place's location must (`EventsRepo.lockLocationsAtPlace`).
 * A venue privacy change takes that lock EXCLUSIVE before writing the Place,
 * so it waits for this transaction to commit and its cascade then sees (and
 * re-projects) the listing; without the lock, a listing could read the place
 * while EXACT and keep its true street after the venue went OBSCURED.
 * Lock order is venue first, then rows: a caller that also row-locks the
 * event must take this lock (or call this helper) BEFORE `lockRows`.
 *
 * The PLACE is the source of truth for the listing's address: the columns are
 * copied with `exactPlaceLocationColumns`, the same copy an owned event saved
 * at an EXACT place gets, so the listing and its venue agree when linked.
 *
 * Refused:
 *  - no such place                         → PLACE_NOT_FOUND
 *  - ARCHIVED                              → PLACE_ARCHIVED
 *  - any other non-ACTIVE status           → PLACE_NOT_ACTIVE
 *  - `locationMode` not literally "EXACT"  → INVALID_INPUT,
 *    meta.reason "PLACE_WITHHOLDS_ADDRESS". A venue that withholds its
 *    address must not be picked: the listing would publish its street. Same
 *    fail-closed guard as the community-listing place-link backfill.
 *  - no formatted address, country or full coordinate pair → INVALID_INPUT,
 *    meta.reason "PLACE_LOCATION_INCOMPLETE": the Event row needs all of them.
 *
 * Linking is NOT confirming: nothing here (or in its callers) writes a venue
 * confirmation. Nobody grants consent for an unowned place, staff included.
 */
export async function resolveListingPlaceLocation(
  repos: {
    events: Pick<EventsRepo, "lockLocationsAtPlace">;
    places: Pick<PlacesRepo, "getById">;
  },
  placeId: string,
): Promise<ListingPlaceLocation> {
  await repos.events.lockLocationsAtPlace({ placeId, mode: "shared" });
  const place = await repos.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND", { meta: { placeId } });
  }
  if (place.status === "ARCHIVED") {
    throw fail("PLACE_ARCHIVED", { meta: { placeId } });
  }
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_ACTIVE", {
      meta: { placeId, status: place.status },
    });
  }
  if (place.locationMode !== "EXACT") {
    throw fail("INVALID_INPUT", {
      message:
        "this place withholds its address and cannot be linked to a community listing",
      meta: { placeId, reason: "PLACE_WITHHOLDS_ADDRESS" },
    });
  }

  const columns = exactPlaceLocationColumns(place);
  if (
    columns.addressText === null ||
    columns.countryCode === null ||
    columns.lat === null ||
    columns.lng === null ||
    columns.geohash6 === null
  ) {
    throw fail("INVALID_INPUT", {
      message: "this place has no complete address and coordinates",
      meta: { placeId, reason: "PLACE_LOCATION_INCOMPLETE" },
    });
  }

  return {
    placeId,
    addressText: columns.addressText,
    countryCode: columns.countryCode,
    region: columns.region,
    locality: columns.locality,
    postalCode: columns.postalCode,
    lat: columns.lat,
    lng: columns.lng,
    geohash6: columns.geohash6,
  };
}
