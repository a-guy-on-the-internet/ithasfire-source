/**
 * Pure geometry helpers for the seat-map touch zoom/navigation UX.
 *
 * The SVG seat map renders a world-coordinate layout inside a viewBox and
 * applies a `translate(t) scale(s)` group transform, so a world point `p`
 * lands at viewBox coordinate `s * p + t`. These helpers compute:
 *
 * - the zoom floor at which seats become comfortably tappable (~22px),
 * - section-focus transforms that respect that floor,
 * - translate clamping that keeps the viewport centred over content,
 * - nearest-seat hit-slop resolution for imprecise touch taps.
 *
 * Everything here is pure and unit-tested in `seat-map-zoom.test.ts`.
 */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Minimum comfortable on-screen seat diameter (and tap slop radius) in px. */
export const TARGET_SEAT_TAP_PX = 22;

/** Default zoom ceiling before the tap-target floor raises it. */
export const BASE_MAX_SCALE = 3;

/** Median of a list of numbers; 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Screen pixels per world unit at zoom scale 1.
 *
 * SVG with default `preserveAspectRatio` ("xMidYMid meet") fits the viewBox
 * into the viewport on the tighter axis.
 */
export function computeBaseUnitScale(
  viewBox: Size,
  viewportPx: Size | null,
): number {
  if (!viewportPx || viewportPx.width <= 0 || viewportPx.height <= 0) return 0;
  if (viewBox.width <= 0 || viewBox.height <= 0) return 0;
  return Math.min(
    viewportPx.width / viewBox.width,
    viewportPx.height / viewBox.height,
  );
}

/**
 * The zoom scale at which the median seat glyph's on-screen DIAMETER reaches
 * `targetDiameterPx`. May be below 1 when seats are already large at fit zoom.
 */
export function computeMinUsableScale(
  medianSeatRadius: number,
  baseUnitScale: number,
  targetDiameterPx: number = TARGET_SEAT_TAP_PX,
): number {
  const diameterAtScale1 = 2 * medianSeatRadius * baseUnitScale;
  if (diameterAtScale1 <= 0) return 1;
  return targetDiameterPx / diameterAtScale1;
}

/**
 * Effective max zoom: raised above the base ceiling when needed so the
 * tap-target floor is always reachable with headroom.
 */
export function computeMaxScale(
  minUsableScale: number,
  baseMaxScale: number = BASE_MAX_SCALE,
): number {
  return Math.max(baseMaxScale, minUsableScale * 1.25);
}

/**
 * Clamp a translate so the world point under the viewport centre stays
 * inside `content`. Unlike a symmetric magnitude clamp, this permits the
 * large translates required to centre far-from-origin sections at high zoom
 * while never letting the map fly fully off screen.
 */
export function clampTranslateToContent(
  tx: number,
  ty: number,
  scale: number,
  content: Bounds,
  viewCenter: Point,
): Point {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
  return {
    x: clamp(
      tx,
      viewCenter.x - scale * content.maxX,
      viewCenter.x - scale * content.minX,
    ),
    y: clamp(
      ty,
      viewCenter.y - scale * content.maxY,
      viewCenter.y - scale * content.minY,
    ),
  };
}

/**
 * Recompute a translate for a scale change so the world point under the
 * viewport centre stays fixed (zoom anchors at the centre of the view).
 */
export function anchorTranslateForScaleChange(
  translate: Point,
  prevScale: number,
  nextScale: number,
  viewCenter: Point,
): Point {
  if (prevScale <= 0) return translate;
  const ratio = nextScale / prevScale;
  return {
    x: viewCenter.x - ratio * (viewCenter.x - translate.x),
    y: viewCenter.y - ratio * (viewCenter.y - translate.y),
  };
}

