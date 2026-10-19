import type {
  AddressRevealPreset,
  EventPlaceLocationColumns,
  PlaceEventLocationProjection,
} from "@th/types";

import { encodeGeohash } from "../geo/geohash";
import {
  applyPlaceLocationFloor,
  placeWithholdsAddress,
  redactPlaceLocation,
  type EventLocationPrivacy,
  type PlaceLocationSource,
} from "./redact-place-location";

/**
 * WHERE A WITHHELD VENUE'S TRUE LOCATION IS STORED: ON THE PLACE ROW, AND
 * NOWHERE ELSE (place-address-withholding D1).
 *
 * An event linked to a place used to receive a COPY of the place's street
 * address, postcode and true coordinates, so every event read surface (ICS,
 * random event, discovery distance, search docs, the builder) bypassed the
 * Place redaction boundary. This module is the rule that replaced the copy:
 *
 *   venue EXACT      → the event gets the true columns, exactly as before.
 *   venue withheld   → the event gets the venue's PUBLIC projection — what
 *                      `redactPlaceLocation` emits to an anonymous viewer — and
 *                      nothing derived from the true point:
 *                        · locationMode           = OBSCURED
 *                        · locationRadiusMeters   = the event's own radius
 *                          floored at the venue's (`applyPlaceLocationFloor`):
 *                          max(event, venue); NULL when either is fully hidden
 *                        · lat / lng              = the venue's public circle
 *                          centre; NULL when the floored radius is NULL
 *                        · geohash6               = the redactor's own
 *                          (of the public centre, or NULL) — never of the
 *                          true point
 *                        · addressText            = the venue's area label
 *                        · locality/region/country = the coarse fields the
 *                          redactor publishes in every state
 *                        · postalCode             = NULL
 *
 * Every Event writer that sets location from a Place goes through here: the
 * events adapter's `upsertDraft` (per event) and `upsertPlace`'s cascade (per
 * venue, applied in one UPDATE). Fail-closed like the redactor it wraps: only
 * the literal "EXACT" copies the truth.
 *
 * LIMIT (W6): freeform-address events (no `placeId`) are NOT covered. Their
 * row is the only record of the address, so it has to hold the truth, and
 * event-level OBSCURED is enforced at read time instead.
 */

/**
 * A place row as the projection needs it. `id` MUST be carried: the public
 * circle is keyed to the place id, and a row without one renders fully hidden
 * (fail-closed) — so an event would lose its map, never gain a pin.
 */
export type PlaceEventLocationSource = PlaceLocationSource;

/** The reveal schedule a newly-withheld event gets when it has none. */
export const WITHHELD_EVENT_DEFAULT_REVEAL: {
  preset: AddressRevealPreset;
  leadMs: number;
} = {
  // Mirrors `resolveAddressReveal`'s default for a new OBSCURED event.
  preset: "DAY_BEFORE",
  leadMs: 24 * 60 * 60 * 1000,
};

/** The columns an EXACT place writes — byte-identical to the historical copy. */
export function exactPlaceLocationColumns(
  place: PlaceEventLocationSource,
): EventPlaceLocationColumns {
  // The historical adapter copy reset every column to NULL and then set each
  // one only when the place value was truthy (`if (place?.city) …`), and the
  // coordinates only when BOTH were present. `|| null` reproduces that for
  // strings (an empty string stays NULL); the pair rule is kept literally.
  const hasPoint =
    typeof place.lat === "number" && typeof place.lng === "number";
  return {
    lat: hasPoint ? (place.lat as number) : null,
    lng: hasPoint ? (place.lng as number) : null,
    geohash6: hasPoint
      ? encodeGeohash(place.lat as number, place.lng as number, 6)
      : null,
    addressText: place.formattedAddress || null,
    locality: place.city || null,
    region: place.region || null,
    countryCode: place.countryCode || null,
    postalCode: place.postalCode || null,
  };
}

/**
 * What one place projects onto EVERY event linked to it. The per-event part
 * (the floored radius, and so whether the event keeps the centre) is applied
 * by the caller — {@link projectEventLocationAtPlace} in TS, the adapter's
 * reproject UPDATE in SQL.
 */
