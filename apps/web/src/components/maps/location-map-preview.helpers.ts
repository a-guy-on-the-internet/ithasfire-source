// ─────────────────────────────────────────────────────────────────────────────
// Pure geometry helpers for LocationMapPreview (no maplibre / DOM deps) so
// the privacy-critical circle math is unit-testable in isolation.
// ─────────────────────────────────────────────────────────────────────────────

import type { LatLngLiteral } from "@/config/maps";

/**
 * Build a GeoJSON polygon approximating a circle for the radius overlay.
 * 64-segment polygon at the given centre and radius (metres).
 */
export function buildCircleGeoJson(
  center: LatLngLiteral,
  radiusMetres: number,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const SEGMENTS = 64;
  const coords: [number, number][] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const angle = (i / SEGMENTS) * 2 * Math.PI;
    const dx = radiusMetres * Math.cos(angle);
    const dy = radiusMetres * Math.sin(angle);
    const lat = center.lat + dy / 111_320;
    const lng =
      center.lng + dx / (111_320 * Math.cos((center.lat * Math.PI) / 180));
    coords.push([lng, lat]);
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

/**
 * Deterministic hash-based jitter so the approximate circle's centre is
 * shifted consistently for the same coordinates. Uses a simple FNV-1a
 * inspired hash seeded from lat+lng to produce an offset within ~33 %
 * of the radius, ensuring the real pin always stays inside the circle
 * while keeping the offset subtle.
 */
export function jitterCenter(
  position: LatLngLiteral,
  radiusMetres: number,
): LatLngLiteral {
  const seed = `${position.lat.toFixed(6)}:${position.lng.toFixed(6)}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Two pseudo-random values in [0,1)
  const r1 = ((h >>> 0) % 10000) / 10000;
  h = Math.imul(h ^ (h >>> 16), 2654435769);
  const r2 = ((h >>> 0) % 10000) / 10000;

  const maxOffsetMetres = radiusMetres * 0.33;
  const angle = r1 * 2 * Math.PI;
  const distance = r2 * maxOffsetMetres;

  const dLat = (distance * Math.sin(angle)) / 111_320;
  const dLng =
    (distance * Math.cos(angle)) /
    (111_320 * Math.cos((position.lat * Math.PI) / 180));

  return { lat: position.lat + dLat, lng: position.lng + dLng };
}

/**
 * Select the map centre actually displayed for a location.
 *
 * - Exact locations render at the true position (a pin, no privacy concern).
 * - Approximate locations fed TRUE coordinates (admin builder preview) are
 *   jittered client-side so the drawn circle's centre never reveals the pin.
 * - Approximate locations fed ALREADY-OBFUSCATED coordinates
 *   (`preObfuscated` — the server-redacted centre from `redactLocation`)
 *   are used as-is: double-offsetting (server up to 70 % of radius + client
 *   up to 33 %) could push the real venue outside the drawn circle.
 */
export function resolveDisplayCenter({
  position,
  isExact,
  preObfuscated,
  radiusMetres,
}: {
  position: LatLngLiteral;
  isExact: boolean;
  preObfuscated: boolean;
  radiusMetres: number;
}): LatLngLiteral {
  return isExact || preObfuscated
    ? position
    : jitterCenter(position, radiusMetres);
}
