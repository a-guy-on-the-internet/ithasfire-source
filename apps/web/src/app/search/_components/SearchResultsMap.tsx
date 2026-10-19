"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "@bprogress/next/app";
import { useTheme } from "tamagui";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  isMapEnabled,
  mapStyleDark,
  mapStyleLight,
  usCentroid,
  defaultMapZoom,
} from "@/config/maps";
import {
  installMissingImageFallback,
  transformLocalMapLibreRequest,
} from "@/components/maps/maplibre-missing-image";
import { installStyleLoadRetry } from "@/components/maps/maplibre-style-retry";
// The literal Stub values — for MapLibre paint, which can't resolve var() strings.
import { stubTheme } from "@th/ui/colors";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { useIsDarkTheme } from "@/hooks/useIsDarkTheme";

import {
  buildAreaCentreGeoJson,
  buildAreaGeoJson,
  buildMarkGeoJson,
  itemBounds,
  type SearchMapItem,
  type SearchMapKind,
} from "./search-map-items";

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export type SearchResultsMapLabels = {
  /** Accessible name of the map region. */
  map: string;
  approxArea: string;
  kickerEvent: string;
  kickerVenue: string;
  viewEvent: string;
  viewVenue: string;
};

export type SearchResultsMapProps = {
  /** Events AND venues, already classified (see ./search-map-items). */
  items: SearchMapItem[];
  /** Which layers are drawn. Toggling never refits the camera. */
  layers?: Record<SearchMapKind, boolean>;
  /** Center the map here (from the search page's active geo filter); null → fit to items. */
  center?: { lat: number; lng: number } | null;
  /** Key (`kind:id`) of the list row being hovered — its mark highlights. */
  highlightedKey?: string | null;
  /** Fired when a mark or area is clicked (so the list can jump to its row). */
  onItemClick?: (key: string) => void;
  /**
   * Fired after the USER pans/zooms — the new center + approx radius (km) for
   * "Search this area". Programmatic camera moves are silent (see below).
   */
  onViewportChange?: (next: {
    center: { lat: number; lng: number };
    radiusKm: number;
  }) => void;
  /** Suppress the popup (still fires `onItemClick`) — mobile uses a bottom card. */
  disablePopup?: boolean;
  labels: SearchResultsMapLabels;
  style?: CSSProperties;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SRC_EVENTS = "search-events";
const SRC_VENUES = "search-venues";
const SRC_AREAS = "search-areas";
const SRC_AREA_CENTRES = "search-area-centres";
const CLUSTER_RADIUS = 40;
const CLUSTER_MAX_ZOOM = 14;
const MAP_ZOOM_WITH_CENTER = 11;
/** Framing for the results, shared by the initial camera and later fits. */
const FIT_OPTIONS = {
  padding: { top: 60, bottom: 50, left: 30, right: 30 },
  maxZoom: 13,
};

// Layer ids
const L_AREA_FILL = "area-fill";
const L_AREA_LINE = "area-line";
const L_AREA_HIGHLIGHT = "area-highlight";
const L_AREA_FLOOR = "area-floor";
const L_AREA_FLOOR_HIGHLIGHT = "area-floor-highlight";
const L_AREA_LABEL = "area-label";
const L_EVENT_CLUSTERS = "event-clusters";
const L_EVENT_CLUSTER_COUNT = "event-cluster-count";
const L_EVENT_HIGHLIGHT = "event-highlight";
const L_EVENT_GLOW = "event-glow";
const L_EVENT_POINT = "event-point";
const L_VENUE_CLUSTERS = "venue-clusters";
const L_VENUE_HIGHLIGHT = "venue-highlight";
const L_VENUE_POINT = "venue-point";

/** Every layer that belongs to one kind — what a legend toggle shows/hides. */
const LAYERS_BY_KIND: Record<SearchMapKind, string[]> = {
  event: [
    L_EVENT_CLUSTERS,
    L_EVENT_CLUSTER_COUNT,
    L_EVENT_HIGHLIGHT,
    L_EVENT_GLOW,
    L_EVENT_POINT,
  ],
  venue: [L_VENUE_CLUSTERS, L_VENUE_HIGHLIGHT, L_VENUE_POINT],
};
/** Area layers draw both kinds; a toggle filters them by `kind` instead. */
const AREA_LAYERS = [
  L_AREA_FILL,
  L_AREA_LINE,
  L_AREA_FLOOR,
  L_AREA_LABEL,
];
/**
 * The area HIGHLIGHT layers are filtered by key (the hovered row) AND by
 * kind (the legend), so a hidden layer's circle can never light up. Their
 * filter is owned by the highlight effect, which combines both.
 */
const AREA_HIGHLIGHT_LAYERS = [L_AREA_HIGHLIGHT, L_AREA_FLOOR_HIGHLIGHT];

/** Topmost first — the click/hover hit order. */
const INTERACTIVE_LAYERS = [
  L_VENUE_POINT,
  L_VENUE_CLUSTERS,
  L_EVENT_POINT,
  L_EVENT_CLUSTERS,
  L_AREA_FLOOR,
  L_AREA_FILL,
];

// Venue marks are SQUARES (the venue tile's shape) so a venue never reads as
// an event dot. MapLibre circle layers are round, so the squares are icons.
const IMG_SQUARE = "search-venue-square";
const IMG_SQUARE_RING = "search-venue-square-ring";
const IMG_SQUARE_CLUSTER = "search-venue-square-cluster";
const ICON_PIXEL_RATIO = 2;

/** Radius of the small-scale stand-in for an approximate area (px). */
const AREA_FLOOR_PX = 8;
/** Hide the stand-in once the real circle is at least this wide (px radius). */
const AREA_FLOOR_HIDE_AT_PX = 14;
/** Show the "approx. area" label only when the circle can hold it (px radius). */
const AREA_LABEL_SHOW_AT_PX = 48;

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
};

const mapContainerStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  position: "absolute",
  inset: 0,
};

const skeletonStyle: CSSProperties = {
  ...containerStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "rgba(15, 27, 51, 0.3)",
  overflow: "hidden",
};

const skeletonPulseStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  background:
    "linear-gradient(110deg, rgba(15,27,51,0.2) 30%, rgba(53,88,154,0.12) 50%, rgba(15,27,51,0.2) 70%)",
  backgroundSize: "200% 100%",
  animation: "hero-map-skeleton-pulse 1.5s ease-in-out infinite",
};

const overlayTextStyle: CSSProperties = {
  position: "absolute",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--color, #211C16)",
};

const fallbackStyle: CSSProperties = {
  ...containerStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "rgba(15, 27, 51, 0.3)",
};

const fallbackTextStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--color, #211C16)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Escape HTML special chars for popup content. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Great-circle distance between two coords, in km. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `a` for a venue feature, `b` for an event feature. */
const byKind = (
  venue: string | number,
  event: string | number,
): maplibregl.ExpressionSpecification => [
  "case",
  ["==", ["get", "kind"], "venue"],
  venue,
  event,
];

/**
 * A paint value that depends on how big an area's REAL circle is on screen.
 * `rpx0` is the circle's radius in pixels at zoom 0 (0 = unknown radius), so
 * at zoom z it is `rpx0 * 2^z`. Zoom may only feed a top-level step, so the
 * comparison is unrolled per integer zoom — exact to within one zoom level.
 */
function byAreaPx(
  test: (pxExpr: maplibregl.ExpressionSpecification) => maplibregl.ExpressionSpecification,
  whenTrue: number,
  whenFalse: number,
): maplibregl.ExpressionSpecification {
  const at = (z: number): maplibregl.ExpressionSpecification => [
    "case",
    test(["*", ["get", "rpx0"], 2 ** z]),
    whenTrue,
    whenFalse,
  ];
  const stops: Array<number | maplibregl.ExpressionSpecification> = [];
  for (let z = 1; z <= 22; z++) stops.push(z, at(z));
  return ["step", ["zoom"], at(0), ...stops] as maplibregl.ExpressionSpecification;
}

