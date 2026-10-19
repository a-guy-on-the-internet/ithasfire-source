import { describe, expect, it } from "vitest";

import { haversineDistance } from "../../geo/haversine";
import {
  MAX_OBFUSCATION_RADIUS_METERS,
  MIN_OBFUSCATION_RADIUS_METERS,
  OBFUSCATION_RADIUS_LADDER_METERS,
  isObfuscationLadderRadius,
  snapObfuscationRadiusUp,
  snapValidatedObfuscationRadius,
} from "../obfuscation-radius-ladder";
import {
  extendObfuscationCircle,
  obfuscateCoordinate,
  offsetPointByMeters,
} from "../redact-location";
import { redactPlaceLocation } from "../redact-place-location";

/**
 * M2 + B5 residual — every distinct circle used to be an independent sample
 * of the true point (any integer radius, per-radius uniform draws), and
 * independent samples intersect. These pin the replacement:
 *
 *   1. a fixed radius LADDER (write snaps up, read snaps up, never down);
 *   2. NESTED sampling along it — C(rᵢ₊₁) = C(rᵢ) + keyed step — so every
 *      circle contains P and any set of rungs reveals no more than the
 *      smallest;
 *   3. P strictly inside every circle under every metric the read paths use.
 */

const LADDER = OBFUSCATION_RADIUS_LADDER_METERS;
const TOP = MAX_OBFUSCATION_RADIUS_METERS;
const M_PER_DEG = 111_320;

type Point = { lat: number; lng: number };

// ── The four distance metrics in play ──────────────────────────────────────

