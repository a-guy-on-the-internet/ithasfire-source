import { z } from "zod";

import type {
  ArrivalAreaGeometry,
  ArrivalAreaPosition,
} from "@th/types/repos/arrival-areas";

import { haversineDistance } from "../geo/haversine";
import {
  plainTextMultilineOptional,
  plainTextOptional,
  plainTextRequired,
} from "../sanitize-plain-text";
import {
  ARRIVAL_AREA_LABEL_MAX,
  ARRIVAL_AREA_NOTE_MAX,
  ARRIVAL_AREA_PRICE_TEXT_MAX,
  MAX_ARRIVAL_AREA_DISTANCE_METERS,
  MAX_ARRIVAL_AREA_POINTS,
  MIN_ARRIVAL_AREA_POLYGON_AREA_M2,
  MIN_ARRIVAL_AREA_POLYGON_MEAN_WIDTH_M,
} from "./limits";

// ─────────────────────────────────────────────────────────────────────────────
// Arrival-area geometry and fields (arrival-areas spec FR-001, FR-005).
//
// A shape is a GeoJSON Polygon (a lot) or LineString (street parking), with
// positions in RFC 7946 order, `[lng, lat]`. v1 polygons have ONE ring: no
// holes (a lot with an island is drawn as its outline). Pure: no repos, no
// clock. NFR-002: nothing here logs, and nothing that calls it may log a
// shape or a point either.
// ─────────────────────────────────────────────────────────────────────────────

// ── Zod schemas (structure and ranges) ──────────────────────────────────────

/**
 * `[lng, lat]`. Zod 4's `z.number()` already refuses NaN and ±Infinity.
 * Exactly two members: an altitude is not accepted.
 */
export const arrivalAreaPositionSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

/**
 * One ring only (no holes in v1). Unknown keys are stripped. The `.max` here
 * is a structural backstop and fails as a generic zod error; callers that
 * need the named `TOO_MANY_POINTS` use {@link validateArrivalAreaGeometry}.
 */
export const arrivalAreaPolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z
    .array(z.array(arrivalAreaPositionSchema).max(MAX_ARRIVAL_AREA_POINTS))
    .length(1),
});

export const arrivalAreaLineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(arrivalAreaPositionSchema).max(MAX_ARRIVAL_AREA_POINTS),
});

/**
 * The stored shape's structure. Structure only: the FR-005 rules (point
 * count, closed ring, self-intersection, 3 km envelope) are
 * {@link validateArrivalAreaGeometry}'s, so their errors can name the limit.
 */
export const arrivalAreaGeometrySchema = z.discriminatedUnion("type", [
  arrivalAreaPolygonSchema,
  arrivalAreaLineStringSchema,
]);

export const arrivalAreaKindSchema = z.enum([
  "PARKING",
  "ACCESSIBLE_DROP_OFF",
  "LOAD_IN",
]);

export const arrivalAreaCostSchema = z.enum(["FREE", "PAID", "UNKNOWN"]);

/** An optional free-text field whose cleaned empty value is stored as null. */
const emptyToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.length === 0 ? null : value;

/**
 * The editable fields of an area (FR-001), sanitized BEFORE the length checks
 * (`plainText*`). Unknown keys are stripped. Geometry is validated separately
 * ({@link validateArrivalAreaGeometry}) because its rules need the pin.
 */
export const arrivalAreaFieldsSchema = z.object({
  kind: arrivalAreaKindSchema,
  label: plainTextRequired(ARRIVAL_AREA_LABEL_MAX),
  cost: arrivalAreaCostSchema.default("UNKNOWN"),
  priceText: plainTextOptional(ARRIVAL_AREA_PRICE_TEXT_MAX)
    .nullable()
    .optional()
    .transform(emptyToNull),
  note: plainTextMultilineOptional(ARRIVAL_AREA_NOTE_MAX)
    .nullable()
    .optional()
    .transform(emptyToNull),
  accessibleSpots: z.boolean().default(false),
});

export type ArrivalAreaFields = z.infer<typeof arrivalAreaFieldsSchema>;

// ── Validation (FR-005) ─────────────────────────────────────────────────────

/** A pin to measure the envelope from. */
export interface ArrivalAreaPin {
  lat: number;
  lng: number;
}

/**
 * Why a shape was refused. Each names the rule it broke and, where there is
 * one, the limit, so the editor can say "which limit it hit".
 */
