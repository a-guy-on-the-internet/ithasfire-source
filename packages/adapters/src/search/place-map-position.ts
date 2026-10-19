import type { PlaceSuggestion } from "@th/ports/search/multi-index.types";

export type PlaceMapPosition = Pick<
  PlaceSuggestion,
  "lat" | "lng" | "locationIsExact" | "locationRadiusMeters" | "locationHidden"
>;

/**
 * The map position a PLACE suggestion may carry, read off the indexed
 * (already redacted) document. Shared by both search adapters so they cannot
 * disagree.
 *
 * The document is redacted before it is written (`placeToDocument` →
 * `redactPlaceLocation`), so this adds nothing the index did not already
 * hold. It exists to fail CLOSED on the way out:
 *
 *   exact + point         → the pin.
 *   not exact + radius    → the circle centre + its radius (an approximate area).
 *   not exact + no radius → NO coordinates. A document indexed before the
 *                           precision attributes existed reads as this, so a
 *                           stale row is left off the map rather than drawn as
 *                           a pin it may not be.
 *
 * `locationHidden` — "keeps its location private" — is true ONLY for a row
 * that is not exact AND has no point: exactly `redactPlaceLocation`'s
 * `hidden` for any reindexed row (an exact venue is never hidden; a withheld
 * one has a point iff it publishes a circle). An EXACT venue that simply has
 * no coordinates is not private, and a stale row that still carries a point
 * is not claimed to be.
 */
export function placeMapPosition(
  lat: number | null | undefined,
  lng: number | null | undefined,
  locationIsExact: boolean | null | undefined,
  locationRadiusMeters: number | null | undefined,
): PlaceMapPosition {
  const isExact = locationIsExact === true;
  const hasPoint =
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    typeof lng === "number" &&
    Number.isFinite(lng);
  const radius =
    !isExact &&
    typeof locationRadiusMeters === "number" &&
    Number.isFinite(locationRadiusMeters) &&
    locationRadiusMeters > 0
      ? locationRadiusMeters
      : null;

  const locationHidden = !isExact && !hasPoint;
  if (!hasPoint || (!isExact && radius === null)) {
    return {
      lat: null,
      lng: null,
      locationIsExact: isExact,
      locationRadiusMeters: null,
      locationHidden,
    };
  }
  return { lat, lng, locationIsExact: isExact, locationRadiusMeters: radius, locationHidden };
}
