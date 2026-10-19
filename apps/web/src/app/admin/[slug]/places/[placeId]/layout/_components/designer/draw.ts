// ─────────────────────────────────────────────────────────────────────────────
// Place Layout Designer — canvas rendering helpers
// ─────────────────────────────────────────────────────────────────────────────
// Pure drawing functions that accept a CanvasRenderingContext2D and state.
// No React dependencies — keeps rendering testable and separable from
// interaction logic.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DesignerSection,
  DesignerSeat,
  DesignerStage,
  DesignerImage,
  DesignerStroke,
  StrokeControlPoint,
  ArcPlacementGroup,
  LinePlacementGroup,
  GridPlacementGroup,
  PlacementPreview,
  Point,
  SnapTarget,
} from "./types";

import {
  computeLinePositions,
  computeArcPositions,
  computeGridPositions,
  computeLinePositionsWithSpacing,
  computeArcPositionsWithSpacing,
  computeGridPositionsWithSpacing,
  computeGridPositionsWithSeparateSpacing,
  tessellatedPolygon,
  findSharedBoundaryEdges,
} from "./reducer";

// ── Constants ────────────────────────────────────────────────────────────────

const STAGE_FILL = "rgba(100, 100, 100, 0.12)";
const STAGE_STROKE = "rgba(100, 100, 100, 0.4)";

const SELECTED_RING_COLOR = "#3b82f6"; // blue-500
const SELECTED_GLOW_COLOR = "rgba(59, 130, 246, 0.25)";
const DRAWING_POLYGON_STROKE = "#f97316"; // orange-500
const DRAWING_POLYGON_FILL = "rgba(249, 115, 22, 0.08)";
const SNAP_VERTEX_COLOR = "#f97316";

const SEAT_STROKE_ALPHA = 1;
const SEAT_FILL_ALPHA = 0.65;

const HELPER_SECTION_FILL_ALPHA = 0.06;
const HELPER_SECTION_STROKE_ALPHA = 0.35;
const HELPER_SECTION_LINE_DASH_SIZE = 6;

const GA_SECTION_FILL_ALPHA = 0.14;
const GA_SECTION_STROKE_ALPHA = 0.6;
const GA_HATCH_SPACING = 14; // pixels between hatch lines (in world units)

const GRID_COLOR = "rgba(160, 160, 160, 0.12)";
const GRID_COLOR_AXIS = "rgba(140, 140, 140, 0.3)";

/**
 * Choose a visually clean grid step for the current zoom level.
 * Returns a step size in world units.
 */
