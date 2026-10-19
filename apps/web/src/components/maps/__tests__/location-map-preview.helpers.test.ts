import { describe, expect, it } from "vitest";

import type { LatLngLiteral } from "@/config/maps";
import {
  buildCircleGeoJson,
  jitterCenter,
  resolveDisplayCenter,
} from "../location-map-preview.helpers";

/** Haversine distance in metres between two points. */
function distanceMetres(a: LatLngLiteral, b: LatLngLiteral): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const POSITION: LatLngLiteral = { lat: 40.7484, lng: -73.9856 };
const RADIUS = 800;

describe("resolveDisplayCenter — circle-containment invariant", () => {
  it("uses the server-obfuscated point EXACTLY when preObfuscated (no double offset)", () => {
    const center = resolveDisplayCenter({
      position: POSITION,
      isExact: false,
      preObfuscated: true,
      radiusMetres: RADIUS,
    });

    // Byte-identical passthrough: the server already offset this point up to
    // 70 % of the radius; any further client jitter could push the real
    // venue outside the drawn circle.
    expect(center).toEqual(POSITION);
    expect(center.lat).toBe(POSITION.lat);
    expect(center.lng).toBe(POSITION.lng);
  });

  it("uses the true position for exact locations", () => {
    const center = resolveDisplayCenter({
      position: POSITION,
      isExact: true,
      preObfuscated: false,
      radiusMetres: RADIUS,
    });

    expect(center).toEqual(POSITION);
  });

  it("jitters TRUE coordinates (admin preview: approximate + not preObfuscated)", () => {
    const center = resolveDisplayCenter({
      position: POSITION,
      isExact: false,
      preObfuscated: false,
      radiusMetres: RADIUS,
    });

    // Offset — the drawn centre must not reveal the real pin …
    expect(center).not.toEqual(POSITION);
    // … but bounded to ≤ 33 % of the radius so the pin stays well inside
    // the circle (small tolerance for the planar-approximation math).
    const offset = distanceMetres(POSITION, center);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(RADIUS * 0.33 * 1.01);
  });

  it("jitter is deterministic for the same coordinates", () => {
    const a = jitterCenter(POSITION, RADIUS);
    const b = jitterCenter({ ...POSITION }, RADIUS);
    expect(a).toEqual(b);
  });
});

describe("buildCircleGeoJson — radius drawn unscaled", () => {
  it("generates a closed 64-segment polygon", () => {
    const feature = buildCircleGeoJson(POSITION, RADIUS);
    const ring = feature.geometry.coordinates[0]!;

    expect(feature.geometry.type).toBe("Polygon");
    expect(ring).toHaveLength(65); // 64 segments + closing point
    expect(ring[0]).toEqual(ring[64]); // closed ring
  });

  it("ring points sit ≈ radiusMeters from the centre (no scaling)", () => {
    const feature = buildCircleGeoJson(POSITION, RADIUS);
    const ring = feature.geometry.coordinates[0]!;

    // Spot-check points around the ring (E, N, W, S and diagonals).
    for (const i of [0, 8, 16, 24, 32, 40, 48, 56]) {
      const [lng, lat] = ring[i]!;
      const d = distanceMetres(POSITION, { lat, lng });
      // Planar metres→degrees conversion is approximate; 1 % is far tighter
      // than any accidental 2×/0.5× scaling bug.
      expect(d).toBeGreaterThan(RADIUS * 0.99);
      expect(d).toBeLessThan(RADIUS * 1.01);
    }
  });

  it("derives the ring from the given radius (different radius → proportional ring)", () => {
    const small = buildCircleGeoJson(POSITION, 200);
    const [lng, lat] = small.geometry.coordinates[0]![0]!;
    const d = distanceMetres(POSITION, { lat, lng });
    expect(d).toBeGreaterThan(200 * 0.99);
    expect(d).toBeLessThan(200 * 1.01);
  });
});