export type ArrivalAreaGeometryError =
  /** Not a Polygon or LineString, a polygon with other than one ring, or positions that are not pairs. */
  | { code: "INVALID_SHAPE" }
  /** A coordinate that is not a finite number. */
  | { code: "NON_FINITE" }
  /** A longitude outside [-180, 180] or a latitude outside [-90, 90]. */
  | { code: "OUT_OF_RANGE" }
  | { code: "TOO_MANY_POINTS"; limit: number; count: number }
  /** A polygon with fewer than 3 distinct corners, or a line with fewer than 2 points. */
  | { code: "TOO_FEW_POINTS"; minimum: number; count: number }
  /** A polygon ring whose last position is not its first. */
  | { code: "NOT_CLOSED" }
  | { code: "SELF_INTERSECTING" }
  /**
   * A polygon too small or too thin to be a place to park: ground area under
   * `minAreaM2`, or mean width (`2 × area / perimeter`) under `minMeanWidthM`.
   */
  | { code: "TOO_THIN"; minAreaM2: number; minMeanWidthM: number }
  /** Positions spanning more than 180° of longitude: across the antimeridian. */
  | { code: "CROSSES_ANTIMERIDIAN" }
  /** A line whose points all coincide. */
  | { code: "ZERO_LENGTH" }
  /** A position farther than `limitMeters` from the pin. */
  | { code: "OUTSIDE_ENVELOPE"; limitMeters: number }
  /** No usable pin to measure the envelope from: refused, never assumed. */
  | { code: "NO_PIN" };

export type ArrivalAreaGeometryErrorCode = ArrivalAreaGeometryError["code"];

export type ArrivalAreaGeometryResult =
  | { ok: true; geometry: ArrivalAreaGeometry }
  | { ok: false; error: ArrivalAreaGeometryError };

const fail = (error: ArrivalAreaGeometryError): ArrivalAreaGeometryResult => ({
  ok: false,
  error,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Positions of a raw list, or an error. Separates "not a number at all /
 * not finite" (NON_FINITE) from "a finite number off the globe"
 * (OUT_OF_RANGE), which the zod schema would fold into one parse error.
 */
function readPositions(
  raw: unknown,
): { ok: true; positions: ArrivalAreaPosition[] } | { ok: false; error: ArrivalAreaGeometryError } {
  if (!Array.isArray(raw)) return { ok: false, error: { code: "INVALID_SHAPE" } };
  const positions: ArrivalAreaPosition[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) {
      return { ok: false, error: { code: "INVALID_SHAPE" } };
    }
    const [lng, lat] = item as unknown[];
    if (
      typeof lng !== "number" ||
      typeof lat !== "number" ||
      !Number.isFinite(lng) ||
      !Number.isFinite(lat)
    ) {
      return { ok: false, error: { code: "NON_FINITE" } };
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return { ok: false, error: { code: "OUT_OF_RANGE" } };
    }
    positions.push([lng, lat]);
  }
  return { ok: true, positions };
}

const samePosition = (a: ArrivalAreaPosition, b: ArrivalAreaPosition): boolean =>
  a[0] === b[0] && a[1] === b[1];

/** Drops consecutive repeats (a double tap in the editor), keeping order. */
function withoutConsecutiveRepeats(
  positions: readonly ArrivalAreaPosition[],
): ArrivalAreaPosition[] {
  const out: ArrivalAreaPosition[] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (!last || !samePosition(last, p)) out.push(p);
  }
  return out;
}

function cross(
  o: ArrivalAreaPosition,
  a: ArrivalAreaPosition,
  b: ArrivalAreaPosition,
): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onSegment(
  p: ArrivalAreaPosition,
  q: ArrivalAreaPosition,
  r: ArrivalAreaPosition,
): boolean {
  // `q` is collinear with p–r; is it inside their bounding box?
  return (
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1])
  );
}

/** Whether segments p1–p2 and p3–p4 touch at all (endpoints included). */
function segmentsIntersect(
  p1: ArrivalAreaPosition,
  p2: ArrivalAreaPosition,
  p3: ArrivalAreaPosition,
  p4: ArrivalAreaPosition,
): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p1, p4)) return true;
  if (d2 === 0 && onSegment(p3, p2, p4)) return true;
  if (d3 === 0 && onSegment(p1, p3, p2)) return true;
  if (d4 === 0 && onSegment(p1, p4, p2)) return true;
  return false;
}

/**
 * Whether a CLOSED ring (first === last, no consecutive repeats) crosses or
 * touches itself. Every pair of non-adjacent edges is tested (O(n²), fine at
 * 200 points). Adjacent edges share an endpoint by construction, which does
 * not count; an adjacent pair that doubles back along itself (a spike,
 * A→B→A) does.
 */