function gridStep(scale: number): number {
  // Target ~40-80 pixels between lines at the current scale
  const targetPx = 60;
  const raw = targetPx / scale;
  // Round to a "nice" value: 1, 2, 5, 10, 20, 50, 100, ...
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const mantissa = raw / base;
  if (mantissa < 2) return base;
  if (mantissa < 5) return 2 * base;
  return 5 * base;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith("#")) return hex;
  let r = 0,
    g = 0,
    b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1]! + hex[1]!, 16);
    g = parseInt(hex[2]! + hex[2]!, 16);
    b = parseInt(hex[3]! + hex[3]!, 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return hex;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Drawing functions ────────────────────────────────────────────────────────

/**
 * Draw a world-space grid that spans the visible canvas area.
 * Must be called inside the save/translate/scale block.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  viewport: { offsetX: number; offsetY: number; scale: number },
  canvasW: number,
  canvasH: number,
): void {
  const { offsetX, offsetY, scale } = viewport;
  const step = gridStep(scale);

  // Visible world-space bounds
  const minWX = -offsetX / scale;
  const minWY = -offsetY / scale;
  const maxWX = (canvasW - offsetX) / scale;
  const maxWY = (canvasH - offsetY) / scale;

  // Round to grid step
  const startX = Math.floor(minWX / step) * step;
  const startY = Math.floor(minWY / step) * step;

  ctx.save();
  ctx.lineWidth = 1 / scale;

  // Vertical lines
  for (let x = startX; x <= maxWX; x += step) {
    ctx.strokeStyle = x === 0 ? GRID_COLOR_AXIS : GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(x, minWY);
    ctx.lineTo(x, maxWY);
    ctx.stroke();
  }

  // Horizontal lines
  for (let y = startY; y <= maxWY; y += step) {
    ctx.strokeStyle = y === 0 ? GRID_COLOR_AXIS : GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(minWX, y);
    ctx.lineTo(maxWX, y);
    ctx.stroke();
  }

  ctx.restore();
}

export function drawBackgroundImage(
  ctx: CanvasRenderingContext2D,
  image: DesignerImage,
  htmlImage: HTMLImageElement | null,
  isSelected: boolean,
  scale: number,
): void {
  if (!htmlImage?.complete) return;

  ctx.save();
  ctx.globalAlpha = image.opacity;
  ctx.drawImage(
    htmlImage,
    image.position.x,
    image.position.y,
    image.width,
    image.height,
  );
  ctx.globalAlpha = 1;

  if (isSelected) {
    ctx.strokeStyle = SELECTED_RING_COLOR;
    ctx.lineWidth = 2 / scale;
    ctx.setLineDash([6 / scale, 4 / scale]);
    ctx.strokeRect(
      image.position.x,
      image.position.y,
      image.width,
      image.height,
    );
    ctx.setLineDash([]);
  }

  ctx.restore();
}

export function drawSections(
  ctx: CanvasRenderingContext2D,
  sections: DesignerSection[],
  selectedIds: Set<string>,
  scale: number,
): void {
  for (const section of sections) {
    const poly = section.polygon;
    if (poly.length < 3) continue;

    // Use tessellated (smooth) polygon for the rendered path, but keep
    // the original control polygon for label centroid calculation.
    const renderPoly = tessellatedPolygon(section);

    ctx.beginPath();
    ctx.moveTo(renderPoly[0]!.x, renderPoly[0]!.y);
    for (let i = 1; i < renderPoly.length; i++) {
      ctx.lineTo(renderPoly[i]!.x, renderPoly[i]!.y);
    }
    ctx.closePath();

    const isHelper = section.kind === "helper";
    const isGa = section.kind === "ga";
    const isSelected = selectedIds.has(section.sectionId);

    // Fill — varies by kind
    const fillAlpha = isHelper
      ? HELPER_SECTION_FILL_ALPHA
      : isGa
        ? GA_SECTION_FILL_ALPHA
        : 0.1;
    ctx.fillStyle = isSelected
      ? SELECTED_GLOW_COLOR
      : hexToRgba(section.color, fillAlpha);
    ctx.fill();

    // GA sections: add diagonal hatch pattern inside the polygon
    if (isGa && !isSelected) {
      ctx.save();
      ctx.clip();
      const hatchStep = GA_HATCH_SPACING / scale;
      // Compute polygon bounding box
      let bMinX = Infinity,
        bMinY = Infinity,
        bMaxX = -Infinity,
        bMaxY = -Infinity;
      for (const p of poly) {
        if (p.x < bMinX) bMinX = p.x;
        if (p.y < bMinY) bMinY = p.y;
        if (p.x > bMaxX) bMaxX = p.x;
        if (p.y > bMaxY) bMaxY = p.y;
      }
      ctx.strokeStyle = hexToRgba(section.color, 0.18);
      ctx.lineWidth = 0.5 / scale;
      ctx.beginPath();
      const diag = bMaxX - bMinX + bMaxY - bMinY;
      for (let d = 0; d < diag; d += hatchStep) {
        ctx.moveTo(bMinX + d, bMinY);
        ctx.lineTo(bMinX, bMinY + d);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Stroke style per kind
    if (isHelper) {
      ctx.setLineDash([
        HELPER_SECTION_LINE_DASH_SIZE / scale,
        HELPER_SECTION_LINE_DASH_SIZE / scale,
      ]);
    }
    const strokeAlpha = isHelper
      ? HELPER_SECTION_STROKE_ALPHA
      : isGa
        ? GA_SECTION_STROKE_ALPHA
        : 0.5;
    ctx.strokeStyle = isSelected
      ? SELECTED_RING_COLOR
      : hexToRgba(section.color, strokeAlpha);
    ctx.lineWidth = (isSelected ? 2.5 : isGa ? 1.5 : 1) / scale;
    ctx.stroke();
    if (isHelper) {
      ctx.setLineDash([]);
    }

    // Section label at centroid
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    const fontSize = Math.max(8 / scale, 2);
    ctx.fillStyle = hexToRgba(section.color, 0.8);
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const kindSuffix = isHelper ? " (helper)" : isGa ? " (GA)" : "";
    ctx.fillText(section.label + kindSuffix, cx, cy);

    // GA sections: show capacity below the label
    if (isGa && section.capacity != null) {
      const smallFont = Math.max(6 / scale, 1.5);
      ctx.font = `${smallFont}px system-ui, sans-serif`;
      ctx.fillStyle = hexToRgba(section.color, 0.6);
      ctx.fillText(`Cap: ${section.capacity}`, cx, cy + fontSize * 1.2);
    }
  }
}

// ── Per-edge smoothing overlays ──────────────────────────────────────────────

const EDGE_SMOOTH_DOT_COLOR = "#14b8a6"; // teal-500
const EDGE_SELECTED_COLOR = "#3b82f6"; // blue-500
const EDGE_SHARED_DASH_COLOR = "#f59e0b"; // amber-500

/**
 * Draw visual indicators for per-edge smoothing on sections:
 * - Small teal dots at midpoints of smooth edges
 * - Highlighted selected edge with endpoint handles
 * - Dashed amber line on shared boundary edges (adjacent section's matching edge)
 */
export function drawEdgeSmoothingOverlays(
  ctx: CanvasRenderingContext2D,
  sections: DesignerSection[],
  selectedEdge: { sectionId: string; edgeIndex: number } | null,
  scale: number,
): void {
  const dotRadius = 3 / scale;
  const handleRadius = 4 / scale;

  // 1. Draw teal dots at midpoints of every smooth edge
  for (const section of sections) {
    if (!section.edgeSmoothing || section.edgeSmoothing.length === 0) continue;
    const poly = section.polygon;
    const n = poly.length;
    for (const flag of section.edgeSmoothing) {
      if (flag.smoothing <= 0) continue;
      const a = poly[flag.edgeIndex];
      const b = poly[(flag.edgeIndex + 1) % n];
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.arc(mx, my, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = EDGE_SMOOTH_DOT_COLOR;
      ctx.fill();
    }
  }

  // 2. Highlight the selected edge
  if (selectedEdge) {
    const section = sections.find(
      (s) => s.sectionId === selectedEdge.sectionId,
    );
    if (section) {
      const poly = section.polygon;
      const n = poly.length;
      const a = poly[selectedEdge.edgeIndex];
      const b = poly[(selectedEdge.edgeIndex + 1) % n];
      if (a && b) {
        // Draw the edge line
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = EDGE_SELECTED_COLOR;
        ctx.lineWidth = 3 / scale;
        ctx.stroke();

        // Endpoint handles
        for (const pt of [a, b]) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
          ctx.fillStyle = EDGE_SELECTED_COLOR;
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1 / scale;
          ctx.stroke();
        }

        // 3. Shared boundary indicator: dashed amber on matching edges
        const shared = findSharedBoundaryEdges(
          sections,
          selectedEdge.sectionId,
          selectedEdge.edgeIndex,
        );
        for (const match of shared) {
          const otherSection = sections.find(
            (s) => s.sectionId === match.sectionId,
          );
          if (!otherSection) continue;
          const m = otherSection.polygon.length;
          const c = otherSection.polygon[match.edgeIndex];
          const d = otherSection.polygon[(match.edgeIndex + 1) % m];
          if (!c || !d) continue;
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(d.x, d.y);
          ctx.strokeStyle = EDGE_SHARED_DASH_COLOR;
          ctx.lineWidth = 2 / scale;
          ctx.setLineDash([6 / scale, 4 / scale]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
}

export function drawSeats(
  ctx: CanvasRenderingContext2D,
  seats: DesignerSeat[],
  sectionColorMap: Map<string, string>,
  selectedIds: Set<string>,
  scale: number,
): void {
  const fallback = "#888888";

  for (const seat of seats) {
    const color = sectionColorMap.get(seat.sectionId) ?? fallback;
    const isSelected = selectedIds.has(seat.id);

    // Seat circle
    ctx.beginPath();
    ctx.arc(seat.position.x, seat.position.y, seat.radius, 0, Math.PI * 2);
    ctx.fillStyle = isSelected
      ? hexToRgba(color, 0.9)
      : hexToRgba(color, SEAT_FILL_ALPHA);
    ctx.fill();
    ctx.strokeStyle = isSelected
      ? SELECTED_RING_COLOR
      : hexToRgba(color, SEAT_STROKE_ALPHA);
    ctx.lineWidth = (isSelected ? 1.2 : 0.5) / scale;
    ctx.stroke();

    // Selection glow ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(
        seat.position.x,
        seat.position.y,
        seat.radius + 2.5 / scale,
        0,
        Math.PI * 2,
      );
      ctx.strokeStyle = SELECTED_RING_COLOR;
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke();
    }

    // ADA accessible indicator — blue badge on the seat
    if (seat.accessible) {
      const badgeR = seat.radius * 0.45;
      const bx = seat.position.x;
      const by = seat.position.y;

      // Blue circle background
      ctx.beginPath();
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = "#2563eb";
      ctx.fill();

      // Wheelchair icon (simplified ♿ glyph)
      const iconSize = badgeR * 1.3;
      ctx.fillStyle = "#ffffff";
      ctx.font = `${iconSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("♿", bx, by);
    }

    // Seat label (only when zoomed in enough)
    if (scale > 1.5 && !seat.accessible) {
      const fontSize = Math.max(3, Math.min(seat.radius * 0.9, 6));
      ctx.fillStyle = "#fff";
      ctx.font = `${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${seat.row}${seat.seat}`, seat.position.x, seat.position.y);
    }
  }
}

export function drawStage(
  ctx: CanvasRenderingContext2D,
  stage: DesignerStage,
  scale: number,
): void {
  const { minX, minY, maxX, maxY } = stage.bounds;
  ctx.fillStyle = STAGE_FILL;
  ctx.strokeStyle = STAGE_STROKE;
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.rect(minX, minY, maxX - minX, maxY - minY);
  ctx.fill();
  ctx.stroke();

  if (stage.label) {
    const fontSize = Math.max(10 / scale, 3);
    ctx.fillStyle = "rgba(80, 80, 80, 0.7)";
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(stage.label, (minX + maxX) / 2, (minY + maxY) / 2);
  }
}

export function drawDrawingPolygon(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  cursorWorld: Point | null,
  scale: number,
): void {
  if (points.length === 0) return;

  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i]!.x, points[i]!.y);
  }
  // Draw line to cursor for preview
  if (cursorWorld) {
    ctx.lineTo(cursorWorld.x, cursorWorld.y);
  }
  if (points.length >= 3) {
    ctx.closePath();
    ctx.fillStyle = DRAWING_POLYGON_FILL;
    ctx.fill();
  }

  ctx.strokeStyle = DRAWING_POLYGON_STROKE;
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw vertices
  for (const pt of points) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3 / scale, 0, Math.PI * 2);
    ctx.fillStyle = SNAP_VERTEX_COLOR;
    ctx.fill();
  }
}

export function drawOriginCrosshair(
  ctx: CanvasRenderingContext2D,
  scale: number,
): void {
  const len = 20 / scale;
  ctx.save();
  ctx.strokeStyle = "rgba(150, 150, 150, 0.3)";
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  ctx.moveTo(-len, 0);
  ctx.lineTo(len, 0);
  ctx.moveTo(0, -len);
  ctx.lineTo(0, len);
  ctx.stroke();
  ctx.restore();
}

// ── HUD overlays (drawn in screen space, after ctx.restore) ──────────────────

/**
 * Draw ghost seats for a batch placement preview (line / arc / grid).
 * Called in world-space (inside the save/translate/scale block).
 */
export function drawPlacementPreview(
  ctx: CanvasRenderingContext2D,
  preview: PlacementPreview,
  seatRadius: number,
  scale: number,
  spacing?: number,
  spacingX?: number,
  spacingY?: number,
): void {
  if (!preview) return;

  let positions: Point[];
  switch (preview.kind) {
    case "line":
      positions =
        spacing && spacing > 0
          ? computeLinePositionsWithSpacing(preview.start, preview.end, spacing)
          : computeLinePositions(preview.start, preview.end, preview.count);
      break;
    case "arc":
      positions =
        spacing && spacing > 0
          ? computeArcPositionsWithSpacing(
              preview.center,
              preview.radius,
              preview.startAngle,
              preview.endAngle,
              spacing,
            )
          : computeArcPositions(
              preview.center,
              preview.radius,
              preview.startAngle,
              preview.endAngle,
              preview.count,
            );
      break;
    case "grid": {
      const effSpX = spacingX ?? 0;
      const effSpY = spacingY ?? 0;
      const hasPerAxis = effSpX > 0 || effSpY > 0;
      if (hasPerAxis) {
        positions = computeGridPositionsWithSeparateSpacing(
          preview.origin,
          preview.extent,
          preview.rows,
          preview.cols,
          effSpX,
          effSpY,
        );
      } else if (spacing && spacing > 0) {
        positions = computeGridPositionsWithSpacing(
          preview.origin,
          preview.extent,
          preview.rows,
          preview.cols,
          spacing,
        );
      } else {
        positions = computeGridPositions(
          preview.origin,
          preview.extent,
          preview.rows,
          preview.cols,
        );
      }
      break;
    }
    default:
      return;
  }

  // Ghost seat style
  const ghostFill = "rgba(59, 130, 246, 0.25)";
  const ghostStroke = "rgba(59, 130, 246, 0.6)";

  for (const pos of positions) {
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, seatRadius, 0, Math.PI * 2);
    ctx.fillStyle = ghostFill;
    ctx.fill();
    ctx.strokeStyle = ghostStroke;
    ctx.lineWidth = 0.8 / scale;
    ctx.stroke();
  }

  // Draw guide lines/shapes for context
  if (preview.kind === "line" && positions.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(preview.start.x, preview.start.y);
    ctx.lineTo(preview.end.x, preview.end.y);
    ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (preview.kind === "arc") {
    ctx.beginPath();
    ctx.arc(
      preview.center.x,
      preview.center.y,
      preview.radius,
      preview.startAngle,
      preview.endAngle,
    );
    ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (preview.kind === "grid" && positions.length > 0) {
    ctx.strokeStyle = "rgba(59, 130, 246, 0.2)";
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeRect(
      preview.origin.x,
      preview.origin.y,
      preview.extent.x - preview.origin.x,
      preview.extent.y - preview.origin.y,
    );
    ctx.setLineDash([]);
  }
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  seatCount: number,
  sectionCount: number,
  _canvasW: number,
  canvasH: number,
  toolName: string,
  undoDepth: number,
): void {
  // Skip the HUD entirely when the layout is empty
  if (seatCount === 0 && sectionCount === 0) return;

  const text = `${seatCount.toLocaleString()} seats · ${sectionCount} sections · ${toolName}${undoDepth > 0 ? ` · ${undoDepth} undo` : ""}`;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  // Measure text so we can draw a background pill
  const metrics = ctx.measureText(text);
  const px = 8;
  const py = canvasH - 8;
  const padH = 6;
  const padV = 4;
  const pillW = metrics.width + padH * 2;
  const pillH = 14 + padV * 2; // approx line height + padding
  const pillX = px - padH;
  const pillY = py - 14 - padV; // baseline offset

  // Semi-transparent dark background pill
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 4);
  ctx.fill();

  // Light text on dark pill
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillText(text, px, py);
}

// ── Strokes ──────────────────────────────────────────────────────────────────

/**
 * Draw committed strokes with Bezier handles.
 * Called in world-space (inside the save/translate/scale block).
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: DesignerStroke[],
  selectedIds: Set<string>,
  scale: number,
): void {
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue;
    const isSelected = selectedIds.has(stroke.id);

    ctx.beginPath();
    const first = stroke.points[0]!;
    ctx.moveTo(first.position.x, first.position.y);

    for (let i = 1; i < stroke.points.length; i++) {
      const prev = stroke.points[i - 1]!;
      const curr = stroke.points[i]!;
      const hasHandleOut = prev.handleOut != null;
      const hasHandleIn = curr.handleIn != null;

      if (hasHandleOut || hasHandleIn) {
        // Cubic Bezier
        const cp1x = prev.position.x + (prev.handleOut?.x ?? 0);
        const cp1y = prev.position.y + (prev.handleOut?.y ?? 0);
        const cp2x = curr.position.x + (curr.handleIn?.x ?? 0);
        const cp2y = curr.position.y + (curr.handleIn?.y ?? 0);
        ctx.bezierCurveTo(
          cp1x,
          cp1y,
          cp2x,
          cp2y,
          curr.position.x,
          curr.position.y,
        );
      } else {
        ctx.lineTo(curr.position.x, curr.position.y);
      }
    }

    if (stroke.closed && stroke.points.length >= 3) {
      ctx.closePath();
    }

    ctx.strokeStyle = isSelected ? SELECTED_RING_COLOR : stroke.color;
    ctx.lineWidth = stroke.strokeWidth / scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // Draw control point handles — always visible so users can see anchors
    drawStrokeHandles(ctx, stroke, scale, isSelected);
  }
}

function drawStrokeHandles(
  ctx: CanvasRenderingContext2D,
  stroke: DesignerStroke,
  scale: number,
  isSelected = true,
): void {
  const handleRadius = 3 / scale;
  const anchorRadius = 3.5 / scale;
  const anchorColor = isSelected
    ? SELECTED_RING_COLOR
    : "rgba(59, 130, 246, 0.45)";
  const lineColor = isSelected
    ? "rgba(59, 130, 246, 0.5)"
    : "rgba(59, 130, 246, 0.25)";
  const handleStroke = isSelected
    ? SELECTED_RING_COLOR
    : "rgba(59, 130, 246, 0.45)";

  for (const cp of stroke.points) {
    // Anchor point
    ctx.beginPath();
    ctx.arc(cp.position.x, cp.position.y, anchorRadius, 0, Math.PI * 2);
    ctx.fillStyle = anchorColor;
    ctx.fill();

    // Handle in
    if (cp.handleIn) {
      const hx = cp.position.x + cp.handleIn.x;
      const hy = cp.position.y + cp.handleIn.y;
      ctx.beginPath();
      ctx.moveTo(cp.position.x, cp.position.y);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1 / scale;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hx, hy, handleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = handleStroke;
      ctx.lineWidth = 1 / scale;
      ctx.fill();
      ctx.stroke();
    }

    // Handle out
    if (cp.handleOut) {
      const hx = cp.position.x + cp.handleOut.x;
      const hy = cp.position.y + cp.handleOut.y;
      ctx.beginPath();
      ctx.moveTo(cp.position.x, cp.position.y);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1 / scale;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hx, hy, handleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = handleStroke;
      ctx.lineWidth = 1 / scale;
      ctx.fill();
      ctx.stroke();
    }
  }
}

/**
 * Draw the in-progress stroke (freeform drawing points).
 * Called in world-space.
 */
export function drawDrawingStroke(
  ctx: CanvasRenderingContext2D,
  points: StrokeControlPoint[],
  color: string,
  strokeWidth: number,
  scale: number,
): void {
  if (points.length === 0) return;

  // Draw the Bezier path
  if (points.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(points[0]!.position.x, points[0]!.position.y);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const cp1 = a.handleOut
        ? { x: a.position.x + a.handleOut.x, y: a.position.y + a.handleOut.y }
        : a.position;
      const cp2 = b.handleIn
        ? { x: b.position.x + b.handleIn.x, y: b.position.y + b.handleIn.y }
        : b.position;
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, b.position.x, b.position.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth / scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // Draw anchor points and handle lines
  const r = 4 / scale;
  for (const pt of points) {
    // Handle lines
    if (pt.handleOut) {
      const hx = pt.position.x + pt.handleOut.x;
      const hy = pt.position.y + pt.handleOut.y;
      ctx.beginPath();
      ctx.moveTo(pt.position.x, pt.position.y);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = "rgba(0,120,255,0.6)";
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
      // Handle dot
      ctx.beginPath();
      ctx.arc(hx, hy, r * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,120,255,0.8)";
      ctx.fill();
    }
    if (pt.handleIn) {
      const hx = pt.position.x + pt.handleIn.x;
      const hy = pt.position.y + pt.handleIn.y;
      ctx.beginPath();
      ctx.moveTo(pt.position.x, pt.position.y);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = "rgba(0,120,255,0.6)";
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, hy, r * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,120,255,0.8)";
      ctx.fill();
    }
    // Anchor point
    ctx.beginPath();
    ctx.arc(pt.position.x, pt.position.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 / scale;
    ctx.stroke();
  }
}

// ── Box section preview ──────────────────────────────────────────────────────

/**
 * Draw a preview rectangle while the user is dragging to create a box section.
 * Called in world-space.
 */
export function drawBoxSectionPreview(
  ctx: CanvasRenderingContext2D,
  start: Point,
  current: Point,
  color: string,
  scale: number,
): void {
  const minX = Math.min(start.x, current.x);
  const minY = Math.min(start.y, current.y);
  const w = Math.abs(current.x - start.x);
  const h = Math.abs(current.y - start.y);

  ctx.fillStyle = hexToRgba(color, 0.15);
  ctx.fillRect(minX, minY, w, h);

  ctx.strokeStyle = hexToRgba(color, 0.6);
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([5 / scale, 3 / scale]);
  ctx.strokeRect(minX, minY, w, h);
  ctx.setLineDash([]);

  // Dimension labels
  const fontSize = Math.max(8 / scale, 2);
  ctx.fillStyle = hexToRgba(color, 0.8);
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(
    `${Math.round(w)}×${Math.round(h)}`,
    minX + w / 2,
    minY + h + 4 / scale,
  );
}

/**
 * Draw a live circle section preview while the user drags from center to edge.
 * Called in world-space.
 */
export function drawCircleSectionPreview(
  ctx: CanvasRenderingContext2D,
  center: Point,
  current: Point,
  color: string,
  scale: number,
): void {
  const dx = current.x - center.x;
  const dy = current.y - center.y;
  const radius = Math.sqrt(dx * dx + dy * dy);

  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);

  ctx.fillStyle = hexToRgba(color, 0.15);
  ctx.fill();

  ctx.strokeStyle = hexToRgba(color, 0.6);
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([5 / scale, 3 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Radius label
  const fontSize = Math.max(8 / scale, 2);
  ctx.fillStyle = hexToRgba(color, 0.8);
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(
    `r=${Math.round(radius)}`,
    center.x,
    center.y + radius + 4 / scale,
  );

  // Small cross at center
  const crossSize = 4 / scale;
  ctx.beginPath();
  ctx.moveTo(center.x - crossSize, center.y);
  ctx.lineTo(center.x + crossSize, center.y);
  ctx.moveTo(center.x, center.y - crossSize);
  ctx.lineTo(center.x, center.y + crossSize);
  ctx.strokeStyle = hexToRgba(color, 0.6);
  ctx.lineWidth = 1 / scale;
  ctx.stroke();
}

// ── Arc group handles ────────────────────────────────────────────────────────

/**
 * Draw interactive handles for a selected arc placement group.
 * Renders: arc guide line, center handle, radius handle, start/end angle handles.
 * Called in world-space.
 */
export function drawArcGroupHandles(
  ctx: CanvasRenderingContext2D,
  group: ArcPlacementGroup,
  scale: number,
): void {
  const { center, radius, startAngle, endAngle } = group;

  // Draw the arc guide line
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, startAngle, endAngle);
  ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw full-circle guide (faded)
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(59, 130, 246, 0.1)";
  ctx.lineWidth = 0.5 / scale;
  ctx.stroke();

  const handleRadius = 5 / scale;
  const smallHandleRadius = 4 / scale;

  // Center handle (filled blue)
  ctx.beginPath();
  ctx.arc(center.x, center.y, handleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(59, 130, 246, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // Radius handle — at midpoint angle on the arc perimeter
  const midAngle = (startAngle + endAngle) / 2;
  const radiusHandleX = center.x + radius * Math.cos(midAngle);
  const radiusHandleY = center.y + radius * Math.sin(midAngle);

  // Draw radius line from center to handle
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(radiusHandleX, radiusHandleY);
  ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([3 / scale, 2 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(radiusHandleX, radiusHandleY, smallHandleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = "rgba(59, 130, 246, 0.9)";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // Start angle handle — on the arc perimeter at startAngle
  const startHandleX = center.x + radius * Math.cos(startAngle);
  const startHandleY = center.y + radius * Math.sin(startAngle);
  ctx.beginPath();
  ctx.arc(startHandleX, startHandleY, smallHandleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(34, 197, 94, 0.9)"; // green
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // End angle handle — on the arc perimeter at endAngle
  const endHandleX = center.x + radius * Math.cos(endAngle);
  const endHandleY = center.y + radius * Math.sin(endAngle);
  ctx.beginPath();
  ctx.arc(endHandleX, endHandleY, smallHandleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(239, 68, 68, 0.9)"; // red
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // Labels
  const fontSize = Math.max(9 / scale, 2);
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  ctx.fillStyle = "rgba(59, 130, 246, 0.8)";
  ctx.fillText("center", center.x, center.y - handleRadius - 2 / scale);

  ctx.fillStyle = "rgba(59, 130, 246, 0.7)";
  ctx.fillText(
    `r=${Math.round(radius)}`,
    radiusHandleX,
    radiusHandleY - smallHandleRadius - 2 / scale,
  );
}

/**
 * Determine which arc group handle (if any) is near the given world point.
 * Returns the handle kind or null.
 */
export function hitTestArcGroupHandle(
  group: ArcPlacementGroup,
  worldPoint: Point,
  scale: number,
): "center" | "radius" | "startAngle" | "endAngle" | null {
  const hitRadius = 8 / scale;
  const { center, radius, startAngle, endAngle } = group;

  // Center handle
  const dcx = worldPoint.x - center.x;
  const dcy = worldPoint.y - center.y;
  if (Math.sqrt(dcx * dcx + dcy * dcy) <= hitRadius) return "center";

  // Radius handle (at mid-angle on perimeter)
  const midAngle = (startAngle + endAngle) / 2;
  const rx = center.x + radius * Math.cos(midAngle);
  const ry = center.y + radius * Math.sin(midAngle);
  const drx = worldPoint.x - rx;
  const dry = worldPoint.y - ry;
  if (Math.sqrt(drx * drx + dry * dry) <= hitRadius) return "radius";

  // Start angle handle
  const sx = center.x + radius * Math.cos(startAngle);
  const sy = center.y + radius * Math.sin(startAngle);
  const dsx = worldPoint.x - sx;
  const dsy = worldPoint.y - sy;
  if (Math.sqrt(dsx * dsx + dsy * dsy) <= hitRadius) return "startAngle";

  // End angle handle
  const ex = center.x + radius * Math.cos(endAngle);
  const ey = center.y + radius * Math.sin(endAngle);
  const dex = worldPoint.x - ex;
  const dey = worldPoint.y - ey;
  if (Math.sqrt(dex * dex + dey * dey) <= hitRadius) return "endAngle";

  return null;
}

// ── Line group handles ───────────────────────────────────────────────────────

/**
 * Draw interactive handles for a selected line placement group.
 * Renders: guide line, start handle, end handle.
 * Called in world-space.
 */
export function drawLineGroupHandles(
  ctx: CanvasRenderingContext2D,
  group: LinePlacementGroup,
  scale: number,
): void {
  const { start, end } = group;
  const handleRadius = 5 / scale;

  // Guide line
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start handle (green)
  ctx.beginPath();
  ctx.arc(start.x, start.y, handleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // End handle (red)
  ctx.beginPath();
  ctx.arc(end.x, end.y, handleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // Labels
  const fontSize = Math.max(9 / scale, 2);
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(34, 197, 94, 0.8)";
  ctx.fillText("start", start.x, start.y - handleRadius - 2 / scale);
  ctx.fillStyle = "rgba(239, 68, 68, 0.8)";
  ctx.fillText("end", end.x, end.y - handleRadius - 2 / scale);
}

/**
 * Determine which line group handle (if any) is near the given world point.
 */
export function hitTestLineGroupHandle(
  group: LinePlacementGroup,
  worldPoint: Point,
  scale: number,
): "start" | "end" | null {
  const hitRadius = 8 / scale;

  const dsx = worldPoint.x - group.start.x;
  const dsy = worldPoint.y - group.start.y;
  if (Math.sqrt(dsx * dsx + dsy * dsy) <= hitRadius) return "start";

  const dex = worldPoint.x - group.end.x;
  const dey = worldPoint.y - group.end.y;
  if (Math.sqrt(dex * dex + dey * dey) <= hitRadius) return "end";

  return null;
}

// ── Grid group handles ───────────────────────────────────────────────────────

/**
 * Draw interactive handles for a selected grid placement group.
 * Renders: outline rectangle, origin handle, extent handle.
 * Called in world-space.
 */
export function drawGridGroupHandles(
  ctx: CanvasRenderingContext2D,
  group: GridPlacementGroup,
  scale: number,
): void {
  const { origin, extent } = group;
  const handleRadius = 5 / scale;

  // Guide rectangle
  ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.strokeRect(origin.x, origin.y, extent.x - origin.x, extent.y - origin.y);
  ctx.setLineDash([]);

  // Origin handle (green)
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, handleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // Extent handle (red)
  ctx.beginPath();
  ctx.arc(extent.x, extent.y, handleRadius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();

  // Labels
  const fontSize = Math.max(9 / scale, 2);
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(34, 197, 94, 0.8)";
  ctx.fillText("origin", origin.x, origin.y - handleRadius - 2 / scale);
  ctx.fillStyle = "rgba(239, 68, 68, 0.8)";
  ctx.fillText("extent", extent.x, extent.y - handleRadius - 2 / scale);
}

/**
 * Determine which grid group handle (if any) is near the given world point.
 */
export function hitTestGridGroupHandle(
  group: GridPlacementGroup,
  worldPoint: Point,
  scale: number,
): "origin" | "extent" | null {
  const hitRadius = 8 / scale;

  const dox = worldPoint.x - group.origin.x;
  const doy = worldPoint.y - group.origin.y;
  if (Math.sqrt(dox * dox + doy * doy) <= hitRadius) return "origin";

  const dex = worldPoint.x - group.extent.x;
  const dey = worldPoint.y - group.extent.y;
  if (Math.sqrt(dex * dex + dey * dey) <= hitRadius) return "extent";

  return null;
}

// ── Section polygon point handles ────────────────────────────────────────────

/**
 * Draw draggable point handles on a selected section's polygon vertices.
 * Called in world-space.
 */
export function drawSectionPointHandles(
  ctx: CanvasRenderingContext2D,
  section: DesignerSection,
  scale: number,
): void {
  const handleRadius = 4 / scale;
  for (let i = 0; i < section.polygon.length; i++) {
    const pt = section.polygon[i]!;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(59, 130, 246, 0.9)";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5 / scale;
    ctx.stroke();
  }
}

/**
 * Determine which section polygon point handle (if any) is near the given world point.
 * Returns the point index or -1.
 */
export function hitTestSectionPointHandle(
  section: DesignerSection,
  worldPoint: Point,
  scale: number,
): number {
  const hitRadius = 8 / scale;
  for (let i = 0; i < section.polygon.length; i++) {
    const pt = section.polygon[i]!;
    const dx = worldPoint.x - pt.x;
    const dy = worldPoint.y - pt.y;
    if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) return i;
  }
  return -1;
}

// ── Vertex snap indicator ────────────────────────────────────────────────────

const SNAP_INDICATOR_INNER = "#f97316"; // orange-500
const SNAP_INDICATOR_OUTER = "rgba(249, 115, 22, 0.3)";

/**
 * Draw a highlighted ring around a snap-target vertex so the user can see
 * they will snap to an existing section corner.  Called in world-space.
 */
export function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  target: SnapTarget,
  scale: number,
): void {
  const { x, y } = target.point;
  const inner = 4 / scale;
  const outer = 10 / scale;

  // Outer glow ring
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, Math.PI * 2);
  ctx.fillStyle = SNAP_INDICATOR_OUTER;
  ctx.fill();

  // Inner filled dot
  ctx.beginPath();
  ctx.arc(x, y, inner, 0, Math.PI * 2);
  ctx.fillStyle = SNAP_INDICATOR_INNER;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();
}

/**
 * Determine which stroke control-point anchor or Bezier handle (if any) is
 * near the given world point.
 *
 * Returns an object identifying the hit:
 *   - `{ kind: "anchor", pointIndex }` when the anchor itself is hit
 *   - `{ kind: "handleIn" | "handleOut", pointIndex }` when a Bezier handle is hit
 *   - `null` when nothing is close enough
 */
export type StrokePointHit =
  | { kind: "anchor"; pointIndex: number }
  | { kind: "handleIn"; pointIndex: number }
  | { kind: "handleOut"; pointIndex: number };

export function hitTestStrokePointHandle(
  stroke: DesignerStroke,
  worldPoint: Point,
  scale: number,
): StrokePointHit | null {
  const hitRadius = 8 / scale;
  for (let i = 0; i < stroke.points.length; i++) {
    const cp = stroke.points[i]!;

    // Check anchor
    const adx = worldPoint.x - cp.position.x;
    const ady = worldPoint.y - cp.position.y;
    if (Math.sqrt(adx * adx + ady * ady) <= hitRadius) {
      return { kind: "anchor", pointIndex: i };
    }

    // Check handleIn (relative to anchor)
    if (cp.handleIn) {
      const hx = cp.position.x + cp.handleIn.x;
      const hy = cp.position.y + cp.handleIn.y;
      const hdx = worldPoint.x - hx;
      const hdy = worldPoint.y - hy;
      if (Math.sqrt(hdx * hdx + hdy * hdy) <= hitRadius) {
        return { kind: "handleIn", pointIndex: i };
      }
    }

    // Check handleOut (relative to anchor)
    if (cp.handleOut) {
      const hx = cp.position.x + cp.handleOut.x;
      const hy = cp.position.y + cp.handleOut.y;
      const hdx = worldPoint.x - hx;
      const hdy = worldPoint.y - hy;
      if (Math.sqrt(hdx * hdx + hdy * hdy) <= hitRadius) {
        return { kind: "handleOut", pointIndex: i };
      }
    }
  }
  return null;
}
