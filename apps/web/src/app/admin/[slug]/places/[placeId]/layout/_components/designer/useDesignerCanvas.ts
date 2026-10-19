"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DesignerCanvas — interactive 2D canvas for drawing section polygons and
// placing seats.
//
// Responsibilities:
//   - Pan (middle-click / space-drag) and zoom (wheel / buttons)
//   - Draw polygonal sections (click to add vertices, double-click to close)
//   - Place seats as points within sections (click)
//   - Select / multi-select seats, sections, and the background image
//   - Drag-to-move selected items (seats, sections, image)
//   - Ctrl/Cmd+Z undo
//   - Delete selected items (Delete / Backspace)
//   - HUD overlay (seat count, active tool, undo depth)
//   - Auto fit-to-view on mount
//
// All mutation flows through the parent's dispatch (DesignerAction) so the
// component is fully controlled.
// ─────────────────────────────────────────────────────────────────────────────

import {
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  DesignerState,
  DesignerAction,
  DesignerImage,
  DesignerTool,
  Point,
  Viewport,
} from "./types";

import {
  drawGrid,
  drawBackgroundImage,
  drawSections,
  drawSeats,
  drawStage,
  drawDrawingPolygon,
  drawOriginCrosshair,
  drawPlacementPreview,
  drawHud,
  drawStrokes,
  drawDrawingStroke,
  drawBoxSectionPreview,
  drawCircleSectionPreview,
  drawArcGroupHandles,
  hitTestArcGroupHandle,
  drawLineGroupHandles,
  hitTestLineGroupHandle,
  drawGridGroupHandles,
  hitTestGridGroupHandle,
  drawSectionPointHandles,
  hitTestSectionPointHandle,
  hitTestStrokePointHandle,
  drawSnapIndicator,
  drawEdgeSmoothingOverlays,
} from "./draw";

import type { StrokePointHit } from "./draw";

import {
  findSeatAt,
  findSectionAt,
  findStrokeAt,
  distance,
  findNearestVertex,
  SNAP_THRESHOLD_WORLD,
} from "./reducer";

import type { DesignerSection } from "./types";

// ── Edge hit-testing ─────────────────────────────────────────────────────────

/** Shortest distance from a point to a line segment A→B. */
function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq),
  );
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Find the closest polygon edge across all sections within `hitRadius`.
 * Returns the section and edge index, or null if nothing is close enough.
 */
function findEdgeAt(
  sections: DesignerSection[],
  world: Point,
  hitRadius: number,
): { sectionId: string; edgeIndex: number } | null {
  let best: { sectionId: string; edgeIndex: number } | null = null;
  let bestDist = Infinity;

  for (const section of sections) {
    const poly = section.polygon;
    const n = poly.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const d = pointToSegmentDistance(world, a, b);
      if (d <= hitRadius && d < bestDist) {
        bestDist = d;
        best = { sectionId: section.sectionId, edgeIndex: i };
      }
    }
  }

  return best;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;
const ZOOM_FACTOR = 1.12;
const CLOSE_POLYGON_DISTANCE = 12; // screen-px threshold to snap-close a polygon

const TOOL_LABELS: Record<string, string> = {
  select: "Select",
  pan: "Pan",
  draw_section: "Draw Section",
  draw_box_section: "Box Section",
  draw_circle_section: "Circle Section",
  draw_stroke: "Stroke",
  place_seat: "Place Seat",
  place_line: "Line Seats",
  place_arc: "Arc Seats",
  place_grid: "Grid Seats",
  erase: "Erase",
};

// ── Props ────────────────────────────────────────────────────────────────────

type DesignerCanvasProps = {
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
  /** The color to assign to the next section polygon when closed. */
  nextSectionColor: string;
  /** Pre-loaded HTMLImageElement for the background image (if any). */
  backgroundImage: HTMLImageElement | null;
};

// ── Hit test for image ───────────────────────────────────────────────────────

