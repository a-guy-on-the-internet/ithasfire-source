"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  GeoJSONStoreFeatures,
  TerraDraw,
  TerraDrawKeyboardEvent,
} from "terra-draw";

import { isMapEnabled, mapStyleLight } from "@/config/maps";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import { ArrivalAreasLayer } from "./ArrivalAreasLayer";
import { ARRIVAL_AREA_PAINT, areaBounds } from "./arrival-areas";
import {
  pinInBounds,
  shapeFromDrawGeometry,
  terraDrawModeFor,
  toDisplayArea,
  type ArrivalAreaShape,
  type EditorArrivalArea,
  type MapPin,
} from "./arrival-areas-editor.helpers";
import {
  installMissingImageFallback,
  transformLocalMapLibreRequest,
} from "./maplibre-missing-image";
import { installStyleLoadRetry, isStyleLoadFailure } from "./maplibre-style-retry";

// ─────────────────────────────────────────────────────────────────────────────
// The drawing surface of the arrival-areas editor (FR-016): a MapLibre map,
// the saved areas drawn by the step-7 layer, the basemap's OSM parking lots
// as a faint tracing guide, and Terra Draw for the one shape being drawn or
// reshaped.
//
// Terra Draw is CLIENT-ONLY: it is imported inside the map's `load` handler,
// never at module scope, so neither SSR nor `next build` prerender ever
// evaluates it.
//
// One working shape at a time. The parent owns it (`working`); this component
// mirrors it into Terra Draw's store whenever `working.key` changes, and
// reports the person's edits back (`onShapeDrawn`, `onShapeChanged`). The
// saved copy of the area being edited is left out of the display layer so it
// is not drawn twice.
//
// NFR-002: nothing here logs a geometry or a point; failures are traced
// under fixed labels.
// ─────────────────────────────────────────────────────────────────────────────

export type EditorTool = "select" | "polygon" | "linestring";

/** A map click this soon after a finish belongs to the finish, not a select. */
const FINISH_CLICK_GRACE_MS = 500;

export type EditorMapStatus =
  | "loading"
  | "ready"
  | "unavailable"
  | "outOfCoverage";

export type EditorMapHandle = {
  /** Remove the last point of the shape being drawn. */
  undoPoint: () => void;
  /** Finish the shape being drawn (same as Enter). */
  finishShape: () => void;
};

export type ArrivalAreasEditorMapProps = {
  pin: MapPin;
  /** Saved areas, drawn as on the public map. */
  areas: readonly EditorArrivalArea[];
  /** The area whose shape Terra Draw holds; left out of the display layer. */
  editingId: string | null;
  /** The shape Terra Draw should hold. A new `key` replaces it. */
  working: { key: string; shape: ArrivalAreaShape | null };
  tool: EditorTool;
  /** False disables drawing input (no pin coverage, saving, limit). */
  interactive: boolean;
  onShapeDrawn: (shape: ArrivalAreaShape) => void;
  onShapeChanged: (shape: ArrivalAreaShape) => void;
  onSelectArea: (id: string) => void;
  onDrawState: (state: { drawing: boolean; canUndo: boolean }) => void;
  onStatus: (status: EditorMapStatus) => void;
  /** Accessible name of the map region. */
  label: string;
  /** Full screen: plain one-finger pan. Inline: cooperative gestures. */
  fullScreen: boolean;
};

const DRAW_MODES = ["polygon", "linestring"] as const;
const OSM_GUIDE_LAYER = "arrival-editor-osm-parking";
const OSM_GUIDE_POINT_LAYER = "arrival-editor-osm-parking-points";
const INITIAL_ZOOM = 17;
const FIT_MAX_ZOOM = 17.5;

type Hex = `#${string}`;

/** The one mode method the Finish button needs. */
type FinishableMode = { onKeyUp: (event: TerraDrawKeyboardEvent) => void };
const hex = (value: string) => value as Hex;

