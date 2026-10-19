import { describe, expect, it } from "vitest";

import {
  areaOutsideEnvelope,
  arrivalAreaFieldsSchema,
  arrivalAreaGeometrySchema,
  validateArrivalAreaGeometry,
  validateArrivalAreaShape,
} from "../geometry";
import {
  MAX_ARRIVAL_AREA_DISTANCE_METERS,
  MAX_ARRIVAL_AREA_POINTS,
  MAX_ARRIVAL_AREAS_PER_EVENT,
  MAX_ARRIVAL_AREAS_PER_PLACE,
} from "../limits";

const PIN = { lat: 36.1775, lng: -86.7412 };
/** ~111 m of latitude. */
const D = 0.001;

const square = (cx = PIN.lng, cy = PIN.lat, s = D) => ({
  type: "Polygon",
  coordinates: [
    [
      [cx, cy],
      [cx + s, cy],
      [cx + s, cy + s],
      [cx, cy + s],
      [cx, cy],
    ],
  ],
});

const line = {
  type: "LineString",
  coordinates: [
    [PIN.lng, PIN.lat],
    [PIN.lng + D, PIN.lat],
  ],
};

function errorCode(raw: unknown, pin: typeof PIN | null = PIN) {
  const result = validateArrivalAreaGeometry(raw, pin);
  return result.ok ? null : result.error;
}

describe("arrival-area limits", () => {
  it("are the ruled numbers (FR-005)", () => {
    expect(MAX_ARRIVAL_AREAS_PER_PLACE).toBe(10);
    expect(MAX_ARRIVAL_AREAS_PER_EVENT).toBe(10);
    expect(MAX_ARRIVAL_AREA_POINTS).toBe(200);
    expect(MAX_ARRIVAL_AREA_DISTANCE_METERS).toBe(3000);
  });
});