function hitTestImage(image: DesignerImage | null, world: Point): boolean {
  if (!image) return false;
  return (
    world.x >= image.position.x &&
    world.x <= image.position.x + image.width &&
    world.y >= image.position.y &&
    world.y <= image.position.y + image.height
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function DesignerCanvas({
  state,
  dispatch,
  nextSectionColor,
  backgroundImage,
}: DesignerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── State ref ──────────────────────────────────────────────────────────
  // The draw loop reads state from a ref so that `draw` / `requestDraw`
  // remain referentially stable.  This decouples canvas paints from
  // React's render cycle and eliminates flicker caused by the canvas being
  // cleared between a React re-render and the next rAF callback.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Background image element ref (same pattern)
  const bgImageRef = useRef(backgroundImage);
  bgImageRef.current = backgroundImage;

  // Viewport in ref to avoid re-renders during pan/zoom
  const viewportRef = useRef<Viewport>({ offsetX: 0, offsetY: 0, scale: 1 });

  // Cursor world position for preview drawing
  const cursorWorldRef = useRef<Point | null>(null);

  // Pan state
  const isPanningRef = useRef(false);
  const panStartRef = useRef<Point>({ x: 0, y: 0 });

  // Drag state (for moving selected items)
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });
  const dragTypeRef = useRef<"seat" | "section" | "image" | "stroke" | null>(
    null,
  );

  // Batch placement state (line/arc/grid first-click anchor)
  const batchAnchorRef = useRef<Point | null>(null);

  // Box section draw state — tracks ongoing click-drag
  const boxSectionDraggingRef = useRef(false);

  // Circle section draw state — tracks ongoing click-drag
  const circleSectionDraggingRef = useRef(false);

  // Stroke drawing — whether click-to-place Bezier mode is active
  const isDrawingStrokeRef = useRef(false);
  // Stroke handle drag — when user clicks + drags after placing a point
  const strokeHandleDragRef = useRef(false);

  // Arc group handle dragging — which handle is being dragged
  const arcHandleDragRef = useRef<{
    groupId: string;
    handle: "center" | "radius" | "startAngle" | "endAngle";
  } | null>(null);

  // Cmd/Ctrl-hold temporary pan — stores the tool to restore on key up
  const toolBeforePanRef = useRef<DesignerTool | null>(null);

  // Section polygon point dragging
  const sectionPointDragRef = useRef<{
    sectionId: string;
    pointIndex: number;
  } | null>(null);

  // Stroke control-point dragging (anchor or Bezier handle)
  const strokePointDragRef = useRef<{
    strokeId: string;
    hit: StrokePointHit;
  } | null>(null);

  // Line / Grid group handle dragging
  const lineGridHandleDragRef = useRef<{
    groupId: string;
    handle: "start" | "end" | "origin" | "extent";
  } | null>(null);

  // Force redraw trigger
  const rafRef = useRef<number>(0);

  // Whether we've done the initial fit-to-view
  const hasInitialFitRef = useRef(false);

  // Section color lookup — kept in a ref so `draw` stays stable
  const sectionColorMapRef = useRef(new Map<string, string>());
  useMemo(() => {
    const map = new Map<string, string>();
    for (const s of state.sections) {
      map.set(s.sectionId, s.color);
    }
    sectionColorMapRef.current = map;
  }, [state.sections]);

  // ── Coordinate conversion ──────────────────────────────────────────────

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const { offsetX, offsetY, scale } = viewportRef.current;
      return {
        x: (clientX - rect.left - offsetX) / scale,
        y: (clientY - rect.top - offsetY) / scale,
      };
    },
    [],
  );

  /** Convert world coords to CSS pixels relative to the canvas container. */
  const worldToScreen = useCallback(
    (wx: number, wy: number): { sx: number; sy: number } => {
      const { offsetX, offsetY, scale } = viewportRef.current;
      return { sx: wx * scale + offsetX, sy: wy * scale + offsetY };
    },
    [],
  );

  // ── Draw ───────────────────────────────────────────────────────────────
  // Reads everything from refs so the function identity is stable and
  // doesn't cause cascading useCallback / useEffect invalidations.

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const s = stateRef.current;
    const bgImg = bgImageRef.current;
    const colorMap = sectionColorMapRef.current;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const vp = viewportRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // World-space drawing
    ctx.save();
    ctx.translate(vp.offsetX, vp.offsetY);
    ctx.scale(vp.scale, vp.scale);

    // Grid
    drawGrid(ctx, vp, w, h);

    drawOriginCrosshair(ctx, vp.scale);

    // Background image (drawn first, behind everything else)
    if (s.image) {
      drawBackgroundImage(ctx, s.image, bgImg, s.imageSelected, vp.scale);
    }

    // Sections
    drawSections(ctx, s.sections, s.selectedSectionIds, vp.scale);

    // Per-edge smoothing overlays (dots, selected edge highlight, shared boundary)
    drawEdgeSmoothingOverlays(ctx, s.sections, s.selectedEdge, vp.scale);

    // Stage
    if (s.stage) {
      drawStage(ctx, s.stage, vp.scale);
    }

    // Strokes (drawn between sections and seats)
    drawStrokes(ctx, s.strokes, s.selectedStrokeIds, vp.scale);

    // Seats — conditionally hidden when zoomed out past the threshold
    if (vp.scale >= s.seatVisibilityThreshold) {
      drawSeats(ctx, s.seats, colorMap, s.selectedSeatIds, vp.scale);
    }

    // Batch placement preview (ghost seats)
    if (s.placementPreview) {
      drawPlacementPreview(
        ctx,
        s.placementPreview,
        s.defaultSeatRadius,
        vp.scale,
        s.batchSpacing,
        s.batchSpacingX,
        s.batchSpacingY,
      );
    }

    // In-progress polygon
    if (s.activeTool === "draw_section" && s.drawingPolygon.length > 0) {
      // When snap is active, draw the preview line toward the snapped point
      const cursor =
        s.vertexSnapEnabled && s.snapTarget
          ? s.snapTarget.point
          : cursorWorldRef.current;
      drawDrawingPolygon(ctx, s.drawingPolygon, cursor, vp.scale);
    }

    // In-progress freeform stroke
    if (s.activeTool === "draw_stroke" && s.drawingStrokePoints.length > 0) {
      drawDrawingStroke(
        ctx,
        s.drawingStrokePoints,
        s.strokeColor,
        s.strokeWidth,
        vp.scale,
      );
    }

    // Box section preview (drag rectangle)
    if (
      s.activeTool === "draw_box_section" &&
      s.boxSectionStart &&
      cursorWorldRef.current
    ) {
      drawBoxSectionPreview(
        ctx,
        s.boxSectionStart,
        cursorWorldRef.current,
        nextSectionColor,
        vp.scale,
      );
    }

    // Circle section preview (drag circle)
    if (
      s.activeTool === "draw_circle_section" &&
      s.circleSectionCenter &&
      cursorWorldRef.current
    ) {
      drawCircleSectionPreview(
        ctx,
        s.circleSectionCenter,
        cursorWorldRef.current,
        nextSectionColor,
        vp.scale,
      );
    }

    // Arc group handles (when an arc placement group is selected)
    if (s.selectedPlacementGroupId) {
      const selectedGroup = s.placementGroups.find(
        (g) => g.id === s.selectedPlacementGroupId,
      );
      if (selectedGroup?.kind === "arc") {
        drawArcGroupHandles(ctx, selectedGroup, vp.scale);
      }
      if (selectedGroup?.kind === "line") {
        drawLineGroupHandles(ctx, selectedGroup, vp.scale);
      }
      if (selectedGroup?.kind === "grid") {
        drawGridGroupHandles(ctx, selectedGroup, vp.scale);
      }
    }

    // Section polygon point handles (when exactly one section is selected)
    if (s.selectedSectionIds.size === 1) {
      const secId = [...s.selectedSectionIds][0]!;
      const sec = s.sections.find((section) => section.sectionId === secId);
      if (sec) {
        drawSectionPointHandles(ctx, sec, vp.scale);
      }
    }

    // Snap indicator (drawing or dragging near an existing vertex)
    if (s.snapTarget) {
      drawSnapIndicator(ctx, s.snapTarget, vp.scale);
    }

    ctx.restore();

    // HUD (screen space)
    drawHud(
      ctx,
      s.seats.length,
      s.sections.length,
      w,
      h,
      TOOL_LABELS[s.activeTool] ?? s.activeTool,
      s.undoStack.length,
    );
  }, []); // stable — reads from refs

  // Schedule draws via rAF
  const requestDraw = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // ── Canvas sizing ──────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        requestDraw();
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [requestDraw]);

  // Redraw when state changes
  useEffect(() => {
    requestDraw();
  }, [state, backgroundImage, requestDraw]);

  // Clear batch anchor when tool changes (e.g. via keyboard shortcut in parent)
  useEffect(() => {
    batchAnchorRef.current = null;
  }, [state.activeTool]);

  // ── Fit to content helper ──────────────────────────────────────────────

  const fitToContent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const s = stateRef.current;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const seat of s.seats) {
      xs.push(seat.position.x);
      ys.push(seat.position.y);
    }
    for (const section of s.sections) {
      for (const pt of section.polygon) {
        xs.push(pt.x);
        ys.push(pt.y);
      }
    }
    if (s.stage) {
      xs.push(s.stage.bounds.minX, s.stage.bounds.maxX);
      ys.push(s.stage.bounds.minY, s.stage.bounds.maxY);
    }
    if (s.image) {
      xs.push(s.image.position.x, s.image.position.x + s.image.width);
      ys.push(s.image.position.y, s.image.position.y + s.image.height);
    }
    for (const stroke of s.strokes) {
      for (const cp of stroke.points) {
        xs.push(cp.position.x);
        ys.push(cp.position.y);
      }
    }

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;

    if (xs.length === 0 || ys.length === 0) {
      viewportRef.current = { offsetX: cw / 2, offsetY: ch / 2, scale: 1 };
      requestDraw();
      return;
    }

    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const bw = maxX - minX || 100;
    const bh = maxY - minY || 100;

    const padding = 60;
    const scaleX = (cw - padding * 2) / bw;
    const scaleY = (ch - padding * 2) / bh;
    const scale = Math.min(scaleX, scaleY, MAX_SCALE);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    viewportRef.current = {
      scale,
      offsetX: cw / 2 - centerX * scale,
      offsetY: ch / 2 - centerY * scale,
    };
    requestDraw();
  }, [requestDraw]); // stable — reads state from ref

  // Auto fit-to-view on first mount once canvas is sized *and* when initial
  // content (sections/seats/stage/image/strokes) becomes available. We need
  // to wait for the ResizeObserver to set canvas.width/height (non-zero) and
  // also for the parent's state to contain content; otherwise an early fit
  // can compute with zero canvas size and produce a broken viewport.
  useEffect(() => {
    if (hasInitialFitRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;

    const s = stateRef.current;
    const hasContent =
      (s.seats && s.seats.length > 0) ||
      (s.sections && s.sections.length > 0) ||
      !!s.stage ||
      !!s.image ||
      (s.strokes && s.strokes.length > 0);

    hasInitialFitRef.current = true;

    if (hasContent) {
      // Fit the actual content (sections/seats/stage/image)
      fitToContent();
      return;
    }

    // No content — center at origin with a scale of 1
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    viewportRef.current = { offsetX: cw / 2, offsetY: ch / 2, scale: 1 };
    requestDraw();
  }, [state, fitToContent, requestDraw]);

  // ── Pointer handlers ───────────────────────────────────────────────────

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const s = stateRef.current;
      const world = screenToWorld(e.clientX, e.clientY);

      // Middle-click or pan tool or Cmd/Ctrl held → start panning
      if (e.button === 1 || s.activeTool === "pan" || e.metaKey || e.ctrlKey) {
        // If Cmd/Ctrl is held and not already in pan mode, temporarily switch
        if (
          (e.metaKey || e.ctrlKey) &&
          s.activeTool !== "pan" &&
          !toolBeforePanRef.current
        ) {
          toolBeforePanRef.current = s.activeTool;
        }
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      if (e.button !== 0) return; // left-click only beyond this point

      switch (s.activeTool) {
        case "select": {
          const hitRadius = 8 / viewportRef.current.scale;

          // Check section polygon point handles first (when exactly one section is selected)
          if (s.selectedSectionIds.size === 1) {
            const secId = [...s.selectedSectionIds][0]!;
            const sec = s.sections.find(
              (section) => section.sectionId === secId,
            );
            if (sec) {
              const ptIdx = hitTestSectionPointHandle(
                sec,
                world,
                viewportRef.current.scale,
              );
              if (ptIdx >= 0) {
                dispatch({ type: "BEGIN_DRAG" });
                sectionPointDragRef.current = {
                  sectionId: secId,
                  pointIndex: ptIdx,
                };
                dragStartRef.current = { ...world };
                canvas.setPointerCapture(e.pointerId);
                return;
              }
            }
          }

          // Check stroke control-point handles (anchor + Bezier handles) when exactly one stroke is selected
          if (s.selectedStrokeIds.size === 1) {
            const sId = [...s.selectedStrokeIds][0]!;
            const stk = s.strokes.find((st) => st.id === sId);
            if (stk) {
              const hit = hitTestStrokePointHandle(
                stk,
                world,
                viewportRef.current.scale,
              );
              if (hit) {
                dispatch({ type: "BEGIN_DRAG" });
                strokePointDragRef.current = { strokeId: sId, hit };
                dragStartRef.current = { ...world };
                canvas.setPointerCapture(e.pointerId);
                return;
              }
            }
          }

          // Check placement group handles (arc, line, grid)
          if (s.selectedPlacementGroupId) {
            const selectedGroup = s.placementGroups.find(
              (g) => g.id === s.selectedPlacementGroupId,
            );
            if (selectedGroup?.kind === "arc") {
              const handle = hitTestArcGroupHandle(
                selectedGroup,
                world,
                viewportRef.current.scale,
              );
              if (handle) {
                dispatch({ type: "BEGIN_DRAG" });
                arcHandleDragRef.current = {
                  groupId: selectedGroup.id,
                  handle,
                };
                dragStartRef.current = { ...world };
                canvas.setPointerCapture(e.pointerId);
                return;
              }
            }
            if (selectedGroup?.kind === "line") {
              const handle = hitTestLineGroupHandle(
                selectedGroup,
                world,
                viewportRef.current.scale,
              );
              if (handle) {
                dispatch({ type: "BEGIN_DRAG" });
                lineGridHandleDragRef.current = {
                  groupId: selectedGroup.id,
                  handle,
                };
                dragStartRef.current = { ...world };
                canvas.setPointerCapture(e.pointerId);
                return;
              }
            }
            if (selectedGroup?.kind === "grid") {
              const handle = hitTestGridGroupHandle(
                selectedGroup,
                world,
                viewportRef.current.scale,
              );
              if (handle) {
                dispatch({ type: "BEGIN_DRAG" });
                lineGridHandleDragRef.current = {
                  groupId: selectedGroup.id,
                  handle,
                };
                dragStartRef.current = { ...world };
                canvas.setPointerCapture(e.pointerId);
                return;
              }
            }
          }

          // Try to select an edge on a section (for per-edge smoothing)
          {
            const edgeHitRadius = 6 / viewportRef.current.scale;
            const edgeHit = findEdgeAt(s.sections, world, edgeHitRadius);
            if (edgeHit && !e.shiftKey) {
              dispatch({
                type: "SELECT_EDGE",
                sectionId: edgeHit.sectionId,
                edgeIndex: edgeHit.edgeIndex,
              });
              // Don't start a drag — edge selection is a click action
              return;
            }
          }

          // Try to select a seat first
          const seat = findSeatAt(s.seats, world, hitRadius);
          if (seat) {
            dispatch({
              type: "SELECT_SEAT",
              seatId: seat.id,
              additive: e.shiftKey,
            });

            // If the seat belongs to a placement group, auto-select that group
            // so the user can immediately see and edit its config
            if (!e.shiftKey) {
              const ownerGroup = s.placementGroups.find((g) =>
                g.seatIds.includes(seat.id),
              );
              if (ownerGroup) {
                dispatch({
                  type: "SELECT_PLACEMENT_GROUP",
                  groupId: ownerGroup.id,
                });
                // Also set the active section to the group's section
                if (ownerGroup.sectionId !== s.activeSectionId) {
                  dispatch({
                    type: "SET_ACTIVE_SECTION",
                    sectionId: ownerGroup.sectionId,
                  });
                }
              }
            }

            // Snapshot undo once, then start drag
            dispatch({ type: "BEGIN_DRAG" });
            isDraggingRef.current = true;
            dragStartRef.current = { ...world };
            dragTypeRef.current = "seat";
            canvas.setPointerCapture(e.pointerId);
            return;
          }

          // Then sections
          const section = findSectionAt(s.sections, world);
          if (section) {
            dispatch({
              type: "SELECT_SECTION",
              sectionId: section.sectionId,
              additive: e.shiftKey,
            });
            dispatch({ type: "BEGIN_DRAG" });
            isDraggingRef.current = true;
            dragStartRef.current = { ...world };
            dragTypeRef.current = "section";
            canvas.setPointerCapture(e.pointerId);
            return;
          }

          // Then strokes
          const strokeHitRadius = 6 / viewportRef.current.scale;
          const stroke = findStrokeAt(s.strokes, world, strokeHitRadius);
          if (stroke) {
            dispatch({
              type: "SELECT_STROKE",
              strokeId: stroke.id,
              additive: e.shiftKey,
            });
            dispatch({ type: "BEGIN_DRAG" });
            isDraggingRef.current = true;
            dragStartRef.current = { ...world };
            dragTypeRef.current = "stroke";
            canvas.setPointerCapture(e.pointerId);
            return;
          }

          // Then background image
          if (hitTestImage(s.image, world)) {
            dispatch({ type: "SELECT_IMAGE" });
            dispatch({ type: "BEGIN_DRAG" });
            isDraggingRef.current = true;
            dragStartRef.current = { ...world };
            dragTypeRef.current = "image";
            canvas.setPointerCapture(e.pointerId);
            return;
          }

          // Nothing hit — clear selection
          dispatch({ type: "CLEAR_SELECTION" });
          dispatch({ type: "CLEAR_EDGE_SELECTION" });
          break;
        }

        case "draw_section": {
          // If near the first vertex → close polygon
          if (s.drawingPolygon.length >= 3) {
            const first = s.drawingPolygon[0]!;
            const screenDist =
              distance(world, first) * viewportRef.current.scale;
            if (screenDist < CLOSE_POLYGON_DISTANCE) {
              dispatch({ type: "CLOSE_POLYGON", color: nextSectionColor });
              return;
            }
          }
          // Use the snapped point if one is active
          const snapPt =
            s.vertexSnapEnabled && s.snapTarget ? s.snapTarget.point : world;
          dispatch({ type: "ADD_POLYGON_POINT", point: snapPt });
          break;
        }

        case "draw_box_section": {
          // Start the click-drag rectangle
          dispatch({ type: "SET_BOX_SECTION_START", point: world });
          boxSectionDraggingRef.current = true;
          canvas.setPointerCapture(e.pointerId);
          break;
        }

        case "draw_circle_section": {
          // Start the click-drag circle (center → edge)
          dispatch({ type: "SET_CIRCLE_SECTION_CENTER", point: world });
          circleSectionDraggingRef.current = true;
          canvas.setPointerCapture(e.pointerId);
          break;
        }

        case "draw_stroke": {
          // If we already have ≥2 points and click near the first → close & commit
          if (s.drawingStrokePoints.length >= 2) {
            const first = s.drawingStrokePoints[0]!;
            const screenDist =
              distance(world, first.position) * viewportRef.current.scale;
            if (screenDist < CLOSE_POLYGON_DISTANCE) {
              isDrawingStrokeRef.current = false;
              strokeHandleDragRef.current = false;
              dispatch({ type: "COMMIT_STROKE", closed: true });
              return;
            }
          }
          // Click-to-place Bezier anchor point
          dispatch({ type: "ADD_STROKE_POINT", point: world });
          isDrawingStrokeRef.current = true;
          strokeHandleDragRef.current = true; // start handle drag
          canvas.setPointerCapture(e.pointerId);
          break;
        }

        case "place_seat": {
          dispatch({ type: "PLACE_SEAT", position: world });
          break;
        }

        case "erase": {
          const hitRadius = 8 / viewportRef.current.scale;
          const seat = findSeatAt(s.seats, world, hitRadius);
          if (seat) {
            dispatch({ type: "SELECT_SEAT", seatId: seat.id, additive: false });
            dispatch({ type: "DELETE_SELECTED" });
          }
          break;
        }

        case "place_line": {
          if (!batchAnchorRef.current) {
            // First click: set anchor
            batchAnchorRef.current = { ...world };
            dispatch({
              type: "SET_PLACEMENT_PREVIEW",
              preview: {
                kind: "line",
                start: world,
                end: world,
                count: s.batchCount,
              },
            });
          } else {
            // Second click: commit the line
            dispatch({
              type: "COMMIT_LINE_PLACEMENT",
              start: batchAnchorRef.current,
              end: world,
              count: s.batchCount,
              spacing: s.batchSpacing,
            });
            batchAnchorRef.current = null;
          }
          break;
        }

        case "place_arc": {
          if (!batchAnchorRef.current) {
            // First click: set center
            batchAnchorRef.current = { ...world };
          } else {
            // Second click: commit the arc
            const dx = world.x - batchAnchorRef.current.x;
            const dy = world.y - batchAnchorRef.current.y;
            const radius = Math.sqrt(dx * dx + dy * dy);
            if (radius > 1) {
              const endAngle = Math.atan2(dy, dx);
              const startAngle = endAngle - Math.PI; // 180-degree arc default
              dispatch({
                type: "COMMIT_ARC_PLACEMENT",
                center: batchAnchorRef.current,
                radius,
                startAngle,
                endAngle,
                count: s.batchCount,
                spacing: s.batchSpacing,
              });
            }
            batchAnchorRef.current = null;
            dispatch({ type: "SET_PLACEMENT_PREVIEW", preview: null });
          }
          break;
        }

        case "place_grid": {
          if (!batchAnchorRef.current) {
            // First click: origin corner
            batchAnchorRef.current = { ...world };
            dispatch({
              type: "SET_PLACEMENT_PREVIEW",
              preview: {
                kind: "grid",
                origin: world,
                extent: world,
                rows: s.batchGridRows,
                cols: s.batchCount,
              },
            });
          } else {
            // Second click: extent corner → commit
            dispatch({
              type: "COMMIT_GRID_PLACEMENT",
              origin: batchAnchorRef.current,
              extent: world,
              rows: s.batchGridRows,
              cols: s.batchCount,
              spacing: s.batchSpacing,
              spacingX: s.batchSpacingX,
              spacingY: s.batchSpacingY,
            });
            batchAnchorRef.current = null;
          }
          break;
        }
      }
    },
    [dispatch, screenToWorld, nextSectionColor],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      cursorWorldRef.current = screenToWorld(e.clientX, e.clientY);

      if (isPanningRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        viewportRef.current = {
          ...viewportRef.current,
          offsetX: viewportRef.current.offsetX + dx,
          offsetY: viewportRef.current.offsetY + dy,
        };
        requestDraw();
        return;
      }

      if (isDraggingRef.current && dragTypeRef.current) {
        const world = screenToWorld(e.clientX, e.clientY);
        const dx = world.x - dragStartRef.current.x;
        const dy = world.y - dragStartRef.current.y;
        dragStartRef.current = { ...world };

        switch (dragTypeRef.current) {
          case "seat":
            dispatch({ type: "MOVE_SELECTED_SEATS", dx, dy });
            break;
          case "section":
            dispatch({ type: "MOVE_SELECTED_SECTIONS", dx, dy });
            break;
          case "image":
            dispatch({ type: "MOVE_IMAGE", dx, dy });
            break;
          case "stroke":
            dispatch({ type: "MOVE_SELECTED_STROKES", dx, dy });
            break;
        }
        return;
      }

      // Arc group handle dragging
      if (arcHandleDragRef.current) {
        const world = screenToWorld(e.clientX, e.clientY);
        const s = stateRef.current;
        const group = s.placementGroups.find(
          (g) => g.id === arcHandleDragRef.current!.groupId,
        );
        if (group?.kind === "arc") {
          const { handle } = arcHandleDragRef.current;
          if (handle === "center") {
            const dx = world.x - dragStartRef.current.x;
            const dy = world.y - dragStartRef.current.y;
            dragStartRef.current = { ...world };
            dispatch({
              type: "MOVE_PLACEMENT_GROUP",
              groupId: group.id,
              dx,
              dy,
            });
          } else if (handle === "radius") {
            const newRadius = Math.max(5, distance(world, group.center));
            dispatch({
              type: "UPDATE_ARC_GROUP_GEOMETRY",
              groupId: group.id,
              updates: { radius: newRadius },
            });
          } else if (handle === "startAngle") {
            const newAngle = Math.atan2(
              world.y - group.center.y,
              world.x - group.center.x,
            );
            dispatch({
              type: "UPDATE_ARC_GROUP_GEOMETRY",
              groupId: group.id,
              updates: { startAngle: newAngle },
            });
          } else if (handle === "endAngle") {
            const newAngle = Math.atan2(
              world.y - group.center.y,
              world.x - group.center.x,
            );
            dispatch({
              type: "UPDATE_ARC_GROUP_GEOMETRY",
              groupId: group.id,
              updates: { endAngle: newAngle },
            });
          }
        }
        requestDraw();
        return;
      }

      // Line / Grid group handle dragging
      if (lineGridHandleDragRef.current) {
        const world = screenToWorld(e.clientX, e.clientY);
        const { groupId, handle } = lineGridHandleDragRef.current;
        if (handle === "start" || handle === "end") {
          dispatch({
            type: "UPDATE_LINE_GROUP_GEOMETRY",
            groupId,
            updates: { [handle]: world },
          });
        } else {
          dispatch({
            type: "UPDATE_GRID_GROUP_GEOMETRY",
            groupId,
            updates: { [handle]: world },
          });
        }
        requestDraw();
        return;
      }

      // Section polygon point dragging
      if (sectionPointDragRef.current) {
        const world = screenToWorld(e.clientX, e.clientY);
        const s = stateRef.current;
        // Snap to nearby vertices of OTHER sections (not the one being edited)
        const snap =
          s.vertexSnapEnabled && !e.altKey
            ? findNearestVertex(
                s.sections,
                world,
                sectionPointDragRef.current.sectionId,
                SNAP_THRESHOLD_WORLD / viewportRef.current.scale,
              )
            : null;
        const pos = snap ? snap.point : world;
        dispatch({ type: "SET_SNAP_TARGET", target: snap });
        dispatch({
          type: "MOVE_SECTION_POINT",
          sectionId: sectionPointDragRef.current.sectionId,
          pointIndex: sectionPointDragRef.current.pointIndex,
          position: pos,
        });
        requestDraw();
        return;
      }

      // Stroke control-point dragging (anchor or Bezier handle on a committed stroke)
      if (strokePointDragRef.current) {
        const world = screenToWorld(e.clientX, e.clientY);
        const { strokeId, hit } = strokePointDragRef.current;
        if (hit.kind === "anchor") {
          dispatch({
            type: "MOVE_STROKE_POINT",
            strokeId,
            pointIndex: hit.pointIndex,
            position: world,
          });
        } else {
          // handleIn or handleOut — compute relative position from anchor
          const stk = stateRef.current.strokes.find((s) => s.id === strokeId);
          if (stk) {
            const cp = stk.points[hit.pointIndex];
            if (cp) {
              const relative = {
                x: world.x - cp.position.x,
                y: world.y - cp.position.y,
              };
              dispatch({
                type: "UPDATE_STROKE_HANDLE",
                strokeId,
                pointIndex: hit.pointIndex,
                handle: hit.kind === "handleIn" ? "in" : "out",
                position: relative,
              });
            }
          }
        }
        requestDraw();
        return;
      }

      // Stroke tool handle drag — set Bezier handle relative to last anchor
      if (strokeHandleDragRef.current) {
        const world = screenToWorld(e.clientX, e.clientY);
        const pts = stateRef.current.drawingStrokePoints;
        if (pts.length > 0) {
          const anchor = pts[pts.length - 1]!.position;
          const handleOut = { x: world.x - anchor.x, y: world.y - anchor.y };
          dispatch({ type: "SET_LAST_STROKE_HANDLES", handleOut });
        }
        requestDraw();
        return;
      }

      // Box section drag preview — update cursor position for the draw loop
      if (boxSectionDraggingRef.current) {
        // cursorWorldRef is already updated above; just request a redraw
        requestDraw();
        return;
      }

      // Circle section drag preview — update cursor position for the draw loop
      if (circleSectionDraggingRef.current) {
        requestDraw();
        return;
      }

      // Update batch placement preview while anchor is set
      if (batchAnchorRef.current) {
        const s = stateRef.current;
        const world = screenToWorld(e.clientX, e.clientY);
        const anchor = batchAnchorRef.current;

        if (s.activeTool === "place_line") {
          dispatch({
            type: "SET_PLACEMENT_PREVIEW",
            preview: {
              kind: "line",
              start: anchor,
              end: world,
              count: s.batchCount,
            },
          });
        } else if (s.activeTool === "place_arc") {
          const dx = world.x - anchor.x;
          const dy = world.y - anchor.y;
          const radius = Math.sqrt(dx * dx + dy * dy);
          const endAngle = Math.atan2(dy, dx);
          const startAngle = endAngle - Math.PI;
          dispatch({
            type: "SET_PLACEMENT_PREVIEW",
            preview: {
              kind: "arc",
              center: anchor,
              radius,
              startAngle,
              endAngle,
              count: s.batchCount,
            },
          });
        } else if (s.activeTool === "place_grid") {
          dispatch({
            type: "SET_PLACEMENT_PREVIEW",
            preview: {
              kind: "grid",
              origin: anchor,
              extent: world,
              rows: s.batchGridRows,
              cols: s.batchCount,
            },
          });
        }
        return;
      }

      // Compute snap target while drawing a section polygon (for preview line)
      {
        const s = stateRef.current;
        if (
          s.activeTool === "draw_section" &&
          s.vertexSnapEnabled &&
          !e.altKey
        ) {
          const world = cursorWorldRef.current;
          if (world) {
            const snap = findNearestVertex(
              s.sections,
              world,
              undefined,
              SNAP_THRESHOLD_WORLD / viewportRef.current.scale,
            );
            dispatch({ type: "SET_SNAP_TARGET", target: snap });
          }
        } else if (s.snapTarget) {
          // Clear stale snap target when not in a snap-eligible tool
          dispatch({ type: "SET_SNAP_TARGET", target: null });
        }
      }

      requestDraw();
    },
    [screenToWorld, requestDraw, dispatch],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        // Restore tool if we were in a temporary Cmd/Ctrl pan
        if (toolBeforePanRef.current) {
          dispatch({ type: "SET_TOOL", tool: toolBeforePanRef.current });
          toolBeforePanRef.current = null;
        }
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        dragTypeRef.current = null;
        dispatch({ type: "END_DRAG" });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // End stroke handle drag (don't commit — user can keep clicking to add points)
      if (strokeHandleDragRef.current) {
        strokeHandleDragRef.current = false;
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // Commit box section on pointer up
      if (boxSectionDraggingRef.current) {
        boxSectionDraggingRef.current = false;
        const world = screenToWorld(e.clientX, e.clientY);
        dispatch({
          type: "COMMIT_BOX_SECTION",
          corner: world,
          color: nextSectionColor,
        });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // Commit circle section on pointer up
      if (circleSectionDraggingRef.current) {
        circleSectionDraggingRef.current = false;
        const world = screenToWorld(e.clientX, e.clientY);
        dispatch({
          type: "COMMIT_CIRCLE_SECTION",
          edgePoint: world,
          color: nextSectionColor,
        });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // Finish arc handle drag
      if (arcHandleDragRef.current) {
        arcHandleDragRef.current = null;
        dispatch({ type: "END_DRAG" });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // Finish line/grid handle drag
      if (lineGridHandleDragRef.current) {
        lineGridHandleDragRef.current = null;
        dispatch({ type: "END_DRAG" });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // Finish section polygon point drag
      if (sectionPointDragRef.current) {
        sectionPointDragRef.current = null;
        dispatch({ type: "SET_SNAP_TARGET", target: null });
        dispatch({ type: "END_DRAG" });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
      // Finish stroke control-point drag
      if (strokePointDragRef.current) {
        strokePointDragRef.current = null;
        dispatch({ type: "END_DRAG" });
        (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      }
    },
    [dispatch, screenToWorld, nextSectionColor],
  );

  // ── Double-click to close polygon / commit stroke ───────────────────

  const handleDoubleClick = useCallback(() => {
    const s = stateRef.current;
    if (s.activeTool === "draw_section" && s.drawingPolygon.length >= 3) {
      dispatch({ type: "CLOSE_POLYGON", color: nextSectionColor });
    } else if (isDrawingStrokeRef.current) {
      // Commit in-progress Bezier stroke on double-click
      isDrawingStrokeRef.current = false;
      strokeHandleDragRef.current = false;
      dispatch({ type: "COMMIT_STROKE" });
    }
  }, [dispatch, nextSectionColor]);

  // ── Zoom ───────────────────────────────────────────────────────────────

  const zoomAtPoint = useCallback(
    (clientX: number, clientY: number, zoomIn: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const { offsetX, offsetY, scale } = viewportRef.current;
      const factor = zoomIn ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      viewportRef.current = {
        scale: newScale,
        offsetX: mx - (mx - offsetX) * (newScale / scale),
        offsetY: my - (my - offsetY) * (newScale / scale),
      };
      requestDraw();
    },
    [requestDraw],
  );

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      zoomAtPoint(e.clientX, e.clientY, e.deltaY < 0);
    },
    [zoomAtPoint],
  );

  // ── Keyboard ───────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
      // Shift+Ctrl/Cmd+Z → redo
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        dispatch({ type: "REDO" });
        return;
      }
      // Ctrl/Cmd+Z → undo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: "UNDO" });
        return;
      }

      const s = stateRef.current;
      switch (e.key) {
        case "Delete":
        case "Backspace":
          if (
            s.selectedSeatIds.size > 0 ||
            s.selectedSectionIds.size > 0 ||
            s.selectedStrokeIds.size > 0
          ) {
            e.preventDefault();
            dispatch({ type: "DELETE_SELECTED" });
          }
          break;
        case "Escape":
          if (s.drawingPolygon.length > 0) {
            dispatch({ type: "CANCEL_DRAWING" });
          } else if (isDrawingStrokeRef.current) {
            // Cancel in-progress Bezier stroke
            isDrawingStrokeRef.current = false;
            strokeHandleDragRef.current = false;
            dispatch({ type: "CANCEL_STROKE" });
          } else if (boxSectionDraggingRef.current) {
            // Cancel in-progress box section
            boxSectionDraggingRef.current = false;
            dispatch({ type: "CANCEL_BOX_SECTION" });
          } else if (circleSectionDraggingRef.current) {
            // Cancel in-progress circle section
            circleSectionDraggingRef.current = false;
            dispatch({ type: "CANCEL_CIRCLE_SECTION" });
          } else if (batchAnchorRef.current) {
            // Cancel in-progress batch placement
            batchAnchorRef.current = null;
            dispatch({ type: "SET_PLACEMENT_PREVIEW", preview: null });
          } else {
            dispatch({ type: "CLEAR_SELECTION" });
          }
          break;
        case "Enter":
          // Commit in-progress Bezier stroke
          if (isDrawingStrokeRef.current) {
            isDrawingStrokeRef.current = false;
            strokeHandleDragRef.current = false;
            dispatch({ type: "COMMIT_STROKE" });
          }
          break;
        case "s":
        case "S":
          // Toggle per-edge smoothing on selected edge (0 → 0.6, >0 → 0)
          if (!e.metaKey && !e.ctrlKey) {
            const sel = stateRef.current.selectedEdge;
            if (sel) {
              e.preventDefault();
              const sec = stateRef.current.sections.find(
                (sc) => sc.sectionId === sel.sectionId,
              );
              const currentVal =
                sec?.edgeSmoothing?.find((f) => f.edgeIndex === sel.edgeIndex)
                  ?.smoothing ?? 0;
              dispatch({
                type: "SET_EDGE_SMOOTHING",
                sectionId: sel.sectionId,
                edgeIndex: sel.edgeIndex,
                smoothing: currentVal > 0 ? 0 : 0.6,
              });
            }
          }
          break;
        case "n":
        case "N":
          // Toggle vertex snap
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            dispatch({ type: "TOGGLE_VERTEX_SNAP" });
          }
          break;
      }
    },
    [dispatch],
  );

  // ── Public zoom controls ───────────────────────────────────────────────

  const zoomIn = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    zoomAtPoint(r.left + r.width / 2, r.top + r.height / 2, true);
  }, [zoomAtPoint]);

  const zoomOut = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    zoomAtPoint(r.left + r.width / 2, r.top + r.height / 2, false);
  }, [zoomAtPoint]);

  // ── Cursor style ───────────────────────────────────────────────────────

  const cursorStyle = (() => {
    if (isPanningRef.current) return "grabbing";
    if (isDraggingRef.current) return "move";
    switch (state.activeTool) {
      case "pan":
        return "grab";
      case "draw_section":
      case "draw_box_section":
      case "draw_circle_section":
      case "draw_stroke":
        return "crosshair";
      case "place_seat":
      case "place_line":
      case "place_arc":
      case "place_grid":
        return "crosshair";
      case "erase":
        return "pointer";
      default:
        return "default";
    }
  })();

  // ── Render ─────────────────────────────────────────────────────────────

  return {
    containerRef,
    canvasRef,
    cursorStyle,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onWheel: handleWheel,
      onDoubleClick: handleDoubleClick,
      onKeyDown: handleKeyDown,
    },
    controls: {
      zoomIn,
      zoomOut,
      fitToContent,
    },
    worldToScreen,
  };
}
