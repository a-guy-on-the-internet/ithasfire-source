"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  detailMapZoom,
  isMapEnabled,
  mapStyleLight,
  type LatLngLiteral,
} from "@/config/maps";
import {
  installMissingImageFallback,
  transformLocalMapLibreRequest,
} from "./maplibre-missing-image";
import { installStyleLoadRetry } from "./maplibre-style-retry";
import { ArrivalAreasLayer } from "./ArrivalAreasLayer";
import type { VisibleArrivalArea } from "./arrival-areas";
import {
  buildCircleGeoJson,
  resolveDisplayCenter,
} from "./location-map-preview.helpers";

const FALLBACK_STYLE: React.CSSProperties = {
  display: "flex",
  height: "20rem" /* ~320px */,
  minHeight: 240,
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0 /* Swiss: strictly rectangular */,
  border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
  background: "rgba(15,23,42,0.4)" /* slate-900/40 */,
  fontSize: "0.875rem",
  // Ink copy — the 40% slate wash composites onto the page canvas (~#999 on
  // Stub cream), where the retired white was 2.2:1. Ink clears AA.
  color: "var(--color, #211C16)",
};

const MAP_CONTAINER_STYLE: React.CSSProperties = {
  position: "relative",
  height: "20rem" /* ~320px */,
  minHeight: 240,
  width: "100%",
  overflow: "hidden",
  borderRadius: 0,
  // Outer frame against the page canvas (cream in Stub) — ink hairline.
  border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
  background: "rgba(15,23,42,0.4)",
};

