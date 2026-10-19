import type { EventLocationMode } from "@th/types";

import { haversineDistance } from "../geo/haversine";
import {
  eventCircleSubject,
  type EventCircleSubjectSource,
} from "./event-circle-subject";
import { snapObfuscationRadiusUp } from "./obfuscation-radius-ladder";
import { obfuscateCoordinate } from "./redact-location";
import {
  applyPlaceLocationFloor,
  placeWithholdsAddress,
  redactPlaceLocation,
  type PlaceLocationSource,
} from "./redact-place-location";

/**
 * THE one projection every PUBLIC read of an event's location goes through —
 * cards, maps, "surprise me", discovery distance, embeds, the search index,
 * calendar feeds, the event page's anonymous view.
 *
 * The rules, in order:
 *
 *   1. The venue is a FLOOR (`applyPlaceLocationFloor`): an event at a venue
 *      that withholds its address is withheld, whatever its own row says.
 *   2. At a withheld venue the event row is NEVER read for position or
 *      street. The public location is the venue's own public projection
 *      (`redactPlaceLocation`): its keyed circle centre, drawn at the floored
 *      radius (≥ the venue's), or nothing when the venue is fully hidden. The
 *      write path already stores that projection on the row, but a row
 *      written before the venue was withheld still carries the house — so
 *      the row is not trusted here.
 *   3. Event-level obscurity (no venue, or a venue that publishes its
 *      address): a keyed circle around the event row's point
 *      (`obfuscateCoordinate`), keyed by `eventCircleSubject` — the owner +
 *      the true point, so every event an organizer runs at one point draws
 *      ONE circle chain — or nothing when the radius is null.
 *
 * Every drawn radius is the stored one snapped UP to the ladder
 * (`obfuscation-radius-ladder.ts`); the emitted `radiusMeters` is the
 * snapped value, so the drawn circle always contains the true point.
 *   4. EXACT is the stored row, byte for byte.
 *   5. A GATED event (password / application — any `gateType` but NONE) is
 *      LABEL ONLY: no coordinates, no radius, no street, whatever 1–4 said.
 *      The gate protects the location like the rest of the page (the gated
 *      preview is title + hero only), and coordinates in a list, an embed or
 *      the search index would hand it over — and make geo search a distance
 *      oracle. A caller that has ALREADY proven the viewer passed the gate
 *      (the event page's full read, behind `ensureFullEventReadAccess*`)
 *      passes `gateAccessGranted` and gets 1–4 unchanged.
 *
 * Anything non-EXACT emits NO street address and NO postcode — only the coarse
 * `label` ("locality, region") and the author's `areaLabel`.
 *
 * There is no viewer and no clock here on purpose. The public projection does
 * not change with time; the ticket-holder reveal is a different decision with
 * different inputs and lives with the reveal paths.
 *
 * A caller that knows the event's place MUST pass it (`options.place`). An
 * event whose place row is gone or unreadable must be passed
 * {@link unreadablePlaceLocation} — fully hidden — never `undefined`.
 * `undefined` means "this event has no venue".
 */

/**
 * The event fields the projection reads. Structural, so any event-shaped row
 * works. The owner fields (`orgId` / `humanId`) key the circle together with
 * the true point (`eventCircleSubject`): EVERY surface that draws an event
 * must pass them, or two surfaces draw two circles for one event.
 */
export interface PublicEventLocationSource extends EventCircleSubjectSource {
  /** Falls back as the circle subject when there is no owner + address. */
  id: string;
  /**
   * The event's gate. REQUIRED (N5, 2026-09-25): anything but the literal
   * "NONE" — including null and undefined — makes the public projection
   * label only (rule 5). It used to be optional with "absent = no gate",
   * which made every projection that forgot the column an ungated one; a
   * raw geo / pick row whose SQL already admits `gateType = 'NONE'` only
   * must still select and pass the column.
   */
  gateType: string | null | undefined;
  /** Only the literal "EXACT" is exact; anything else fails closed. */
  locationMode?: EventLocationMode | string | null;
  /** Circle radius in metres; null under OBSCURED = fully hidden. */
  locationRadiusMeters?: number | null;
  locationLabel?: string | null;
  addressText?: string | null;
  lat?: number | null;
  lng?: number | null;
  locality?: string | null;
  region?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
}

