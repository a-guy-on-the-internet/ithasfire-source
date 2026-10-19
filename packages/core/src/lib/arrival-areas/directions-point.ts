import type {
  ArrivalAreaGeometry,
  ArrivalAreaPosition,
} from "@th/types/repos/arrival-areas";

import { haversineDistance } from "../geo/haversine";
import { localPlaneMeters, validateArrivalAreaShape } from "./geometry";

// ─────────────────────────────────────────────────────────────────────────────
// Where "Directions" sends a visitor for one area (arrival-areas FR-007, owner
// ruling R3 Q4: the shape's centre as lat/lng, no entrance spot, no reverse
// geocoding).
//
//   Polygon    → the pole of inaccessibility (the polylabel algorithm): the
//                point inside the ring farthest from its edges. Unlike the
//                centroid it is INSIDE by construction, so an L-shaped lot
//                never routes to the far side of a fence.
//   LineString → the point halfway along the line's length.
//
// Protected location data (NFR-002): it follows the address's visibility,
// and it is never logged. A shape that does not pass the shape rules (a row
// written by SQL or a seed) gets null, never a throw: the area still shows,
// without a Directions link.
//
// Implemented in-house (no `polylabel` dependency anywhere in the repo, and
// ~80 lines here); after mapbox/polylabel (ISC), on a local equirectangular
// plane so a cell is square on the ground.
// ─────────────────────────────────────────────────────────────────────────────

export interface DirectionsPoint {
  lat: number;
  lng: number;
}

type XY = [number, number];

/** Signed distance from `p` to the ring: positive inside, negative outside. */
function signedDistance(p: XY, ring: readonly XY[]): number {
  let inside = false;
  let minSq = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
    minSq = Math.min(minSq, segmentDistanceSq(p, a, b));
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

function segmentDistanceSq(p: XY, a: XY, b: XY): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

interface Cell {
  x: number;
  y: number;
  /** Half the cell's side. */
  h: number;
  /** Distance from the centre to the ring. */
  d: number;
  /** Best distance any point in the cell could reach. */
  max: number;
}

function makeCell(x: number, y: number, h: number, ring: readonly XY[]): Cell {
  const d = signedDistance([x, y], ring);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

/**
 * Upper bound on cells taken off the queue. Every cell built costs one pass
 * over the ring (≤200 edges): up to ~1000 seed cells plus 4 children per
 * cell taken, so the work is bounded by about (1000 + 4 × 2000) × 200 ≈
 * 1.8M edge tests per shape on every read, whatever a row holds (a sliver
 * once cost 12 s).
 */
const MAX_CELLS = 2_000;

/** How far inside the ring the point must be, in plane units (metres). */
const POLE_MIN_MARGIN = 0.01;

/** Max-heap of cells on `max`, so taking the best cell is O(log n). */
class CellHeap {
  private readonly items: Cell[] = [];

  get size(): number {
    return this.items.length;
  }

  push(cell: Cell): void {
    const items = this.items;
    items.push(cell);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.max >= items[i]!.max) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): Cell | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l]!.max > items[m]!.max) m = l;
        if (r < items.length && items[r]!.max > items[m]!.max) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Pole of inaccessibility on a plane, or null when nothing inside was found.
 * Exported for its own bounded-work tests: it runs on every public read, so
 * it must stay fast even for a shape validation would refuse.
 */