describe("validateArrivalAreaGeometry", () => {
  it("accepts a closed simple polygon near the pin", () => {
    const result = validateArrivalAreaGeometry(square(), PIN);
    expect(result).toEqual({ ok: true, geometry: square() });
  });

  it("accepts a street line near the pin", () => {
    expect(validateArrivalAreaGeometry(line, PIN).ok).toBe(true);
  });

  it("strips unknown keys from what it returns", () => {
    const result = validateArrivalAreaGeometry(
      { ...square(), properties: { evil: true }, bbox: [0, 0, 0, 0] },
      PIN,
    );
    expect(result.ok && result.geometry).toEqual(square());
  });

  it("INVALID_SHAPE: not a polygon or a line, a hole, or a 3D position", () => {
    expect(errorCode({ type: "Point", coordinates: [PIN.lng, PIN.lat] })).toEqual({
      code: "INVALID_SHAPE",
    });
    expect(errorCode(null)).toEqual({ code: "INVALID_SHAPE" });
    const withHole = square();
    withHole.coordinates.push(square(PIN.lng + D / 4, PIN.lat + D / 4, D / 4).coordinates[0]!);
    expect(errorCode(withHole)).toEqual({ code: "INVALID_SHAPE" });
    expect(
      errorCode({ type: "LineString", coordinates: [[PIN.lng, PIN.lat, 10], [PIN.lng + D, PIN.lat, 10]] }),
    ).toEqual({ code: "INVALID_SHAPE" });
  });

  it("NON_FINITE: NaN, Infinity, null or a string coordinate", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, "36.1"]) {
      expect(
        errorCode({ type: "LineString", coordinates: [[PIN.lng, PIN.lat], [bad, PIN.lat]] }),
      ).toEqual({ code: "NON_FINITE" });
    }
  });

  it("OUT_OF_RANGE: a longitude or latitude off the globe", () => {
    expect(
      errorCode({ type: "LineString", coordinates: [[PIN.lng, PIN.lat], [181, PIN.lat]] }),
    ).toEqual({ code: "OUT_OF_RANGE" });
    expect(
      errorCode({ type: "LineString", coordinates: [[PIN.lng, PIN.lat], [PIN.lng, -91]] }),
    ).toEqual({ code: "OUT_OF_RANGE" });
  });

  it("TOO_MANY_POINTS names the limit, counting a polygon's closing point", () => {
    // 200 positions stored, closing point included: allowed.
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < 199; i += 1) {
      const a = (2 * Math.PI * i) / 199;
      ring.push([PIN.lng + D * Math.cos(a), PIN.lat + D * Math.sin(a)]);
    }
    ring.push(ring[0]!);
    expect(ring).toHaveLength(200);
    expect(validateArrivalAreaGeometry({ type: "Polygon", coordinates: [ring] }, PIN).ok).toBe(true);

    const ring201: Array<[number, number]> = [];
    for (let i = 0; i < 200; i += 1) {
      const a = (2 * Math.PI * i) / 200;
      ring201.push([PIN.lng + D * Math.cos(a), PIN.lat + D * Math.sin(a)]);
    }
    ring201.push(ring201[0]!);
    expect(errorCode({ type: "Polygon", coordinates: [ring201] })).toEqual({
      code: "TOO_MANY_POINTS",
      limit: 200,
      count: 201,
    });

    const long = Array.from({ length: 201 }, (_, i) => [PIN.lng + i * 1e-5, PIN.lat]);
    expect(errorCode({ type: "LineString", coordinates: long })).toEqual({
      code: "TOO_MANY_POINTS",
      limit: 200,
      count: 201,
    });
  });

  it("TOO_MANY_POINTS is counted on the raw array, before any position is read", () => {
    // 10 000 junk entries: refused by count, not by the first bad entry.
    const junk = Array.from({ length: 10_000 }, () => "x");
    expect(errorCode({ type: "LineString", coordinates: junk })).toEqual({
      code: "TOO_MANY_POINTS",
      limit: 200,
      count: 10_000,
    });
    expect(errorCode({ type: "Polygon", coordinates: [junk] })).toEqual({
      code: "TOO_MANY_POINTS",
      limit: 200,
      count: 10_000,
    });
  });

  it("NOT_CLOSED: a ring whose last point is not its first", () => {
    const open = square();
    open.coordinates[0]!.pop();
    expect(errorCode(open)).toEqual({ code: "NOT_CLOSED" });
  });

  it("TOO_FEW_POINTS: under 3 distinct polygon corners, or a one-point line", () => {
    expect(
      errorCode({
        type: "Polygon",
        coordinates: [[[PIN.lng, PIN.lat], [PIN.lng + D, PIN.lat], [PIN.lng, PIN.lat]]],
      }),
    ).toEqual({ code: "TOO_FEW_POINTS", minimum: 3, count: 2 });
    expect(
      errorCode({ type: "LineString", coordinates: [[PIN.lng, PIN.lat]] }),
    ).toEqual({ code: "TOO_FEW_POINTS", minimum: 2, count: 1 });
  });

  it("SELF_INTERSECTING: a bow tie", () => {
    const bowTie = {
      type: "Polygon",
      coordinates: [
        [
          [PIN.lng, PIN.lat],
          [PIN.lng + D, PIN.lat + D],
          [PIN.lng + D, PIN.lat],
          [PIN.lng, PIN.lat + D],
          [PIN.lng, PIN.lat],
        ],
      ],
    };
    expect(errorCode(bowTie)).toEqual({ code: "SELF_INTERSECTING" });
  });

  it("SELF_INTERSECTING: a spike that doubles back on its own edge", () => {
    const spike = {
      type: "Polygon",
      coordinates: [
        [
          [PIN.lng, PIN.lat],
          [PIN.lng + D, PIN.lat],
          [PIN.lng + 2 * D, PIN.lat],
          [PIN.lng + D, PIN.lat],
          [PIN.lng + D, PIN.lat + D],
          [PIN.lng, PIN.lat],
        ],
      ],
    };
    expect(errorCode(spike)).toEqual({ code: "SELF_INTERSECTING" });
  });

  it("adjacent edges sharing a corner do not count as an intersection", () => {
    // A concave L: every corner is shared by two edges, nothing crosses.
    expect(errorCode(L_SHAPE)).toBeNull();
  });

  it("TOO_THIN: slivers and specks, naming both limits", () => {
    const tooThin = { code: "TOO_THIN", minAreaM2: 1, minMeanWidthM: 0.5 };
    // The reproduced sliver: ~1.8 km long, ~1 cm high.
    expect(
      errorCode(
        {
          type: "Polygon",
          coordinates: [[[-86.79, 36.16], [-86.77, 36.16], [-86.78, 36.1600001], [-86.79, 36.16]]],
        },
        { lat: 36.16, lng: -86.78 },
      ),
    ).toEqual(tooThin);
    // Thinner: 1e-9 and 1e-12 degrees, and a one-ulp apex.
    for (const dy of [1e-7, 1e-9, 1e-12]) {
      expect(
        errorCode({
          type: "Polygon",
          coordinates: [[[PIN.lng, PIN.lat], [PIN.lng + 10 * D, PIN.lat], [PIN.lng + 5 * D, PIN.lat + dy], [PIN.lng, PIN.lat]]],
        }),
      ).toEqual(tooThin);
    }
    const ulp = PIN.lat + Number.EPSILON * 64; // two ulps above 36.1775 (the ulp there is 32 × EPSILON)
    expect(ulp).toBeGreaterThan(PIN.lat);
    expect(
      errorCode({
        type: "Polygon",
        coordinates: [[[PIN.lng, PIN.lat], [PIN.lng + 10 * D, PIN.lat], [PIN.lng + 5 * D, ulp], [PIN.lng, PIN.lat]]],
      }),
    ).toEqual(tooThin);
    // A speck: 0.5 m square, under 1 m².
    const speck = 0.5 / 111_000;
    expect(errorCode(square(PIN.lng, PIN.lat, speck))).toEqual(tooThin);
  });

  it("a real strip of parallel parking (100 m × 2 m) is not too thin", () => {
    const len = 100 / (111_195 * Math.cos((PIN.lat * Math.PI) / 180));
    const wid = 2 / 111_195;
    expect(
      errorCode({
        type: "Polygon",
        coordinates: [[[PIN.lng, PIN.lat], [PIN.lng + len, PIN.lat], [PIN.lng + len, PIN.lat + wid], [PIN.lng, PIN.lat + wid], [PIN.lng, PIN.lat]]],
      }),
    ).toBeNull();
  });

  it("CROSSES_ANTIMERIDIAN: a shape spanning more than 180° of longitude", () => {
    const pin = { lat: -16.5, lng: 179.999 };
    expect(
      errorCode(
        {
          type: "Polygon",
          coordinates: [[[179.999, -16.5], [-179.999, -16.5], [-179.999, -16.499], [179.999, -16.499], [179.999, -16.5]]],
        },
        pin,
      ),
    ).toEqual({ code: "CROSSES_ANTIMERIDIAN" });
    expect(
      errorCode({ type: "LineString", coordinates: [[179.9995, -16.5], [-179.9995, -16.5]] }, pin),
    ).toEqual({ code: "CROSSES_ANTIMERIDIAN" });
    // Beside it but not across it: fine.
    expect(
      errorCode({ type: "LineString", coordinates: [[179.998, -16.5], [179.9995, -16.5]] }, pin),
    ).toBeNull();
  });

  it("ZERO_LENGTH: a line whose points coincide", () => {
    expect(
      errorCode({ type: "LineString", coordinates: [[PIN.lng, PIN.lat], [PIN.lng, PIN.lat]] }),
    ).toEqual({ code: "ZERO_LENGTH" });
  });

  it("OUTSIDE_ENVELOPE names the 3 km limit", () => {
    // ~3.3 km north.
    expect(errorCode(square(PIN.lng, PIN.lat + 0.03))).toEqual({
      code: "OUTSIDE_ENVELOPE",
      limitMeters: 3000,
    });
    // ~2.2 km north: inside.
    expect(errorCode(square(PIN.lng, PIN.lat + 0.02))).toBeNull();
  });

  it("NO_PIN: no usable pin is refused, never treated as no limit", () => {
    expect(errorCode(square(), null)).toEqual({ code: "NO_PIN" });
    expect(
      validateArrivalAreaGeometry(square(), { lat: Number.NaN, lng: 0 }),
    ).toEqual({ ok: false, error: { code: "NO_PIN" } });
  });

  it("a shape error wins over a missing pin (the shape is checked first)", () => {
    expect(errorCode({ type: "Point" }, null)).toEqual({ code: "INVALID_SHAPE" });
  });
});

