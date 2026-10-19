import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@th/trpc";

import type { SeatModel, SeatPriceModel, SectionModel } from "./seat-price-model";

/**
 * The Map view's geometry, kept pure so the glyph-to-seat rule is tested on
 * its own.
 *
 * THE MAPPING RULE. A layout glyph's `seatId` is unique only inside its own
 * layout section: sections `A` and `A-B` can both produce `A-B-C-1`. So a
 * glyph is resolved in two steps, never by one map over the whole layout:
 *   1. its section, from the layout's own data: `glyph.sectionId` is the
 *      `layoutSectionId` of one section in the seat price read;
 *   2. its seat, by `glyphKey`, among THAT section's seats only.
 * The id string is never split. A glyph that resolves to no seat is not a
 * seat of this event: it is drawn as an outline only, cannot be focused and
 * is not selectable.
 */

export type PublicPlaceLayout =
  inferRouterOutputs<AppRouter>["placeLayouts"]["getPublicPlaceLayout"]["layout"];
export type LayoutSection = PublicPlaceLayout["sections"][number];

export type Point = { x: number; y: number };

/** One entry of the layout's glyph blob (the fields this view reads). */
export type SeatGlyph = {
  seatId: string;
  sectionId: string;
  label: string;
  position: Point;
  radius?: number;
};

/**
 * The glyph file is the layout's own upload, read as JSON: keep only the
 * entries that have the fields the map draws with.
 */
export function isSeatGlyph(value: unknown): value is SeatGlyph {
  if (typeof value !== "object" || value === null) return false;
  const glyph = value as Record<string, unknown>;
  const position = glyph.position as Record<string, unknown> | null | undefined;
  return (
    typeof glyph.seatId === "string" &&
    typeof glyph.sectionId === "string" &&
    typeof glyph.label === "string" &&
    typeof position === "object" &&
    position !== null &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    (glyph.radius === undefined || Number.isFinite(glyph.radius))
  );
}

/** A glyph file the map cannot use. `entries` is how many it held. */
export class SeatGlyphFileError extends Error {
  readonly entries: number;
  constructor(message: string, entries: number) {
    super(message);
    this.name = "SeatGlyphFileError";
    this.entries = entries;
  }
}

/**
 * The seats of a glyph file: a list, or `{ glyphs: [...] }`. An empty list
 * is a layout with no saved positions. A file that is not a list, or whose
 * entries are all unreadable, is broken: it throws, so it is reported and
 * shown as failed rather than as "no saved positions".
 */
export function readSeatGlyphFile(data: unknown): SeatGlyph[] {
  const entries: unknown = Array.isArray(data)
    ? data
    : (data as { glyphs?: unknown } | null)?.glyphs;
  if (!Array.isArray(entries)) {
    throw new SeatGlyphFileError("Seat glyphs: the file is not a list", 0);
  }
  const glyphs = entries.filter(isSeatGlyph);
  if (entries.length > 0 && glyphs.length === 0) {
    throw new SeatGlyphFileError(
      "Seat glyphs: no entry has a seat, section, label and position",
      entries.length,
    );
  }
  return glyphs;
}

/**
 * What identifies a glyph file across re-signed links: the link without its
 * query. The object path names the layout's checksum, so a replaced layout
 * gets a new key and a re-signed link of the same file does not.
 */
export function glyphFileKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export type MapSeat = {
  /** Unique on the map: the event seat id, or a key for an unmatched glyph. */
  key: string;
  glyph: SeatGlyph;
  /** `null` when no seat of the event matches the glyph. */
  seat: SeatModel | null;
  section: SectionModel | null;
};

/**
 * Every glyph of the layout, each with the event seat it stands for. Only
 * sections of `layoutId` take part: a section on another layout is not on
 * this map.
 */
export function resolveMapSeats(
  model: SeatPriceModel,
  layoutId: string,
  glyphs: readonly SeatGlyph[],
): MapSeat[] {
  // Step 1's lookup: layout section id → the read's section.
  const sectionByLayoutId = new Map<string, SectionModel>();
  for (const section of model.sections) {
    if (section.placeLayoutId !== layoutId || !section.layoutSectionId) continue;
    if (!sectionByLayoutId.has(section.layoutSectionId)) {
      sectionByLayoutId.set(section.layoutSectionId, section);
    }
  }
  // Step 2's lookups: one glyphKey → seat map PER section.
  const seatsByGlyphKey = new Map<string, Map<string, SeatModel>>();
  for (const section of sectionByLayoutId.values()) {
    const byKey = new Map<string, SeatModel>();
    for (const group of section.rowGroups) {
      for (const seat of group.seats) {
        if (seat.glyphKey !== null) byKey.set(seat.glyphKey, seat);
      }
    }
    seatsByGlyphKey.set(section.id, byKey);
  }
  return glyphs.map((glyph, index) => {
    const section = sectionByLayoutId.get(glyph.sectionId) ?? null;
    const seat = section
      ? (seatsByGlyphKey.get(section.id)?.get(glyph.seatId) ?? null)
      : null;
    return {
      key: seat ? seat.id : `glyph-${index}`,
      glyph,
      seat,
      section,
    };
  });
}

/**
 * When the layout's glyph file cannot be read (it is not served, or a fetch
 * failed), each section's seats are laid out in rows inside the section's
 * outline instead, as the buyer's map does. Positions are approximate; every
 * seat is still the event's own and keeps its section. A section of this
 * layout with no outline or origin is left off.
 */
