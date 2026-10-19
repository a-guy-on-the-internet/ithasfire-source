"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import { useRouter } from "@bprogress/next/app";
import { useTheme } from "tamagui";
import { Navigation, X } from "lucide-react";
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
import LocationAutocomplete, {
  type PlaceDetail,
} from "@/components/maps/LocationAutocomplete";
import { trpc } from "@/trpc";
import { useTranslations } from "@th/ui";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";
// The literal Stub values — for MapLibre paint, which can't resolve the var() strings above.
import { stubTheme } from "@th/ui/colors";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsDarkTheme } from "@/hooks/useIsDarkTheme";
import type { TickerEvent } from "./ticker-types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HeroEventMapProps = {
  /** User coordinates — when available, map centres here and loads nearby events. */
  coords: { lat: number; lng: number } | null;
  /** Reports the currently displayed event set for the ticker. */
  onTickerEventsChange?: (events: TickerEvent[]) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAP_ZOOM_WITH_COORDS = 10;
const NEARBY_RADIUS_M = 120_000; // 120 km
const NEARBY_LIMIT = 50;
const SOURCE_ID = "hero-events";
const CLUSTER_RADIUS = 40;
const CLUSTER_MAX_ZOOM = 14;

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
  filter: "grayscale(0.6) contrast(1.05)",
};

const overlayStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: 16,
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  backgroundColor: "rgba(15, 27, 51, 0.85)",
  border: `1px solid ${STRUCTURAL}`,
  pointerEvents: "none",
};

// NOTE: `color`/`background`/`border` on this and the two button styles below
// are per-theme and are ALWAYS overridden by the `…StyleT` variants built from
// the `chrome` memo in-component. The values here are inert defaults, so they
// mirror Stub (the shipped default) rather than the retired navy scheme.
const overlayTextStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "rgba(33, 28, 22, 0.72)",
  lineHeight: 1,
};

const overlayCountStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: ACCENT,
  lineHeight: 1,
};

// ── Location search overlay styles ─────────────────────────────────────────

const locationOverlayStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 4,
  display: "flex",
  alignItems: "stretch",
  width: "min(360px, calc(100% - 24px))",
};

const locationBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 38,
  flexShrink: 0,
  border: "1px solid rgba(33, 28, 22, 0.3)",
  borderLeft: "none",
  background: "rgba(246, 240, 228, 0.95)",
  color: "rgba(33, 28, 22, 0.72)",
  cursor: "pointer",
  transition: "color 0.15s, background 0.15s",
};

const clearBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  flexShrink: 0,
  border: "1px solid rgba(33, 28, 22, 0.3)",
  borderLeft: "none",
  background: "rgba(246, 240, 228, 0.95)",
  color: "rgba(33, 28, 22, 0.5)",
  cursor: "pointer",
  transition: "color 0.15s",
};

// ── Time-window chip bar styles ────────────────────────────────────────────

const chipBarStyle: CSSProperties = {
  position: "absolute",
  bottom: 16,
  right: 16,
  zIndex: 3,
  display: "flex",
  gap: 0,
};

const mobileChipBarStyle: CSSProperties = {
  ...chipBarStyle,
  top: 62,
  bottom: "auto",
  left: "50%",
  right: "auto",
  transform: "translateX(-50%)",
  zIndex: 3,
};

// Base chip type/box; per-theme colors are applied by `chipStyleT` in-component.
const chipBaseStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  lineHeight: 1,
  padding: "6px 10px",
  cursor: "pointer",
  border: `1px solid ${STRUCTURAL}`,
  transition: "background 0.15s, color 0.15s, border-color 0.15s",
  whiteSpace: "nowrap",
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
  // `$color` tracks the theme and is legible on this placeholder in both: ink on
  // the warm grey the 30% navy panel becomes over Stub's cream, white on Ember's
  // dark one. The old 0.35 white washed out completely on Stub.
  color: "var(--color, #211C16)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Debug helper: fetch style.json and report status in the debug banner
// ─────────────────────────────────────────────────────────────────────────────