/** An L: its centroid falls in the notch, outside the shape. */
const L_SHAPE = {
  type: "Polygon" as const,
  coordinates: [
    [
      [PIN.lng, PIN.lat],
      [PIN.lng + 10 * D, PIN.lat],
      [PIN.lng + 10 * D, PIN.lat + D],
      [PIN.lng + D, PIN.lat + D],
      [PIN.lng + D, PIN.lat + 10 * D],
      [PIN.lng, PIN.lat + 10 * D],
      [PIN.lng, PIN.lat],
    ] as Array<[number, number]>,
  ],
};

describe("arrivalAreaGeometrySchema", () => {
  it("parses a valid polygon and refuses a polygon with two rings", () => {
    expect(arrivalAreaGeometrySchema.safeParse(square()).success).toBe(true);
    const twoRings = square();
    twoRings.coordinates.push(twoRings.coordinates[0]!);
    expect(arrivalAreaGeometrySchema.safeParse(twoRings).success).toBe(false);
  });

  it("caps the ring and the line at 200 positions (a structural backstop)", () => {
    const line201 = Array.from({ length: 201 }, (_, i) => [i * 1e-5, 0]);
    expect(arrivalAreaGeometrySchema.safeParse({ type: "LineString", coordinates: line201 }).success).toBe(false);
    expect(
      arrivalAreaGeometrySchema.safeParse({ type: "LineString", coordinates: line201.slice(0, 200) }).success,
    ).toBe(true);
    expect(
      arrivalAreaGeometrySchema.safeParse({ type: "Polygon", coordinates: [line201] }).success,
    ).toBe(false);
  });

  it("refuses Infinity and out-of-range coordinates", () => {
    expect(
      arrivalAreaGeometrySchema.safeParse({
        type: "LineString",
        coordinates: [[Number.POSITIVE_INFINITY, 0], [0, 0]],
      }).success,
    ).toBe(false);
    expect(
      arrivalAreaGeometrySchema.safeParse({
        type: "LineString",
        coordinates: [[0, 95], [0, 0]],
      }).success,
    ).toBe(false);
  });
});

