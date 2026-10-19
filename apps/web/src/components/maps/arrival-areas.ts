import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";
import { stubTheme } from "@th/ui/colors";

import { palette } from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Arrival areas on the public place and event pages (arrival-areas spec
// FR-006, FR-007, NFR-002, NFR-003). Pure helpers shared by the map layer
// (`ArrivalAreasLayer`) and the text twin (`GettingThereList`).
//
// NFR-002: nothing in this file, or in anything that calls it, may log,
// trace or send to analytics a geometry or a Directions point. Areas are
// protected location data under the same rule as the exact address.
// ─────────────────────────────────────────────────────────────────────────────

export type { VisibleArrivalArea };

export type ArrivalAreaKind = VisibleArrivalArea["kind"];

/**
 * What the legend and the list swatch show. Street parking is its own entry
 * because it is drawn differently (a line, not a filled lot).
 */
export type ArrivalAreaLegendKey =
  | "PARKING_LOT"
  | "STREET_PARKING"
  | "ACCESSIBLE_DROP_OFF"
  | "LOAD_IN";

/** Legend order: parking first, then drop-off, then load-in. */
export const LEGEND_ORDER: readonly ArrivalAreaLegendKey[] = [
  "PARKING_LOT",
  "STREET_PARKING",
  "ACCESSIBLE_DROP_OFF",
  "LOAD_IN",
];

export function legendKeyFor(area: VisibleArrivalArea): ArrivalAreaLegendKey {
  if (area.kind === "PARKING") {
    return area.geometry?.type === "LineString"
      ? "STREET_PARKING"
      : "PARKING_LOT";
  }
  return area.kind;
}

/**
 * MapLibre paint. Paint expressions cannot take `var()`, so these are literal
 * hex values from the design-system primitives. The detail map always draws
 * the LIGHT basemap (`mapStyleLight`, both themes), so one set fits it.
 * Kinds differ by PATTERN as well as colour (NFR-003): parking is solid,
 * accessible drop-off is a dotted outline, load-in is dashed, street parking
 * is a thick line.
 */
export const ARRIVAL_AREA_PAINT = {
  parking: palette.brandPrimary,
  dropOffFill: palette.support,
  dropOffLine: stubTheme.warningSoft,
  loadIn: stubTheme.color,
  selected: stubTheme.accent,
  casing: stubTheme.surface,
} as const;

// ── Geometry guards (client side, draw-only) ────────────────────────────────

type Position = [number, number];

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}

/**
 * The geometry, when it is safe to hand to MapLibre; otherwise null (the area
 * is still listed, just not drawn). The server already validated it on write
 * and nulls a malformed stored shape; this is the last guard before the GL
 * layer, which throws on garbage and takes the whole map down with it.
 */
export function drawableGeometry(
  area: VisibleArrivalArea,
): GeoJSON.Polygon | GeoJSON.LineString | null {
  const geometry: unknown = area.geometry;
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === "LineString") {
    const coords = g.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    if (!coords.every(isPosition)) return null;
    return { type: "LineString", coordinates: coords as Position[] };
  }
  if (g.type === "Polygon") {
    const rings = g.coordinates;
    if (!Array.isArray(rings) || rings.length !== 1) return null;
    const ring: unknown = rings[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    if (!ring.every(isPosition)) return null;
    return { type: "Polygon", coordinates: [ring as Position[]] };
  }
  return null;
}

export type ArrivalAreaFeatureProps = {
  id: string;
  kind: ArrivalAreaKind;
};

/** The drawable areas as one FeatureCollection, in the server's order. */
export function toFeatureCollection(
  areas: readonly VisibleArrivalArea[],
): GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.LineString,
  ArrivalAreaFeatureProps
> {
  const features: GeoJSON.Feature<
    GeoJSON.Polygon | GeoJSON.LineString,
    ArrivalAreaFeatureProps
  >[] = [];
  for (const area of areas) {
    const geometry = drawableGeometry(area);
    if (!geometry) continue;
    features.push({
      type: "Feature",
      id: area.id,
      geometry,
      properties: { id: area.id, kind: area.kind },
    });
  }
  return { type: "FeatureCollection", features };
}

/** `[west, south, east, north]` over every drawable area, or null. */
export function areaBounds(
  areas: readonly VisibleArrivalArea[],
  extra?: { lat: number; lng: number } | null,
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const add = ([lng, lat]: Position) => {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  let any = false;
  for (const area of areas) {
    const geometry = drawableGeometry(area);
    if (!geometry) continue;
    any = true;
    const positions =
      geometry.type === "Polygon"
        ? (geometry.coordinates[0] as Position[])
        : (geometry.coordinates as Position[]);
    positions.forEach(add);
  }
  if (!any) return null;
  if (extra && Number.isFinite(extra.lat) && Number.isFinite(extra.lng)) {
    add([extra.lng, extra.lat]);
  }
  return [west, south, east, north];
}

/** The legend entries for the areas actually drawn, in legend order. */
export function legendKeysFor(
  areas: readonly VisibleArrivalArea[],
): ArrivalAreaLegendKey[] {
  const present = new Set<ArrivalAreaLegendKey>();
  for (const area of areas) {
    if (drawableGeometry(area)) present.add(legendKeyFor(area));
  }
  return LEGEND_ORDER.filter((key) => present.has(key));
}

/** Message keys for each legend entry / row kind. */
export const LEGEND_LABEL_KEY: Record<ArrivalAreaLegendKey, string> = {
  PARKING_LOT: "arrivalAreas.legendParkingLot",
  STREET_PARKING: "arrivalAreas.legendStreetParking",
  ACCESSIBLE_DROP_OFF: "arrivalAreas.kindAccessibleDropOff",
  LOAD_IN: "arrivalAreas.kindLoadIn",
};

export const KIND_LABEL_KEY: Record<ArrivalAreaKind, string> = {
  PARKING: "arrivalAreas.kindParking",
  ACCESSIBLE_DROP_OFF: "arrivalAreas.kindAccessibleDropOff",
  LOAD_IN: "arrivalAreas.kindLoadIn",
};

export const COST_LABEL_KEY: Record<VisibleArrivalArea["cost"], string> = {
  FREE: "arrivalAreas.costFree",
  PAID: "arrivalAreas.costPaid",
  UNKNOWN: "arrivalAreas.costUnknown",
};