function DebugStyleCheck({ styleUrl }: { styleUrl: string }) {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!styleUrl) return;
    void (async () => {
      try {
        const res = await fetch(styleUrl, {
          method: "GET",
          credentials: "omit",
        });
        if (!mounted) return;
        setStatus(`${res.status} ${res.statusText}`);
      } catch (err) {
        if (!mounted) return;
        setStatus(String(err));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [styleUrl]);

  return <div>style.json status: {status ?? "checking..."}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-window filter
// ─────────────────────────────────────────────────────────────────────────────

type MapTimeWindow = "week" | "month" | "sixMonths";

const TIME_WINDOWS: readonly MapTimeWindow[] = [
  "week",
  "month",
  "sixMonths",
] as const;

/** Compute the ISO date range for a given time-window chip. */
function buildDateRange(window: MapTimeWindow): {
  startsAfter: string;
  startsBefore: string;
} {
  const now = new Date();
  const end = new Date(now);

  switch (window) {
    case "week":
      end.setDate(end.getDate() + 7);
      break;
    case "month":
      end.setMonth(end.getMonth() + 1);
      break;
    case "sixMonths":
      end.setMonth(end.getMonth() + 6);
      break;
  }

  return {
    startsAfter: now.toISOString(),
    startsBefore: end.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type MapEvent = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  venue: string;
  slug: string | null;
  /**
   * True when lat/lng is a server-obfuscated point (OBSCURED location mode,
   * FR-013) — rendered as a soft blob instead of a sharp pin. Fully-hidden
   * events never appear in the payload at all.
   */
  obscured?: boolean;
  /** Obfuscation circle radius in meters — informational only. */
  radiusMeters?: number | null;
};

/** Build a GeoJSON FeatureCollection from map events. */
function buildGeoJson(
  events: MapEvent[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lng, e.lat] },
      properties: {
        id: e.id,
        title: e.title,
        venue: e.venue,
        slug: e.slug ?? "",
        obscured: e.obscured === true,
      },
    })),
  };
}

/** MapLibre paint expression: `a` when the feature is obscured, else `b`. */
const ifObscured = (
  a: string | number,
  b: string | number,
): maplibregl.ExpressionSpecification => [
  "case",
  ["==", ["get", "obscured"], true],
  a,
  b,
];

/** Fit the map to a bounding box that contains all events, respecting user coords. */
function fitMapToEvents(
  map: maplibregl.Map,
  events: MapEvent[],
  userCoords: { lat: number; lng: number } | null,
) {
  if (events.length === 0) return;

  const bounds = new maplibregl.LngLatBounds();
  for (const e of events) {
    bounds.extend([e.lng, e.lat]);
  }
  if (userCoords) {
    bounds.extend([userCoords.lng, userCoords.lat]);
  }

  map.fitBounds(bounds, {
    padding: { top: 60, bottom: 50, left: 30, right: 30 },
    maxZoom: 13,
    duration: 600,
  });
}

