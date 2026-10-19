import { describe, expect, it } from "vitest";

import {
  bboxForRadius,
  decodeGeohash,
  encodeGeohash,
  geohashNeighbors,
  haversineDistance,
} from "../../src/lib/geo";

describe("geohash helpers", () => {
  it("encodes and decodes a coordinate", () => {
    const hash = encodeGeohash(40.7128, -74.006, 8);
    const decoded = decodeGeohash(hash);

    expect(hash).toHaveLength(8);
    expect(decoded.lat).toBeCloseTo(40.7128, 3);
    expect(decoded.lng).toBeCloseTo(-74.006, 3);
    expect(decoded.errorMeters).toBeGreaterThan(0);
  });

  it("returns neighboring hashes", () => {
    const center = encodeGeohash(37.7749, -122.4194, 6);
    const neighbors = geohashNeighbors(center);

    expect(neighbors).toHaveLength(8);
    neighbors.forEach((neighbor) => {
      expect(neighbor).toHaveLength(center.length);
    });
  });

  it("computes a bounding box for small radius", () => {
    const box = bboxForRadius(37.7749, -122.4194, 5);

    expect(box.minLat).toBeLessThan(37.7749);
    expect(box.maxLat).toBeGreaterThan(37.7749);
    expect(box.minLng).toBeLessThan(-122.4194);
    expect(box.maxLng).toBeGreaterThan(-122.4194);
  });

  it("returns full longitude range when crossing the anti-meridian", () => {
    const box = bboxForRadius(0, 179.9, 500);

    expect(box.minLng).toBe(-180);
    expect(box.maxLng).toBe(180);
  });

  it("computes haversine distance in meters", () => {
    const distance = haversineDistance(34.0522, -118.2437, 36.1699, -115.1398);

    expect(distance).toBeGreaterThan(0);
    const distanceKm = distance / 1_000;
    expect(distanceKm).toBeGreaterThan(300);
    expect(distanceKm).toBeLessThan(400);
  });
});
