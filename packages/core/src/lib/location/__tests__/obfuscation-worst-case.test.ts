import { describe, expect, it, vi } from "vitest";

/**
 * The IMPLEMENTATION at its worst case. `obfuscation-nesting.test.ts` proves
 * the geometry with hand-built aligned chains and samples the keyed draws;
 * here every keyed step is forced to full length along one bearing (the
 * uniforms are pinned), so `obfuscateCoordinate` itself produces the
 * farthest centre it can — and the true point must still be strictly inside
 * under every metric the read paths use.
 */
const pinned = vi.hoisted(() => ({ bearingFraction: 0 }));

vi.mock("../obfuscation-key", async (importOriginal) => {
  const original = await importOriginal<typeof import("../obfuscation-key")>();
  return {
    ...original,
    // u1 → 1: radial fraction √u1 → 1 (full step); u2: the pinned bearing.
    locationOffsetUniforms: () => ({
      u1: 1 - 2 ** -48,
      u2: pinned.bearingFraction,
    }),
  };
});

import { haversineDistance } from "../../geo/haversine";
import { OBFUSCATION_RADIUS_LADDER_METERS } from "../obfuscation-radius-ladder";
import { obfuscateCoordinate } from "../redact-location";

const M_PER_DEG = 111_320;

function planarMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dy = (b.lat - a.lat) * M_PER_DEG;
  const dx = (b.lng - a.lng) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

describe("obfuscateCoordinate at its worst case (every step full length, one bearing)", () => {
  it("stays within 0.99·r and strictly inside r (haversine), every rung, three latitudes", () => {
    for (const lat of [0, 45, 70]) {
      const P = { lat, lng: -86.7412 };
      for (let deg = 0; deg < 360; deg += 30) {
        pinned.bearingFraction = deg / 360;
        for (const rung of OBFUSCATION_RADIUS_LADDER_METERS) {
          const c = obfuscateCoordinate({
            ...P,
            radiusMeters: rung,
            scope: "place",
            subjectId: "worst-case",
          })!;
          // Sum of full steps = 0.99·(r₁ + Σ Δ) = 0.99·r (haversine's
          // 6,371 km sphere reads ~0.1 % short of the 111,320 m/° frame; the
          // 30 km top step adds up to ~0.2 % at 70°). A step drawn at full Δ
          // (no 0.99) would put r = 250 at 249 m and the top rung at r − 1 m
          // — both fail this bound.
          const d = haversineDistance(P.lat, P.lng, c.lat, c.lng);
          expect(d).toBeLessThanOrEqual(0.99 * rung * 1.0025);
          expect(d).toBeLessThan(rung);
          // The planar frame at P drifts with latitude (each step converts
          // at the chain's own latitude) but never reaches r.
          expect(planarMeters(P, c)).toBeLessThan(rung);
        }
      }
    }
  });
});