/** The basemap's vector source (protomaps today), whatever its id. */
function vectorSourceId(map: maplibregl.Map): string | null {
  const sources = map.getStyle()?.sources ?? {};
  for (const [id, source] of Object.entries(sources)) {
    if ((source as { type?: string }).type === "vector") return id;
  }
  return null;
}

/**
 * OSM parking from the basemap, very faint, as a tracing guide (FR-016,
 * R3 Q7). Nothing is copied from it (one-tap copy waits on legal question
 * L15). Two layers, because the Protomaps build here (maxzoom 14) carries
 * parking only as POINTS (`pois`, kind "parking"; measured near the Greek
 * Theatre: 42 points, no `landuse` parking polygons). Lots that do come as
 * polygons shade under the roads; the points mark where a lot is.
 */
function addOsmParkingGuide(map: maplibregl.Map): void {
  const source = vectorSourceId(map);
  if (!source || map.getLayer(OSM_GUIDE_LAYER)) return;
  map.addLayer({
    id: OSM_GUIDE_POINT_LAYER,
    type: "circle",
    source,
    "source-layer": "pois",
    filter: ["==", ["get", "kind"], "parking"],
    paint: {
      "circle-radius": 5,
      "circle-color": ARRIVAL_AREA_PAINT.loadIn,
      "circle-opacity": 0.3,
    },
  });
  const layers = map.getStyle()?.layers ?? [];
  const beforeId = layers.find((layer) => layer.id.startsWith("roads"))?.id;
  map.addLayer(
    {
      id: OSM_GUIDE_LAYER,
      type: "fill",
      source,
      "source-layer": "landuse",
      filter: ["==", ["get", "kind"], "parking"],
      paint: {
        "fill-color": ARRIVAL_AREA_PAINT.loadIn,
        "fill-opacity": 0.14,
        "fill-outline-color": ARRIVAL_AREA_PAINT.loadIn,
      },
    },
    beforeId,
  );
}

/** The basemap's TileJSON bounds, once the source has loaded them. */
function basemapBounds(map: maplibregl.Map): readonly number[] | null {
  const id = vectorSourceId(map);
  if (!id) return null;
  const source = map.getSource(id) as { bounds?: unknown } | undefined;
  const bounds = source?.bounds;
  return Array.isArray(bounds) && bounds.length === 4
    ? (bounds as number[])
    : null;
}

