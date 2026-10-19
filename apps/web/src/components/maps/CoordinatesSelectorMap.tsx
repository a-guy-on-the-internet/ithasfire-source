"use client";

import {
  useMemo,
  useRef,
  useState,
  useEffect,
  type CSSProperties,
} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  coordinatesPickerZoom,
  isMapEnabled,
  mapStyleLight,
  type LatLngLiteral,
  usCentroid,
} from "@/config/maps";

import { useTranslations } from "@th/ui";
import {
  installMissingImageFallback,
  transformLocalMapLibreRequest,
} from "./maplibre-missing-image";
import { installStyleLoadRetry } from "./maplibre-style-retry";

// ─────────────────────────────────────────────────────────────────────────────
// Styles (inline)
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE_STYLE: CSSProperties = {
  position: "relative",
  flex: 1,
  height: "100%",
  minHeight: 320,
  width: "100%",
  overflow: "hidden",
  borderRadius: 0,
  // Outer frame — sits against the page canvas (cream in Stub), so it must be
  // an ink hairline, not the retired dark theme's white alpha.
  border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
  backgroundColor: "rgba(15, 23, 42, 0.4)",
};

const OVERLAY_STYLE: CSSProperties = {
  pointerEvents: "none",
  position: "absolute",
  bottom: 12,
  left: 12,
  zIndex: 10,
  display: "flex",
  gap: 6,
  alignItems: "center",
};

// NOTE: the badges below are a deliberately DARK overlay chrome (fixed slate
// fill in every theme) floating on the light map canvas — their white-alpha
// foregrounds are CORRECT and must not be inverted to ink. Only convert these
// if the badge fill itself is ever re-tokenised to a theme surface.
const COORD_BADGE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 10px",
  borderRadius: 0,
  backgroundColor: "rgba(15, 23, 42, 0.75)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  fontSize: 12,
  fontWeight: 700,
  // Coordinate readout is code-like → system mono stack (never a webfont).
  fontFamily: "var(--font-mono, monospace)",
  color: "rgba(255, 255, 255, 0.9)",
  letterSpacing: 0.3,
};

const COORD_LABEL_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  color: "rgba(255, 255, 255, 0.5)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const HINT_BADGE_STYLE: CSSProperties = {
  pointerEvents: "none",
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10,
  padding: "5px 12px",
  borderRadius: 0,
  backgroundColor: "rgba(15, 23, 42, 0.75)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  fontSize: 12,
  fontWeight: 500,
  color: "rgba(255, 255, 255, 0.7)",
  whiteSpace: "nowrap",
};

const FALLBACK_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  height: "100%",
  minHeight: 320,
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0,
  border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
  backgroundColor: "rgba(15, 23, 42, 0.4)",
  fontSize: 14,
  // Ink copy: this box has no map under it, so the 40%-slate wash composites
  // straight onto the page canvas (~#999 on Stub cream) where the old white
  // was 2.2:1. Ink clears AA. TODO: the slate wash itself is dark-theme debt.
  color: "var(--color, #211C16)",
};

// ── Center pin overlay ───────────────────────────────────────────────────
// Always visible — the map slides underneath so the pin tip marks the
// selected location.  The pin is pure CSS with no extra assets.

const CENTER_PIN_CONTAINER_STYLE: CSSProperties = {
  pointerEvents: "none",
  position: "absolute",
  inset: 0,
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const CENTER_PIN_STYLE: CSSProperties = {
  position: "relative",
  // Shift up so the point of the pin sits at the exact center of the map.
  transform: "translateY(-50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.35))",
};

const PIN_HEAD_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 0,
  backgroundColor: "#0ea5e9",
  border: "3px solid #fff",
  boxSizing: "border-box",
};

const PIN_TAIL_STYLE: CSSProperties = {
  width: 0,
  height: 0,
  borderLeft: "6px solid transparent",
  borderRight: "6px solid transparent",
  borderTop: "10px solid #fff",
  marginTop: -1,
};

// Small dot that sits exactly at the map center (ground level)
const PIN_DOT_STYLE: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 0,
  backgroundColor: "rgba(14, 165, 233, 0.5)",
  marginTop: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export type CoordinatesSelectorMapProps = {
  latitude?: number | null;
  longitude?: number | null;
  onPositionChangeAction?: (value: LatLngLiteral) => void;
  label?: string | null;
  style?: CSSProperties;
  /**
   * When false the map is non-interactive — dragging, scrolling, zooming and
   * keyboard shortcuts are all disabled.  The centre pin and coordinate
   * badges still render so the user sees where the pin is.
   * Defaults to `true`.
   */
  interactive?: boolean;
};

const toPosition = (
  latitude?: number | null,
  longitude?: number | null,
): LatLngLiteral | null => {
  if (typeof latitude !== "number" || Number.isNaN(latitude)) return null;
  if (typeof longitude !== "number" || Number.isNaN(longitude)) return null;
  return { lat: latitude, lng: longitude } satisfies LatLngLiteral;
};