export function poleOfInaccessibility(ring: readonly XY[]): XY | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(Math.min(width, height) > 0)) return null;
  // About a thousandth of the lot's size. The seed cell is never smaller
  // than that (polylabel v2's guard), so the seed grid holds at most ~1000
  // cells however thin the shape is.
  const precision = Math.max(width, height) / 1_000;
  const cellSize = Math.max(precision, Math.min(width, height));
  const h = cellSize / 2;

  const queue = new CellHeap();
  // Integer steps, never `x += cellSize`: a float step too small for `x`
  // stops advancing and loops forever.
  const nx = Math.min(Math.ceil(width / cellSize), 1_000);
  const ny = Math.min(Math.ceil(height / cellSize), 1_000);
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      queue.push(makeCell(minX + i * cellSize + h, minY + j * cellSize + h, h, ring));
    }
  }

  // Seed with the area centroid (often inside) and the box centre.
  let best = centroidCell(ring);
  const boxCell = makeCell(minX + width / 2, minY + height / 2, 0, ring);
  if (boxCell.d > best.d) best = boxCell;

  let examined = 0;
  while (queue.size > 0 && examined < MAX_CELLS) {
    const cell = queue.pop()!;
    examined += 1;
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    const half = cell.h / 2;
    queue.push(makeCell(cell.x - half, cell.y - half, half, ring));
    queue.push(makeCell(cell.x + half, cell.y - half, half, ring));
    queue.push(makeCell(cell.x - half, cell.y + half, half, ring));
    queue.push(makeCell(cell.x + half, cell.y + half, half, ring));
  }

  // Inside, and by a margin: at least 1 cm from every edge (the plane is in
  // metres for every production caller), so rounding back to lng/lat cannot
  // land the point on or across an edge.
  return best.d > POLE_MIN_MARGIN ? [best.x, best.y] : null;
}

function centroidCell(ring: readonly XY[]): Cell {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    const f = a[0] * b[1] - b[0] * a[1];
    x += (a[0] + b[0]) * f;
    y += (a[1] + b[1]) * f;
    area += f * 3;
  }
  if (area === 0) return makeCell(ring[0]![0], ring[0]![1], 0, ring);
  return makeCell(x / area, y / area, 0, ring);
}

/** A point inside the polygon ring (`[lng, lat]` positions, closed). */
function polygonDirectionsPoint(
  ring: readonly ArrivalAreaPosition[],
): DirectionsPoint | null {
  // Local plane in metres around the first corner (`localPlaneMeters`):
  // square on the ground at an area's few-km scale, and small numbers, so
  // no precision is lost to a large longitude.
  const plane = localPlaneMeters(ring);
  if (!plane) return null;
  const pole = poleOfInaccessibility(plane.points);
  if (!pole) return null;
  const point = plane.toLngLat(pole);
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
}

/** The point halfway along the line's ground length. */
function lineDirectionsPoint(
  line: readonly ArrivalAreaPosition[],
): DirectionsPoint | null {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const d = haversineDistance(a[1], a[0], b[1], b[0]);
    lengths.push(d);
    total += d;
  }
  if (!(total > 0)) return null;
  let remaining = total / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    const segment = lengths[i]!;
    if (segment > 0 && remaining <= segment) {
      const t = remaining / segment;
      const a = line[i]!;
      const b = line[i + 1]!;
      // Linear in lng/lat: exact enough over one segment of a ≤3 km shape.
      return { lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t };
    }
    remaining -= segment;
  }
  const last = line[line.length - 1]!;
  return { lng: last[0], lat: last[1] };
}

/**
 * Directions for a shape that has ALREADY passed `validateArrivalAreaShape`
 * (the caller holds its `ok` result): no second validation. Null when no
 * point can be promised. Never throws.
 */
export function directionsPointForValidShape(
  geometry: ArrivalAreaGeometry,
): DirectionsPoint | null {
  try {
    return geometry.type === "Polygon"
      ? polygonDirectionsPoint(geometry.coordinates[0]!)
      : lineDirectionsPoint(geometry.coordinates);
  } catch {
    return null;
  }
}

/**
 * Where Directions points for a STORED area's geometry, or null when the
 * shape is malformed (or degenerate) and no point can be promised. Never
 * throws.
 */
export function arrivalAreaDirectionsPoint(
  geometry: unknown,
): DirectionsPoint | null {
  try {
    const shape = validateArrivalAreaShape(geometry);
    if (!shape.ok) return null;
    return directionsPointForValidShape(shape.geometry);
  } catch {
    return null;
  }
}