export function approximateMapSeats(
  model: SeatPriceModel,
  layoutId: string,
  layoutSections: readonly LayoutSection[],
): MapSeat[] {
  const byLayoutId = new Map(layoutSections.map((s) => [s.sectionId, s]));
  const result: MapSeat[] = [];
  for (const section of model.sections) {
    if (section.placeLayoutId !== layoutId || !section.layoutSectionId) continue;
    const shape = byLayoutId.get(section.layoutSectionId)?.geometry;
    const points = shape?.polygons?.flat() ?? [];
    let box: Rect;
    if (points.length > 0) {
      box = {
        minX: Math.min(...points.map((p) => p.x)),
        minY: Math.min(...points.map((p) => p.y)),
        maxX: Math.max(...points.map((p) => p.x)),
        maxY: Math.max(...points.map((p) => p.y)),
      };
    } else if (shape?.origin) {
      const { x, y } = shape.origin;
      box = { minX: x - 40, minY: y - 20, maxX: x + 40, maxY: y + 20 };
    } else {
      continue;
    }
    const rows = section.rowGroups;
    const perRow = Math.max(1, ...rows.map((row) => row.seats.length));
    const inset = 4;
    const cellW = (box.maxX - box.minX - inset * 2) / perRow;
    const cellH = (box.maxY - box.minY - inset * 2) / Math.max(rows.length, 1);
    const radius = Math.max(4, Math.min(cellW, cellH) * 0.44);
    rows.forEach((row, rowIndex) => {
      row.seats.forEach((seat, colIndex) => {
        result.push({
          key: seat.id,
          seat,
          section,
          glyph: {
            seatId: seat.glyphKey ?? seat.id,
            sectionId: section.layoutSectionId as string,
            label: seat.label,
            position: {
              x: box.minX + inset + cellW * (colIndex + 0.5),
              y: box.minY + inset + cellH * (rowIndex + 0.5),
            },
            radius,
          },
        });
      });
    });
  }
  return result;
}

/**
 * The layout the map draws: the one most seated sections of the event sit
 * on (almost always the only one). `null` when no section has a layout.
 * Decided once, in the model, so `SectionModel.onMap` agrees with it.
 */
export function pickMapLayoutId(model: SeatPriceModel): string | null {
  return model.mapLayoutId;
}

export type Rect = { minX: number; minY: number; maxX: number; maxY: number };

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/** The selectable seats whose glyph centre lies inside `rect` (world units). */
export function selectableSeatIdsIn(
  seats: readonly MapSeat[],
  rect: Rect,
): string[] {
  return seats.flatMap(({ seat, glyph: { position: p } }) =>
    seat?.selectable &&
    p.x >= rect.minX &&
    p.x <= rect.maxX &&
    p.y >= rect.minY &&
    p.y <= rect.maxY
      ? [seat.id]
      : [],
  );
}

// ── Copied from the buyer map ──────────────────────────────────────────────
// `SeatMapPicker.tsx` (checkout) keeps these private, and that file is not
// ours to edit. Copied: the arrow-key scoring of handleArrowNav, the
// defaultRadius formula and SeatNode's label sizing.

/**
 * A section's colour is the layout's own (the layout designer gives every
 * section one). The buyer's map falls back to a hard-coded palette; this
 * view falls back to the theme's muted ink instead (the caller's token), so
 * the folder carries no raw colours.
 */
export function sectionColor(section: LayoutSection | undefined): string | null {
  return section?.color ?? null;
}

const ARROW_DIRECTIONS: Record<string, Point> = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowDown: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: -1 },
};

/**
 * The seat an arrow key moves to: ahead in that direction, preferring the
 * one most in line with it. `null` at the edge.
 */
export function nextSeatInDirection(
  seats: readonly MapSeat[],
  from: MapSeat,
  key: string,
): MapSeat | null {
  const dir = ARROW_DIRECTIONS[key];
  if (!dir) return null;
  const { x, y } = from.glyph.position;
  let best: MapSeat | null = null;
  let bestScore = Infinity;
  for (const candidate of seats) {
    // A glyph that is not a seat of this event is not a stop.
    if (candidate.key === from.key || candidate.seat === null) continue;
    const dx = candidate.glyph.position.x - x;
    const dy = candidate.glyph.position.y - y;
    if (dx * dir.x + dy * dir.y <= 0) continue;
    const score = Math.hypot(dx, dy) + Math.abs(dx * dir.y - dy * dir.x) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Seat radius in world units from the layout's density, 10 to 18. */
export function defaultSeatRadius(bounds: Rect, glyphCount: number): number {
  const width = bounds.maxX - bounds.minX || 1;
  const height = bounds.maxY - bounds.minY || 1;
  if (glyphCount === 0) return Math.min(width, height) * 0.04;
  return Math.max(10, Math.min(18, Math.sqrt((width * height) / glyphCount) * 0.52));
}

/**
 * The text drawn in a seat at this on-screen radius, and its font size: the
 * full label when it fits, the trailing number when only that does, nothing
 * when the seat is too small to read. `maxLen` is the longest label of that
 * tier on the map, so every seat number renders at one size.
 */
export function seatLabelFor(
  label: string,
  radius: number,
  zoom: number,
  maxLen: { full: number; digits: number },
): { text: string; fontSize: number } {
  const onScreen = radius * zoom;
  if (onScreen < 7) return { text: "", fontSize: 0 };
  const digits = label.match(/\d+$/)?.[0] ?? label.slice(-2);
  const [text, sizingLen] =
    onScreen < 13 ? [digits, maxLen.digits] : [label, maxLen.full];
  const fontSize = Math.min(
    radius * 1.4,
    (radius * 1.7) / (0.6 * Math.max(1, sizingLen)),
  );
  return { text, fontSize };
}
