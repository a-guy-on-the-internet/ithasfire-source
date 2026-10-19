import type { EventLocationMode } from "@th/types";

import { eventCircleSubject } from "./event-circle-subject";
import {
  locationOffsetUniforms,
  type LocationObfuscationScope,
} from "./obfuscation-key";
import {
  OBFUSCATION_RADIUS_LADDER_METERS,
  snapObfuscationRadiusUp,
} from "./obfuscation-radius-ladder";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExactLocation {
  lat: number;
  lng: number;
  addressText: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
  locationLabel: string | null;
}

export interface RedactedLocation {
  /** Keyed obfuscated circle centre (`obfuscateCoordinate`), within `radiusMeters` of the truth. */
  lat: number;
  lng: number;
  /** Radius in meters for the circle overlay — a ladder rung (the stored value snapped up). */
  radiusMeters: number;
  /** Human-readable area label (e.g. "Bushwick, Brooklyn"). */
  areaLabel: string | null;
  isExact: false;
  hidden: false;
}

/**
 * FULLY-HIDDEN pre-reveal view (OBSCURED + `radiusMeters === null`): no
 * coordinates, no radius, no map — only the coarse area label.
 */
export interface HiddenLocation {
  /** Human-readable area label (e.g. "Bushwick, Brooklyn"). */
  areaLabel: string | null;
  isExact: false;
  hidden: true;
}

export interface ExactLocationOutput {
  lat: number;
  lng: number;
  addressText: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
  locationLabel: string | null;
  isExact: true;
}

export type PublicLocation =
  | RedactedLocation
  | HiddenLocation
  | ExactLocationOutput;

export interface RedactLocationInput {
  mode: EventLocationMode;
  exact: ExactLocation;
  /**
   * Public pre-reveal precision for OBSCURED events: obfuscation radius in
   * meters, or null = FULLY HIDDEN (no public coordinates at all).
   */
  radiusMeters: number | null;
  /** Whether the caller has purchased a ticket (for OBSCURED mode reveal). */
  callerIsTicketHolder: boolean;
  /**
   * When the exact address becomes visible to ticket holders. Required
   * (non-null) for OBSCURED events — a null here is a data-invariant
   * violation and FAILS CLOSED (never revealed), it does NOT mean
   * "reveal immediately".
   */
  addressRevealAt: Date | null;
  /** Current time — injected for testability. */
  now: Date;
  /**
   * The event the circle belongs to. With the owner and the true point
   * (`exact.lat/lng`) it keys the offset (`eventCircleSubject`): every event
   * an owner runs at one point draws one circle chain.
   */
  eventId: string;
  orgId?: string | null;
  humanId?: string | null;
  seriesId?: string | null;
}

// ── Obfuscation helpers ──────────────────────────────────────────────────────

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Every step of a circle's construction is at most `DISC_FRACTION · Δ` long
 * (the first is drawn from a disc of radius `0.99 · r₁`, each later one is a
 * ring step of exactly `0.99 · (rᵢ₊₁ − rᵢ)`), so the emitted centre is within
 * `0.99 · R` of the true point in the planar frame below.
 *
 * The planar metres→degrees conversion disagrees with the geodesic (PostGIS
 * `ST_Distance`), spherical (`earth_distance`) and haversine metrics by under
 * 1 % up to ~70° latitude: the ellipsoid's ~0.34 % plus a step-size term
 * (Δ²·tan φ / 4R — ~0.33 % for the 30 km top step at 70°). The geo adapters
 * widen candidate queries by exactly `R`, and the circle a viewer sees has
 * radius `R`, so the true point must be strictly inside under EVERY metric —
 * the 1 % margin is what guarantees it (pinned at 0°, 45° and 70° at the top
 * rung in `obfuscation-nesting.test.ts` and `obfuscation-worst-case.test.ts`).
 */
const DISC_FRACTION = 0.99;

export interface ObfuscateCoordinateInput {
  lat: number;
  lng: number;
  /**
   * The radius the caller wants. Snapped UP to the ladder
   * (`snapObfuscationRadiusUp`) — a caller that EMITS a radius must emit the
   * snapped one, or the drawn circle may not contain the true point.
   */
  radiusMeters: number;
  /** Namespace of the subject — part of the keyed HMAC message. */
  scope: LocationObfuscationScope;
  /** The subject the circle belongs to (`eventCircleSubject`, a place id). Absent → no circle. */
  subjectId: string | null | undefined;
}

type Point = { lat: number; lng: number };