/** Local planar metres AT `a` — the frame `obfuscateCoordinate` steps in. */
function planarMeters(a: Point, b: Point): number {
  const dy = (b.lat - a.lat) * M_PER_DEG;
  const dx = (b.lng - a.lng) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Core haversine (R = 6,371,000 m) — discovery / surprise-me distance. */
function haversine(a: Point, b: Point): number {
  return haversineDistance(a.lat, a.lng, b.lat, b.lng);
}

/** Postgres `earth_distance(ll_to_earth(...))` — a sphere of R = 6,378,168 m. */
function earthDistance(a: Point, b: Point): number {
  const R = 6_378_168;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dPhi = toRad(b.lat - a.lat);
  const dLam = toRad(b.lng - a.lng);
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** PostGIS geography `ST_Distance` / `ST_DWithin` — the WGS84 ellipsoid (Vincenty). */
function wgs84Meters(p1: Point, p2: Point): number {
  const a = 6_378_137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const toRad = (d: number) => (d * Math.PI) / 180;
  const L = toRad(p2.lng - p1.lng);
  const U1 = Math.atan((1 - f) * Math.tan(toRad(p1.lat)));
  const U2 = Math.atan((1 - f) * Math.tan(toRad(p2.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  for (let i = 0; i < 200; i += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C *
            sinSigma *
            (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }
  const uSq = (cosSqAlpha * (a ** 2 - b ** 2)) / b ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma ** 2) *
            (-3 + 4 * cos2SigmaM ** 2)));
  return b * A * (sigma - deltaSigma);
}

const METRICS: Array<[string, (a: Point, b: Point) => number]> = [
  ["planar", planarMeters],
  ["haversine", haversine],
  ["earth_distance", earthDistance],
  ["wgs84", wgs84Meters],
];

function expectStrictlyInside(p: Point, centre: Point, radius: number, label: string) {
  for (const [name, metric] of METRICS) {
    const d = metric(p, centre);
    if (!(d < radius)) {
      throw new Error(
        `${label}: ${name} distance ${d.toFixed(3)} m is not < ${radius} m`,
      );
    }
  }
}

function drawChain(p: Point, scope: "place" | "event-point", subjectId: string) {
  return LADDER.map((rung) => {
    const c = obfuscateCoordinate({ ...p, radiusMeters: rung, scope, subjectId });
    if (!c) throw new Error(`no circle at ${rung}`);
    return { rung, centre: c };
  });
}

// ── 1. The ladder ───────────────────────────────────────────────────────────

describe("the radius ladder", () => {
  it("is the nine ruled rungs, strictly ascending from MIN to MAX", () => {
    expect([...LADDER]).toEqual([
      100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
    ]);
    expect(LADDER[0]).toBe(MIN_OBFUSCATION_RADIUS_METERS);
    expect(LADDER[LADDER.length - 1]).toBe(TOP);
    for (let i = 1; i < LADDER.length; i += 1) {
      expect(LADDER[i]!).toBeGreaterThan(LADDER[i - 1]!);
    }
  });

  it("snaps UP to the next rung — never down", () => {
    expect(snapObfuscationRadiusUp(1)).toBe(100);
    expect(snapObfuscationRadiusUp(100)).toBe(100);
    expect(snapObfuscationRadiusUp(101)).toBe(250);
    expect(snapObfuscationRadiusUp(120)).toBe(250);
    expect(snapObfuscationRadiusUp(501)).toBe(1_000);
    expect(snapObfuscationRadiusUp(1_250)).toBe(2_000);
    expect(snapObfuscationRadiusUp(10_001)).toBe(20_000);
    expect(snapObfuscationRadiusUp(TOP)).toBe(TOP);
    for (let r = 1; r <= TOP; r += 37) {
      const snapped = snapObfuscationRadiusUp(r)!;
      expect(snapped).toBeGreaterThanOrEqual(r);
      expect(isObfuscationLadderRadius(snapped)).toBe(true);
    }
  });

  it("has no rung for a missing, non-positive, non-finite or above-top radius (fail closed → hidden)", () => {
    for (const bad of [null, undefined, 0, -5, Number.NaN, Infinity, TOP + 1]) {
      expect(snapObfuscationRadiusUp(bad as number | null | undefined)).toBeNull();
    }
    expect(() => snapValidatedObfuscationRadius(TOP + 1)).toThrow(RangeError);
    expect(snapValidatedObfuscationRadius(333)).toBe(500);
  });

  it("an off-ladder stored radius draws the NEXT rung's circle, and says so", () => {
    const P = { lat: 36.1775, lng: -86.7412 };
    const scope = "place" as const;
    const subjectId = "00000000-0000-4000-8000-0000000000a1";
    expect(obfuscateCoordinate({ ...P, radiusMeters: 120, scope, subjectId })).toEqual(
      obfuscateCoordinate({ ...P, radiusMeters: 250, scope, subjectId }),
    );
    const legacy = redactPlaceLocation({
      id: subjectId,
      locationMode: "OBSCURED",
      locationRadiusMeters: 120,
      ...P,
    });
    const rung = redactPlaceLocation({
      id: subjectId,
      locationMode: "OBSCURED",
      locationRadiusMeters: 250,
      ...P,
    });
    expect(legacy).toEqual(rung);
    expect(legacy.radiusMeters).toBe(250);
    // Above the top rung there is no circle at all.
    expect(
      redactPlaceLocation({
        id: subjectId,
        locationMode: "OBSCURED",
        locationRadiusMeters: TOP + 1,
        ...P,
      }),
    ).toMatchObject({ hidden: true, lat: null, lng: null, radiusMeters: null });
  });
});

// ── 2. Containment under every metric ───────────────────────────────────────

describe("the true point is STRICTLY inside every circle, under every metric", () => {
  const LATITUDES = [0, 45, 70];

  it("worst case: every step at full length along one bearing, to the TOP rung, at three latitudes", () => {
    for (const lat of LATITUDES) {
      const P = { lat, lng: -86.7412 };
      for (let deg = 0; deg < 360; deg += 15) {
        const bearing = (deg * Math.PI) / 180;
        let centre = offsetPointByMeters(P, 0.99 * LADDER[0]!, bearing);
        expectStrictlyInside(P, centre, LADDER[0]!, `lat ${lat} bearing ${deg} r ${LADDER[0]}`);
        for (let i = 1; i < LADDER.length; i += 1) {
          centre = offsetPointByMeters(
            centre,
            0.99 * (LADDER[i]! - LADDER[i - 1]!),
            bearing,
          );
          expectStrictlyInside(P, centre, LADDER[i]!, `lat ${lat} bearing ${deg} r ${LADDER[i]}`);
        }
        // And with margin to spare at the top: ≥ 0.4 % under the worst metric.
        const worst = Math.max(...METRICS.map(([, m]) => m(P, centre)));
        expect(worst / TOP).toBeLessThan(0.996);
      }
    }
  });

  it("keyed draws: 300 subjects × every rung × three latitudes", () => {
    for (const lat of LATITUDES) {
      const P = { lat, lng: 12.5 };
      for (let s = 0; s < 300; s += 1) {
        const subjectId = `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;
        for (const { rung, centre } of drawChain(P, "place", subjectId)) {
          expectStrictlyInside(P, centre, rung, `lat ${lat} subject ${s} r ${rung}`);
        }
      }
    }
  });
});

// ── 3. Nesting: more rungs reveal nothing beyond the smallest ───────────────

describe("NESTED sampling — any set of rungs reveals no more than the smallest", () => {
  const P = { lat: 36.1775, lng: -86.7412 };

  it("CONSTRUCTIVE: C(rⱼ) is a function of C(rᵢ) and the key alone — `extendObfuscationCircle` takes no true point", () => {
    for (let s = 0; s < 10; s += 1) {
      const subjectId = `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;
      const chain = drawChain(P, "place", subjectId);
      for (let i = 0; i < chain.length; i += 1) {
        for (let j = i; j < chain.length; j += 1) {
          expect(
            extendObfuscationCircle({
              centre: chain[i]!.centre,
              fromRadiusMeters: chain[i]!.rung,
              toRadiusMeters: chain[j]!.rung,
              scope: "place",
              subjectId,
            }),
          ).toEqual(chain[j]!.centre);
        }
      }
    }
  });

  it("the steps are the SAME for any true point: C(rⱼ) − C(rᵢ), in metres, does not depend on P", () => {
    const subjectId = "00000000-0000-4000-8000-0000000000a1";
    const stepsFrom = (p: Point) => {
      const chain = drawChain(p, "place", subjectId);
      const steps: Array<{ dx: number; dy: number }> = [];
      let previous: Point = p;
      for (const { centre } of chain) {
        steps.push({
          dy: (centre.lat - previous.lat) * M_PER_DEG,
          dx:
            (centre.lng - previous.lng) *
            M_PER_DEG *
            Math.cos((previous.lat * Math.PI) / 180),
        });
        previous = centre;
      }
      return steps;
    };
    const nashville = stepsFrom(P);
    const oslo = stepsFrom({ lat: 59.9139, lng: 10.7522 });
    expect(oslo).toHaveLength(nashville.length);
    for (let i = 0; i < nashville.length; i += 1) {
      expect(oslo[i]!.dx).toBeCloseTo(nashville[i]!.dx, 5);
      expect(oslo[i]!.dy).toBeCloseTo(nashville[i]!.dy, 5);
    }
  });

  it("STATISTICAL: across subjects, C(rⱼ) − C(r₁) is uncorrelated with C(r₁) − P", () => {
    const n = 2_000;
    const j = LADDER.indexOf(5_000);
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    const pairs: Array<[number, number]> = [];
    for (let s = 0; s < n; s += 1) {
      const subjectId = `stat-${s}`;
      const c1 = obfuscateCoordinate({ ...P, radiusMeters: LADDER[0]!, scope: "place", subjectId })!;
      const cj = obfuscateCoordinate({ ...P, radiusMeters: LADDER[j]!, scope: "place", subjectId })!;
      // East components, metres.
      const inner = (c1.lng - P.lng) * M_PER_DEG * Math.cos((P.lat * Math.PI) / 180);
      const outer = (cj.lng - c1.lng) * M_PER_DEG * Math.cos((c1.lat * Math.PI) / 180);
      pairs.push([inner, outer]);
    }
    const mean = (k: 0 | 1) => pairs.reduce((acc, p) => acc + p[k], 0) / n;
    const mx = mean(0);
    const my = mean(1);
    for (const [x, y] of pairs) {
      sxx += (x - mx) ** 2;
      syy += (y - my) ** 2;
      sxy += (x - mx) * (y - my);
    }
    const correlation = sxy / Math.sqrt(sxx * syy);
    // Independent ⇒ |r| ~ 1/√n ≈ 0.022; 0.08 is ~3.6σ.
    expect(Math.abs(correlation)).toBeLessThan(0.08);
  });

  it("every circle of one subject contains P, for ANY set of rungs", () => {
    const chain = drawChain(P, "place", "00000000-0000-4000-8000-0000000000a1");
    for (const { rung, centre } of chain) {
      expectStrictlyInside(P, centre, rung, `r ${rung}`);
    }
    // And they are distinct circles — nesting is not "one point for all".
    expect(new Set(chain.map(({ centre }) => `${centre.lat},${centre.lng}`)).size).toBe(
      LADDER.length,
    );
  });

  it("rejects a bad rung pair rather than inventing one", () => {
    const centre = { lat: 1, lng: 1 };
    const base = { centre, scope: "place" as const, subjectId: "s" };
    expect(extendObfuscationCircle({ ...base, fromRadiusMeters: 120, toRadiusMeters: 500 })).toBeNull();
    expect(extendObfuscationCircle({ ...base, fromRadiusMeters: 500, toRadiusMeters: 400 })).toBeNull();
    expect(extendObfuscationCircle({ ...base, fromRadiusMeters: 500, toRadiusMeters: 500 })).toEqual(centre);
  });
});

// ── 4. Ring steps and spread (the 2026-09-25 geometry ruling) ───────────────

describe("RING steps after the first: full length, keyed direction", () => {
  const P = { lat: 36.1775, lng: -86.7412 };

  it("every step after the innermost is EXACTLY 0.99·(rᵢ₊₁ − rᵢ) long (in the frame of its start)", () => {
    for (let s = 0; s < 50; s += 1) {
      const chain = drawChain(P, "place", `ring-${s}`);
      for (let i = 1; i < chain.length; i += 1) {
        const from = chain[i - 1]!.centre;
        const to = chain[i]!.centre;
        const length = planarMeters(from, to);
        const expected = 0.99 * (chain[i]!.rung - chain[i - 1]!.rung);
        expect(Math.abs(length - expected) / expected).toBeLessThan(1e-9);
      }
    }
  });

  it("SPREAD: the RMS offset of C(r) from P is ≥ 0.55·r at every rung (the old 39-rung disc chain gave ~0.19·r at 5 km)", () => {
    const n = 3_000;
    for (const rung of LADDER) {
      let sumSquares = 0;
      for (let s = 0; s < n; s += 1) {
        const c = obfuscateCoordinate({
          ...P,
          radiusMeters: rung,
          scope: "place",
          subjectId: `spread-${s}`,
        })!;
        sumSquares += haversine(P, c) ** 2;
      }
      const rms = Math.sqrt(sumSquares / n);
      expect(rms / rung).toBeGreaterThanOrEqual(0.55);
      expect(rms / rung).toBeLessThan(0.99);
    }
  });

  it("the ring HOLE is where the geometry says and no bigger: 0.99·(r − 2·r_prev) at 250 / 5,000 / 50,000 m, none elsewhere", () => {
    const n = 3_000;
    for (let i = 1; i < LADDER.length; i += 1) {
      const rung = LADDER[i]!;
      const hole = Math.max(0, 0.99 * (rung - 2 * LADDER[i - 1]!));
      let nearest = Infinity;
      for (let s = 0; s < n; s += 1) {
        const c = obfuscateCoordinate({
          ...P,
          radiusMeters: rung,
          scope: "place",
          subjectId: `hole-${s}`,
        })!;
        nearest = Math.min(nearest, planarMeters(P, c));
      }
      // Never inside the hole (planar ≈ the stepping frame; 0.5 % slack)…
      expect(nearest).toBeGreaterThanOrEqual(hole * 0.995);
      // …and draws do reach close to it: the hole is not wider than stated.
      expect(nearest).toBeLessThan(hole + 0.1 * rung);
    }
  });
});