/** Bounding box of a set of points; null when empty. */
export function boundsOfPoints(points: Point[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Bounding box across one or more polygons; null when empty. */
export function boundsOfPolygons(polygons: Point[][]): Bounds | null {
  return boundsOfPoints(polygons.flat());
}

export type SectionFocusOptions = {
  /** World-space bounding box of the section being focused. */
  sectionBounds: Bounds;
  /** World-space bounding box of the whole layout (seatIndexBounds). */
  contentBounds: Bounds;
  /** World point at the centre of the base (scale 1) view. */
  viewCenter: Point;
  /** World-unit size of the base view (layout width/height). */
  viewSize: Size;
  /** Tap-target zoom floor — focus never lands below this. */
  minUsableScale: number;
  minScale: number;
  maxScale: number;
  /** Fraction of the viewport the section should fill when fitting. */
  fillFraction?: number;
};

/**
 * Scale + translate that centres a section in the viewport at
 * `max(fitSectionScale, minUsableScale)`, clamped to [minScale, maxScale].
 */
export function computeSectionFocusTransform(opts: SectionFocusOptions): {
  scale: number;
  translate: Point;
} {
  const fill = opts.fillFraction ?? 0.85;
  const sWidth = Math.max(opts.sectionBounds.maxX - opts.sectionBounds.minX, 1e-6);
  const sHeight = Math.max(
    opts.sectionBounds.maxY - opts.sectionBounds.minY,
    1e-6,
  );
  const fitScale = Math.min(
    (opts.viewSize.width * fill) / sWidth,
    (opts.viewSize.height * fill) / sHeight,
  );
  const scale = Math.min(
    opts.maxScale,
    Math.max(opts.minScale, Math.max(fitScale, opts.minUsableScale)),
  );
  const cx = (opts.sectionBounds.minX + opts.sectionBounds.maxX) / 2;
  const cy = (opts.sectionBounds.minY + opts.sectionBounds.maxY) / 2;
  const translate = clampTranslateToContent(
    opts.viewCenter.x - scale * cx,
    opts.viewCenter.y - scale * cy,
    scale,
    opts.contentBounds,
    opts.viewCenter,
  );
  return { scale, translate };
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x;
    const yi = polygon[i]!.y;
    const xj = polygon[j]!.x;
    const yj = polygon[j]!.y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** First section whose polygon contains the point; null when none do. */
export function findSectionAtPoint(
  point: Point,
  sections: { sectionId: string; polygons: Point[][] }[],
): string | null {
  for (const section of sections) {
    for (const polygon of section.polygons) {
      if (polygon.length >= 3 && pointInPolygon(point, polygon)) {
        return section.sectionId;
      }
    }
  }
  return null;
}

export type SlopSeat = {
  seatId: string;
  sectionId: string;
  x: number;
  y: number;
  /** Glyph radius in world units. */
  radius: number;
  /** AVAILABLE or already selected (toggleable). Never unavailable seats. */
  selectable: boolean;
};

/**
 * Nearest selectable seat whose glyph EDGE is within `slopRadius` world
 * units of the tap point.
 *
 * When `restrictToSectionId` is provided (the section polygon containing the
 * tap), only that section's seats are eligible — taps never slop-select
 * across section boundaries. When the tap lands outside every polygon, the
 * nearest selectable seat within slop wins regardless of section.
 */
export function findNearestSeatWithinSlop(
  point: Point,
  seats: SlopSeat[],
  slopRadius: number,
  restrictToSectionId?: string | null,
): SlopSeat | null {
  let best: SlopSeat | null = null;
  let bestDist = Infinity;
  for (const seat of seats) {
    if (!seat.selectable) continue;
    if (restrictToSectionId && seat.sectionId !== restrictToSectionId) continue;
    const edgeDist =
      Math.hypot(seat.x - point.x, seat.y - point.y) - seat.radius;
    if (edgeDist > slopRadius) continue;
    if (edgeDist < bestDist) {
      bestDist = edgeDist;
      best = seat;
    }
  }
  return best;
}
