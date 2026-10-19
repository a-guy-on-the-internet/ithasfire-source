"use client";

import { useEffect, useMemo, useRef } from "react";
import type maplibregl from "maplibre-gl";
import { useTranslations } from "@th/ui";

import {
  ARRIVAL_AREA_PAINT,
  LEGEND_LABEL_KEY,
  areaBounds,
  legendKeysFor,
  toFeatureCollection,
  type ArrivalAreaLegendKey,
  type VisibleArrivalArea,
} from "./arrival-areas";
import styles from "./arrival-areas.module.css";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

// ─────────────────────────────────────────────────────────────────────────────
// Arrival areas drawn on the detail map (arrival-areas FR-006, NFR-003).
//
// A MapLibre GeoJSON source plus a handful of layers on the map that
// `LocationMapPreview` already owns. Renders no DOM of its own: the map is
// supplementary, and the "Getting there" list is the text twin every area is
// reachable from by keyboard.
//
// Kinds differ by PATTERN as well as colour: parking is solid (a filled lot,
// or a thick line for street parking), accessible drop-off is a dotted
// outline, load-in is dashed. The selected area gets an accent casing and the
// rest dim, so the selection reads without relying on colour alone.
//
// Malformed or null geometry is never handed to MapLibre (see
// `drawableGeometry`). NFR-002: nothing here logs a shape or a point.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_ID = "arrival-areas";
const L_FILL = "arrival-areas-fill";
const L_SELECTED = "arrival-areas-selected";
const L_SOLID = "arrival-areas-line-solid";
const L_DOTTED = "arrival-areas-line-dotted";
const L_DASHED = "arrival-areas-line-dashed";
const L_HIT = "arrival-areas-hit";

const ALL_LAYERS = [L_HIT, L_DASHED, L_DOTTED, L_SOLID, L_SELECTED, L_FILL];
const CLICK_LAYERS = [L_HIT, L_FILL];

/** Areas never zoom past this when the map frames them. */
const FIT_MAX_ZOOM = 17;

type Expr = maplibregl.ExpressionSpecification;

const isLine: Expr = ["==", ["geometry-type"], "LineString"];

function isSelected(selectedId: string | null): Expr {
  return ["==", ["get", "id"], selectedId ?? ""];
}

function kindColor(): Expr {
  return [
    "match",
    ["get", "kind"],
    "ACCESSIBLE_DROP_OFF",
    ARRIVAL_AREA_PAINT.dropOffLine,
    "LOAD_IN",
    ARRIVAL_AREA_PAINT.loadIn,
    ARRIVAL_AREA_PAINT.parking,
  ];
}

function fillColor(): Expr {
  return [
    "match",
    ["get", "kind"],
    "ACCESSIBLE_DROP_OFF",
    ARRIVAL_AREA_PAINT.dropOffFill,
    "LOAD_IN",
    ARRIVAL_AREA_PAINT.loadIn,
    ARRIVAL_AREA_PAINT.parking,
  ];
}

function fillOpacity(selectedId: string | null): Expr | number {
  const base: Expr = ["match", ["get", "kind"], "LOAD_IN", 0.1, 0.24];
  if (!selectedId) return base;
  return ["case", isSelected(selectedId), 0.34, 0.08];
}

function lineOpacity(selectedId: string | null): Expr | number {
  if (!selectedId) return 1;
  return ["case", isSelected(selectedId), 1, 0.4];
}

function lineWidth(selectedId: string | null): Expr {
  return [
    "case",
    isLine,
    ["case", isSelected(selectedId), 7, 5],
    ["case", isSelected(selectedId), 3, 2],
  ];
}

function outlineLayer(
  id: string,
  kindFilter: Expr,
  selectedId: string | null,
  dash: number[] | null,
): maplibregl.LineLayerSpecification {
  return {
    id,
    type: "line",
    source: SOURCE_ID,
    filter: kindFilter,
    layout: {
      // Dots need round caps; dashes and solid lines keep square ends.
      "line-cap": (dash?.[0] ?? 1) < 1 ? "round" : "butt",
      "line-join": "round",
    },
    paint: {
      "line-color": kindColor(),
      "line-width": lineWidth(selectedId),
      "line-opacity": lineOpacity(selectedId),
      ...(dash ? { "line-dasharray": dash } : {}),
    },
  };
}

/**
 * Adds every arrival-area layer that is not on the map yet. Idempotent, so a
 * partial add (the source landed, a later layer threw) is completed by the
 * next `ensure` instead of leaving the map half drawn for good.
 */
function addLayers(map: maplibregl.Map, selectedId: string | null): void {
  const add = (layer: maplibregl.LayerSpecification) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  };
  add({
    id: L_FILL,
    type: "fill",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": fillColor(),
      "fill-opacity": fillOpacity(selectedId),
    },
  });
  // The selection casing: an accent band under the selected shape's own line.
  add({
    id: L_SELECTED,
    type: "line",
    source: SOURCE_ID,
    filter: isSelected(selectedId),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ARRIVAL_AREA_PAINT.selected,
      "line-width": ["case", isLine, 12, 7],
    },
  });
  add(
    outlineLayer(L_SOLID, ["==", ["get", "kind"], "PARKING"], selectedId, null),
  );
  add(
    outlineLayer(
      L_DOTTED,
      ["==", ["get", "kind"], "ACCESSIBLE_DROP_OFF"],
      selectedId,
      [0.1, 1.8],
    ),
  );
  add(
    outlineLayer(L_DASHED, ["==", ["get", "kind"], "LOAD_IN"], selectedId, [
      3, 2,
    ]),
  );
  // A wide invisible band so a street line is tappable with a finger.
  add({
    id: L_HIT,
    type: "line",
    source: SOURCE_ID,
    filter: isLine,
    paint: { "line-color": ARRIVAL_AREA_PAINT.casing, "line-width": 22, "line-opacity": 0 },
  });
}