export const CoordinatesSelectorMap = ({
  latitude,
  longitude,
  onPositionChangeAction,
  label,
  style,
  interactive = true,
}: CoordinatesSelectorMapProps) => {
  const t = useTranslations();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const initialPosition = useMemo(
    () => toPosition(latitude, longitude),
    [latitude, longitude],
  );
  const mapCenter = initialPosition ?? usCentroid;

  const [displayCenter, setDisplayCenter] = useState<LatLngLiteral>(mapCenter);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPropPositionRef = useRef<string>("");
  const onPositionChangeRef = useRef(onPositionChangeAction);
  onPositionChangeRef.current = onPositionChangeAction;

  // Track whether the user is actively dragging the map so we can suppress
  // the prop-driven flyTo (which would fight the user's gesture).
  const isDraggingRef = useRef(false);
  // After a user-initiated move we mark the position so the prop-sync
  // effect skips the flyTo when the parent echoes it back.
  const userMoveKeyRef = useRef<string>("");

  // Initialise MapLibre map once
  useEffect(() => {
    if (!containerRef.current || !isMapEnabled) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyleLight,
      center: [mapCenter.lng, mapCenter.lat],
      zoom: coordinatesPickerZoom,
      attributionControl: false,
      // Disable all interaction handlers when starting locked
      dragPan: interactive,
      dragRotate: interactive,
      scrollZoom: interactive,
      touchZoomRotate: interactive,
      doubleClickZoom: interactive,
      keyboard: interactive,
      // Shift+drag box zoom moves the map without `originalEvent`, so the
      // moveend guard below would drop it; a centre-pin picker has no use for it.
      boxZoom: false,
      transformRequest: transformLocalMapLibreRequest,
    });

    installMissingImageFallback(map, mapStyleLight);
    // No failure UI here; just retry a style the tileserver dropped once.
    const retryStyleLoad = installStyleLoadRetry(map, mapStyleLight);
    map.on("error", (e) => {
      // A listener turns off MapLibre's console fallback; keep it for the rest.
      if (!retryStyleLoad(e)) console.error(e?.error ?? e);
    });

    map.on("dragstart", () => {
      isDraggingRef.current = true;
      // Cancel any pending position-change callback while the user grabs the map
      if (debounceRef.current) clearTimeout(debounceRef.current);
    });

    map.on("dragend", () => {
      isDraggingRef.current = false;
    });

    map.on("moveend", (e: { originalEvent?: unknown }) => {
      const center = map.getCenter();
      const pos: LatLngLiteral = { lat: center.lat, lng: center.lng };
      setDisplayCenter(pos);

      // MapLibre sets `originalEvent` only on user gestures (drag, inertia,
      // wheel, keyboard, tap zoom). Our own flyTo/resize never carry it, and
      // must not report as a pin move (it would clear the place and
      // reverse-geocode over the stored address). Return before touching the
      // debounce so a pending user move is not cancelled.
      if (!e.originalEvent) return;

      // Don't fire callback while user is still dragging (intermediate moveend
      // events can fire during momentum / programmatic flyTo overlap).
      if (isDraggingRef.current) return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        // Record the key so the prop-sync effect can recognise this as an
        // echo of the user's move and skip the flyTo.
        const key = `${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}`;
        userMoveKeyRef.current = key;
        lastPropPositionRef.current = key;
        onPositionChangeRef.current?.(pos);
      }, 550);
    });

    map.on("move", () => {
      const center = map.getCenter();
      setDisplayCenter({ lat: center.lat, lng: center.lng });
    });

    mapRef.current = map;
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      map.remove();
      mapRef.current = null;
    };
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pan map when parent passes new coordinates (e.g. after search selection).
  // Skip when the position was echoed back from a user drag — the map is
  // already centred there and flying to it would cause a visible bounce.
  useEffect(() => {
    if (!mapRef.current || !initialPosition) return;
    if (isDraggingRef.current) return; // never fight an active drag gesture
    const key = `${initialPosition.lat.toFixed(6)},${initialPosition.lng.toFixed(6)}`;
    if (key === lastPropPositionRef.current) return;
    // If the position matches what the user just dragged to, record it
    // but don't flyTo — the map is already there.
    if (key === userMoveKeyRef.current) {
      lastPropPositionRef.current = key;
      return;
    }
    lastPropPositionRef.current = key;
    userMoveKeyRef.current = ""; // clear — this is an external update
    mapRef.current.flyTo({
      center: [initialPosition.lng, initialPosition.lat],
      zoom: coordinatesPickerZoom,
    });
  }, [initialPosition]);

  // Toggle map interactivity when the `interactive` prop changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handlers = [
      map.dragPan,
      map.dragRotate,
      map.scrollZoom,
      map.touchZoomRotate,
      map.doubleClickZoom,
      map.keyboard,
    ] as const;

    for (const h of handlers) {
      if (interactive) h.enable();
      else h.disable();
    }
  }, [interactive]);

  if (!isMapEnabled) {
    const message =
      process.env.NODE_ENV === "production"
        ? String(t("admin.mapPickerUnavailable"))
        : "Configure NEXT_PUBLIC_TILESERVER_URL to drop a pin on the map.";
    return <div style={{ ...FALLBACK_STYLE, ...style }}>{message}</div>;
  }

  return (
    <div style={{ ...SURFACE_STYLE, ...style }}>
      {/* Hint badge — top center (only when interactive) */}
      {interactive && (
        <div style={HINT_BADGE_STYLE}>{String(t("admin.mapPanHint"))}</div>
      )}

      {/* Coordinate badges — bottom left */}
      <div style={OVERLAY_STYLE}>
        <div style={COORD_BADGE_STYLE}>
          <span style={COORD_LABEL_STYLE}>{String(t("admin.lpiLat"))}</span>
          {displayCenter.lat.toFixed(5)}
        </div>
        <div style={COORD_BADGE_STYLE}>
          <span style={COORD_LABEL_STYLE}>{String(t("admin.lpiLng"))}</span>
          {displayCenter.lng.toFixed(5)}
        </div>
      </div>

      {/* Center pin — always visible, the map slides underneath it */}
      <div style={CENTER_PIN_CONTAINER_STYLE}>
        <div style={CENTER_PIN_STYLE}>
          <div style={PIN_HEAD_STYLE} />
          <div style={PIN_TAIL_STYLE} />
          <div style={PIN_DOT_STYLE} />
        </div>
      </div>

      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
};