function wrapLongitude(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Move `from` by `distanceMeters` along `bearingRad` (0 = north, clockwise),
 * in the local planar frame AT `from`. The frame is evaluated at the point
 * being moved — never at the true point — so a step is a function of where
 * the chain already is, and nothing else.
 */
export function offsetPointByMeters(
  from: Point,
  distanceMeters: number,
  bearingRad: number,
): Point {
  const latOffset = (distanceMeters * Math.cos(bearingRad)) / METERS_PER_DEGREE_LAT;
  const lngOffset =
    (distanceMeters * Math.sin(bearingRad)) /
    (METERS_PER_DEGREE_LAT * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + latOffset, lng: wrapLongitude(from.lng + lngOffset) };
}

/**
 * The FIRST keyed step: a point drawn UNIFORMLY from the disc of radius
 * `discRadiusMeters` around `from` (radial fraction √u — uniform in the disc,
 * not an annulus, which would say "not near the centre"). Keyed by
 * `HMAC(key, scope ‖ subject ‖ rung)`. Null without a key or a subject.
 */
function keyedDiscStep(
  from: Point,
  discRadiusMeters: number,
  scope: LocationObfuscationScope,
  subjectId: string | null | undefined,
  rung: number,
): Point | null {
  const uniforms = locationOffsetUniforms(scope, subjectId, rung);
  if (!uniforms) return null;
  return offsetPointByMeters(
    from,
    discRadiusMeters * Math.sqrt(uniforms.u1),
    2 * Math.PI * uniforms.u2,
  );
}

/**
 * Every LATER keyed step: a RING step — exactly `lengthMeters` long, in a
 * direction θ uniform from `HMAC(key, scope ‖ subject ‖ rung)`. Full length on
 * purpose: nesting caps a step at the gap to the previous rung, and a disc
 * draw would waste most of that budget near the centre, leaving a large
 * circle's centre far closer to the house than its radius suggests. Null
 * without a key or a subject.
 */
function keyedRingStep(
  from: Point,
  lengthMeters: number,
  scope: LocationObfuscationScope,
  subjectId: string | null | undefined,
  rung: number,
): Point | null {
  const uniforms = locationOffsetUniforms(scope, subjectId, rung);
  if (!uniforms) return null;
  return offsetPointByMeters(from, lengthMeters, 2 * Math.PI * uniforms.u2);
}

/**
 * The public centre of an obfuscation circle — NESTED across the radius
 * ladder (`obfuscation-radius-ladder.ts`).
 *
 * For a subject, with the ladder r₁ < r₂ < … :
 *
 *   C(r₁)   = P      + U(D(0, 0.99·r₁))                keyed (scope, subject, r₁)
 *   C(rᵢ₊₁) = C(rᵢ) + 0.99·(rᵢ₊₁ − rᵢ)·(cos θ, sin θ)  θ keyed (scope, subject, rᵢ₊₁)
 *
 * What that buys:
 *   · CONTAINMENT — |C(rᵢ) − P| ≤ 0.99·rᵢ, so every published circle
 *     contains the true point (under every metric the adapters use).
 *   · NESTING — each step is drawn from where the chain already is, never
 *     from P, so C(rⱼ) − C(rᵢ) is independent of P given C(rᵢ). However many
 *     rungs of one subject an observer collects, they learn nothing beyond
 *     the SMALLEST one. Independent per-radius draws (the previous model)
 *     were each a fresh sample of P, and samples intersect.
 *   · KEYED — without the server key nobody can compute a circle for a
 *     guessed address and compare it with the published one.
 *
 * SPREAD. A large circle's centre is a sum of steps, each capped by a gap on
 * the ladder, so the ladder is coarse (nine rungs, roughly doubling) and the
 * later steps are full-length rings: the RMS offset of C(r) from P stays at
 * ~0.6·r (vs 0.7·r for a single uniform draw from the disc), where 39 fine
 * rungs with disc steps left it at ~0.19·r. The price of rings: where a gap
 * is wider than the previous rung (250, 5,000 and 50,000 m), the centre
 * cannot land within 0.99·(rᵢ₊₁ − 2rᵢ) of P — a small hole holding ~4 % of
 * the disc's area. Measured and pinned in `obfuscation-nesting.test.ts`.
 *
 * The radius is snapped UP to the ladder first. Returns NULL — callers render
 * the location fully hidden — when there is no key, no subject, no usable
 * radius (or one above the top rung), or no finite point. Never falls back to
 * the true point.
 */
export function obfuscateCoordinate(
  input: ObfuscateCoordinateInput,
): { lat: number; lng: number } | null {
  const { lat, lng, scope, subjectId } = input;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const target = snapObfuscationRadiusUp(input.radiusMeters);
  if (target === null) return null;

  const first = OBFUSCATION_RADIUS_LADDER_METERS[0] as number;
  const innermost = keyedDiscStep(
    { lat, lng },
    DISC_FRACTION * first,
    scope,
    subjectId,
    first,
  );
  if (!innermost) return null;
  return extendObfuscationCircle({
    centre: innermost,
    fromRadiusMeters: first,
    toRadiusMeters: target,
    scope,
    subjectId,
  });
}

export interface ExtendObfuscationCircleInput {
  /** C(from) — an already-drawn centre on this subject's chain. */
  centre: Point;
  /** A ladder rung: the radius `centre` was drawn at. */
  fromRadiusMeters: number;
  /** A ladder rung ≥ `fromRadiusMeters`. */
  toRadiusMeters: number;
  scope: LocationObfuscationScope;
  subjectId: string | null | undefined;
}

/**
 * C(to) from C(from) — the rest of the chain. Takes NO true point: that
 * signature IS the nesting property (the larger circle is a function of the
 * smaller one and the key, nothing else). Null for a bad rung pair or a
 * missing key/subject.
 */
export function extendObfuscationCircle(
  input: ExtendObfuscationCircleInput,
): Point | null {
  const { fromRadiusMeters, toRadiusMeters, scope, subjectId } = input;
  if (
    snapObfuscationRadiusUp(fromRadiusMeters) !== fromRadiusMeters ||
    snapObfuscationRadiusUp(toRadiusMeters) !== toRadiusMeters ||
    toRadiusMeters < fromRadiusMeters
  ) {
    return null;
  }
  let centre: Point | null = input.centre;
  let previous = fromRadiusMeters;
  for (const rung of OBFUSCATION_RADIUS_LADDER_METERS) {
    if (rung <= fromRadiusMeters) continue;
    if (rung > toRadiusMeters) break;
    centre = keyedRingStep(
      centre,
      DISC_FRACTION * (rung - previous),
      scope,
      subjectId,
      rung,
    );
    if (!centre) return null;
    previous = rung;
  }
  return centre;
}

function buildAreaLabel(loc: ExactLocation): string | null {
  const parts = [loc.locality, loc.region].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Returns location data appropriate for the caller's access level.
 *
 * EXACT    → always returns exact coordinates.
 * OBSCURED → revealed = `callerIsTicketHolder` AND `addressRevealAt` has
 *            passed (`now >= addressRevealAt`); revealed callers get the
 *            exact location. Otherwise:
 *              - `radiusMeters != null` → keyed obfuscated circle
 *                (`obfuscateCoordinate`) + area label; fully hidden when
 *                the obfuscation key is missing.
 *              - `radiusMeters == null` → FULLY HIDDEN: no lat/lng/radius,
 *                only the area label (`hidden: true`).
 *
 * Fail-closed: any mode other than the literal "EXACT" is treated as
 * OBSCURED, and a null `addressRevealAt` (invariant violation — OBSCURED
 * events always carry a reveal date) is treated as not-yet-revealed.
 */
export function redactLocation(input: RedactLocationInput): PublicLocation {
  const {
    mode,
    exact,
    radiusMeters,
    callerIsTicketHolder,
    addressRevealAt,
    now,
    eventId,
  } = input;
  const subject = eventCircleSubject({
    id: eventId,
    orgId: input.orgId,
    humanId: input.humanId,
    lat: exact.lat,
    lng: exact.lng,
    seriesId: input.seriesId,
  });

  // Full reveal: EXACT mode, or OBSCURED + ticket holder + reveal time passed.
  const revealed =
    mode === "EXACT" ||
    (callerIsTicketHolder &&
      addressRevealAt !== null &&
      now.getTime() >= addressRevealAt.getTime());

  if (revealed) {
    return {
      lat: exact.lat,
      lng: exact.lng,
      addressText: exact.addressText,
      locality: exact.locality,
      region: exact.region,
      countryCode: exact.countryCode,
      postalCode: exact.postalCode,
      locationLabel: exact.locationLabel,
      isExact: true,
    };
  }

  const areaLabel = exact.locationLabel ?? buildAreaLabel(exact);

  // The radius the circle is DRAWN at: the stored value snapped up to the
  // ladder. Above the top rung (or unusable) → fully hidden.
  const drawnRadius = snapObfuscationRadiusUp(radiusMeters);

  // Fully hidden: no public coordinates at all before the reveal.
  if (radiusMeters === null || drawnRadius === null) {
    return { areaLabel, isExact: false, hidden: true };
  }

  // Obfuscated circle: OBSCURED with a public precision radius. No key (or
  // no subject) means no circle — fully hidden, never the true point.
  const obfuscated = obfuscateCoordinate({
    lat: exact.lat,
    lng: exact.lng,
    radiusMeters: drawnRadius,
    scope: subject.scope,
    subjectId: subject.id,
  });
  if (!obfuscated) {
    return { areaLabel, isExact: false, hidden: true };
  }
  return {
    lat: obfuscated.lat,
    lng: obfuscated.lng,
    radiusMeters: drawnRadius,
    areaLabel,
    isExact: false,
    hidden: false,
  };
}