export function ringSelfIntersects(ring: readonly ArrivalAreaPosition[]): boolean {
  const edges = ring.length - 1;
  for (let i = 0; i < edges; i += 1) {
    for (let j = i + 1; j < edges; j += 1) {
      const adjacent = j === i + 1 || (i === 0 && j === edges - 1);
      const a1 = ring[i]!;
      const a2 = ring[i + 1]!;
      const b1 = ring[j]!;
      const b2 = ring[j + 1]!;
      if (adjacent) {
        // Shared corner and the two far ends.
        const shared = j === i + 1 ? a2 : a1;
        const farA = j === i + 1 ? a1 : a2;
        const farB = j === i + 1 ? b2 : b1;
        const turn = cross(shared, farA, farB);
        const dot =
          (farA[0] - shared[0]) * (farB[0] - shared[0]) +
          (farA[1] - shared[1]) * (farB[1] - shared[1]);
        if (turn === 0 && dot > 0) return true;
        continue;
      }
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

const METERS_PER_DEGREE = (Math.PI * 6_371_000) / 180;

/**
 * A ring or line on a local plane in METRES around its first position
 * (equirectangular at the shape's mean latitude): square on the ground at the
 * few-km scale an area lives at, and small numbers, so nothing is lost to a
 * large longitude. Null when the projection is unusable (at a pole, or a
 * non-finite input). Valid shapes never cross the antimeridian (refused as
 * `CROSSES_ANTIMERIDIAN`), so a plain longitude difference is right.
 */
export function localPlaneMeters(positions: readonly ArrivalAreaPosition[]): {
  points: Array<[number, number]>;
  toLngLat(point: readonly [number, number]): { lng: number; lat: number };
} | null {
  const origin = positions[0];
  if (!origin) return null;
  const meanLat = positions.reduce((sum, p) => sum + p[1], 0) / positions.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  if (!(k > 1e-9) || !Number.isFinite(k)) return null;
  const [lng0, lat0] = origin;
  const points = positions.map(
    ([lng, lat]): [number, number] => [
      (lng - lng0) * k * METERS_PER_DEGREE,
      (lat - lat0) * METERS_PER_DEGREE,
    ],
  );
  if (!points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
    return null;
  }
  return {
    points,
    toLngLat: ([x, y]) => ({
      lng: lng0 + x / (k * METERS_PER_DEGREE),
      lat: lat0 + y / METERS_PER_DEGREE,
    }),
  };
}

/** Whether a polygon ring is too small or thin to be a place (TOO_THIN). */
function ringTooThin(ring: readonly ArrivalAreaPosition[]): boolean {
  const plane = localPlaneMeters(ring);
  if (!plane) return true;
  const pts = plane.points;
  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    twiceArea += a[0] * b[1] - b[0] * a[1];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const area = Math.abs(twiceArea) / 2;
  if (!(area >= MIN_ARRIVAL_AREA_POLYGON_AREA_M2)) return true;
  if (!(perimeter > 0)) return true;
  return (2 * area) / perimeter < MIN_ARRIVAL_AREA_POLYGON_MEAN_WIDTH_M;
}

/** Whether positions span more than 180° of longitude. */
function crossesAntimeridian(positions: readonly ArrivalAreaPosition[]): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (const [lng] of positions) {
    min = Math.min(min, lng);
    max = Math.max(max, lng);
  }
  return max - min > 180;
}

/** `TOO_MANY_POINTS` with the raw count when a raw array is over the limit. */
function rawCountOverLimit(raw: unknown): ArrivalAreaGeometryError | null {
  return Array.isArray(raw) && raw.length > MAX_ARRIVAL_AREA_POINTS
    ? { code: "TOO_MANY_POINTS", limit: MAX_ARRIVAL_AREA_POINTS, count: raw.length }
    : null;
}

/** Length of a line in metres, along the ground. */
export function lineLengthMeters(positions: readonly ArrivalAreaPosition[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i += 1) {
    const a = positions[i - 1]!;
    const b = positions[i]!;
    total += haversineDistance(a[1], a[0], b[1], b[0]);
  }
  return total;
}

/**
 * The shape rules, without the envelope: structure, finite in-range
 * coordinates, the point limit, no antimeridian crossing, a closed simple
 * ring with 3+ distinct corners that is not a sliver, a line with length. Shared by save-time validation and by the
 * read side, which uses it to refuse a malformed stored row (written by SQL
 * or a seed) instead of drawing it.
 */
export function validateArrivalAreaShape(raw: unknown): ArrivalAreaGeometryResult {
  if (!isRecord(raw)) return fail({ code: "INVALID_SHAPE" });

  if (raw.type === "Polygon") {
    if (!Array.isArray(raw.coordinates) || raw.coordinates.length !== 1) {
      return fail({ code: "INVALID_SHAPE" });
    }
    // Count BEFORE reading: a huge raw array is refused without walking it.
    const tooMany = rawCountOverLimit(raw.coordinates[0]);
    if (tooMany) return fail(tooMany);
    const read = readPositions(raw.coordinates[0]);
    if (!read.ok) return fail(read.error);
    const ring = read.positions;
    if (ring.length > MAX_ARRIVAL_AREA_POINTS) {
      return fail({
        code: "TOO_MANY_POINTS",
        limit: MAX_ARRIVAL_AREA_POINTS,
        count: ring.length,
      });
    }
    if (crossesAntimeridian(ring)) return fail({ code: "CROSSES_ANTIMERIDIAN" });
    // Too few corners is the more useful message, so it is checked first.
    const distinct = new Set(ring.map((p) => `${p[0]},${p[1]}`)).size;
    if (distinct < 3) {
      return fail({ code: "TOO_FEW_POINTS", minimum: 3, count: distinct });
    }
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (!samePosition(first, last)) return fail({ code: "NOT_CLOSED" });
    if (ringSelfIntersects(withoutConsecutiveRepeats(ring))) {
      return fail({ code: "SELF_INTERSECTING" });
    }
    if (ringTooThin(ring)) {
      return fail({
        code: "TOO_THIN",
        minAreaM2: MIN_ARRIVAL_AREA_POLYGON_AREA_M2,
        minMeanWidthM: MIN_ARRIVAL_AREA_POLYGON_MEAN_WIDTH_M,
      });
    }
    return { ok: true, geometry: { type: "Polygon", coordinates: [ring] } };
  }

  if (raw.type === "LineString") {
    const tooMany = rawCountOverLimit(raw.coordinates);
    if (tooMany) return fail(tooMany);
    const read = readPositions(raw.coordinates);
    if (!read.ok) return fail(read.error);
    const line = read.positions;
    if (line.length > MAX_ARRIVAL_AREA_POINTS) {
      return fail({
        code: "TOO_MANY_POINTS",
        limit: MAX_ARRIVAL_AREA_POINTS,
        count: line.length,
      });
    }
    if (line.length < 2) {
      return fail({ code: "TOO_FEW_POINTS", minimum: 2, count: line.length });
    }
    if (crossesAntimeridian(line)) return fail({ code: "CROSSES_ANTIMERIDIAN" });
    if (!(lineLengthMeters(line) > 0)) return fail({ code: "ZERO_LENGTH" });
    return { ok: true, geometry: { type: "LineString", coordinates: line } };
  }

  return fail({ code: "INVALID_SHAPE" });
}

/** Every position of a valid shape (a polygon's closing point included). */
export function arrivalAreaPositions(
  geometry: ArrivalAreaGeometry,
): ArrivalAreaPosition[] {
  return geometry.type === "Polygon"
    ? [...(geometry.coordinates[0] ?? [])]
    : [...geometry.coordinates];
}

function usablePin(pin: ArrivalAreaPin | null | undefined): pin is ArrivalAreaPin {
  return (
    !!pin &&
    typeof pin.lat === "number" &&
    typeof pin.lng === "number" &&
    Number.isFinite(pin.lat) &&
    Number.isFinite(pin.lng)
  );
}

function withinEnvelope(geometry: ArrivalAreaGeometry, pin: ArrivalAreaPin): boolean {
  return arrivalAreaPositions(geometry).every(
    ([lng, lat]) =>
      haversineDistance(pin.lat, pin.lng, lat, lng) <=
      MAX_ARRIVAL_AREA_DISTANCE_METERS,
  );
}

/**
 * FR-005, the save-time gate: {@link validateArrivalAreaShape} plus "every
 * position within 3 km of `pin`" (the place pin for a place area, the event
 * pin for an event-only area). No usable pin → `NO_PIN`, never "no limit".
 */
export function validateArrivalAreaGeometry(
  raw: unknown,
  pin: ArrivalAreaPin | null | undefined,
): ArrivalAreaGeometryResult {
  const shape = validateArrivalAreaShape(raw);
  if (!shape.ok) return shape;
  if (!usablePin(pin)) return fail({ code: "NO_PIN" });
  if (!withinEnvelope(shape.geometry, pin)) {
    return fail({
      code: "OUTSIDE_ENVELOPE",
      limitMeters: MAX_ARRIVAL_AREA_DISTANCE_METERS,
    });
  }
  return shape;
}

/**
 * FR-014: whether a STORED area needs the manager's attention after the pin
 * moved: any position beyond 3 km of `pin`. A shape that no longer passes
 * the shape rules, or a missing pin, is flagged too (it cannot be shown to
 * be inside). Never throws.
 */
export function areaOutsideEnvelope(
  area: { geometry: unknown },
  pin: ArrivalAreaPin | null | undefined,
): boolean {
  try {
    const shape = validateArrivalAreaShape(area.geometry);
    if (!shape.ok || !usablePin(pin)) return true;
    return !withinEnvelope(shape.geometry, pin);
  } catch {
    return true;
  }
}