/** Draw a square icon into ImageData for `map.addImage` (device-pixel sized). */
function squareImage(
  sizeCss: number,
  fill: string | null,
  stroke: string,
  strokeCss: number,
): ImageData | null {
  const size = Math.round(sizeCss * ICON_PIXEL_RATIO);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const sw = strokeCss * ICON_PIXEL_RATIO;
  if (fill) {
    ctx.fillStyle = stroke;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = fill;
    ctx.fillRect(sw, sw, size - 2 * sw, size - 2 * sw);
  } else {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = sw;
    ctx.strokeRect(sw / 2, sw / 2, size - sw, size - sw);
  }
  return ctx.getImageData(0, 0, size, size);
}

function addSquareImages(
  map: maplibregl.Map,
  paint: { squareFill: string; squareStroke: string; ring: string },
) {
  const images: Array<[string, ImageData | null]> = [
    [IMG_SQUARE, squareImage(16, paint.squareFill, paint.squareStroke, 2)],
    [IMG_SQUARE_CLUSTER, squareImage(30, paint.squareFill, paint.squareStroke, 2)],
    [IMG_SQUARE_RING, squareImage(28, null, paint.ring, 3)],
  ];
  for (const [name, data] of images) {
    if (!data || map.hasImage(name)) continue;
    map.addImage(name, data, { pixelRatio: ICON_PIXEL_RATIO });
  }
}