/** Escape HTML special chars for popup content. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function HeroEventMap({
  coords,
  onTickerEventsChange,
}: HeroEventMapProps) {
  const t = useTranslations();
  const router = useRouter();
  const isMobile = useIsMobile();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  // MapLibre click handlers register once; read `t` through a ref so popups
  // built later always use the current locale.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [mapError, setMapError] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

  // ── Theme-aware basemap + marker paint ───────────────────────────────────
  // Ember (dark) keeps the cinematic dark tiles + white pins. Stub (light)
  // uses the light street tiles with accent/ink markers so pins read on the
  // pale basemap. The style is chosen ON MOUNT from the active theme (the app
  // loads a single active theme; full live-swap on toggle is not required).
  const theme = useTheme();
  const isDark = useIsDarkTheme();
  const mapStyle = isDark ? mapStyleDark : mapStyleLight;
  // NOT `?? ACCENT` — that constant is now a `var()` string, which MapLibre's paint expressions
  // cannot resolve (see the note at the markerPaint below). This needs a literal, so fall back to
  // the Stub theme's own accent value rather than a hardcoded hex.
  const accentColor = String(theme.accent?.val ?? stubTheme.accent);
  // Marker/label paint pairs — swap so pins + labels stay legible on whichever
  // basemap is active.
  //
  // These feed MapLibre GL PAINT EXPRESSIONS, which cannot resolve `var()` —
  // they need literal colors, so the whites below stay. They are safe: they are
  // the Ember branch only, i.e. white pins on the dark basemap. The Stub branch
  // is ink/accent/paper, never white-on-pale.
  const markerPaint = useMemo(
    () =>
      isDark
        ? {
            clusterFill: "#FFFFFF",
            clusterStroke: "rgba(0, 0, 0, 0.4)",
            clusterText: "#000000",
            pinFill: "#FFFFFF",
            pinObscuredFill: "rgba(255, 255, 255, 0.35)",
            pinStroke: "rgba(0, 0, 0, 0.5)",
            glowExact: "rgba(255, 255, 255, 0.25)",
            glowObscured: "rgba(255, 255, 255, 0.15)",
            mapFilter: "grayscale(0.6) contrast(1.05)",
          }
        : {
            // Ink clusters with a paper halo + paper count on the light map.
            clusterFill: "#211C16",
            clusterStroke: "rgba(246, 240, 228, 0.7)",
            clusterText: "#FDFAF3",
            // Accent (burnt-orange) pins with an ink ring for definition.
            pinFill: accentColor,
            pinObscuredFill: "rgba(226, 72, 29, 0.35)",
            pinStroke: "rgba(33, 28, 22, 0.55)",
            glowExact: "rgba(33, 28, 22, 0.28)",
            glowObscured: "rgba(33, 28, 22, 0.15)",
            // Lighter grayscale keeps the Stub map airy rather than washed grey.
            mapFilter: "grayscale(0.25) contrast(1.0)",
          },
    [isDark, accentColor],
  );

  // ── Theme-aware floating map chrome (search pill, time chips, count) ──────
  // Ember keeps the navy-on-dark chrome; Stub uses a warm-paper surface with
  // ink text + soft ink borders so the controls read on the light basemap
  // instead of floating as dark navy boxes.
  // The whites in the Ember branch are deliberate and stay: the two branches
  // paint fundamentally different panels (navy vs warm paper), so this reads as
  // an explicit per-theme pair rather than something collapsible to one token —
  // every white below sits on that branch's own navy panel, never on cream.
  const chrome = useMemo(
    () => ({
      // The active chip is filled with the accent in BOTH themes, so its label
      // is the accent's paired foreground — which is NOT white everywhere
      // (Ember uses ink: white on #FF5721 is 3.16:1 and fails AA).
      activeChipText: "var(--onBrandSecondary, #FFFFFF)",
      ...(isDark
        ? {
            panelBg: "rgba(15, 27, 51, 0.85)",
            panelBgStrong: "rgba(15, 27, 51, 0.92)",
            border: STRUCTURAL,
            borderSoft: "#5A78A6",
            text: "rgba(255, 255, 255, 0.6)",
            textDim: "rgba(255, 255, 255, 0.45)",
            textStrong: "#FFFFFF",
            chipInactiveText: "rgba(255, 255, 255, 0.55)",
            chipHoverBorder: "rgba(255, 255, 255, 0.3)",
          }
        : {
            panelBg: "rgba(246, 240, 228, 0.9)",
            panelBgStrong: "rgba(246, 240, 228, 0.95)",
            border: "rgba(33, 28, 22, 0.3)",
            borderSoft: "rgba(33, 28, 22, 0.3)",
            text: "rgba(33, 28, 22, 0.72)",
            textDim: "rgba(33, 28, 22, 0.5)",
            textStrong: "#211C16",
            chipInactiveText: "rgba(33, 28, 22, 0.6)",
            chipHoverBorder: "rgba(33, 28, 22, 0.5)",
          }),
    }),
    [isDark],
  );

  // Themed variants of the module-level chrome styles.
  const overlayStyleT: CSSProperties = {
    ...overlayStyle,
    backgroundColor: chrome.panelBgStrong,
    border: `1px solid ${chrome.border}`,
  };
  const overlayTextStyleT: CSSProperties = { ...overlayTextStyle, color: chrome.text };
  const locationBtnStyleT: CSSProperties = {
    ...locationBtnStyle,
    border: `1px solid ${chrome.borderSoft}`,
    borderLeft: "none",
    background: chrome.panelBgStrong,
    color: chrome.text,
  };
  const clearBtnStyleT: CSSProperties = {
    ...clearBtnStyle,
    border: `1px solid ${chrome.borderSoft}`,
    borderLeft: "none",
    background: chrome.panelBgStrong,
    color: chrome.textDim,
  };
  const chipStyleT = (active: boolean): CSSProperties => ({
    ...chipBaseStyle,
    background: active ? accentColor : chrome.panelBg,
    color: active ? chrome.activeChipText : chrome.chipInactiveText,
    borderColor: active ? accentColor : chrome.border,
  });

  // ── Translated time-window labels ────────────────────────────────────────
  const twLabels: Record<MapTimeWindow, string> = useMemo(
    () => ({
      week: String(t("home.mapTimeWeek")),
      month: String(t("home.mapTimeMonth")),
      sixMonths: String(t("home.mapTime6Months")),
    }),
    [t],
  );

  // ── Internal location state (from search overlay) ────────────────────────
  const [locationCoords, setLocationCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [locationQuery, setLocationQuery] = useState("");

  // ── Time-window filter ───────────────────────────────────────────────────
  const [timeWindow, setTimeWindow] = useState<MapTimeWindow>("week");
  const dateRange = useMemo(() => buildDateRange(timeWindow), [timeWindow]);

  // Effective coords: user search > parent prop > null
  const effectiveCoords = locationCoords ?? coords;
  const hasCoords = effectiveCoords != null;

  // ── Nearby events (user shared location) ─────────────────────────────────
  const { data: nearbyData, isLoading: nearbyLoading } =
    trpc.events.nearbyEventsForMap.useQuery(
      {
        lat: effectiveCoords?.lat ?? 0,
        lng: effectiveCoords?.lng ?? 0,
        radiusM: NEARBY_RADIUS_M,
        limit: NEARBY_LIMIT,
        startsAfter: dateRange.startsAfter,
        startsBefore: dateRange.startsBefore,
      },
      {
        enabled: isMapEnabled && hasCoords,
        staleTime: 120_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
    );

  // ── Overview events (no user location — US-wide box search) ──────────────
  const { data: overviewData, isLoading: overviewLoading } =
    trpc.events.eventsForMapOverview.useQuery(
      {
        limit: NEARBY_LIMIT,
        startsAfter: dateRange.startsAfter,
        startsBefore: dateRange.startsBefore,
      },
      {
        enabled: isMapEnabled && !hasCoords,
        staleTime: 120_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
    );

  // Pick whichever query returned data
  const mapEvents = hasCoords ? nearbyData : overviewData;
  const eventsLoading = hasCoords ? nearbyLoading : overviewLoading;

  const tickerEvents = useMemo<TickerEvent[]>(() => {
    const events = mapEvents?.events;
    if (!events || events.length === 0) return [];
    return events.map((event) => ({
      id: event.id,
      title: event.title,
      venue: event.venue || undefined,
    }));
  }, [mapEvents]);

  useEffect(() => {
    if (!onTickerEventsChange) return;
    onTickerEventsChange(tickerEvents);
  }, [onTickerEventsChange, tickerEvents]);

  // ── Location search handlers ─────────────────────────────────────────────
  const handlePlaceSelect = useCallback((place: PlaceDetail) => {
    if (place.lat != null && place.lng != null) {
      const newCoords = { lat: place.lat, lng: place.lng };
      setLocationCoords(newCoords);
      // Fly the map to the new location
      mapRef.current?.flyTo({
        center: [newCoords.lng, newCoords.lat],
        zoom: MAP_ZOOM_WITH_COORDS,
        duration: 800,
      });
    }
  }, []);

  const handleClearLocation = useCallback(() => {
    setLocationCoords(null);
    setLocationQuery("");
    // If parent coords exist, fly back to them; otherwise show overview
    const fallback = coords ?? usCentroid;
    const fallbackZoom = coords ? MAP_ZOOM_WITH_COORDS : defaultMapZoom;
    mapRef.current?.flyTo({
      center: [fallback.lng, fallback.lat],
      zoom: fallbackZoom,
      duration: 600,
    });
  }, [coords]);

  const [geoRequesting, setGeoRequesting] = useState(false);

  const handleUseMyLocation = useCallback(() => {
    if (geoRequesting) return;
    setGeoRequesting(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const newCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        setLocationCoords(newCoords);
        setLocationQuery("");
        setGeoRequesting(false);
        mapRef.current?.flyTo({
          center: [newCoords.lng, newCoords.lat],
          zoom: MAP_ZOOM_WITH_COORDS,
          duration: 800,
        });
      },
      () => {
        setGeoRequesting(false);
        // Silently fail — the user denied permission
      },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [geoRequesting]);

  // ── Navigate to event detail ─────────────────────────────────────────────
  const navigateToEvent = useCallback(
    (slug: string) => {
      if (slug) router.push(`/events/${slug}`);
    },
    [router],
  );

  // ── Initialise map ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isMapEnabled || !mapContainerRef.current) return;

    const center = effectiveCoords ?? usCentroid;
    const zoom = effectiveCoords ? MAP_ZOOM_WITH_COORDS : defaultMapZoom;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: mapStyle,
        center: [center.lng, center.lat],
        zoom,
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
      // A cold-starting tileserver can drop the first style fetch.
      if (retryStyleLoad(e)) return;
      setMapError(true);
      try {
        map.remove();
      } catch {
        /* already gone */
      }
      mapRef.current = null;
    });

    // Disable rotation
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    map.on("load", () => {
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
      setMapLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- map should only init once on mount
  }, []);

  // ── Add clustered source + layers when event data arrives ────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !mapEvents?.events?.length) return;

    const events = mapEvents.events as MapEvent[];
    const geojson = buildGeoJson(events);

    // ── Source (with clustering) ───────────────────────────────────────────
    if (map.getSource(SOURCE_ID)) {
      (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource).setData(geojson);
    } else {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterRadius: CLUSTER_RADIUS,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
      });

      // ── Cluster circles ──────────────────────────────────────────────
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": markerPaint.clusterFill,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            16, // 1–9
            10,
            22, // 10–24
            25,
            28, // 25+
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": markerPaint.clusterStroke,
        },
      });

      // ── Cluster count labels ─────────────────────────────────────────
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-size": 11,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": markerPaint.clusterText,
        },
      });

      // ── Individual event markers (unclustered) ───────────────────────
      // Exact events: sharp white pin. Obscured events (server-coarsened
      // coordinate, FR-013): a soft, blurred blob so the marker reads as
      // "somewhere around here", never a precise venue pin.
      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": ifObscured(
            markerPaint.pinObscuredFill,
            markerPaint.pinFill,
          ),
          "circle-radius": ifObscured(16, 6),
          "circle-blur": ifObscured(0.7, 0),
          "circle-stroke-width": ifObscured(0, 2),
          "circle-stroke-color": markerPaint.pinStroke,
        },
      });

      // ── Outer ring: glow on exact pins, faint halo on obscured blobs ──
      map.addLayer({
        id: "unclustered-glow",
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "transparent",
          "circle-radius": ifObscured(22, 12),
          "circle-stroke-width": ifObscured(1, 3),
          "circle-stroke-color": ifObscured(
            markerPaint.glowObscured,
            markerPaint.glowExact,
          ),
        },
      });

      // ── Interactions ─────────────────────────────────────────────────

      // Click cluster → zoom into it
      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["clusters"],
        });
        if (!features.length) return;
        const clusterId = features[0].properties?.cluster_id;
        if (clusterId == null) return;
        (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource)
          .getClusterExpansionZoom(clusterId)
          .then((zoom) => {
            if (zoom == null) return;
            const geom = features[0].geometry;
            if (geom.type !== "Point") return;
            map.easeTo({
              center: geom.coordinates as [number, number],
              zoom,
              duration: 400,
            });
          })
          .catch(traceIgnoredError("home.heroMap.clusterExpand"));
      });

      // Click individual pin → show popup with link to event
      map.on("click", "unclustered-point", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["unclustered-point"],
        });
        if (!features.length) return;
        const props = features[0].properties;
        const geom = features[0].geometry;
        if (!props || geom.type !== "Point") return;

        const slug = props.slug as string;
        const title = props.title as string;
        const venue = props.venue as string;
        const isObscuredEvent = props.obscured === true;
        const lngLat = geom.coordinates as [number, number];

        popupRef.current?.remove();

        // Popup copy rides `onStructure`, matching the close button in
        // globals.css: `.hero-map-popup` is a hard navy card in BOTH themes, and
        // `onStructure` is the light foreground in every theme (paper on Stub,
        // white on Ember). This is popup *DOM*, not MapLibre paint, so `var()`
        // resolves here.
        const linkHtml = slug
          ? `<a href="/events/${esc(slug)}" class="hero-map-link" style="display:block;margin-top:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--onStructure, #FDFAF3);text-decoration:none;">View event &rarr;</a>`
          : "";

        // Plain qualifier so the blob never reads as a venue pin. Translated
        // text flows through esc() like every other popup string.
        const obscuredHtml = isObscuredEvent
          ? `<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:color-mix(in srgb, var(--onStructure, #FDFAF3) 45%, transparent);margin-top:3px;">${esc(String(tRef.current("home.mapApproximateArea")))}</div>`
          : "";

        popupRef.current = new maplibregl.Popup({
          offset: 14,
          closeButton: false,
          closeOnClick: true,
          className: "hero-map-popup",
          maxWidth: "220px",
        })
          .setLngLat(lngLat)
          .setHTML(
            `<div style="font-size:12px;font-weight:700;color:var(--onStructure, #FDFAF3);text-transform:uppercase;letter-spacing:0.5px;line-height:1.3;">${esc(title)}</div>` +
              `<div style="font-size:10px;color:color-mix(in srgb, var(--onStructure, #FDFAF3) 60%, transparent);margin-top:3px;">${esc(venue)}</div>` +
              obscuredHtml +
              linkHtml,
          )
          .addTo(map);

        // Allow clicking the popup link to navigate via Next router
        const popupEl = popupRef.current.getElement();
        const linkEl = popupEl?.querySelector(".hero-map-link");
        if (linkEl && slug) {
          linkEl.addEventListener("click", (evt) => {
            evt.preventDefault();
            navigateToEvent(slug);
          });
        }
      });

      // Cursor feedback
      map.on("mouseenter", "clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "clusters", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "unclustered-point", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "unclustered-point", () => {
        map.getCanvas().style.cursor = "";
      });
    }

    // Fit map to show all events
    fitMapToEvents(map, events, effectiveCoords);
  }, [mapEvents, mapLoaded, effectiveCoords, navigateToEvent, markerPaint]);

  // ── Fallback: map disabled or errored ────────────────────────────────────
  if (!isMapEnabled || mapError) {
    // Debug helper: show runtime info when requested via query param
    const showDebug = (() => {
      try {
        if (typeof window === "undefined") return false;
        const url = new URL(window.location.href);
        return (
          url.searchParams.get("debugmaps") === "1" ||
          process.env.NODE_ENV !== "production"
        );
      } catch {
        return false;
      }
    })();

    return (
      <div className="swiss-diagonal" style={fallbackStyle} aria-hidden>
        <span style={fallbackTextStyle}>
          {String(t("home.mapUnavailable"))}
        </span>
        {showDebug && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              // Debug-only overlay (dev tool, never shipped to users). It brings
              // its own opaque black box on every theme, so the white here is
              // white-on-black and deliberately fixed alongside it.
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              padding: 8,
              fontSize: 12,
              zIndex: 10,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Map Debug</div>
            <div>
              NEXT_PUBLIC_TILESERVER_URL:{" "}
              {String(process.env.NEXT_PUBLIC_TILESERVER_URL)}
            </div>
            <div>isMapEnabled: {String(isMapEnabled)}</div>
            <div>mapError: {String(mapError)}</div>
            <DebugStyleCheck styleUrl={mapStyle} />
          </div>
        )}
      </div>
    );
  }

  const eventCount = mapEvents?.events?.length ?? 0;
  const showSkeleton = !mapLoaded || eventsLoading;

  return (
    <div style={containerStyle} aria-label="Event map">
      {/* Skeleton loader — visible until map + events are ready */}
      {showSkeleton && (
        <div style={skeletonStyle} aria-hidden>
          <div style={skeletonPulseStyle} />
          <span
            style={{
              position: "absolute",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              // Theme-tracking — see fallbackTextStyle.
              color: "var(--color, #211C16)",
            }}
          >
            {String(t("home.mapLoading"))}
          </span>
        </div>
      )}

      <div
        ref={mapContainerRef}
        style={{ ...mapContainerStyle, filter: markerPaint.mapFilter }}
      />

      {/* ── Location search overlay ──────────────────────────────────────── */}
      <div className="hero-map-location-overlay" style={locationOverlayStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <LocationAutocomplete
            value={locationQuery}
            onChange={setLocationQuery}
            onSelect={handlePlaceSelect}
            placeholder={String(t("home.mapEnterAddress"))}
            testIdBase="hero-map-location"
          />
        </div>
        {/* Clear button — visible only when a location is active */}
        {(locationQuery.length > 0 || locationCoords != null) && (
          <button
            type="button"
            title="Clear location"
            aria-label="Clear location"
            onClick={handleClearLocation}
            style={clearBtnStyleT}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = chrome.textStrong;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = chrome.textDim;
            }}
          >
            <X size={14} />
          </button>
        )}
        <button
          type="button"
          title="Use my location"
          aria-label="Use my location"
          onClick={handleUseMyLocation}
          style={locationBtnStyleT}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = accentColor;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = chrome.text;
          }}
        >
          <Navigation size={15} />
        </button>
      </div>

      {/*
        The event-count chip overlays the bottom of the map.
        On mobile the hero is only ~480px tall, so the map's bottom strip
        sits exactly where the content layer's BROWSE / CREATE buttons
        render. Hide the decorative count on mobile, but keep the time
        range controls accessible by moving them below the location search.
      */}
      {!isMobile && eventCount > 0 && (
        <div style={overlayStyleT}>
          <span style={{ ...overlayCountStyle, color: accentColor }}>
            {eventCount}
          </span>
          <span style={overlayTextStyleT}>
            {hasCoords
              ? String(t("home.mapNearby"))
              : String(t("home.mapEvents"))}{" "}
            &middot; {twLabels[timeWindow]}
          </span>
        </div>
      )}

      {/* ── Time-window chip bar ─────────────────────────────────────────── */}
      <div
        style={isMobile ? mobileChipBarStyle : chipBarStyle}
        role="group"
        aria-label="Map time range"
      >
        {TIME_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={timeWindow === w}
            onClick={() => setTimeWindow(w)}
            style={chipStyleT(timeWindow === w)}
            onMouseEnter={(e) => {
              if (timeWindow !== w) {
                e.currentTarget.style.color = chrome.textStrong;
                e.currentTarget.style.borderColor = chrome.chipHoverBorder;
              }
            }}
            onMouseLeave={(e) => {
              if (timeWindow !== w) {
                e.currentTarget.style.color = chrome.chipInactiveText;
                e.currentTarget.style.borderColor = chrome.border;
              }
            }}
          >
            {twLabels[w]}
          </button>
        ))}
      </div>
    </div>
  );
}
