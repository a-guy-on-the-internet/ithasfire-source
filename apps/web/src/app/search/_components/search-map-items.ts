// ─────────────────────────────────────────────────────────────────────────────
// Pure data layer for the /search results map (no maplibre / DOM), so the
// privacy-relevant "how may this be drawn" decision is unit-testable.
//
// Every coordinate here arrives already redacted by the server
// (`projectPublicEventLocation` / `redactPlaceLocation`, applied at index
// time). This module only decides HOW to draw what it was given:
//
//   exact  → a mark at the point (event dot / venue square).
//   area   → a shaded circle at the published radius, in METRES (geographic),
//            never a pin.
//   approx → approximate, radius unknown. Only an event document indexed
//            before the precision fields existed can be this (the projection
//            never publishes an approximate point without a radius). Drawn as
//            a small soft area marker — never a pin — until the next reindex.
//   (null) → not plotted: hidden / gated / no coordinates.
// ─────────────────────────────────────────────────────────────────────────────

import { buildCircleGeoJson } from "@/components/maps/location-map-preview.helpers";

export type SearchMapKind = "event" | "venue";
export type SearchMapPrecision = "exact" | "area" | "approx";

export type SearchMapItem = {
  /** `${kind}:${id}` — unique across both layers; the highlight/click key. */
  key: string;
  kind: SearchMapKind;
  id: string;
  title: string;
  /** Event: venue/area line. Venue: city or area. */
  subtitle: string | null;
  /** Where the popup / bottom card links. */
  href: string | null;
  lat: number;
  lng: number;
  precision: SearchMapPrecision;
  /** Published circle radius (metres) for `area`; null otherwise. */
  radiusMeters: number | null;
};

export const mapItemKey = (kind: SearchMapKind, id: string) => `${kind}:${id}`;

/** Parse a key back into its kind + id. Null for a malformed key. */
export function parseMapItemKey(
  key: string,
): { kind: SearchMapKind; id: string } | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  const kind = key.slice(0, i);
  if (kind !== "event" && kind !== "venue") return null;
  return { kind, id: key.slice(i + 1) };
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

type Precision = {
  lat?: number | null;
  lng?: number | null;
  locationIsExact?: boolean | null;
  locationRadiusMeters?: number | null;
};

/**
 * The drawing decision. `allowUnknownRadius` is true for EVENTS only — see the
 * module header: venue suggestions already fail closed server-side (no radius
 * and not exact ⇒ no coordinates), so a venue never reaches `approx`.
 */
export function classifyPrecision(
  p: Precision,
  allowUnknownRadius: boolean,
): { precision: SearchMapPrecision; radiusMeters: number | null } | null {
  if (!finite(p.lat) || !finite(p.lng)) return null;
  if (p.locationIsExact === true) return { precision: "exact", radiusMeters: null };
  if (finite(p.locationRadiusMeters) && p.locationRadiusMeters > 0) {
    return { precision: "area", radiusMeters: p.locationRadiusMeters };
  }
  return allowUnknownRadius ? { precision: "approx", radiusMeters: null } : null;
}

export type EventMapSource = Precision & {
  eventId: string;
  title: string;
  subtitle?: string | null;
  slug?: string | null;
};

export function toEventMapItem(e: EventMapSource): SearchMapItem | null {
  const drawn = classifyPrecision(e, true);
  if (!drawn) return null;
  return {
    key: mapItemKey("event", e.eventId),
    kind: "event",
    id: e.eventId,
    title: e.title,
    subtitle: e.subtitle ?? null,
    href: e.slug ? `/events/${e.slug}` : null,
    lat: e.lat as number,
    lng: e.lng as number,
    ...drawn,
  };
}

export type VenueMapSource = Precision & {
  id: string;
  placeId?: string | null;
  title: string;
  subtitle?: string | null;
  city?: string | null;
  pageSlug?: string | null;
  /** The server's "publishes no position at all" flag. */
  locationHidden?: boolean | null;
};

/** The venue page link: the entity-page slug, else the id route (never a 404). */
export function venueHref(v: Pick<VenueMapSource, "pageSlug" | "placeId">): string | null {
  if (v.pageSlug) return `/places/${v.pageSlug}`;
  if (v.placeId) return `/places/id/${v.placeId}`;
  return null;
}