/** The layer-visibility filter for the shared area layers. */
function kindFilter(
  layers: Record<SearchMapKind, boolean>,
): maplibregl.ExpressionSpecification {
  const on = (Object.keys(layers) as SearchMapKind[]).filter((k) => layers[k]);
  return ["in", ["get", "kind"], ["literal", on]];
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const ALL_LAYERS: Record<SearchMapKind, boolean> = { event: true, venue: true };

/**
 * The /search results map: ONE map, two layers.
 *
 *   events → orange dots (clustered).
 *   venues → ink squares with a paper outline (clustered as larger squares).
 *   either, when approximate → a shaded circle at its published radius in
 *   metres, never a pin; below the scale where that circle is visible, a
 *   small soft ring stands in for it.
 *
 * Every coordinate is the server's public projection; this component only
 * draws.
 */
export function SearchResultsMap({
  items,
  layers = ALL_LAYERS,
  center,
  highlightedKey,
  onItemClick,
  onViewportChange,
  disablePopup,
  labels,
  style,
}: SearchResultsMapProps) {
  const router = useRouter();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [mapError, setMapError] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  // The instance exists from construction; `mapRef`/`mapLoaded` once the style is parsed (`style.load`).
  const instanceRef = useRef<maplibregl.Map | null>(null);
  const [mapCreated, setMapCreated] = useState(false);

  // ── Theme-aware basemap + marker paint (chosen on mount) ──────────────────
  const theme = useTheme();
  const isDark = useIsDarkTheme();
  const mapStyle = isDark ? mapStyleDark : mapStyleLight;
  // A LITERAL colour — MapLibre paint can't resolve var() strings.
  const accentColor = String(theme.accent?.val ?? stubTheme.accent);

  // Marker paint pairs, swapped per basemap. MapLibre GL PAINT EXPRESSIONS
  // need literal colours; the whites are the Ember branch only.
  const markerPaint = useMemo(
    () =>
      isDark
        ? {
            clusterFill: "#FFFFFF",
            clusterStroke: "rgba(0, 0, 0, 0.4)",
            clusterText: "#000000",
            pinFill: "#FFFFFF",
            pinStroke: "rgba(0, 0, 0, 0.5)",
            glow: "rgba(255, 255, 255, 0.25)",
            squareFill: "#FFFFFF",
            squareStroke: "#0F1B33",
            venueArea: "#FFFFFF",
            eventArea: accentColor,
            labelText: "#FFFFFF",
            labelHalo: "rgba(15, 27, 51, 0.85)",
            mapFilter: "grayscale(0.6) contrast(1.05)",
          }
        : {
            clusterFill: "#211C16",
            clusterStroke: "rgba(246, 240, 228, 0.7)",
            clusterText: "#FDFAF3",
            pinFill: accentColor,
            pinStroke: "rgba(33, 28, 22, 0.55)",
            glow: "rgba(33, 28, 22, 0.28)",
            // Board: ink fill, paper outline.
            squareFill: "#211C16",
            squareStroke: "#FDFAF3",
            venueArea: "#211C16",
            eventArea: accentColor,
            labelText: "#211C16",
            labelHalo: "rgba(253, 250, 243, 0.9)",
            mapFilter: "grayscale(0.25) contrast(1.0)",
          },
    [isDark, accentColor],
  );

  // ── Refs so the once-registered MapLibre handlers read live values ────────
  const onItemClickRef = useRef(onItemClick);
  const onViewportChangeRef = useRef(onViewportChange);
  const disablePopupRef = useRef(disablePopup);
  const labelsRef = useRef(labels);
  useEffect(() => {
    onItemClickRef.current = onItemClick;
  }, [onItemClick]);
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);
  useEffect(() => {
    disablePopupRef.current = disablePopup;
  }, [disablePopup]);
  useEffect(() => {
    labelsRef.current = labels;
  }, [labels]);

  // ── Initialise map (once, on mount) ───────────────────────────────────────
  useEffect(() => {
    if (!isMapEnabled || !mapContainerRef.current) return;

    const initialCenter = center ?? usCentroid;
    const initialZoom = center ? MAP_ZOOM_WITH_CENTER : defaultMapZoom;
    // Start on the results, not the continent: no continental tiles to wait on.
    const initialBounds = center == null ? itemBounds(items) : null;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: mapStyle,
        // Always set: the fallback if `bounds` can't be fitted (tiny container).
        center: [initialCenter.lng, initialCenter.lat],
        zoom: initialZoom,
        ...(initialBounds && {
          bounds: initialBounds,
          fitBoundsOptions: FIT_OPTIONS,
        }),
        interactive: true,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchZoomRotate: true,
        transformRequest: transformLocalMapLibreRequest,
      });
    } catch {
      setMapError(true);
      return;
    }

    installMissingImageFallback(map, mapStyle);
    const retryStyleLoad = installStyleLoadRetry(map, mapStyle);

    map.on("error", (e) => {
      // A cold-starting tileserver can drop the first style fetch: retry it
      // once before calling the map dead, and keep that first miss out of
      // Sentry.
      if (retryStyleLoad(e)) return;
      // Client component: traceIgnoredError is the right surface (not
      // ReporterPort).
      traceIgnoredError("search.resultsMap.init")(e?.error ?? e);
      // A single failed tile/source request is not a dead map: MapLibre fires
      // those here too (tile errors carry `tile`, forwarded ones `sourceId`).
      const ev = e as { tile?: unknown; sourceId?: unknown };
      if (ev.tile != null || ev.sourceId != null) return;
      // A late error from a removed (strict-mode) instance: cleanup already
      // removed it, and it must not replace the live map with the panel.
      if (instanceRef.current !== map) return;
      // A whole-feature failure (tileserver outage / style 500) → the "Map
      // unavailable" panel.
      setMapError(true);
      try {
        map.remove();
      } catch {
        /* already gone */
      }
      mapRef.current = null;
      instanceRef.current = null;
      setMapCreated(false);
    });

    instanceRef.current = map;
    setMapCreated(true);

    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    // Not `load`: that waits on every in-view tile, so one hung tile would mean
    // no marks. addImage/addSource/addLayer need only the parsed style.
    void map.once("style.load", () => {
      if (instanceRef.current !== map) return;
      addSquareImages(map, {
        squareFill: markerPaint.squareFill,
        squareStroke: markerPaint.squareStroke,
        ring: accentColor,
      });

      const empty: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [],
      };
      for (const id of [SRC_EVENTS, SRC_VENUES]) {
        map.addSource(id, {
          type: "geojson",
          data: empty,
          cluster: true,
          clusterRadius: CLUSTER_RADIUS,
          clusterMaxZoom: CLUSTER_MAX_ZOOM,
        });
      }
      map.addSource(SRC_AREAS, { type: "geojson", data: empty });
      map.addSource(SRC_AREA_CENTRES, { type: "geojson", data: empty });

      // ── Approximate areas (bottom): geographic circles, never pins ───────
      map.addLayer({
        id: L_AREA_FILL,
        type: "fill",
        source: SRC_AREAS,
        paint: {
          "fill-color": byKind(markerPaint.venueArea, markerPaint.eventArea),
          "fill-opacity": byKind(0.12, 0.14),
        },
      });
      map.addLayer({
        id: L_AREA_LINE,
        type: "line",
        source: SRC_AREAS,
        paint: {
          "line-color": byKind(markerPaint.venueArea, markerPaint.eventArea),
          "line-width": 2,
          "line-opacity": 0.85,
          "line-dasharray": [2.5, 2],
        },
      });
      map.addLayer({
        id: L_AREA_HIGHLIGHT,
        type: "line",
        source: SRC_AREAS,
        filter: ["==", ["get", "key"], "__none__"],
        paint: { "line-color": accentColor, "line-width": 3 },
      });
      // The stand-in while the real circle is too small to read: a soft,
      // hollow-looking ring. Never a solid dot, so it cannot pass for a pin.
      map.addLayer({
        id: L_AREA_FLOOR,
        type: "circle",
        source: SRC_AREA_CENTRES,
        paint: {
          "circle-radius": AREA_FLOOR_PX,
          "circle-color": byKind(markerPaint.venueArea, markerPaint.eventArea),
          "circle-opacity": byAreaPx(
            (px) => ["<", px, AREA_FLOOR_HIDE_AT_PX],
            0.18,
            0,
          ),
          "circle-stroke-width": 1.5,
          "circle-stroke-color": byKind(
            markerPaint.venueArea,
            markerPaint.eventArea,
          ),
          "circle-stroke-opacity": byAreaPx(
            (px) => ["<", px, AREA_FLOOR_HIDE_AT_PX],
            0.8,
            0,
          ),
        },
      });
      map.addLayer({
        id: L_AREA_FLOOR_HIGHLIGHT,
        type: "circle",
        source: SRC_AREA_CENTRES,
        filter: ["==", ["get", "key"], "__none__"],
        paint: {
          "circle-radius": AREA_FLOOR_PX + 4,
          "circle-color": "transparent",
          "circle-stroke-width": 3,
          "circle-stroke-color": accentColor,
          "circle-stroke-opacity": byAreaPx(
            (px) => ["<", px, AREA_FLOOR_HIDE_AT_PX],
            1,
            0,
          ),
        },
      });
      map.addLayer({
        id: L_AREA_LABEL,
        type: "symbol",
        source: SRC_AREA_CENTRES,
        layout: {
          "text-field": labelsRef.current.approxArea,
          "text-transform": "uppercase",
          "text-size": 9,
          "text-letter-spacing": 0.15,
          // One line, as on the board — the default 10em wraps it in two.
          "text-max-width": 30,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": markerPaint.labelText,
          "text-halo-color": markerPaint.labelHalo,
          "text-halo-width": 1.2,
          "text-opacity": byAreaPx(
            (px) => [">=", px, AREA_LABEL_SHOW_AT_PX],
            1,
            0,
          ),
        },
      });

      // ── Events: orange dots, clustered ───────────────────────────────────
      map.addLayer({
        id: L_EVENT_CLUSTERS,
        type: "circle",
        source: SRC_EVENTS,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": markerPaint.clusterFill,
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 25, 28],
          "circle-stroke-width": 2,
          "circle-stroke-color": markerPaint.clusterStroke,
        },
      });
      map.addLayer({
        id: L_EVENT_CLUSTER_COUNT,
        type: "symbol",
        source: SRC_EVENTS,
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-size": 11,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: { "text-color": markerPaint.clusterText },
      });
      map.addLayer({
        id: L_EVENT_HIGHLIGHT,
        type: "circle",
        source: SRC_EVENTS,
        filter: ["==", ["get", "key"], "__none__"],
        paint: {
          "circle-color": "transparent",
          "circle-radius": 14,
          "circle-stroke-width": 4,
          "circle-stroke-color": accentColor,
          "circle-stroke-opacity": 0.9,
        },
      });
      map.addLayer({
        id: L_EVENT_GLOW,
        type: "circle",
        source: SRC_EVENTS,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "transparent",
          "circle-radius": 12,
          "circle-stroke-width": 3,
          "circle-stroke-color": markerPaint.glow,
        },
      });
      map.addLayer({
        id: L_EVENT_POINT,
        type: "circle",
        source: SRC_EVENTS,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": markerPaint.pinFill,
          "circle-radius": 6,
          "circle-stroke-width": 2,
          "circle-stroke-color": markerPaint.pinStroke,
        },
      });

      // ── Venues: ink squares, clustered as larger squares ─────────────────
      map.addLayer({
        id: L_VENUE_CLUSTERS,
        type: "symbol",
        source: SRC_VENUES,
        filter: ["has", "point_count"],
        layout: {
          "icon-image": IMG_SQUARE_CLUSTER,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": "{point_count_abbreviated}",
          "text-size": 11,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": markerPaint.clusterText },
      });
      map.addLayer({
        id: L_VENUE_HIGHLIGHT,
        type: "symbol",
        source: SRC_VENUES,
        filter: ["==", ["get", "key"], "__none__"],
        layout: {
          "icon-image": IMG_SQUARE_RING,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      map.addLayer({
        id: L_VENUE_POINT,
        type: "symbol",
        source: SRC_VENUES,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": IMG_SQUARE,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });

      // ── Interactions ─────────────────────────────────────────────────────
      map.on("click", (e) => {
        // Topmost first; a layer toggled off (visibility none) is not rendered,
        // so it never answers.
        const feature = map.queryRenderedFeatures(e.point, {
          layers: INTERACTIVE_LAYERS.filter((id) => map.getLayer(id)),
        })[0];
        if (!feature) return;
        const props = feature.properties ?? {};

        // Cluster → zoom into it.
        if (props.cluster_id != null) {
          const sourceId = feature.layer.id === L_VENUE_CLUSTERS ? SRC_VENUES : SRC_EVENTS;
          const geom = feature.geometry;
          (map.getSource(sourceId) as maplibregl.GeoJSONSource)
            .getClusterExpansionZoom(props.cluster_id as number)
            .then((zoom) => {
              if (zoom == null || geom.type !== "Point") return;
              map.easeTo({
                center: geom.coordinates as [number, number],
                zoom,
                duration: 400,
              });
            })
            .catch(traceIgnoredError("search.resultsMap.clusterExpand"));
          return;
        }

        const key = String(props.key ?? "");
        if (!key) return;
        onItemClickRef.current?.(key);
        if (disablePopupRef.current) return;

        const kind = props.kind === "venue" ? "venue" : "event";
        const title = String(props.title ?? "");
        const subtitle = String(props.subtitle ?? "");
        const href = String(props.href ?? "");
        const approximate = props.precision !== "exact";
        const l = labelsRef.current;

        popupRef.current?.remove();
        // `.hero-map-popup` is a hard navy card in BOTH themes (globals.css);
        // copy rides `onStructure`. Popup DOM, not paint, so var() resolves.
        const kicker = `<div style="font-family:var(--font-mono, ui-monospace, monospace);font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:color-mix(in srgb, var(--onStructure, #FDFAF3) 70%, transparent);">${esc(kind === "venue" ? l.kickerVenue : l.kickerEvent)}</div>`;
        const approxHtml = approximate
          ? `<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:color-mix(in srgb, var(--onStructure, #FDFAF3) 55%, transparent);margin-top:3px;">${esc(l.approxArea)}</div>`
          : "";
        const linkHtml = href
          ? `<a href="${esc(href)}" class="hero-map-link" style="display:block;margin-top:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--onStructure, #FDFAF3);text-decoration:none;">${esc(kind === "venue" ? l.viewVenue : l.viewEvent)} &rarr;</a>`
          : "";

        // Anchor at the click for an area (its centre is not a location).
        const geom = feature.geometry;
        const at: [number, number] =
          !approximate && geom.type === "Point"
            ? (geom.coordinates as [number, number])
            : [e.lngLat.lng, e.lngLat.lat];

        popupRef.current = new maplibregl.Popup({
          offset: 14,
          closeButton: false,
          closeOnClick: true,
          className: "hero-map-popup",
          maxWidth: "220px",
        })
          .setLngLat(at)
          .setHTML(
            kicker +
              `<div style="font-size:12px;font-weight:700;color:var(--onStructure, #FDFAF3);text-transform:uppercase;letter-spacing:0.5px;line-height:1.3;margin-top:2px;">${esc(title)}</div>` +
              (subtitle
                ? `<div style="font-size:10px;color:color-mix(in srgb, var(--onStructure, #FDFAF3) 60%, transparent);margin-top:3px;">${esc(subtitle)}</div>`
                : "") +
              approxHtml +
              linkHtml,
          )
          .addTo(map);

        const linkEl = popupRef.current.getElement()?.querySelector(".hero-map-link");
        if (linkEl && href) {
          linkEl.addEventListener("click", (evt) => {
            evt.preventDefault();
            router.push(href);
          });
        }
      });

      // Cursor feedback over anything clickable.
      map.on("mousemove", (e) => {
        const hit = map.queryRenderedFeatures(e.point, {
          layers: INTERACTIVE_LAYERS.filter((id) => map.getLayer(id)),
        });
        map.getCanvas().style.cursor = hit.length > 0 ? "pointer" : "";
      });

      // ── Viewport reporting (USER-driven moves only) ──────────────────────
      // MapLibre tags user moves with `originalEvent`; flyTo/fitBounds/easeTo
      // leave it undefined, so every programmatic move stays silent.
      map.on("moveend", (e) => {
        if (!e.originalEvent) return;
        const cb = onViewportChangeRef.current;
        if (!cb) return;
        const c = map.getCenter();
        const ne = map.getBounds().getNorthEast();
        const centerLatLng = { lat: c.lat, lng: c.lng };
        cb({
          center: centerLatLng,
          radiusKm: haversineKm(centerLatLng, { lat: ne.lat, lng: ne.lng }),
        });
      });

      mapRef.current = map;
      setMapLoaded(true);
    });

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      try {
        map.remove();
      } catch {
        /* noop */
      }
      mapRef.current = null;
      instanceRef.current = null;
      setMapCreated(false);
      setMapLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- map inits once on mount
  }, []);

  // ── Update source data when the result set changes ────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const set = (id: string, data: GeoJSON.FeatureCollection) =>
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);
    set(SRC_EVENTS, buildMarkGeoJson(items, "event"));
    set(SRC_VENUES, buildMarkGeoJson(items, "venue"));
    set(SRC_AREAS, buildAreaGeoJson(items));
    set(SRC_AREA_CENTRES, buildAreaCentreGeoJson(items));
  }, [items, mapLoaded]);

  // ── Frame the results (camera only, so it need not wait for `load`) ───────
  // `load` waits on every in-view tile; a slow tile at the starting view would
  // otherwise leave the person on the continental camera.
  useEffect(() => {
    const map = instanceRef.current;
    if (!map || !mapCreated || center != null) return;
    // No explicit center → frame everything drawn (circles by their full
    // extent). Programmatic, so its moveend never reports a viewport.
    const bounds = itemBounds(items);
    if (bounds) map.fitBounds(bounds, { ...FIT_OPTIONS, duration: 600 });
    // `center` has its own effect; excluded so a refresh doesn't re-fit while
    // the user explores a chosen center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, mapCreated]);

  // ── Layer toggles (legend chips) ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    for (const kind of Object.keys(LAYERS_BY_KIND) as SearchMapKind[]) {
      for (const id of LAYERS_BY_KIND[kind]) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", layers[kind] ? "visible" : "none");
        }
      }
    }
    for (const id of AREA_LAYERS) {
      if (map.getLayer(id)) map.setFilter(id, kindFilter(layers));
    }
    popupRef.current?.remove();
  }, [layers, mapLoaded]);

  // ── Fly to an explicit center when it changes ─────────────────────────────
  useEffect(() => {
    const map = instanceRef.current;
    if (!map || !mapCreated || center == null) return;
    // "Search this area" sets the center to ~the current map center: keep the
    // user's frame (zoom) so the searched radius and the visible frame agree.
    const current = map.getCenter();
    const isSameFrame =
      haversineKm(
        { lat: current.lat, lng: current.lng },
        { lat: center.lat, lng: center.lng },
      ) < 0.5;
    map.flyTo({
      center: [center.lng, center.lat],
      zoom: isSameFrame ? map.getZoom() : MAP_ZOOM_WITH_CENTER,
      duration: 800,
    });
  }, [center, mapCreated]);

  // ── Highlight the hovered row's mark ──────────────────────────────────────
  // Event/venue highlight layers hide with their layer group (visibility);
  // the shared area highlight layers also need the legend's kind filter.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const byKey: maplibregl.ExpressionSpecification = [
      "==",
      ["get", "key"],
      highlightedKey ?? "__none__",
    ];
    for (const id of [L_EVENT_HIGHLIGHT, L_VENUE_HIGHLIGHT]) {
      if (map.getLayer(id)) map.setFilter(id, byKey);
    }
    for (const id of AREA_HIGHLIGHT_LAYERS) {
      if (map.getLayer(id)) map.setFilter(id, ["all", byKey, kindFilter(layers)]);
    }
  }, [highlightedKey, layers, mapLoaded]);

  // ── Fallback: map disabled or errored ─────────────────────────────────────
  if (!isMapEnabled || mapError) {
    return (
      <div
        className="swiss-diagonal"
        style={{ ...fallbackStyle, ...style }}
        aria-hidden
      >
        {/* TODO i18n */}
        <span style={fallbackTextStyle}>Map unavailable</span>
      </div>
    );
  }

  return (
    // A labelled region, not role="img": the MapLibre canvas inside is
    // focusable and keyboard-pannable, and role="img" would make it
    // presentational to assistive tech.
    <div
      style={{ ...containerStyle, ...style }}
      role="region"
      aria-label={labels.map}
    >
      {!mapLoaded && (
        <div style={skeletonStyle} aria-hidden>
          <div style={skeletonPulseStyle} />
          {/* TODO i18n */}
          <span style={overlayTextStyle}>Loading map</span>
        </div>
      )}
      <div
        ref={mapContainerRef}
        style={{ ...mapContainerStyle, filter: markerPaint.mapFilter }}
      />
    </div>
  );
}

export default SearchResultsMap;
