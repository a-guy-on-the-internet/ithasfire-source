import type { EventLocationMode } from "@th/types";

import { encodeGeohash } from "../geo/geohash";
import { snapObfuscationRadiusUp } from "./obfuscation-radius-ladder";
import { obfuscateCoordinate } from "./redact-location";

/**
 * THE one function every public read of a Place's location goes through.
 *
 * Places got the three-state privacy model Events already had
 * (place-address-withholding) so a DIY house can list as a venue without ever
 * publishing where it is. A LEAK is the failure mode here, not a bug, so this
 * module is written to be the only thing a caller has to get right: hand it the
 * row, take what it gives back, and never reach past it for
 * `formattedAddress` / `addressLine1` / `addressLine2` / `postalCode` /
 * `lat` / `lng`.
 *
 * The three states (identical to `Event`, same enum, on purpose):
 *
 *   EXACT                       → full address + true coordinates.
 *   OBSCURED + radius non-null  → KEYED obfuscated circle, drawn at the
 *                                 stored radius snapped UP to the ladder. The
 *                                 centre is keyed by HMAC(server key, "place"
 *                                 ‖ placeId ‖ rung) and NESTED across rungs
 *                                 (`obfuscateCoordinate`): every surface that
 *                                 redacts this place at this radius emits the
 *                                 IDENTICAL point, every radius's circle
 *                                 contains the house, any set of radii reveals
 *                                 no more than the smallest, and without the
 *                                 key nobody can compute the circle for a
 *                                 guessed address. No key, or no `id` on the
 *                                 row → fully hidden, never the true point.
 *   OBSCURED + radius null      → FULLY HIDDEN. No coordinates, no radius, no
 *                                 map. Only the coarse area label.
 *
 * FAIL-CLOSED throughout: only the literal string `"EXACT"` unlocks the true
 * address. `null`, `undefined`, `""`, or an unrecognised value is treated as
 * withheld, so a fake/partial row in a test — or a repo that forgets the
 * column — leaks nothing.
 */

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * Structurally-typed so any place-shaped row works: the full `PlaceRecord`, a
 * search-index projection, a hand-built test fake. Every field is optional
 * BECAUSE that is the fail-closed direction — a row that omits `locationMode`
 * is withheld, not exact.
 */
