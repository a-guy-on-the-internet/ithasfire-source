/**
 * THE web layer's fail-closed reading of a place's address privacy.
 *
 * Core already redacts every public projection (`redactPlaceLocation`), so by
 * the time a value reaches a component the street address is gone. This module
 * answers the other question a component has to get right: **what am I allowed
 * to DRAW?** A pin, a circle, or nothing — and whether a directions /
 * copy-address affordance may exist at all.
 *
 * It is deliberately paranoid about its input. Several producers hand
 * components a place-shaped object where the privacy flags are OPTIONAL
 * (`EntitySummary`'s PLACE arm, the entity-page block `data` bag, a hand-built
 * test fixture, a client-side fallback summary). An absent flag must never
 * read as "exact" — the whole point of the feature is that the failure mode is
 * somebody's home address on a public page, not a missing map.
 *
 * So: **only the literal `true` on `locationIsExact` unlocks exact rendering.**
 * `undefined`, `null`, a string, a truthy non-boolean — all withheld.
 */

/**
 * Anything place-shaped. Every field optional BECAUSE that is the fail-closed
 * direction: a caller that forgot to pass the flags gets "withheld", not a pin.
 */
export interface PlaceLocationPrivacySource {
  /** Only `true` unlocks the address. See the module doc. */
  locationIsExact?: boolean | null;
  /** `true` = fully hidden. Also INFERRED when a withheld place has no radius. */
  locationHidden?: boolean | null;
  /** Obfuscation circle radius in metres. Non-null only in the circle state. */
  locationRadiusMeters?: number | null;
  /** Coarse area label, the only place string a withheld venue publishes. */
  areaLabel?: string | null;
  /** Coarse fields — published in every state, used for the label fallback. */
  city?: string | null;
  region?: string | null;
  /** Obfuscated CENTRE when withheld-with-radius; the true pin when exact. */
  lat?: number | null;
  lng?: number | null;
}

/** What a component may draw. Read `kind`, never the raw source. */
export type PlaceLocationPrivacy =
  | {
      /** Full address + a true pin. Directions and copy-address are allowed. */
      kind: "exact";
      lat: number | null;
      lng: number | null;
      areaLabel: string | null;
    }
  | {
      /** A circle over an offset centre. No pin, no directions, no address. */
      kind: "area";
      lat: number;
      lng: number;
      radiusMeters: number;
      areaLabel: string | null;
    }
  | {
      /** No map at all. The area label is the entire public location. */
      kind: "hidden";
      areaLabel: string | null;
    };

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coarseLabel(source: PlaceLocationPrivacySource): string | null {
  const explicit = source.areaLabel?.trim();
  if (explicit) return explicit;
  const parts = [source.city, source.region]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Resolve what may be drawn for a place.
 *
 * Fail-closed in three separate ways, each of which has a real caller:
 *  - `locationIsExact !== true` → withheld (an optional/absent flag).
 *  - withheld with a non-finite / null radius → fully hidden, no map.
 *  - withheld with a radius but no coordinates → fully hidden, no map. A
 *    circle needs a centre; a caller holding a radius and no centre has a
 *    partial projection, and a partial projection is not a licence to guess.
 */
export function resolvePlaceLocationPrivacy(
  source: PlaceLocationPrivacySource | null | undefined,
): PlaceLocationPrivacy {
  const areaLabel = source ? coarseLabel(source) : null;

  // No source at all is the most withheld thing there is.
  if (!source) return { kind: "hidden", areaLabel: null };

  if (source.locationIsExact === true) {
    return {
      kind: "exact",
      lat: finiteOrNull(source.lat),
      lng: finiteOrNull(source.lng),
      areaLabel,
    };
  }

  // Withheld from here down. An explicit `locationHidden === true` short-cuts
  // straight to no-map even if a stray radius rode along.
  if (source.locationHidden === true) return { kind: "hidden", areaLabel };

  const radiusMeters = finiteOrNull(source.locationRadiusMeters);
  const lat = finiteOrNull(source.lat);
  const lng = finiteOrNull(source.lng);

  if (radiusMeters === null || radiusMeters <= 0 || lat === null || lng === null) {
    return { kind: "hidden", areaLabel };
  }

  return { kind: "area", lat, lng, radiusMeters, areaLabel };
}

/**
 * May this place carry a directions link, a maps link, or a copy-address
 * control? Only in the `exact` state, and only when there is something real to
 * navigate to.
 *
 * Split out as its own predicate because it is the affordance that actually
 * hurts: an obfuscated centre renders fine as a circle, but routed to as a
 * destination it sends someone to a stranger's door, and a copy-address button
 * on a withheld venue is a promise the product must not make.
 */
export function placeAllowsDirections(
  privacy: PlaceLocationPrivacy,
  address?: string | null,
): boolean {
  if (privacy.kind !== "exact") return false;
  const hasCoords = privacy.lat !== null && privacy.lng !== null;
  return hasCoords || Boolean(address?.trim());
}
