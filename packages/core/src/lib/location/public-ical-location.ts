import {
  projectPublicEventLocation,
  unreadablePlaceLocation,
  type PublicEventLocationSource,
} from "./project-public-event-location";
import {
  redactPlaceLocation,
  type PlaceLocationSource,
} from "./redact-place-location";

/** `LOCATION` + `GEO` for one VEVENT. */
export interface PublicIcalLocation {
  location: string | null;
  geo: { lat: number; lng: number } | null;
}

/**
 * The location an anonymous calendar feed may carry for an event.
 *
 * ICS is the least retractable surface there is: the feeds are public,
 * cached for an hour, and copied into other people's calendar apps where we
 * can never take a line back. So there is no ticket-holder reveal here, ever:
 *
 *   non-EXACT (the event's own mode, FLOORED by its venue) → the coarse
 *     "locality, region" label, NO `GEO`, and no venue name — a venue's name
 *     is a de-facto address while its address is withheld.
 *   EXACT → exactly what the feeds always emitted: the venue's address (or
 *     its name) and pin when the event has a venue, the event's own address
 *     otherwise, the event's pin as the `GEO` fallback.
 *
 * The event goes through `projectPublicEventLocation`; the Place row is read
 * ONLY through `redactPlaceLocation`, and only once the floor has proven it
 * EXACT. An event whose venue row is missing fails closed (label only).
 *
 * A GATED event (password / application — anything but `gateType: NONE`)
 * carries NO location at all: the gate protects the location like the rest
 * of the page (the gated preview is title + hero only), and a feed is not a
 * way around the gate. Any present value other than "NONE" is a gate; every
 * route passes the `EventRecord`, which always carries the column.
 */
export function publicIcalLocation(
  event: PublicEventLocationSource & {
    placeId?: string | null;
    gateType?: string | null;
  },
  /** The event's OWN venue (the row at `event.placeId`), or null. */
  place: (PlaceLocationSource & { name?: string | null }) | null,
): PublicIcalLocation {
  if (event.gateType != null && event.gateType !== "NONE") {
    return { location: null, geo: null };
  }
  const venue = event.placeId
    ? (place ?? unreadablePlaceLocation(event.placeId))
    : null;
  const projected = projectPublicEventLocation(event, { place: venue });

  if (projected.mode !== "EXACT") {
    return { location: projected.label, geo: null };
  }

  let location: string | null = null;
  let geo: PublicIcalLocation["geo"] = null;
  if (event.placeId) {
    if (place) {
      // EXACT after the floor ⇒ the venue publishes its address.
      const venueLocation = redactPlaceLocation(place);
      location = venueLocation.formattedAddress ?? place.name ?? null;
      if (venueLocation.lat !== null && venueLocation.lng !== null) {
        geo = { lat: venueLocation.lat, lng: venueLocation.lng };
      }
    }
  } else if (event.addressText) {
    location = event.addressText;
  }
  if (!geo && projected.lat !== null && projected.lng !== null) {
    geo = { lat: projected.lat, lng: projected.lng };
  }
  return { location, geo };
}