function initialCamera(
  pin: MapPin,
  areas: readonly EditorArrivalArea[],
): { bounds: [[number, number], [number, number]] | null } {
  const b = areaBounds(areas.map(toDisplayArea), pin);
  if (!b) return { bounds: null };
  return {
    bounds: [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
  };
}

function drawStyles() {
  const line = hex(ARRIVAL_AREA_PAINT.parking);
  const accent = hex(ARRIVAL_AREA_PAINT.selected);
  const paper = hex(ARRIVAL_AREA_PAINT.casing);
  return {
    polygon: {
      fillColor: line,
      fillOpacity: 0.24,
      outlineColor: accent,
      outlineWidth: 3,
      closingPointColor: paper,
      closingPointOutlineColor: accent,
      closingPointWidth: 9,
      closingPointOutlineWidth: 3,
      coordinatePointColor: paper,
      coordinatePointOutlineColor: line,
      coordinatePointWidth: 6,
      coordinatePointOutlineWidth: 2,
    },
    linestring: {
      lineStringColor: accent,
      lineStringWidth: 5,
      closingPointColor: paper,
      closingPointOutlineColor: accent,
      closingPointWidth: 9,
      closingPointOutlineWidth: 3,
      coordinatePointColor: paper,
      coordinatePointOutlineColor: line,
      coordinatePointWidth: 6,
      coordinatePointOutlineWidth: 2,
    },
    select: {
      selectedPolygonColor: line,
      selectedPolygonFillOpacity: 0.3,
      selectedPolygonOutlineColor: accent,
      selectedPolygonOutlineWidth: 3,
      selectedLineStringColor: accent,
      selectedLineStringWidth: 6,
      selectionPointColor: paper,
      selectionPointOutlineColor: accent,
      selectionPointWidth: 7,
      selectionPointOutlineWidth: 3,
      midPointColor: paper,
      midPointOutlineColor: line,
      midPointWidth: 4,
      midPointOutlineWidth: 2,
    },
  };
}

/** Polygons and lines in Terra Draw's store, minus guidance points. */
function drawnShapes(draw: TerraDraw): GeoJSONStoreFeatures[] {
  return draw
    .getSnapshot()
    .filter(
      (f) =>
        (f.geometry.type === "Polygon" || f.geometry.type === "LineString") &&
        (f.properties?.mode === "polygon" || f.properties?.mode === "linestring"),
    );
}

export const ArrivalAreasEditorMap = forwardRef<
  EditorMapHandle,
  ArrivalAreasEditorMapProps
>(function ArrivalAreasEditorMap(
  {
    pin,
    areas,
    editingId,
    working,
    tool,
    interactive,
    onShapeDrawn,
    onShapeChanged,
    onSelectArea,
    onDrawState,
    onStatus,
    label,
    fullScreen,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [styledMap, setStyledMap] = useState<maplibregl.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const modesRef = useRef<Record<string, FinishableMode>>({});
  const [drawReady, setDrawReady] = useState(false);
  const workingIdRef = useRef<string | null>(null);
  const syncingRef = useRef(false);
  // When Terra Draw last finished a shape or an edit. The click that closes
  // a lot is also a map click: landing on another area (measured: the
  // closing corner on the Gayley Rd line), it would select that area the
  // moment the tool flips back to Select.
  const lastFinishAtRef = useRef(0);

  // Latest callbacks and inputs, read from long-lived map listeners.
  const latest = useRef({
    onShapeDrawn,
    onShapeChanged,
    onDrawState,
    onStatus,
    areas,
    tool,
  });
  latest.current = {
    onShapeDrawn,
    onShapeChanged,
    onDrawState,
    onStatus,
    areas,
    tool,
  };

  const pinLat = pin.lat;
  const pinLng = pin.lng;

  // ── The map + Terra Draw (once per pin) ──────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!isMapEnabled) {
      latest.current.onStatus("unavailable");
      return;
    }
    latest.current.onStatus("loading");
    const here = { lat: pinLat, lng: pinLng };
    let cancelled = false;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: mapStyleLight,
        center: [pinLng, pinLat],
        zoom: INITIAL_ZOOM,
        attributionControl: { compact: true },
        cooperativeGestures: !fullScreen,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        transformRequest: transformLocalMapLibreRequest,
      });
    } catch (err) {
      traceIgnoredError("maps.arrivalAreasEditor.init")(err);
      latest.current.onStatus("unavailable");
      return;
    }
    map.touchZoomRotate.disableRotation();

    installMissingImageFallback(map, mapStyleLight);
    const retryStyleLoad = installStyleLoadRetry(map, mapStyleLight);
    map.on("error", (e) => {
      if (retryStyleLoad(e)) return;
      // Only a style that never loads is fatal; a missing tile is not.
      if (isStyleLoadFailure(e, mapStyleLight)) {
        latest.current.onStatus("unavailable");
      }
    });

    const marker = new maplibregl.Marker({ color: ARRIVAL_AREA_PAINT.selected })
      .setLngLat([pinLng, pinLat])
      .addTo(map);
    // The pin must never swallow a tap meant for a point of a shape.
    marker.getElement().style.pointerEvents = "none";

    map.on("style.load", () => {
      try {
        addOsmParkingGuide(map);
      } catch (err) {
        traceIgnoredError("maps.arrivalAreasEditor.osmGuide")(err);
      }
      setStyledMap(map);
    });

    // `once` with a listener returns the map; the overload that types it as
    // a promise is the listener-less one.
    void map.once("load", () => {
      if (cancelled) return;
      if (!pinInBounds(here, basemapBounds(map))) {
        latest.current.onStatus("outOfCoverage");
        return;
      }
      const camera = initialCamera(here, latest.current.areas);
      if (camera.bounds) {
        try {
          map.fitBounds(camera.bounds, {
            padding: 40,
            maxZoom: FIT_MAX_ZOOM,
            duration: 0,
          });
        } catch {
          // A degenerate box keeps the pin framing.
        }
      }
      void Promise.all([
        import("terra-draw"),
        import("terra-draw-maplibre-gl-adapter"),
      ])
        .then(([td, adapterModule]) => {
          if (cancelled) return;
          const styles = drawStyles();
          const polygon = new td.TerraDrawPolygonMode({
            styles: styles.polygon,
            pointerDistance: 30,
          });
          const linestring = new td.TerraDrawLineStringMode({
            styles: styles.linestring,
            pointerDistance: 30,
          });
          const select = new td.TerraDrawSelectMode({
            styles: styles.select,
            allowManualDeselection: false,
            pointerDistance: 30,
            flags: {
              polygon: {
                feature: {
                  draggable: true,
                  coordinates: { draggable: true, midpoints: true, deletable: true },
                },
              },
              linestring: {
                feature: {
                  draggable: true,
                  coordinates: { draggable: true, midpoints: true, deletable: true },
                },
              },
            },
          });
          const draw = new td.TerraDraw({
            adapter: new adapterModule.TerraDrawMapLibreGLAdapter({
              map,
              coordinatePrecision: 9,
            }),
            modes: [select, polygon, linestring],
            undoRedo: { modeLevel: new td.TerraDrawModeUndoRedo() },
          });
          modesRef.current = {
            polygon,
            linestring,
          };

          // `change` fires on every pointer move while drawing: report only
          // when one of the two flags actually flips.
          let lastDrawing: boolean | null = null;
          let lastCanUndo: boolean | null = null;
          const report = () => {
            try {
              const drawing = draw.getModeState() === "drawing";
              const canUndo = drawing && draw.canUndo();
              if (drawing === lastDrawing && canUndo === lastCanUndo) return;
              lastDrawing = drawing;
              lastCanUndo = canUndo;
              latest.current.onDrawState({ drawing, canUndo });
            } catch {
              // The instance stopped between the event and the read.
            }
          };

          draw.on("change", report);
          draw.on("history", report);
          draw.on("finish", (id, context) => {
            lastFinishAtRef.current = Date.now();
            report();
            const feature = draw.getSnapshotFeature(id);
            const shape = shapeFromDrawGeometry(feature?.geometry);
            if (!shape) return;
            if (context.action === "draw") {
              // The parent turns the drawn shape into the working draft;
              // it comes back through `working` under a fresh key.
              latest.current.onShapeDrawn(shape);
              return;
            }
            if (!syncingRef.current && String(id) === workingIdRef.current) {
              latest.current.onShapeChanged(shape);
            }
          });

          draw.start();
          drawRef.current = draw;
          setDrawReady(true);
          latest.current.onStatus("ready");
        })
        .catch((err) => {
          traceIgnoredError("maps.arrivalAreasEditor.terraDraw")(err);
          if (!cancelled) latest.current.onStatus("unavailable");
        });
    });

    return () => {
      cancelled = true;
      setDrawReady(false);
      setStyledMap(null);
      const draw = drawRef.current;
      drawRef.current = null;
      workingIdRef.current = null;
      try {
        draw?.stop();
      } catch {
        // Already stopped with the map.
      }
      try {
        map.remove();
      } catch {
        // Already removed.
      }
    };
    // The map is built once per pin and screen mode; everything else is
    // read through `latest`.
  }, [pinLat, pinLng, fullScreen]);

  // ── The working shape, mirrored into Terra Draw ──────────────────────────
  const workingKey = working.key;
  const workingShapeRef = useRef(working.shape);
  workingShapeRef.current = working.shape;
  useEffect(() => {
    const draw = drawRef.current;
    if (!drawReady || !draw) return;
    syncingRef.current = true;
    try {
      // Drop the previous working feature (and any half-drawn shape).
      const previous = drawnShapes(draw).map((f) => f.id as string);
      if (previous.length > 0) draw.removeFeatures(previous);
      workingIdRef.current = null;
      const shape = workingShapeRef.current;
      if (shape) {
        const id = draw.getFeatureId();
        const results = draw.addFeatures([
          {
            type: "Feature",
            id,
            geometry: shape,
            properties: {
              mode: shape.type === "Polygon" ? "polygon" : "linestring",
            },
          },
        ]);
        if (results[0]?.valid) {
          workingIdRef.current = String(id);
        }
      }
    } catch (err) {
      traceIgnoredError("maps.arrivalAreasEditor.working")(err);
    } finally {
      syncingRef.current = false;
    }
  }, [drawReady, workingKey]);

  // ── Full screen: keep the shape being edited in view ─────────────────────
  // The sheet shrinks the frame to a strip; MapLibre's own resize observer
  // fires `resize`, and the map jumps (no motion) to the working shape's
  // centre so the strip shows what the form is about.
  useEffect(() => {
    if (!styledMap || !fullScreen) return;
    const onResize = () => {
      const shape = workingShapeRef.current;
      if (!shape) return;
      const positions =
        shape.type === "Polygon" ? (shape.coordinates[0] ?? []) : shape.coordinates;
      if (positions.length === 0) return;
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const [lng, lat] of positions) {
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      styledMap.jumpTo({ center: [(west + east) / 2, (south + north) / 2] });
    };
    styledMap.on("resize", onResize);
    return () => {
      styledMap.off("resize", onResize);
    };
  }, [styledMap, fullScreen]);

  // ── Tool → Terra Draw mode ───────────────────────────────────────────────
  useEffect(() => {
    const draw = drawRef.current;
    if (!drawReady || !draw) return;
    try {
      const mode = terraDrawModeFor(tool, interactive);
      draw.setMode(mode);
      if (mode === "select") {
        const id = workingIdRef.current;
        if (id && draw.hasFeature(id)) draw.selectFeature(id);
      }
    } catch (err) {
      traceIgnoredError("maps.arrivalAreasEditor.mode")(err);
    }
  }, [drawReady, tool, interactive, workingKey]);

  useImperativeHandle(
    ref,
    () => ({
      undoPoint: () => {
        try {
          drawRef.current?.undo();
        } catch (err) {
          traceIgnoredError("maps.arrivalAreasEditor.undo")(err);
        }
      },
      finishShape: () => {
        const mode = modesRef.current[latest.current.tool];
        if (!mode || !(DRAW_MODES as readonly string[]).includes(latest.current.tool)) {
          return;
        }
        try {
          // Terra Draw finishes a shape on its `finish` key (Enter). This is
          // the same call its adapter makes, for a button a finger can press.
          mode.onKeyUp({ key: "Enter", heldKeys: [], preventDefault: () => {} });
        } catch (err) {
          traceIgnoredError("maps.arrivalAreasEditor.finish")(err);
        }
      },
    }),
    [],
  );

  const displayAreas = useMemo(
    () => areas.filter((a) => a.id !== editingId).map(toDisplayArea),
    [areas, editingId],
  );

  return (
    <div
      role="region"
      aria-label={label}
      style={{ position: "absolute", inset: 0 }}
      data-testid="arrival-areas-editor-map"
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <ArrivalAreasLayer
        map={styledMap}
        areas={displayAreas}
        selectedId={null}
        onSelect={(id) => {
          if (latest.current.tool !== "select") return;
          if (Date.now() - lastFinishAtRef.current < FINISH_CLICK_GRACE_MS) return;
          onSelectArea(id);
        }}
        pin={pin}
        fitToAreas={false}
      />
    </div>
  );
});