/** MapLibre's "style is not done loading" throw, the one expected miss. */
function isStyleNotReady(err: unknown): boolean {
  return (
    err instanceof Error && /style is not done loading/i.test(err.message)
  );
}

function applySelection(map: maplibregl.Map, selectedId: string | null): void {
  if (!map.getLayer(L_FILL)) return;
  map.setPaintProperty(L_FILL, "fill-opacity", fillOpacity(selectedId));
  map.setFilter(L_SELECTED, isSelected(selectedId));
  for (const id of [L_SOLID, L_DOTTED, L_DASHED]) {
    map.setPaintProperty(id, "line-width", lineWidth(selectedId));
    map.setPaintProperty(id, "line-opacity", lineOpacity(selectedId));
  }
}

function removeAll(map: maplibregl.Map): void {
  try {
    for (const id of ALL_LAYERS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  } catch {
    // The map was already removed with its container.
  }
}

export type ArrivalAreasLayerProps = {
  /** The map to draw on, once its style has loaded. */
  map: maplibregl.Map | null;
  areas: readonly VisibleArrivalArea[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Kept in frame with the areas when the map fits them (the place pin). */
  pin?: { lat: number; lng: number } | null;
  /**
   * Fit the map to the areas whenever the set changes (default). The editor
   * turns this off: it frames the map once and the person pans from there,
   * so selecting an area must not move the camera.
   */
  fitToAreas?: boolean;
};

export function ArrivalAreasLayer({
  map,
  areas,
  selectedId,
  onSelect,
  pin,
  fitToAreas = true,
}: ArrivalAreasLayerProps) {
  const data = useMemo(() => toFeatureCollection(areas), [areas]);
  const pinLat = pin?.lat ?? null;
  const pinLng = pin?.lng ?? null;
  // A string key, so a caller passing a fresh `pin` object every render does
  // not tear the layers down and re-fit the map.
  const boundsKey = useMemo(() => {
    const b = areaBounds(
      areas,
      pinLat !== null && pinLng !== null ? { lat: pinLat, lng: pinLng } : null,
    );
    return b ? b.join(",") : null;
  }, [areas, pinLat, pinLng]);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Source, layers, click handling. Re-run when the area set changes.
  useEffect(() => {
    if (!map) return;
    if (data.features.length === 0) {
      removeAll(map);
      return;
    }

    const ensure = () => {
      try {
        const source = map.getSource(SOURCE_ID) as
          | maplibregl.GeoJSONSource
          | undefined;
        if (source) {
          source.setData(data);
        } else {
          map.addSource(SOURCE_ID, { type: "geojson", data });
        }
        // Every time, not only with a new source: completes a partial add.
        addLayers(map, selectedRef.current);
      } catch (err) {
        // Style not ready yet: `style.load` re-runs this. Anything else is a
        // real failure, traced under a fixed label (NFR-002: never the data,
        // and MapLibre's own messages name layers, not coordinates).
        if (!isStyleNotReady(err)) {
          traceIgnoredError("maps.arrivalAreas.layer")(err);
        }
      }
    };
    ensure();
    // A style reload (the cold-start retry) drops custom layers.
    map.on("style.load", ensure);

    const bounds =
      fitToAreas && boundsKey ? boundsKey.split(",").map(Number) : null;
    if (bounds?.length === 4) {
      try {
        map.fitBounds(
          [
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ],
          { padding: 28, maxZoom: FIT_MAX_ZOOM, duration: 0 },
        );
      } catch {
        // A degenerate box (one point) keeps the map's own framing.
      }
    }

    const hit = (point: maplibregl.PointLike) => {
      try {
        const layers = CLICK_LAYERS.filter((id) => map.getLayer(id));
        if (layers.length === 0) return null;
        const features = map.queryRenderedFeatures(point, { layers });
        const id = features[0]?.properties?.id;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    };
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const id = hit(e.point);
      if (id) onSelectRef.current(id);
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      map.getCanvas().style.cursor = hit(e.point) ? "pointer" : "";
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);

    return () => {
      map.off("style.load", ensure);
      map.off("click", onClick);
      map.off("mousemove", onMove);
      try {
        map.getCanvas().style.cursor = "";
      } catch {
        // Map already removed.
      }
      removeAll(map);
    };
  }, [map, data, boundsKey, fitToAreas]);

  useEffect(() => {
    if (!map) return;
    try {
      applySelection(map, selectedId);
    } catch {
      // Layers not added yet; `addLayers` reads the current selection.
    }
  }, [map, selectedId]);

  return null;
}

/**
 * The legend under the map: one entry per kind (and per street parking) that
 * is actually drawn, swatch colour AND pattern. Renders nothing when nothing
 * is drawn.
 */
export function ArrivalAreasLegend({
  areas,
}: {
  areas: readonly VisibleArrivalArea[];
}) {
  const t = useTranslations();
  const keys = legendKeysFor(areas);
  if (keys.length === 0) return null;
  return (
    <div className={styles.root}>
      <ul
        className={styles.legend}
        aria-label={String(t("arrivalAreas.legendLabel"))}
        data-testid="arrival-areas-legend"
      >
        {keys.map((key) => (
          <li key={key} className={styles.legendItem}>
            <ArrivalAreaSwatch kind={key} />
            {String(t(LEGEND_LABEL_KEY[key]))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ArrivalAreaSwatch({ kind }: { kind: ArrivalAreaLegendKey }) {
  return <span className={styles.swatch} data-kind={kind} aria-hidden="true" />;
}
