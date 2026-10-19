import { describe, expect, it } from "vitest";

import {
  arrivalAreaDirectionsPoint,
  directionsPointForValidShape,
  poleOfInaccessibility,
} from "../directions-point";
import { haversineDistance } from "../../geo/haversine";

const PIN = { lat: 36.1775, lng: -86.7412 };
const D = 0.001;

/** Even-odd point-in-ring test on raw `[lng, lat]` positions. */
function inside(point: { lat: number; lng: number }, ring: Array<[number, number]>): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) {
      result = !result;
    }
  }
  return result;
}

/** An L whose area centroid falls in the notch, OUTSIDE the shape. */
const L_RING: Array<[number, number]> = [
  [PIN.lng, PIN.lat],
  [PIN.lng + 10 * D, PIN.lat],
  [PIN.lng + 10 * D, PIN.lat + D],
  [PIN.lng + D, PIN.lat + D],
  [PIN.lng + D, PIN.lat + 10 * D],
  [PIN.lng, PIN.lat + 10 * D],
  [PIN.lng, PIN.lat],
];

function centroid(ring: Array<[number, number]>) {
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    const f = x0 * y1 - x1 * y0;
    a += f;
    x += (x0 + x1) * f;
    y += (y0 + y1) * f;
  }
  return { lng: x / (3 * a), lat: y / (3 * a) };
}

describe("arrivalAreaDirectionsPoint", () => {
  it("puts an L-shaped lot's point INSIDE the lot, where its centroid is not", () => {
    // The premise: the centroid is outside.
    expect(inside(centroid(L_RING), L_RING)).toBe(false);

    const point = arrivalAreaDirectionsPoint({ type: "Polygon", coordinates: [L_RING] });
    expect(point).not.toBeNull();
    expect(inside(point!, L_RING)).toBe(true);
  });

  it("puts a square's point at its middle", () => {
    const ring: Array<[number, number]> = [
      [PIN.lng, PIN.lat],
      [PIN.lng + D, PIN.lat],
      [PIN.lng + D, PIN.lat + D],
      [PIN.lng, PIN.lat + D],
      [PIN.lng, PIN.lat],
    ];
    const point = arrivalAreaDirectionsPoint({ type: "Polygon", coordinates: [ring] })!;
    expect(inside(point, ring)).toBe(true);
    expect(
      haversineDistance(point.lat, point.lng, PIN.lat + D / 2, PIN.lng + D / 2),
    ).toBeLessThan(5);
  });

  it("puts a line's point halfway along its length, not at its middle vertex", () => {
    // Two legs: 100 units east then 300 units north (by length, east leg is
    // short). Halfway along the 400 is 100 units up the north leg.
    const line: Array<[number, number]> = [
      [PIN.lng, PIN.lat],
      [PIN.lng + D, PIN.lat],
      [PIN.lng + D, PIN.lat + 3 * D],
    ];
    const point = arrivalAreaDirectionsPoint({ type: "LineString", coordinates: line })!;
    const eastLeg = haversineDistance(PIN.lat, PIN.lng, PIN.lat, PIN.lng + D);
    const northLeg = haversineDistance(PIN.lat, PIN.lng + D, PIN.lat + 3 * D, PIN.lng + D);
    const half = (eastLeg + northLeg) / 2;
    expect(point.lng).toBeCloseTo(PIN.lng + D, 9);
    const along = eastLeg + haversineDistance(PIN.lat, PIN.lng + D, point.lat, point.lng);
    expect(Math.abs(along - half)).toBeLessThan(1);
  });

  it("puts a straight two-point line's point at its midpoint", () => {
    const point = arrivalAreaDirectionsPoint({
      type: "LineString",
      coordinates: [
        [PIN.lng, PIN.lat],
        [PIN.lng + 2 * D, PIN.lat],
      ],
    })!;
    expect(point.lng).toBeCloseTo(PIN.lng + D, 9);
    expect(point.lat).toBeCloseTo(PIN.lat, 9);
  });

  it("returns null, never throws, for a malformed stored shape", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      "Polygon",
      { type: "Polygon" },
      { type: "Polygon", coordinates: [[["a", "b"]]] },
      { type: "Polygon", coordinates: [[[0, 0], [1, 1], [1, 0]]] }, // not closed
      {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
      }, // bow tie
      { type: "LineString", coordinates: [[0, 0], [0, 0]] }, // zero length
      { type: "LineString", coordinates: [[Number.NaN, 0], [1, 1]] },
      { type: "MultiPolygon", coordinates: [] },
      { get type(): string { throw new Error("hostile getter"); } },
    ];
    for (const geometry of malformed) {
      expect(arrivalAreaDirectionsPoint(geometry)).toBeNull();
    }
  });
});