export type LocationMapPreviewProps = {
  latitude?: number | null;
  longitude?: number | null;
  label?: string | null;
  missingMessage?: string;
  /** When false the map renders a radius circle instead of a pin. */
  isExact?: boolean;
  /** Radius in metres for approximate / hidden locations. */
  radiusMeters?: number | null;
  /**
   * When true, the provided coordinates are ALREADY an obfuscated point
   * (e.g. the server-redacted centre from `redactLocation`). The circle is
   * centred on them directly, with no additional client-side jitter —
   * double-offsetting (server up to 70 % of radius + client up to 33 %)
   * could push the real venue outside the drawn circle. Leave false when
   * passing true coordinates (admin builder preview), where the client
   * jitter is what keeps the exact centre unrevealed.
   */
  preObfuscated?: boolean;
  /** Optional container height (css string like '100%' or number in px). */
  height?: string | number;
  /**
   * Arrival areas to draw (arrival-areas FR-006). Omitted = today's map,
   * unchanged. The caller owns the selection so the "Getting there" list
   * and the map stay in sync.
   */
  arrivalAreas?: {
    areas: readonly VisibleArrivalArea[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  };
};

const buildPosition = (
  latitude?: number | null,
  longitude?: number | null,
): LatLngLiteral | null => {
  if (typeof latitude !== "number" || Number.isNaN(latitude)) return null;
  if (typeof longitude !== "number" || Number.isNaN(longitude)) return null;
  return { lat: latitude, lng: longitude } satisfies LatLngLiteral;
};

/**
 * Compute a MapLibre zoom level that ensures a circle of `radiusMetres`
 * fits comfortably within the map container. Uses the Web Mercator
 * metres-per-pixel formula with a 2.5× padding multiplier so the circle
 * is well within the viewport edges.
 */
function zoomForRadius(lat: number, radiusMetres: number): number {
  const WORLD_PX = 512; // MapLibre tile size at zoom 0
  const EQUATOR_M = 40_075_016.686;
  // We want the full diameter (× 2.5 padding) to fit the smaller viewport
  // dimension. Assume ~320 px as a conservative container size.
  const viewportPx = 320;
  const metresToFit = radiusMetres * 2 * 2.5;
  const metresPerPixel = metresToFit / viewportPx;
  const metresPerPixelAtZoom0 =
    (EQUATOR_M * Math.cos((lat * Math.PI) / 180)) / WORLD_PX;
  const zoom = Math.log2(metresPerPixelAtZoom0 / metresPerPixel);
  // Clamp between 1 (whole world) and 18 (street level)
  return Math.max(1, Math.min(18, zoom));
}

export const LocationMapPreview = ({
  latitude,
  longitude,
  label,
  missingMessage = "Location coordinates unavailable",
  isExact = true,
  radiusMeters,
  preObfuscated = false,
  height,
  arrivalAreas,
}: LocationMapPreviewProps) => {
  const position = useMemo(
    () => buildPosition(latitude, longitude),
    [latitude, longitude],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  // The map once its style has parsed: what an overlay layer may draw on.
  const [styledMap, setStyledMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!isMapEnabled || !position || !containerRef.current) return;

    // For approximate locations, jitter the displayed centre so the real
    // pin position isn't revealed. The jitter is deterministic (same
    // coords always produce the same offset). Skipped when the caller's
    // coordinates are already server-obfuscated (`preObfuscated`).
    const radius = radiusMeters ?? 500;
    const displayCenter = resolveDisplayCenter({
      position,
      isExact,
      preObfuscated,
      radiusMetres: radius,
    });

    // For approximate locations, compute a zoom level that shows the
    // entire radius circle with comfortable padding. Exact pins use
    // the default detail zoom.
    const zoom = isExact
      ? detailMapZoom
      : zoomForRadius(displayCenter.lat, radius);

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: mapStyleLight,
        center: [displayCenter.lng, displayCenter.lat],
        zoom,
        interactive: false,
        attributionControl: false,
        transformRequest: transformLocalMapLibreRequest,
      });
    } catch {
      setMapError("Map preview unavailable");
      return;
    }

    map.on("style.load", () => setStyledMap(map));

    installMissingImageFallback(map, mapStyleLight);
    const retryStyleLoad = installStyleLoadRetry(map, mapStyleLight);

    map.on("error", (e) => {
      // A cold-starting tileserver can drop the first style fetch.
      if (retryStyleLoad(e)) return;
      // Style URL unreachable or tile server down — show fallback
      setMapError("Map preview unavailable");
      try {
        map.remove();
      } catch {
        /* already removed */
      }
      mapRef.current = null;
      setStyledMap(null);
    });

    if (isExact) {
      new maplibregl.Marker({ color: "#0ea5e9" })
        .setLngLat([position.lng, position.lat])
        .addTo(map);
    } else {
      map.on("load", () => {
        map.addSource("radius-circle", {
          type: "geojson",
          data: buildCircleGeoJson(displayCenter, radius),
        });

        map.addLayer({
          id: "radius-circle-fill",
          type: "fill",
          source: "radius-circle",
          paint: {
            "fill-color": "#0ea5e9",
            "fill-opacity": 0.15,
          },
        });

        map.addLayer({
          id: "radius-circle-stroke",
          type: "line",
          source: "radius-circle",
          paint: {
            "line-color": "#0ea5e9",
            "line-width": 2,
            "line-opacity": 0.6,
          },
        });
      });
    }

    mapRef.current = map;
    return () => {
      setStyledMap(null);
      map.remove();
      mapRef.current = null;
    };
  }, [position, isExact, radiusMeters, preObfuscated]);

  if (!isMapEnabled) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Map preview unavailable"
        : "Configure NEXT_PUBLIC_TILESERVER_URL to preview this location.";
    const computedHeight =
      typeof height === "number"
        ? `${height}px`
        : (height ?? FALLBACK_STYLE.height);
    return (
      <div style={{ ...FALLBACK_STYLE, height: computedHeight }}>{message}</div>
    );
  }

  if (!position) {
    const computedHeight =
      typeof height === "number"
        ? `${height}px`
        : (height ?? MAP_CONTAINER_STYLE.height);
    return (
      <div style={{ ...FALLBACK_STYLE, height: computedHeight }}>
        {missingMessage}
      </div>
    );
  }

  if (mapError) {
    const computedHeight =
      typeof height === "number"
        ? `${height}px`
        : (height ?? FALLBACK_STYLE.height);
    return (
      <div style={{ ...FALLBACK_STYLE, height: computedHeight }}>
        {mapError}
      </div>
    );
  }

  const computedHeight =
    typeof height === "number"
      ? `${height}px`
      : (height ?? MAP_CONTAINER_STYLE.height);

  return (
    <div
      style={{ ...MAP_CONTAINER_STYLE, height: computedHeight }}
      data-testid="location-map-preview"
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {arrivalAreas && (
        <ArrivalAreasLayer
          map={styledMap}
          areas={arrivalAreas.areas}
          selectedId={arrivalAreas.selectedId}
          onSelect={arrivalAreas.onSelect}
          pin={isExact ? position : null}
        />
      )}
    </div>
  );
};