export interface ProjectPublicEventLocationOptions {
  /**
   * The event's venue (the row at `event.placeId`), when it has one. Omit
   * ONLY for an event with no place. See the module header.
   */
  place?: PlaceLocationSource | null;
  /**
   * TRUE only when the caller has already proven this viewer satisfied the
   * event's gate (password unlocked, application approved, or a bypass
   * role) — i.e. the event page's full read. Never inferred here; default
   * FALSE, so a gated event is label only (rule 5).
   */
  gateAccessGranted?: boolean;
}

/**
 * The ONLY location shape a public surface may render for an event. Uniform
 * across states (no union) so a projection into a `.strict()` output schema
 * cannot forget to null a field on one branch.
 */
export interface PublicEventLocation {
  /** Post-floor mode. "OBSCURED" whenever the event OR its venue withholds. */
  mode: EventLocationMode;
  /** OBSCURED with no public position at all (no circle, no pin). */
  hidden: boolean;
  /** True pin (EXACT) · keyed circle centre (OBSCURED) · null (hidden). */
  lat: number | null;
  lng: number | null;
  /** Circle radius in metres — non-null ONLY for a drawn circle. */
  radiusMeters: number | null;
  /**
   * The one line a public card prints for the location. EXACT → the stored
   * `addressText` (unchanged); OBSCURED → coarse "locality, region", never a
   * street.
   */
  label: string | null;
  /**
   * Author-chosen label for a redacted view (the event's `locationLabel`, or
   * the venue's when the venue withholds), falling back to `label`. Null for
   * EXACT.
   */
  areaLabel: string | null;
  /** Street address. NULL unless EXACT. */
  addressText: string | null;
  /** NULL unless EXACT — a postcode rides with the street. */
  postalCode: string | null;
  /** Coarse fields — public in every state. */
  locality: string | null;
  region: string | null;
  countryCode: string | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function coarseLabel(
  locality: string | null,
  region: string | null,
): string | null {
  const parts = [locality, region].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The stand-in for a place row that is GONE or could not be READ: fully
 * hidden. A degraded read that hides a venue too hard self-heals on the next
 * read; a published pin does not un-publish.
 */
export function unreadablePlaceLocation(placeId: string): PlaceLocationSource {
  return { id: placeId, locationMode: "OBSCURED", locationRadiusMeters: null };
}

/** Narrow a place row to the fields the projections read (and nothing else). */
export function toPlaceLocationSource(place: PlaceLocationSource): PlaceLocationSource {
  return {
    id: place.id ?? null,
    locationMode: place.locationMode ?? null,
    locationRadiusMeters: place.locationRadiusMeters ?? null,
    locationLabel: place.locationLabel ?? null,
    formattedAddress: place.formattedAddress ?? null,
    addressLine1: place.addressLine1 ?? null,
    addressLine2: place.addressLine2 ?? null,
    city: place.city ?? null,
    region: place.region ?? null,
    postalCode: place.postalCode ?? null,
    countryCode: place.countryCode ?? null,
    lat: place.lat ?? null,
    lng: place.lng ?? null,
  };
}

/**
 * Whether the event is gated. FAILS CLOSED: only the literal "NONE" is
 * ungated; a missing (undefined / null) or unknown value is gated.
 */
export function eventIsGated(event: {
  gateType: string | null | undefined;
}): boolean {
  return event.gateType !== "NONE";
}

export function projectPublicEventLocation(
  event: PublicEventLocationSource,
  options: ProjectPublicEventLocationOptions = {},
): PublicEventLocation {
  const projected = projectUngatedEventLocation(event, options);
  if (options.gateAccessGranted === true || !eventIsGated(event)) {
    return projected;
  }
  // Rule 5 — gated: the coarse label, and nothing that locates it.
  const label = coarseLabel(projected.locality, projected.region);
  return {
    ...projected,
    mode: "OBSCURED",
    hidden: true,
    lat: null,
    lng: null,
    radiusMeters: null,
    label,
    // An OBSCURED event's author label was already public; an EXACT event
    // has none, so the coarse label stands in.
    areaLabel:
      projected.mode === "EXACT" ? label : (projected.areaLabel ?? label),
    addressText: null,
    postalCode: null,
  };
}

function projectUngatedEventLocation(
  event: PublicEventLocationSource,
  options: ProjectPublicEventLocationOptions,
): PublicEventLocation {
  const place = options.place ?? null;
  const floored = applyPlaceLocationFloor(
    {
      locationMode: event.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
      locationRadiusMeters: finiteOrNull(event.locationRadiusMeters),
    },
    place,
  );

  const locality = event.locality ?? null;
  const region = event.region ?? null;
  const countryCode = event.countryCode ?? null;

  if (floored.locationMode === "EXACT") {
    return {
      mode: "EXACT",
      hidden: false,
      lat: finiteOrNull(event.lat),
      lng: finiteOrNull(event.lng),
      radiusMeters: null,
      label: event.addressText ?? null,
      areaLabel: null,
      addressText: event.addressText ?? null,
      postalCode: event.postalCode ?? null,
      locality,
      region,
      countryCode,
    };
  }

  // The radius a circle is DRAWN (and published) at: the floored value
  // snapped UP to the ladder (monotone, so still ≥ the venue's drawn radius).
  // Above the top rung → no circle.
  const radius = snapObfuscationRadiusUp(floored.locationRadiusMeters);

  // Rule 2 — the venue withholds: its public projection, never the row.
  if (place !== null && placeWithholdsAddress(place)) {
    const venue = redactPlaceLocation(place);
    const venueLocality = venue.city ?? locality;
    const venueRegion = venue.region ?? region;
    const label = coarseLabel(venueLocality, venueRegion);
    const drawn =
      radius !== null && !venue.hidden && venue.lat !== null && venue.lng !== null;
    return {
      mode: "OBSCURED",
      hidden: !drawn,
      lat: drawn ? venue.lat : null,
      lng: drawn ? venue.lng : null,
      // The floor guarantees radius ≥ the venue's, so the venue's circle
      // centre at this radius still contains the venue.
      radiusMeters: drawn ? radius : null,
      label,
      areaLabel: nonEmpty(venue.areaLabel) ?? label,
      addressText: null,
      postalCode: null,
      locality: venueLocality,
      region: venueRegion,
      countryCode: venue.countryCode ?? countryCode,
    };
  }

  // Rule 3 — event-level obscurity: a keyed circle around the row's point.
  const lat = finiteOrNull(event.lat);
  const lng = finiteOrNull(event.lng);
  const subject = eventCircleSubject(event);
  const centre =
    radius !== null && lat !== null && lng !== null
      ? obfuscateCoordinate({
          lat,
          lng,
          radiusMeters: radius,
          scope: subject.scope,
          subjectId: subject.id,
        })
      : null;
  const label = coarseLabel(locality, region);
  return {
    mode: "OBSCURED",
    hidden: centre === null,
    lat: centre?.lat ?? null,
    lng: centre?.lng ?? null,
    radiusMeters: centre ? radius : null,
    label,
    areaLabel: nonEmpty(event.locationLabel) ?? label,
    addressText: null,
    postalCode: null,
    locality,
    region,
    countryCode,
  };
}

/**
 * Metres from `from` to the location a viewer is SHOWN — the true pin for
 * EXACT, the circle centre for OBSCURED, null when hidden. Never the true
 * point of a withheld location: a distance from it, differenced across a few
 * viewer positions, trilaterates the house.
 */
export function publicDistanceMeters(
  from: { lat: number; lng: number },
  location: Pick<PublicEventLocation, "lat" | "lng">,
): number | null {
  if (location.lat === null || location.lng === null) return null;
  return haversineDistance(from.lat, from.lng, location.lat, location.lng);
}