describe("validateArrivalAreaShape", () => {
  it("is the shape rules without the envelope", () => {
    expect(validateArrivalAreaShape(square(0, 0)).ok).toBe(true);
  });
});

describe("areaOutsideEnvelope (FR-014)", () => {
  it("is false for an area within 3 km of the pin", () => {
    expect(areaOutsideEnvelope({ geometry: square() }, PIN)).toBe(false);
  });

  it("is true once the pin has moved more than 3 km away", () => {
    expect(
      areaOutsideEnvelope({ geometry: square() }, { lat: PIN.lat + 0.05, lng: PIN.lng }),
    ).toBe(true);
  });

  it("flags a malformed stored shape or a missing pin instead of throwing", () => {
    expect(areaOutsideEnvelope({ geometry: { type: "Polygon", coordinates: "x" } }, PIN)).toBe(true);
    expect(areaOutsideEnvelope({ geometry: square() }, null)).toBe(true);
  });
});

describe("arrivalAreaFieldsSchema (FR-001)", () => {
  it("trims and sanitizes the label, defaults cost and spots, strips unknown keys", () => {
    const parsed = arrivalAreaFieldsSchema.parse({
      kind: "PARKING",
      label: "  <b>Lot B</b>  ",
      extra: "dropped",
    });
    expect(parsed).toEqual({
      kind: "PARKING",
      label: "Lot B",
      cost: "UNKNOWN",
      priceText: null,
      note: null,
      accessibleSpots: false,
    });
  });

  it("enforces label 1–80, price text ≤40, note ≤280", () => {
    expect(arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "   " }).success).toBe(false);
    expect(
      arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "x".repeat(80) }).success,
    ).toBe(true);
    expect(
      arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "L", priceText: "x".repeat(41) })
        .success,
    ).toBe(false);
    expect(
      arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "L", note: "x".repeat(281) })
        .success,
    ).toBe(false);
    expect(
      arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "L", note: "x".repeat(280) })
        .success,
    ).toBe(true);
  });

  it("refuses an unknown kind or cost", () => {
    expect(arrivalAreaFieldsSchema.safeParse({ kind: "VALET", label: "L" }).success).toBe(false);
    expect(
      arrivalAreaFieldsSchema.safeParse({ kind: "PARKING", label: "L", cost: "CHEAP" }).success,
    ).toBe(false);
  });
});