/** Wall time of one call, in ms. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("directionsPointForValidShape", () => {
  it("gives the same point as the validating path for a valid shape", () => {
    const geometry = { type: "Polygon" as const, coordinates: [L_RING] };
    expect(directionsPointForValidShape(geometry)).toEqual(
      arrivalAreaDirectionsPoint(geometry),
    );
  });
});

describe("the pole keeps a margin from the edges", () => {
  it("returns null when the best point is under 1 cm inside", () => {
    // A 1.5 cm square (metres plane): its pole is 0.75 cm from every edge.
    expect(
      poleOfInaccessibility([[0, 0], [0.015, 0], [0.015, 0.015], [0, 0.015], [0, 0]]),
    ).toBeNull();
    // A 1 m square: 50 cm inside.
    expect(
      poleOfInaccessibility([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
    ).not.toBeNull();
  });
});

describe("bounded work on every read (the sliver DoS)", () => {
  const BUDGET_MS = 500;

  it("the reproduced sliver and thinner ones return within budget, through the public path", () => {
    const slivers: unknown[] = [
      { type: "Polygon", coordinates: [[[-86.79, 36.16], [-86.77, 36.16], [-86.78, 36.1600001], [-86.79, 36.16]]] },
      ...[1e-7, 1e-9, 1e-12].map((dy) => ({
        type: "Polygon",
        coordinates: [[[PIN.lng, PIN.lat], [PIN.lng + 10 * D, PIN.lat], [PIN.lng + 5 * D, PIN.lat + dy], [PIN.lng, PIN.lat]]],
      })),
      // Near the equator, where a float `x += cellSize` once stopped advancing.
      { type: "Polygon", coordinates: [[[0.0001, 0.0001], [0.0201, 0.0001], [0.0101, 0.0001 + 1e-12], [0.0001, 0.0001]]] },
    ];
    for (const geometry of slivers) {
      const { value, ms } = timed(() => arrivalAreaDirectionsPoint(geometry));
      expect(value).toBeNull(); // refused as TOO_THIN before any search
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it("the search itself stays bounded on slivers validation would refuse", () => {
    // Raw planes, skipping validation: metres, and raw degrees at the equator.
    const planes: Array<Array<[number, number]>> = [
      [[0, 0], [1800, 0], [900, 0.011], [0, 0]],
      [[0, 0], [1800, 0], [900, 1e-7], [0, 0]],
      [[0, 0], [1800, 0], [900, 1e-12], [0, 0]],
      [[0, 0], [1800, 0], [900, Number.MIN_VALUE], [0, 0]],
      [[1e-4, 1e-4], [0.0201, 1e-4], [0.0101, 1e-4 + 1e-12], [1e-4, 1e-4]],
      [[100, 100], [100 + 1e-9, 100], [100, 100 + 1e-9], [100, 100]],
    ];
    for (const plane of planes) {
      const { ms } = timed(() => poleOfInaccessibility(plane));
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it("a 199-tooth comb (the point limit) is fast and its point is inside", () => {
    // Teeth 20 m wide and 200 m tall along a 30 m spine, in degrees.
    const m = 1 / 111_195;
    const k = Math.cos((PIN.lat * Math.PI) / 180);
    const ring: Array<[number, number]> = [];
    const teeth = 49; // 4 corners per tooth + the spine: 199 positions with the close
    for (let t = 0; t < teeth; t += 1) {
      const x0 = PIN.lng + (t * 40 * m) / k;
      const x1 = PIN.lng + (t * 40 + 20) * m / k;
      ring.push([x0, PIN.lat + 30 * m], [x0, PIN.lat + 230 * m], [x1, PIN.lat + 230 * m], [x1, PIN.lat + 30 * m]);
    }
    ring.push([PIN.lng + ((teeth * 40) * m) / k, PIN.lat + 30 * m]);
    ring.push([PIN.lng + ((teeth * 40) * m) / k, PIN.lat]);
    ring.push([PIN.lng, PIN.lat]);
    ring.push(ring[0]!);
    expect(ring).toHaveLength(200);
    const geometry = { type: "Polygon", coordinates: [ring] };
    const { value, ms } = timed(() => arrivalAreaDirectionsPoint(geometry));
    expect(value).not.toBeNull();
    expect(inside(value!, ring)).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