export function toVenueMapItem(v: VenueMapSource): SearchMapItem | null {
  const drawn = classifyPrecision(v, false);
  if (!drawn) return null;
  return {
    key: mapItemKey("venue", v.id),
    kind: "venue",
    id: v.id,
    title: v.title,
    subtitle: v.city ?? v.subtitle ?? null,
    href: venueHref(v),
    lat: v.lat as number,
    lng: v.lng as number,
    ...drawn,
  };
}

/**
 * Venues that keep their location private — the count behind "N venues keep
 * their location private and aren't on the map". ONLY the server's
 * `locationHidden` counts: an un-geocoded EXACT venue is off the map too but
 * is NOT private, so it is left out of the claim. One stale case remains: an
 * un-geocoded EXACT venue on a row written before the precision columns
 * existed reads as hidden until the next full reindex (see
 * docs/records/2026-09-28-search-map-precision-deploy.md).
 */
export function countPrivateVenues(venues: VenueMapSource[]): number {
  return venues.filter((v) => v.locationHidden === true).length;
}

// ── GeoJSON ─────────────────────────────────────────────────────────────────

type ItemProps = {
  key: string;
  kind: SearchMapKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  precision: SearchMapPrecision;
  /** Circle radius in PIXELS at zoom 0 (0 = unknown radius). See `areaPxAtZoom0`. */
  rpx0: number;
};

/** Web-Mercator metres per pixel at zoom 0 on the equator, for MapLibre's 512px tiles. */
const METRES_PER_PX_Z0 = 40_075_016.686 / 512;

/**
 * A geographic radius in screen pixels at zoom 0 at this latitude. Pixels
 * double per zoom level, so the radius at zoom z is `rpx0 * 2^z` — which is
 * what lets a paint expression hide the small-scale stand-in marker once the
 * real circle is big enough to read.
 */
export function areaPxAtZoom0(radiusMeters: number, lat: number): number {
  return radiusMeters / (METRES_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180));
}

function propsOf(item: SearchMapItem): ItemProps {
  return {
    key: item.key,
    kind: item.kind,
    id: item.id,
    title: item.title,
    subtitle: item.subtitle ?? "",
    href: item.href ?? "",
    precision: item.precision,
    rpx0:
      item.radiusMeters !== null ? areaPxAtZoom0(item.radiusMeters, item.lat) : 0,
  };
}

/** Points for one layer's EXACT marks (clustered source). */
export function buildMarkGeoJson(
  items: SearchMapItem[],
  kind: SearchMapKind,
): GeoJSON.FeatureCollection<GeoJSON.Point, ItemProps> {
  return {
    type: "FeatureCollection",
    features: items
      .filter((i) => i.kind === kind && i.precision === "exact")
      .map((i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [i.lng, i.lat] },
        properties: propsOf(i),
      })),
  };
}

/** Geographic circle polygons for every `area` item (both layers). */
export function buildAreaGeoJson(
  items: SearchMapItem[],
): GeoJSON.FeatureCollection<GeoJSON.Polygon, ItemProps> {
  return {
    type: "FeatureCollection",
    features: items
      .filter((i) => i.precision === "area" && i.radiusMeters !== null)
      .map((i) => ({
        ...buildCircleGeoJson({ lat: i.lat, lng: i.lng }, i.radiusMeters as number),
        properties: propsOf(i),
      })),
  };
}

/**
 * Centre points for every non-exact item — the small-scale stand-in marker
 * (when the real circle is too small to see), the "approx. area" label and
 * the tap target. Never styled as a pin.
 */
export function buildAreaCentreGeoJson(
  items: SearchMapItem[],
): GeoJSON.FeatureCollection<GeoJSON.Point, ItemProps> {
  return {
    type: "FeatureCollection",
    features: items
      .filter((i) => i.precision !== "exact")
      .map((i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [i.lng, i.lat] },
        properties: propsOf(i),
      })),
  };
}

/**
 * The bounds that frame every drawn item — a circle's full extent, not just
 * its centre, so an approximate area is never framed half off-screen.
 */
export function itemBounds(
  items: SearchMapItem[],
): [[number, number], [number, number]] | null {
  if (items.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const i of items) {
    const r = i.radiusMeters ?? 0;
    const dLat = r / 111_320;
    const dLng = r / (111_320 * Math.cos((i.lat * Math.PI) / 180));
    minLng = Math.min(minLng, i.lng - dLng);
    maxLng = Math.max(maxLng, i.lng + dLng);
    minLat = Math.min(minLat, i.lat - dLat);
    maxLat = Math.max(maxLat, i.lat + dLat);
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