export function projectPlaceLocationForEvents(
  place: PlaceEventLocationSource,
): PlaceEventLocationProjection {
  if (!placeWithholdsAddress(place)) {
    return { kind: "exact", columns: exactPlaceLocationColumns(place) };
  }

  // The ANONYMOUS projection, never an owner-unlocked one: what we store is
  // what every event surface may publish.
  const publicLocation = redactPlaceLocation(place);

  // `geohash6` is whatever the redactor publishes for the venue (derived
  // from the public centre, or withheld when the circle is wider than a
  // cell) — the event never carries a finer or different cell than its venue.
  const publicCentre =
    publicLocation.lat !== null && publicLocation.lng !== null
      ? {
          lat: publicLocation.lat,
          lng: publicLocation.lng,
          geohash6: publicLocation.geohash6,
        }
      : null;

  return {
    kind: "withheld",
    // The redactor's own radius is null whenever it drew no circle (fully
    // hidden, OR a radius with no coordinates to draw it from). The floor
    // below needs the venue's CONFIGURED radius instead, so an event there
    // keeps its OBSCURED-with-radius shape even though it has no centre yet.
    venueRadiusMeters: configuredRadius(place),
    publicCentre,
    addressText: publicLocation.areaLabel,
    locality: publicLocation.city,
    region: publicLocation.region,
    countryCode: publicLocation.countryCode,
  };
}

export type EventLocationAtPlace =
  | {
      /** Venue publishes its address: copy the truth; privacy untouched. */
      withheld: false;
      columns: EventPlaceLocationColumns;
    }
  | {
      /** Venue withholds: store the public projection; privacy floored. */
      withheld: true;
      privacy: EventLocationPrivacy;
      columns: EventPlaceLocationColumns;
    };

/**
 * The location an event saved at `place` must be STORED with, given the
 * privacy it asked for. For an EXACT place `requested` is returned untouched
 * (the adapter keeps whatever the caller set) — the historical behaviour.
 */
export function projectEventLocationAtPlace(
  place: PlaceEventLocationSource,
  requested: EventLocationPrivacy,
): EventLocationAtPlace {
  const projection = projectPlaceLocationForEvents(place);
  if (projection.kind === "exact") {
    return { withheld: false, columns: projection.columns };
  }

  const privacy = applyPlaceLocationFloor(requested, place);
  // Fully hidden (by the venue or by the event's own stricter choice): no
  // coordinates at all, not even the public centre.
  const centre =
    privacy.locationRadiusMeters === null ? null : projection.publicCentre;

  return {
    withheld: true,
    privacy,
    columns: {
      lat: centre?.lat ?? null,
      lng: centre?.lng ?? null,
      geohash6: centre?.geohash6 ?? null,
      addressText: projection.addressText,
      locality: projection.locality,
      region: projection.region,
      countryCode: projection.countryCode,
      postalCode: null,
    },
  };
}

/**
 * Whether a change to a place alters what its events must store — i.e.
 * whether `upsertPlace` has to re-project them.
 *
 * Any privacy field change (tighten OR loosen) counts. While the place is
 * withheld, so does any change to the fields the public projection is built
 * from (coordinates → the centre; label / city / region → the area label) —
 * a venue that renames its area label because the old one said too much must
 * not leave the old label on every event. An EXACT → EXACT address edit is
 * NOT a projection change: it re-projects onto UPCOMING events only, through
 * {@link placeExactAddressChanged} and `followPlaceAddressOntoEvents`.
 */
export function placeEventProjectionChanged(
  before: PlaceEventLocationSource,
  after: PlaceEventLocationSource,
): boolean {
  const withheldBefore = placeWithholdsAddress(before);
  const withheldAfter = placeWithholdsAddress(after);
  if (withheldBefore !== withheldAfter) return true;
  if (!withheldAfter) return false;

  return (
    configuredRadius(before) !== configuredRadius(after) ||
    (before.locationLabel ?? null) !== (after.locationLabel ?? null) ||
    (before.lat ?? null) !== (after.lat ?? null) ||
    (before.lng ?? null) !== (after.lng ?? null) ||
    (before.city ?? null) !== (after.city ?? null) ||
    (before.region ?? null) !== (after.region ?? null) ||
    (before.countryCode ?? null) !== (after.countryCode ?? null)
  );
}

/**
 * Whether an EXACT → EXACT place write changed what its events copy — the
 * trigger for the address follow (owner ruling 2026-10-14, "make events
 * follow the edits"). Compares exactly the columns an EXACT place writes
 * onto an event ({@link exactPlaceLocationColumns}), so a name, phone or
 * website edit never fires it, and a street edit always does. False when
 * either side withholds: that is a privacy change, which
 * {@link placeEventProjectionChanged} owns.
 */
export function placeExactAddressChanged(
  before: PlaceEventLocationSource,
  after: PlaceEventLocationSource,
): boolean {
  if (placeWithholdsAddress(before) || placeWithholdsAddress(after)) {
    return false;
  }
  const a = exactPlaceLocationColumns(before);
  const b = exactPlaceLocationColumns(after);
  return (Object.keys(a) as Array<keyof EventPlaceLocationColumns>).some(
    (key) => a[key] !== b[key],
  );
}

function configuredRadius(place: PlaceLocationSource): number | null {
  return typeof place.locationRadiusMeters === "number" &&
    Number.isFinite(place.locationRadiusMeters)
    ? place.locationRadiusMeters
    : null;
}