export interface PlaceLocationSource {
  /**
   * The place id — the SUBJECT the obfuscation circle is keyed to. A row
   * without one cannot get a circle and is rendered fully hidden.
   */
  id?: string | null;
  /** Only the literal "EXACT" unlocks the address. Anything else is withheld. */
  locationMode?: EventLocationMode | string | null;
  /** Obfuscation radius in metres; null/absent = FULLY HIDDEN under OBSCURED. */
  locationRadiusMeters?: number | null;
  /** Coarse publishable label; falls back to "city, region". */
  locationLabel?: string | null;
  formattedAddress?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface RedactPlaceLocationOptions {
  /**
   * Set TRUE only when the caller has already proven the viewer may see the
   * real address — a verified owner of this place, or platform staff.
   *
   * Defaults to FALSE and is never inferred here: this module has no authz
   * context, and a redactor that guesses at permission is a redactor that
   * eventually guesses wrong.
   */
  viewerCanSeeExact?: boolean;
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * The ONLY location shape a public surface may render for a place.
 *
 * Every field is present in every state (rather than a discriminated union)
 * because the callers are projections into `.strict()` zod output schemas: a
 * uniform shape means a caller cannot forget to null a field on one branch,
 * which is exactly the mistake this exists to prevent. Read `isExact` /
 * `hidden` to decide what to DRAW, never to decide what to trust.
 */
export interface PublicPlaceLocation {
  /** True only for a genuinely EXACT (or owner/staff-unlocked) read. */
  isExact: boolean;
  /** True for OBSCURED with a null radius: there is no public map at all. */
  hidden: boolean;
  /** Street-level fields. NULL unless `isExact`. */
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  /**
   * NULL unless `isExact`. A postcode is a small enough polygon to combine
   * with "which house has the shows" — it rides with the street address, not
   * with the coarse fields.
   */
  postalCode: string | null;
  /**
   * COARSE fields, published in EVERY state. This is deliberate and is what
   * keeps a withheld venue findable: it still appears in city browse and
   * "near me" without being pinpointed.
   */
  city: string | null;
  region: string | null;
  countryCode: string | null;
  /** True pin when exact; obfuscated circle centre when OBSCURED+radius; null when hidden. */
  lat: number | null;
  lng: number | null;
  /** Circle radius in metres — non-null ONLY in the obfuscated-circle state. */
  radiusMeters: number | null;
  /** Coarse human label (e.g. "East Nashville"), or "city, region". */
  areaLabel: string | null;
  /**
   * COARSE geohash (~1.2 km x 0.6 km).
   *
   *   EXACT          → the cell of the true point.
   *   circle         → the cell of the EMITTED centre, and only while the
   *                    circle is smaller than a cell (radius <
   *                    {@link GEOHASH6_CELL_METERS}). A cell of the TRUE point
   *                    intersected with the circle narrows the house down —
   *                    for a 1 km circle, to a quarter of it — so the true
   *                    point never feeds it; and once the circle is wider
   *                    than a cell, a cell reads as more precision than the
   *                    venue publishes.
   *   fully hidden   → null. A hidden venue publishes no position at all.
   */
  geohash6: string | null;
  /**
   * FINE geohash (~38 m x 19 m). Never emitted for a withheld place — a
   * 38-metre cell IS the house. Typed as `string | null` rather than `null`
   * so exact places can carry one, but any non-EXACT read returns null and
   * `redact-place-location.test.ts` pins that.
   */
  geohash8: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function coarseLabel(place: PlaceLocationSource): string | null {
  const parts = [place.city, place.region].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function areaLabelFor(place: PlaceLocationSource): string | null {
  const explicit = place.locationLabel?.trim();
  return explicit && explicit.length > 0 ? explicit : coarseLabel(place);
}

function coarseGeohash(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return encodeGeohash(lat, lng, 6);
}

/**
 * Long side of a geohash-6 cell (~1.2 km x 0.6 km). A withheld place's circle
 * at or above this radius publishes no geohash6 — see `geohash6`.
 */
export const GEOHASH6_CELL_METERS = 1_200;

function fineGeohash(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return encodeGeohash(lat, lng, 8);
}

/**
 * Whether this place withholds its address from the public.
 *
 * Fail-closed: anything that is not the literal `"EXACT"` is withheld. Use
 * this for gating (e.g. "should this venue be named?"), never as a substitute
 * for actually redacting the fields.
 */
export function placeWithholdsAddress(place: PlaceLocationSource): boolean {
  return place.locationMode !== "EXACT";
}

// ── Main API ────────────────────────────────────────────────────────────────

export function redactPlaceLocation(
  place: PlaceLocationSource,
  options: RedactPlaceLocationOptions = {},
): PublicPlaceLocation {
  const lat = typeof place.lat === "number" ? place.lat : null;
  const lng = typeof place.lng === "number" ? place.lng : null;

  const city = place.city ?? null;
  const region = place.region ?? null;
  const countryCode = place.countryCode ?? null;

  // Fail-closed: ONLY the literal "EXACT" (or a caller that has already proven
  // owner/staff access) unlocks the street address.
  const exact = options.viewerCanSeeExact === true || place.locationMode === "EXACT";

  if (exact) {
    return {
      isExact: true,
      hidden: false,
      formattedAddress: place.formattedAddress ?? null,
      addressLine1: place.addressLine1 ?? null,
      addressLine2: place.addressLine2 ?? null,
      postalCode: place.postalCode ?? null,
      city,
      region,
      countryCode,
      lat,
      lng,
      radiusMeters: null,
      areaLabel: areaLabelFor(place),
      geohash6: coarseGeohash(lat, lng),
      geohash8: fineGeohash(lat, lng),
    };
  }

  // The radius the circle is DRAWN (and published) at: the stored value
  // snapped UP to the ladder. Null, unusable, or above the top rung → no
  // circle (fully hidden).
  const radiusMeters = snapObfuscationRadiusUp(place.locationRadiusMeters);

  const withheld: PublicPlaceLocation = {
    isExact: false,
    hidden: true,
    formattedAddress: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city,
    region,
    countryCode,
    lat: null,
    lng: null,
    radiusMeters: null,
    areaLabel: areaLabelFor(place),
    // Fully hidden publishes no position — not even a coarse cell.
    geohash6: null,
    // A withheld place NEVER publishes a fine geohash. See the field doc.
    geohash8: null,
  };

  // FULLY HIDDEN: null radius, or no coordinates to build a circle from.
  if (radiusMeters === null || lat === null || lng === null) {
    return withheld;
  }

  // Keyed circle. Null = no key or no place id → fully hidden (fail closed).
  const obfuscated = obfuscateCoordinate({
    lat,
    lng,
    radiusMeters,
    scope: "place",
    subjectId: place.id,
  });
  if (!obfuscated) {
    return withheld;
  }
  return {
    ...withheld,
    hidden: false,
    lat: obfuscated.lat,
    lng: obfuscated.lng,
    radiusMeters,
    geohash6:
      radiusMeters < GEOHASH6_CELL_METERS
        ? coarseGeohash(obfuscated.lat, obfuscated.lng)
        : null,
  };
}

// ── The ceiling: an event inherits its venue's obscurity as a FLOOR ─────────

/** The pair of columns that decides an event's public location precision. */
export interface EventLocationPrivacy {
  locationMode: EventLocationMode;
  /** Obfuscation radius in metres, or null = FULLY HIDDEN. */
  locationRadiusMeters: number | null;
}

/**
 * Clamps an event's requested location privacy to its venue's.
 *
 * THE RULE: an event whose location resolves from a Place can never be more
 * precise in public than that Place. An event at an OBSCURED venue is
 * OBSCURED, whatever it asked for — by mistake, by direct API call, or by
 * being created before the venue was ever withheld.
 *
 * This is the guarantee; the event builder's UI lock is a courtesy. The rule
 * is applied in TWO places on purpose, and both are load-bearing:
 *
 *   WRITE — `save-event-shared` clamps before persisting, so the stored row
 *     never claims a precision it may not have.
 *   READ  — `buildEventSeo` clamps again against the venue's CURRENT state, so
 *     flipping a venue to withheld hides the events ALREADY PUBLISHED there
 *     immediately, instead of on their next save. For a house that has just
 *     decided it needs to disappear, "on next save" is not an answer.
 *
 * Direction of the clamp — more private always wins:
 *   · venue EXACT              → the event keeps whatever it chose.
 *   · venue OBSCURED, radius R → the event is OBSCURED with radius
 *     `max(its own, R)`; a null (fully hidden) event radius stays null,
 *     because null is MORE private than any circle, not less.
 *   · venue OBSCURED, radius null (fully hidden) → the event is fully hidden.
 */
export function applyPlaceLocationFloor(
  requested: EventLocationPrivacy,
  place: PlaceLocationSource | null | undefined,
): EventLocationPrivacy {
  // No venue, or a venue that publishes its address: nothing to inherit.
  if (!place || !placeWithholdsAddress(place)) {
    return requested;
  }

  const placeRadius =
    typeof place.locationRadiusMeters === "number" &&
    Number.isFinite(place.locationRadiusMeters)
      ? place.locationRadiusMeters
      : null;

  // The venue publishes no map at all — neither may anything hosted in it.
  if (placeRadius === null) {
    return { locationMode: "OBSCURED", locationRadiusMeters: null };
  }

  // The event asked to be fully hidden. That is stricter than the venue's
  // circle, so it stands.
  if (
    requested.locationMode !== "EXACT" &&
    requested.locationRadiusMeters === null
  ) {
    return { locationMode: "OBSCURED", locationRadiusMeters: null };
  }

  const requestedRadius =
    requested.locationMode === "EXACT"
      ? null
      : requested.locationRadiusMeters;

  return {
    locationMode: "OBSCURED",
    locationRadiusMeters:
      requestedRadius === null
        ? placeRadius
        : Math.max(requestedRadius, placeRadius),
  };
}
