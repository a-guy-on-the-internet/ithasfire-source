"use client";

import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useTranslations, QuantityStepper } from "@th/ui";
import {
  getBuyerAllInDisplayCents,
  getBuyerPriceRange,
} from "@/lib/pricing/buyer-display";
import {
  adjustableSeatPriceLabel,
  seatMapPriceLabel,
} from "./seat-map-price-label";
import { useIsTouchViewport } from "@/hooks/useIsTouchViewport";
import { BG, FG as fg, fgAlpha, srOnlyStyle } from "./checkout-tokens";
import {
  anchorTranslateForScaleChange,
  boundsOfPoints,
  boundsOfPolygons,
  clampTranslateToContent,
  computeBaseUnitScale,
  computeMaxScale,
  computeMinUsableScale,
  computeSectionFocusTransform,
  findNearestSeatWithinSlop,
  findSectionAtPoint,
  median,
  TARGET_SEAT_TAP_PX,
  type SlopSeat,
} from "./seat-map-zoom";

// Above this zoom the map counts as "zoomed in" (shows jump chips on touch).
const OVERVIEW_SCALE_THRESHOLD = 1.05;
// Pointer movement (px) beyond which a pointer session is a pan, not a tap.
const PAN_TAP_SLOP_PX = 8;

/** Mobile section jump chip — uppercase Swiss label over soft map chrome. */
function sectionChipStyle(active: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    height: 44,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    whiteSpace: "nowrap",
    borderRadius: 0,
    border: active ? `1px solid ${fg}` : `1px solid ${fgAlpha(15)}`,
    background: active ? fg : `color-mix(in srgb, ${BG} 78%, transparent)`,
    color: active ? BG : fg,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    cursor: "pointer",
  };
}

/** Bottom-centre touch guidance hint overlay. */
const mapHintStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 15,
  maxWidth: "calc(100% - 16px)",
  padding: "8px 14px",
  background: "rgba(0,0,0,0.78)",
  color: "#ffffff",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  borderRadius: 0,
  pointerEvents: "none",
};

// ── Types ──────────────────────────────────────────────────────────────────────

type SeatSection = {
  sectionId: string;
  label: string;
  color?: string | null;
  capacity: number;
  geometry?: {
    polygons?: { x: number; y: number }[][] | null;
    origin?: { x: number; y: number } | null;
    rotation?: number | null;
    scale?: number | null;
    smoothing?: number | null;
  } | null;
  stageAnchor?: {
    point: { x: number; y: number };
    facingAngle?: number | null;
  } | null;
};

type StageLayout = {
  kind: string;
  label?: string | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

export type PlaceLayout = {
  id: string;
  name: string;
  seatCount: number;
  sectionCount: number;
  seatIndexBounds: { minX: number; minY: number; maxX: number; maxY: number };
  sections: SeatSection[];
  stage: StageLayout | null;
  /** Signed URL for fetching individual seat glyph positions. */
  glyphBlobUrl?: string | null;
};

type TicketTypeForSection = {
  id: string;
  name: string;
  priceCents: number;
  buyerUnitTotalCents?: number | null;
  /** The face the estimate row was priced at (`withBuyerUnitTotals`). */
  buyerUnitPriceCents?: number | null;
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity: number;
  seatSectionId: string | null;
  /** Layout-internal section key (e.g. "ga-floor") for matching with PlaceLayout sections. */
  layoutSectionId: string | null;
};

/** Per-seat availability record from the backend. */
export type SeatAvailability = {
  id: string;
  seatSectionId: string;
  status: "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";
  label: string;
  row: string | null;
  number: number | null;
  priceOverride?: {
    priceCents: number;
    buyerTotalCents?: number | null;
  } | null;
};

/** Individual seat glyph from the blob URL. */
type SeatGlyph = {
  seatId: string;
  sectionId: string;
  label: string;
  position: { x: number; y: number };
  radius?: number;
  width?: number;
  height?: number;
  rotationDeg?: number;
  facingAngleDeg?: number;
  metadata?: Record<string, unknown>;
};

export type SeatMapPickerProps = {
  layout: PlaceLayout;
  ticketTypes: TicketTypeForSection[];
  quantities: Record<string, number>;
  onQuantityChange: (ticketTypeId: string, delta: number) => void;
  formatPrice: (cents: number) => string;
  disabled?: boolean;
  /** Per-seat availability data for assigned-seating events. */
  seatAvailability?: SeatAvailability[];
  /** Currently selected individual seat IDs, keyed by ticketTypeId. */
  selectedSeatIds?: Record<string, string[]>;
  /** Called when a user clicks an individual seat to toggle selection. */
  onSeatToggle?: (seatId: string, sectionId: string) => void;
  /** True while the seat availability query is in flight. */
  isLoadingSeats?: boolean;
  /** Callback to zoom the map to a specific section's bounding box. */
  onZoomToSection?: (sectionId: string) => void;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const SECTION_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
];

function getSectionColor(section: SeatSection, index: number): string {
  return section.color ?? SECTION_COLORS[index % SECTION_COLORS.length]!;
}

/**
 * Tessellate a polygon with Catmull-Rom smoothing for SVG rendering.
 * When smoothing is 0 / absent, returns the original polygon unchanged.
 *
 * Caps output at 1 600 points to prevent browser memory/CPU exhaustion
 * from oversized polygons (100 control vertices * 16 segments at full
 * smoothing). Real-world sections rarely exceed ~30 control points.
 */
const MAX_TESSELLATED_SVG_POINTS = 1_600;

function tessellateForSvg(
  polygon: { x: number; y: number }[],
  smoothing: number | null | undefined,
): { x: number; y: number }[] {
  if (!smoothing || smoothing <= 0 || polygon.length < 3) return polygon;
  const n = polygon.length;
  const segs = Math.max(2, Math.round(smoothing * 16));

  // Early bail: if the output would exceed the cap, skip smoothing entirely.
  if (n * segs > MAX_TESSELLATED_SVG_POINTS) return polygon;

  const result: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = polygon[(i - 1 + n) % n]!;
    const p1 = polygon[i]!;
    const p2 = polygon[(i + 1) % n]!;
    const p3 = polygon[(i + 2) % n]!;
    for (let j = 0; j < segs; j++) {
      const t = j / segs;
      const t2 = t * t;
      const t3 = t2 * t;
      const sx =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const sy =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      const lx = p1.x + (p2.x - p1.x) * t;
      const ly = p1.y + (p2.y - p1.y) * t;
      result.push({
        x: lx + (sx - lx) * smoothing,
        y: ly + (sy - ly) * smoothing,
      });
    }
  }
  return result;
}

// ── Contiguous seat picking ────────────────────────────────────────────────────

type RowSeat = Pick<SeatAvailability, "id" | "row" | "number" | "status">;

/**
 * Group seats by row and sort by seat number within each row.
 * Seats without a row or number are collected in a special "__unassigned" group.
 */
function groupSeatsByRow(seats: RowSeat[]): Map<string, RowSeat[]> {
  const rows = new Map<string, RowSeat[]>();
  for (const s of seats) {
    const key = s.row ?? "__unassigned";
    let list = rows.get(key);
    if (!list) {
      list = [];
      rows.set(key, list);
    }
    list.push(s);
  }
  for (const list of rows.values()) {
    list.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }
  return rows;
}

/**
 * Pick the best next seat to ADD when the user taps +.
 *
 * Strategy:
 * 1. If the user already has seats in this section, try to extend the
 *    contiguous block by finding an adjacent available seat.
 * 2. If extension isn't possible, find the best available contiguous run
 *    in the preferred row (or the overall best row if no preference).
 * 3. "Best" = closest to the center of the row, breaking ties by
 *    proximity to the front (lower row letter/number).
 * 4. Falls back to any available seat if nothing contiguous exists.
 */
function pickNextContiguousSeat(
  sectionSeats: SeatAvailability[],
  currentlySelectedIds: string[],
  preferredRow: string | null,
): string | null {
  if (sectionSeats.length === 0) return null;

  const selectedSet = new Set(currentlySelectedIds);
  const rows = groupSeatsByRow(sectionSeats);

  // ── Try to extend existing selection ───────────────────────────────
  if (currentlySelectedIds.length > 0) {
    // Group selected seats by row to find the edges
    for (const [rowKey, rowSeats] of rows) {
      const selectedInRow = rowSeats.filter((s) => selectedSet.has(s.id));
      if (selectedInRow.length === 0) continue;

      // Find the min and max seat numbers in the selection for this row
      const selectedNums = selectedInRow
        .map((s) => s.number)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      if (selectedNums.length === 0) continue;

      const minNum = selectedNums[0]!;
      const maxNum = selectedNums[selectedNums.length - 1]!;

      // Try to extend right (seat number = maxNum + 1)
      const rightNeighbor = rowSeats.find(
        (s) =>
          s.number === maxNum + 1 &&
          s.status === "AVAILABLE" &&
          !selectedSet.has(s.id),
      );
      // Try to extend left (seat number = minNum - 1)
      const leftNeighbor = rowSeats.find(
        (s) =>
          s.number === minNum - 1 &&
          s.status === "AVAILABLE" &&
          !selectedSet.has(s.id),
      );

      // Prefer the side closer to center of the row
      if (rightNeighbor && leftNeighbor) {
        const rowLen = rowSeats.length;
        const center = rowLen / 2;
        const rightDist = Math.abs(maxNum + 1 - center);
        const leftDist = Math.abs(minNum - 1 - center);
        return rightDist <= leftDist ? rightNeighbor.id : leftNeighbor.id;
      }
      if (rightNeighbor) return rightNeighbor.id;
      if (leftNeighbor) return leftNeighbor.id;
    }
  }

  // ── No extension possible — pick the best available seat ───────────
  // Score each available seat: prefer the preferred row, then center-of-row
  type Candidate = {
    id: string;
    row: string;
    rowIdx: number;
    centerDist: number;
  };
  const rowKeys = [...rows.keys()].filter((k) => k !== "__unassigned");
  // Sort rows naturally (A, B, C... or 1, 2, 3...)
  rowKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const candidates: Candidate[] = [];
  for (let ri = 0; ri < rowKeys.length; ri++) {
    const rowKey = rowKeys[ri]!;
    const rowSeats = rows.get(rowKey)!;
    const rowLen = rowSeats.length;
    const center = (rowLen - 1) / 2;

    for (let si = 0; si < rowSeats.length; si++) {
      const seat = rowSeats[si]!;
      if (seat.status !== "AVAILABLE" || selectedSet.has(seat.id)) continue;
      candidates.push({
        id: seat.id,
        row: rowKey,
        rowIdx: ri,
        centerDist: Math.abs(si - center),
      });
    }
  }

  if (candidates.length === 0) return null;

  // Sort: preferred row first, then by row index (front), then center distance
  candidates.sort((a, b) => {
    // Preferred row gets priority
    if (preferredRow) {
      if (a.row === preferredRow && b.row !== preferredRow) return -1;
      if (b.row === preferredRow && a.row !== preferredRow) return 1;
    }
    // Closer to front
    if (a.rowIdx !== b.rowIdx) return a.rowIdx - b.rowIdx;
    // Closer to center
    return a.centerDist - b.centerDist;
  });

  return candidates[0]!.id;
}

/**
 * Pick the best seat to REMOVE when the user taps −.
 * Removes from the edge of the contiguous block to keep the group compact.
 * If seats span multiple rows, removes from the row with the least seats.
 */
function pickEdgeSeatToRemove(
  sectionSeats: SeatAvailability[],
  currentlySelectedIds: string[],
): string | null {
  if (currentlySelectedIds.length === 0) return null;
  if (currentlySelectedIds.length === 1) return currentlySelectedIds[0]!;

  const seatById = new Map(sectionSeats.map((s) => [s.id, s]));
  const rows = groupSeatsByRow(sectionSeats);

  // Group selected seats by row
  const selectedByRow = new Map<string, SeatAvailability[]>();
  for (const id of currentlySelectedIds) {
    const seat = seatById.get(id);
    if (!seat) continue;
    const key = seat.row ?? "__unassigned";
    let list = selectedByRow.get(key);
    if (!list) {
      list = [];
      selectedByRow.set(key, list);
    }
    list.push(seat);
  }

  // If multiple rows, remove from the row with fewest seats (keep the main group)
  if (selectedByRow.size > 1) {
    let minRow: string | null = null;
    let minCount = Infinity;
    for (const [row, seats] of selectedByRow) {
      if (seats.length < minCount) {
        minCount = seats.length;
        minRow = row;
      }
    }
    if (minRow) {
      const seats = selectedByRow.get(minRow)!;
      // Remove the outermost seat from this row
      seats.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      return seats[seats.length - 1]!.id;
    }
  }

  // Single row: remove the outermost seat (highest or lowest seat number)
  const [, rowSeats] = [...selectedByRow.entries()][0]!;
  rowSeats.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  // Remove from whichever edge is farther from center of the full row
  const rowKey = rowSeats[0]!.row ?? "__unassigned";
  const fullRow = rows.get(rowKey);
  if (fullRow && fullRow.length > 0) {
    const center = (fullRow.length - 1) / 2;
    const first = rowSeats[0]!;
    const last = rowSeats[rowSeats.length - 1]!;
    const firstIdx = fullRow.findIndex((s) => s.id === first.id);
    const lastIdx = fullRow.findIndex((s) => s.id === last.id);
    const firstDist = Math.abs(firstIdx - center);
    const lastDist = Math.abs(lastIdx - center);
    return lastDist >= firstDist ? last.id : first.id;
  }
  return rowSeats[rowSeats.length - 1]!.id;
}

// ── Memoized per-seat renderer ───────────────────────────────────────────────
// Extracted + memoized to avoid re-rendering ALL seat <g> nodes on every hover
// (which mutates `tooltip` state in the parent). With React.memo + stable
// props, only the 1-2 seats whose props actually change re-commit on hover.

type SeatNodeProps = {
  glyph: SeatGlyph;
  isSelected: boolean;
  isAvailable: boolean;
  isTooltipTarget: boolean;
  defaultRadius: number;
  /** Current canvas zoom level — labels are sized/hidden relative to this. */
  scale: number;
  /**
   * Longest full label / trailing-digits length across ALL rendered seats.
   * Font size divides by these (not the glyph's own length) so every seat
   * number in the same tier renders at an identical size.
   */
  maxFullLabelLen: number;
  maxDigitsLabelLen: number;
  sectionColor: string;
  disabled: boolean;
  ariaLabel: string;
  onInteract: (
    glyph: SeatGlyph,
    e: React.MouseEvent | React.KeyboardEvent,
  ) => void;
  onHover: (glyph: SeatGlyph) => void;
  onHoverEnd: () => void;
  onArrowNav: (glyph: SeatGlyph, key: string) => void;
};

const SeatNode = React.memo(function SeatNode(props: SeatNodeProps) {
  const {
    glyph,
    isSelected,
    isAvailable,
    isTooltipTarget,
    defaultRadius,
    scale,
    maxFullLabelLen,
    maxDigitsLabelLen,
    sectionColor,
    disabled,
    ariaLabel,
    onInteract,
    onHover,
    onHoverEnd,
    onArrowNav,
  } = props;

  const isClickable = (isAvailable || isSelected) && !disabled;

  let fill: string;
  let fillOpacity: number;
  let strokeColor: string;
  let strokeOpacity: number;
  if (isSelected) {
    fill = sectionColor;
    fillOpacity = 1;
    strokeColor = "#211C16";
    strokeOpacity = 1;
  } else if (isAvailable) {
    fill = sectionColor;
    fillOpacity = 0.55;
    strokeColor = sectionColor;
    strokeOpacity = 0.9;
  } else {
    fill = "var(--foreground)";
    fillOpacity = 0.12;
    strokeColor = "var(--foreground)";
    strokeOpacity = 0.15;
  }

  const r = glyph.radius ?? defaultRadius;

  // Labels live inside the zoomed <g>, so their on-screen size is r * scale.
  // Pick label content + font size relative to that so glyphs never overflow
  // their circle (the cause of the smooshed-together labels at default zoom).
  const onScreenR = r * scale;
  const digits = glyph.label.match(/\d+$/)?.[0] ?? glyph.label.slice(-2);
  let label: string;
  let sizingLen: number;
  if (onScreenR < 7) {
    // Too small to read anything — drop the label until the user zooms in.
    label = "";
    sizingLen = 1;
  } else if (onScreenR < 13) {
    // Room for the trailing number only (e.g. "V11" → "11").
    label = digits;
    sizingLen = maxDigitsLabelLen;
  } else {
    label = glyph.label;
    sizingLen = maxFullLabelLen;
  }
  // Fit within the circle both vertically (≤ ~1.4r) and horizontally
  // (~0.6em per char must span ≤ 1.7r across the diameter). The horizontal
  // divisor uses the LONGEST label in the tier across the whole map — not
  // this glyph's own length — so all seat numbers render at the same size
  // ("9" no longer balloons relative to "10").
  const fontSize = label
    ? Math.min(r * 1.4, (r * 1.7) / (0.6 * Math.max(1, sizingLen)))
    : 0;

  return (
    <g
      data-seat-id={glyph.seatId}
      transform={`translate(${glyph.position.x}, ${glyph.position.y})`}
      style={{
        cursor: isClickable ? "pointer" : "default",
        pointerEvents: "auto",
      }}
      onClick={isClickable ? (e) => onInteract(glyph, e) : undefined}
      onMouseEnter={() => onHover(glyph)}
      onMouseLeave={onHoverEnd}
      onKeyDown={(e) => {
        if (
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight"
        ) {
          e.preventDefault();
          onArrowNav(glyph, e.key);
        } else if (isClickable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onInteract(glyph, e);
        }
      }}
      tabIndex={0}
      role={isClickable ? "button" : "img"}
      aria-label={ariaLabel}
    >
      <circle
        cx={0}
        cy={0}
        r={isTooltipTarget ? r * 1.25 : r}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke={strokeColor}
        strokeOpacity={strokeOpacity}
        strokeWidth={isSelected || isTooltipTarget ? 1.5 : 0.5}
        style={{
          transition: "fill 0.12s, fill-opacity 0.12s, stroke 0.12s",
        }}
      />
      {label && (
        <text
          x={0}
          y={0}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#211C16"
          fillOpacity={1}
          style={{
            fontSize,
            fontWeight: 900,
            pointerEvents: "none",
            textShadow: "0 1px 0 rgba(253,250,243,0.6)",
          }}
        >
          {label}
        </text>
      )}
    </g>
  );
});

// ── Component ──────────────────────────────────────────────────────────────────

export const SeatMapPicker = ({
  layout,
  ticketTypes,
  quantities,
  onQuantityChange,
  formatPrice,
  disabled = false,
  seatAvailability,
  selectedSeatIds,
  onSeatToggle,
  isLoadingSeats = false,
}: SeatMapPickerProps) => {
  const t = useTranslations();
  // On touch viewports the in-map overlay teaches section-first navigation,
  // so the header's "Tap a seat to select" (false at fit zoom) is hidden.
  const isTouchViewport = useIsTouchViewport();

  // Map layoutSectionId → ticket type for quick lookup.
  // Uses layoutSectionId (e.g. "ga-floor") so sections can be joined to
  // PlaceLayout.sections[].sectionId without UUID-vs-string mismatches.
  const sectionTicketMap = useMemo(() => {
    const map = new Map<string, TicketTypeForSection>();
    for (const tt of ticketTypes) {
      if (tt.layoutSectionId) {
        map.set(tt.layoutSectionId, tt);
      }
    }
    return map;
  }, [ticketTypes]);

  // Reverse map: layoutSectionId → DB SeatSection UUID.
  // Used to filter SeatAvailability records (which carry DB UUIDs) when
  // iterating PlaceLayout sections (which carry layout string keys).
  const layoutToDbSectionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const tt of ticketTypes) {
      if (tt.layoutSectionId && tt.seatSectionId) {
        map.set(tt.layoutSectionId, tt.seatSectionId);
      }
    }
    return map;
  }, [ticketTypes]);

  // GA ticket types (no seatSectionId) still render below the map
  const gaTicketTypes = useMemo(
    () => ticketTypes.filter((tt) => !tt.seatSectionId),
    [ticketTypes],
  );

  // Build a set of all currently selected seat IDs for quick lookup
  const allSelectedSeatIds = useMemo(() => {
    const set = new Set<string>();
    if (selectedSeatIds) {
      for (const ids of Object.values(selectedSeatIds)) {
        for (const id of ids) set.add(id);
      }
    }
    return set;
  }, [selectedSeatIds]);

  // Build seat availability lookup: seatId → status
  const seatStatusMap = useMemo(() => {
    const map = new Map<string, SeatAvailability["status"]>();
    if (seatAvailability) {
      for (const seat of seatAvailability) map.set(seat.id, seat.status);
    }
    return map;
  }, [seatAvailability]);

  // Determine if we have assigned seating (individual seat data available)
  const hasAssignedSeating = Boolean(
    seatAvailability && seatAvailability.length > 0,
  );

  const hasGeometry = layout.sections.some((s) => s.geometry?.polygons?.length);

  // ── Row preference memory ──────────────────────────────────────────
  // Tracks the row the user last manually clicked a seat in, so the
  // auto-pick algorithm can prefer that row for subsequent + taps.
  const [preferredRowBySection, setPreferredRowBySection] = useState<
    Record<string, string>
  >({});

  // ── Smart contiguous quick-pick for quantity steppers ──────────────
  // Incrementing → picks the best contiguous seat extending the block.
  // Decrementing → removes from the edge to keep the group compact.
  const handleQuickPick = useCallback(
    (sectionId: string, delta: number) => {
      const tt = sectionTicketMap.get(sectionId);
      if (!tt || !onSeatToggle || !seatAvailability) return;

      const dbSectionId = layoutToDbSectionId.get(sectionId);
      if (!dbSectionId) return;

      const sectionSeats = seatAvailability.filter(
        (s) => s.seatSectionId === dbSectionId,
      );
      const currentlySelected = selectedSeatIds?.[tt.id] ?? [];

      if (delta > 0) {
        const preferred = preferredRowBySection[sectionId] ?? null;
        const pickId = pickNextContiguousSeat(
          sectionSeats,
          currentlySelected,
          preferred,
        );
        if (pickId) onSeatToggle(pickId, sectionId);
      } else if (delta < 0) {
        const removeId = pickEdgeSeatToRemove(sectionSeats, currentlySelected);
        if (removeId) onSeatToggle(removeId, sectionId);
      }
    },
    [
      sectionTicketMap,
      layoutToDbSectionId,
      onSeatToggle,
      seatAvailability,
      selectedSeatIds,
      preferredRowBySection,
    ],
  );

  // ── Wrap onSeatToggle to record row preference on manual clicks ────
  const handleSeatToggleWithRowMemory = useCallback(
    (seatId: string, sectionId: string) => {
      onSeatToggle?.(seatId, sectionId);
      // Record the row of the seat the user clicked for future auto-picks
      if (seatAvailability) {
        const seat = seatAvailability.find((s) => s.id === seatId);
        if (seat?.row) {
          setPreferredRowBySection((prev) =>
            prev[sectionId] === seat.row
              ? prev
              : { ...prev, [sectionId]: seat.row! },
          );
        }
      }
    },
    [onSeatToggle, seatAvailability],
  );

  // ── View mode toggle (map vs list) for assigned seating ─────────
  // On desktop (>720px), we show both side-by-side, so the toggle
  // only matters on mobile where we show one at a time.
  const [viewMode, setViewMode] = useState<"map" | "list">("map");

  // ── Focused section (zoom-to-section from section cards) ───────
  const [focusedSectionId, setFocusedSectionId] = useState<string | null>(null);

  /** Build a lookup of seat labels keyed by ticketTypeId for inline chips */
  const selectedSeatLabelsByTt = useMemo(() => {
    if (!selectedSeatIds || !seatAvailability) return {};
    const labelMap = new Map<string, string>();
    for (const s of seatAvailability) labelMap.set(s.id, s.label);
    const result: Record<string, string[]> = {};
    for (const [ttId, ids] of Object.entries(selectedSeatIds)) {
      if (ids.length > 0)
        result[ttId] = ids.map((id) => labelMap.get(id) ?? id);
    }
    return result;
  }, [selectedSeatIds, seatAvailability]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Spinner + shimmer animations */}
      <style>{`
        @keyframes seat-spinner { to { transform: rotate(360deg); } }
        @keyframes seat-shimmer {
          0% { opacity: 0.06; }
          50% { opacity: 0.14; }
          100% { opacity: 0.06; }
        }
      `}</style>
      {/* ── Responsive styles for side-by-side layout ───────────────── */}
      {hasAssignedSeating && hasGeometry && (
        <style>{`
          .seat-picker-dual-pane {
            display: grid;
            grid-template-columns: clamp(200px, 28%, 300px) 1fr;
            gap: 16px;
            align-items: start;
          }
          .seat-picker-dual-pane .seat-picker-list-pane { display: block; }
          .seat-picker-dual-pane .seat-picker-map-pane { display: block; min-height: 0; }
          .seat-picker-toggle-mobile { display: none !important; }
          @media (max-width: 900px) {
            .seat-picker-dual-pane {
              display: flex;
              flex-direction: column;
              gap: 12px;
            }
            .seat-picker-dual-pane .seat-picker-list-pane {
              display: ${viewMode === "list" ? "block" : "none"};
              max-height: 50vh;
            }
            .seat-picker-dual-pane .seat-picker-map-pane {
              display: ${viewMode === "map" ? "block" : "none"};
            }
            .seat-picker-toggle-mobile { display: flex !important; }
          }
          @media (max-width: 480px) {
            .seat-picker-dual-pane .seat-picker-map-pane {
              margin: 0 -8px;
              border-radius: 0;
            }
          }
        `}</style>
      )}

      {/* ── Price range banner ────────────────────────────────────────── */}
      {(() => {
        const range = getBuyerPriceRange(ticketTypes);
        if (!range) return null;
        const minPrice = range.minCents;
        const maxPrice = range.maxCents;
        if (minPrice === maxPrice) return null;
        return (
          <p
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 700,
              color: fgAlpha(80),
              letterSpacing: "0.01em",
            }}
          >
            {String(
              t("checkout.priceRange", {
                min: formatPrice(minPrice),
                max: formatPrice(maxPrice),
              }),
            )}
          </p>
        );
      })()}

      {/* ── Mobile-only view toggle (map / list) ─────────────────────── */}
      {hasAssignedSeating && hasGeometry && (
        <div
          className="seat-picker-toggle-mobile"
          style={{
            display: "none",
            gap: 2,
            borderRadius: 0,
            overflow: "hidden",
            border: `1px solid ${fgAlpha(10)}`,
            alignSelf: "flex-start",
          }}
        >
          {(["map", "list"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                border: "none",
                cursor: "pointer",
                background: viewMode === mode ? fgAlpha(10) : "transparent",
                color: viewMode === mode ? fg : fgAlpha(65),
                transition: "all 0.15s",
              }}
            >
              {mode === "map"
                ? String(t("checkout.seatMapView"))
                : String(t("checkout.seatListView"))}
            </button>
          ))}
        </div>
      )}

      {/* ── Side-by-side: list (left) + map (right) on desktop ────────── */}
      {hasAssignedSeating && hasGeometry && seatAvailability ? (
        <div className="seat-picker-dual-pane">
          {/* List pane */}
          <div
            className="seat-picker-list-pane"
            style={{ maxHeight: 520, overflowY: "auto" }}
          >
            <SeatListView
              layout={layout}
              seatAvailability={seatAvailability}
              allSelectedSeatIds={allSelectedSeatIds}
              seatStatusMap={seatStatusMap}
              sectionTicketMap={sectionTicketMap}
              layoutToDbSectionId={layoutToDbSectionId}
              onSeatToggle={handleSeatToggleWithRowMemory}
              disabled={disabled}
              formatPrice={formatPrice}
            />
          </div>

          {/* Map pane */}
          <div
            className="seat-picker-map-pane"
            style={{
              position: "relative",
              overflow: "hidden",
              borderRadius: 0,
              border: `1px solid ${fgAlpha(8)}`,
              background: fgAlpha(1.5),
              padding: 8,
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
                padding: "0 8px",
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: fgAlpha(75),
                }}
              >
                {layout.name}
              </p>
              {allSelectedSeatIds.size > 0 && (
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#3b82f6",
                    background: "rgba(59,130,246,0.1)",
                    padding: "2px 8px",
                    borderRadius: 0,
                  }}
                >
                  {allSelectedSeatIds.size}{" "}
                  {allSelectedSeatIds.size === 1 ? "seat" : "seats"}
                </span>
              )}
              {allSelectedSeatIds.size === 0 && !isTouchViewport && (
                <span
                  style={{
                    fontSize: 12,
                    color: fgAlpha(50),
                    fontStyle: "italic",
                  }}
                >
                  {String(t("checkout.tapToSelect"))}
                </span>
              )}
            </div>
            <SeatMapVisual
              layout={layout}
              sectionTicketMap={sectionTicketMap}
              quantities={quantities}
              seatAvailability={seatAvailability}
              allSelectedSeatIds={allSelectedSeatIds}
              seatStatusMap={seatStatusMap}
              onSeatToggle={handleSeatToggleWithRowMemory}
              disabled={disabled}
              formatPrice={formatPrice}
              focusedSectionId={focusedSectionId}
              onFocusHandled={() => setFocusedSectionId(null)}
            />
          </div>
        </div>
      ) : (
        <>
          {/* ── Visual map only (no assigned seating list) ──────────── */}
          {hasGeometry && (
            <div
              style={{
                position: "relative",
                overflow: "hidden",
                borderRadius: 0,
                border: `1px solid ${fgAlpha(8)}`,
                background: fgAlpha(1.5),
                padding: 8,
                userSelect: "none",
                WebkitUserSelect: "none",
              }}
              className="seat-map-visual-container"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                  padding: "0 8px",
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: fgAlpha(75),
                  }}
                >
                  {layout.name}
                </p>
                {allSelectedSeatIds.size > 0 && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#3b82f6",
                      background: "rgba(59,130,246,0.1)",
                      padding: "2px 8px",
                      borderRadius: 0,
                    }}
                  >
                    {allSelectedSeatIds.size}{" "}
                    {allSelectedSeatIds.size === 1 ? "seat" : "seats"}
                  </span>
                )}
              </div>
              <SeatMapVisual
                layout={layout}
                sectionTicketMap={sectionTicketMap}
                quantities={quantities}
                seatAvailability={seatAvailability}
                allSelectedSeatIds={allSelectedSeatIds}
                seatStatusMap={seatStatusMap}
                onSeatToggle={handleSeatToggleWithRowMemory}
                disabled={disabled}
                formatPrice={formatPrice}
                focusedSectionId={focusedSectionId}
                onFocusHandled={() => setFocusedSectionId(null)}
                />
              {/* Shimmer skeleton while seat availability is being fetched */}
              {isLoadingSeats && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(0,0,0,0.25)",
                    borderRadius: 0,
                    zIndex: 5,
                    overflow: "hidden",
                  }}
                >
                  {/* Section-shaped shimmer polygons */}
                  <svg
                    viewBox={`${layout.seatIndexBounds.minX - 8} ${layout.seatIndexBounds.minY - 8} ${layout.seatIndexBounds.maxX - layout.seatIndexBounds.minX + 16} ${layout.seatIndexBounds.maxY - layout.seatIndexBounds.minY + 16}`}
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "absolute",
                      inset: 0,
                    }}
                  >
                    {layout.sections.map((section, idx) =>
                      section.geometry?.polygons?.map((polygon, pIdx) => {
                        const tessellated = tessellateForSvg(
                          polygon,
                          section.geometry?.smoothing,
                        );
                        return (
                          <polygon
                            key={`shimmer-${section.sectionId}-${pIdx}`}
                            points={tessellated
                              .map((p) => `${p.x},${p.y}`)
                              .join(" ")}
                            fill="var(--foreground, #211C16)"
                            style={{
                              animation: `seat-shimmer 1.5s ease-in-out infinite`,
                              animationDelay: `${idx * 0.15}s`,
                            }}
                          />
                        );
                      }),
                    )}
                  </svg>
                  {/* Centered label */}
                  <span
                    style={{
                      position: "relative",
                      zIndex: 6,
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#fff",
                      letterSpacing: "0.02em",
                      textShadow: "0 1px 4px rgba(0,0,0,0.5)",
                    }}
                  >
                    {String(t("common.loading"))}
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Section cards ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gap: 12,
        }}
        className="seat-picker-section-cards"
      >
        <style>{`
          .seat-picker-section-cards {
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          }
          @media (max-width: 480px) {
            .seat-picker-section-cards {
              grid-template-columns: 1fr;
            }
          }
        `}</style>
        {layout.sections.map((section, idx) => {
          const tt = sectionTicketMap.get(section.sectionId);
          if (!tt) return null;

          const qty = quantities[tt.id] ?? 0;
          const isSoldOut = tt.capacity <= 0;
          const isSelected = qty > 0;
          const color = getSectionColor(section, idx);

          // For assigned seating, count selected seats for this section
          const selectedCount = selectedSeatIds?.[tt.id]?.length ?? 0;
          const dbSecId = layoutToDbSectionId.get(section.sectionId);
          const isAssignedSection =
            hasAssignedSeating &&
            seatAvailability?.some((s) => s.seatSectionId === dbSecId);
          // Stale-guarded like every other listing: a cached row priced at another
          // face reads "Calculating", never new face + old fees.
          const priceLine = seatMapPriceLabel(tt, { formatPrice, t });

          const cardBorder = isSoldOut
            ? `1px solid ${fgAlpha(5)}`
            : isSelected || selectedCount > 0
              ? `1px solid ${fgAlpha(15)}`
              : `1px solid ${fgAlpha(7)}`;

          const cardBg =
            isSelected || selectedCount > 0 ? fgAlpha(2.5) : "transparent";

          const cardShadow = "none";

          return (
            <div
              key={section.sectionId}
              style={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                borderRadius: 0,
                border: cardBorder,
                background: cardBg,
                boxShadow: cardShadow,
                padding: 20,
                opacity: isSoldOut ? 0.5 : 1,
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {/* Color accent bar */}
              <div
                style={{
                  position: "absolute",
                  top: 12,
                  bottom: 12,
                  left: 0,
                  width: 3,
                  borderRadius: 0,
                  backgroundColor:
                    isSelected || selectedCount > 0 ? color : `${color}40`,
                }}
              />

              {/* Section info */}
              <div style={{ marginBottom: 20, paddingLeft: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      display: "inline-block",
                      height: 10,
                      width: 10,
                      borderRadius: 0,
                      backgroundColor: color,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (hasGeometry && section.geometry?.polygons?.length) {
                        setFocusedSectionId(section.sectionId);
                        setViewMode("map");
                      }
                    }}
                    style={{
                      all: "unset",
                      fontSize: 15,
                      fontWeight: 700,
                      lineHeight: 1.3,
                      color: fg,
                      cursor: hasGeometry ? "pointer" : "default",
                      borderBottom: hasGeometry
                        ? `1px dashed ${fgAlpha(20)}`
                        : "none",
                      transition: "border-color 0.15s",
                    }}
                  >
                    {section.label}
                  </button>
                </div>
                <p
                  style={{
                    marginTop: 4,
                    fontSize: 14,
                    color: fgAlpha(80),
                    margin: "4px 0 0",
                  }}
                >
                  {(() => {
                    if (isSoldOut) return String(t("common.soldOut"));
                    if (isAssignedSection && dbSecId) {
                      const availInSection =
                        seatAvailability?.filter(
                          (s) =>
                            s.seatSectionId === dbSecId &&
                            s.status === "AVAILABLE",
                        ).length ?? 0;
                      const totalInSection =
                        seatAvailability?.filter(
                          (s) => s.seatSectionId === dbSecId,
                        ).length ?? 0;
                      if (selectedCount > 0) {
                        return `${String(t("checkout.nSeatsSelected", { count: selectedCount }))} \u00B7 ${String(t("checkout.nOfTotalAvailable", { available: availInSection, total: totalInSection }))}`;
                      }
                      return `${String(t("checkout.selectSeatsOnMap"))} \u00B7 ${String(t("checkout.nOfTotalAvailable", { available: availInSection, total: totalInSection }))}`;
                    }
                    return String(
                      t("common.nRemaining", { count: tt.capacity }),
                    );
                  })()}
                </p>
                {/* Selected seat label chips */}
                {isAssignedSection &&
                  selectedCount > 0 &&
                  selectedSeatLabelsByTt[tt.id] && (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        marginTop: 8,
                      }}
                    >
                      {selectedSeatLabelsByTt[tt.id]
                        .slice(0, 8)
                        .map((label) => (
                          <span
                            key={label}
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              fontSize: 12,
                              fontWeight: 700,
                              borderRadius: 0,
                              background: `${color}22`,
                              color,
                              border: `1px solid ${color}44`,
                            }}
                          >
                            {label}
                          </span>
                        ))}
                      {selectedSeatLabelsByTt[tt.id].length > 8 && (
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            fontSize: 12,
                            fontWeight: 700,
                            borderRadius: 0,
                            background: fgAlpha(5),
                            color: fgAlpha(70),
                          }}
                        >
                          +{selectedSeatLabelsByTt[tt.id].length - 8}
                        </span>
                      )}
                    </div>
                  )}
              </div>

              {/* Price + stepper (for GA) or quick-pick stepper (for assigned) */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <p
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: fg,
                      margin: 0,
                    }}
                  >
                    {priceLine.label}
                  </p>
                  {priceLine.hint ? (
                    <p
                      style={{
                        fontSize: 12,
                        color: fgAlpha(60),
                        margin: 0,
                      }}
                    >
                      {priceLine.hint}
                    </p>
                  ) : null}
                </div>

                {isAssignedSection ? (
                  <QuantityStepper
                    value={selectedCount}
                    onStep={(delta) =>
                      handleQuickPick(section.sectionId, delta)
                    }
                    min={0}
                    max={
                      isSoldOut
                        ? 0
                        : (seatAvailability?.filter(
                            (s) =>
                              s.seatSectionId === dbSecId &&
                              (s.status === "AVAILABLE" ||
                                allSelectedSeatIds.has(s.id)),
                          ).length ?? 0)
                    }
                    disabled={isSoldOut || disabled}
                    aria-label={`${section.label} quick pick`}
                  />
                ) : (
                  <QuantityStepper
                    value={qty}
                    onStep={(delta) => onQuantityChange(tt.id, delta)}
                    min={0}
                    max={isSoldOut ? 0 : undefined}
                    disabled={isSoldOut || disabled}
                    aria-label={section.label}
                  />
                )}
              </div>
            </div>
          );
        })}

        {/* GA tickets without a section */}
        {gaTicketTypes.map((tt) => {
          const qty = quantities[tt.id] ?? 0;
          const isSoldOut = tt.capacity <= 0;
          const isSelected = qty > 0;
          // Stale-guarded like every other listing: a cached row priced at another
          // face reads "Calculating", never new face + old fees.
          const priceLine = seatMapPriceLabel(tt, { formatPrice, t });

          return (
            <div
              key={tt.id}
              style={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                borderRadius: 0,
                border: isSoldOut
                  ? `1px solid ${fgAlpha(5)}`
                  : isSelected
                    ? `1px solid ${fgAlpha(15)}`
                    : `1px solid ${fgAlpha(7)}`,
                background: isSelected ? fgAlpha(2.5) : "transparent",
                boxShadow: "none",
                padding: 20,
                opacity: isSoldOut ? 0.5 : 1,
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {isSelected && (
                <div
                  style={{
                    position: "absolute",
                    top: 12,
                    bottom: 12,
                    left: 0,
                    width: 3,
                    borderRadius: 0,
                    backgroundColor: fg,
                  }}
                />
              )}

              <div style={{ marginBottom: 20 }}>
                <p
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    lineHeight: 1.3,
                    color: fg,
                    margin: 0,
                  }}
                >
                  {tt.name}
                </p>
                <p
                  style={{
                    marginTop: 4,
                    fontSize: 14,
                    color: fgAlpha(80),
                    margin: "4px 0 0",
                  }}
                >
                  {isSoldOut
                    ? String(t("common.soldOut"))
                    : String(t("common.nRemaining", { count: tt.capacity }))}
                </p>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <p
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: fg,
                      margin: 0,
                    }}
                  >
                    {priceLine.label}
                  </p>
                  {priceLine.hint ? (
                    <p
                      style={{
                        fontSize: 12,
                        color: fgAlpha(60),
                        margin: 0,
                      }}
                    >
                      {priceLine.hint}
                    </p>
                  ) : null}
                </div>

                <QuantityStepper
                  value={qty}
                  onStep={(delta) => onQuantityChange(tt.id, delta)}
                  min={0}
                  max={isSoldOut ? 0 : undefined}
                  disabled={isSoldOut || disabled}
                  aria-label={tt.name}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      {hasAssignedSeating && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            fontSize: 13,
            color: fgAlpha(80),
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                height: 10,
                width: 10,
                borderRadius: 0,
                backgroundColor: "#10b981",
              }}
            />
            {String(t("checkout.legendAvailable"))}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                height: 10,
                width: 10,
                borderRadius: 0,
                backgroundColor: "#3b82f6",
              }}
            />
            {String(t("checkout.legendSelected"))}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                height: 10,
                width: 10,
                borderRadius: 0,
                backgroundColor: fgAlpha(20),
              }}
            />
            {String(t("checkout.legendUnavailable"))}
          </span>
        </div>
      )}
    </div>
  );
};

// ── SVG seat map visual ────────────────────────────────────────────────────────

type SeatMapVisualProps = {
  layout: PlaceLayout;
  sectionTicketMap: Map<string, TicketTypeForSection>;
  quantities: Record<string, number>;
  seatAvailability?: SeatAvailability[];
  allSelectedSeatIds: Set<string>;
  seatStatusMap: Map<string, SeatAvailability["status"]>;
  onSeatToggle?: (seatId: string, sectionId: string) => void;
  disabled?: boolean;
  formatPrice?: (cents: number) => string;
  /** When set, the map will animate-zoom to this section's bounding box. */
  focusedSectionId?: string | null;
  /** Called after the zoom animation starts so the parent can clear the focused ID. */
  onFocusHandled?: () => void;
};

const SeatMapVisual = ({
  layout,
  sectionTicketMap,
  quantities,
  seatAvailability,
  allSelectedSeatIds,
  seatStatusMap,
  onSeatToggle,
  disabled = false,
  formatPrice: formatPriceProp,
  focusedSectionId,
  onFocusHandled,
}: SeatMapVisualProps) => {
  const t = useTranslations();
  // ── Load seat glyphs from blob URL ───────────────────────────────────
  const [glyphs, setGlyphs] = useState<SeatGlyph[] | null>(null);

  useEffect(() => {
    if (!layout.glyphBlobUrl) return;
    let cancelled = false;

    async function fetchGlyphs() {
      try {
        const response = await fetch(layout.glyphBlobUrl!);
        if (!response.ok) return;
        const data: SeatGlyph[] = await response.json();
        if (!cancelled) setGlyphs(data);
      } catch {
        /* glyph fetch is best-effort; fall back to section polygons */
      }
    }

    void fetchGlyphs();
    return () => {
      cancelled = true;
    };
  }, [layout.glyphBlobUrl]);

  // ── Section color index for glyph coloring ───────────────────────────
  const sectionIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    layout.sections.forEach((s, i) => map.set(s.sectionId, i));
    return map;
  }, [layout.sections]);

  // ── Reverse lookup: DB seatSectionId → layout sectionId ─────────────
  const dbToLayoutSectionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const section of layout.sections) {
      // Find a ticket type that links this layout section to a DB section
      const tt = sectionTicketMap.get(section.sectionId);
      if (tt?.seatSectionId) {
        map.set(tt.seatSectionId, section.sectionId);
      }
    }
    return map;
  }, [layout.sections, sectionTicketMap]);

  // ── Fallback seat positions (when glyphs aren't available) ───────────
  // Derives a grid layout per-section from seat availability data + section
  // geometry, placing seats in rows within the section's bounding box.
  const fallbackGlyphs = useMemo<SeatGlyph[] | null>(() => {
    if (glyphs && glyphs.length > 0) return null; // real glyphs available
    if (!seatAvailability || seatAvailability.length === 0) return null;

    const result: SeatGlyph[] = [];

    // Group seats by DB seatSectionId
    const bySection = new Map<string, SeatAvailability[]>();
    for (const seat of seatAvailability) {
      const arr = bySection.get(seat.seatSectionId) ?? [];
      arr.push(seat);
      bySection.set(seat.seatSectionId, arr);
    }

    for (const [dbSectionId, seats] of bySection) {
      const layoutSectionId = dbToLayoutSectionId.get(dbSectionId);
      if (!layoutSectionId) continue;

      const section = layout.sections.find(
        (s) => s.sectionId === layoutSectionId,
      );
      if (!section) continue;

      // Determine bounding box from section geometry or seatIndexBounds
      let bx: number, by: number, bw: number, bh: number;
      if (section.geometry?.polygons?.length) {
        const pts = section.geometry.polygons.flat();
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        bx = Math.min(...xs);
        by = Math.min(...ys);
        bw = Math.max(...xs) - bx;
        bh = Math.max(...ys) - by;
      } else if (section.geometry?.origin) {
        // Fallback: center a box around origin
        bx = section.geometry.origin.x - 40;
        by = section.geometry.origin.y - 20;
        bw = 80;
        bh = 40;
      } else {
        continue;
      }

      // Sort seats by row then number for a natural grid
      const sorted = [...seats].sort((a, b) => {
        if (a.row !== b.row) return (a.row ?? "").localeCompare(b.row ?? "");
        return (a.number ?? 0) - (b.number ?? 0);
      });

      // Determine unique rows + index lookup (avoids per-seat indexOf scan)
      const rowIdxByKey = new Map<string, number>();
      for (const s of sorted) {
        const key = s.row ?? "__default";
        if (!rowIdxByKey.has(key)) rowIdxByKey.set(key, rowIdxByKey.size);
      }
      const seatsPerRow = Math.ceil(sorted.length / rowIdxByKey.size);
      const inset = 4; // padding inside the bounding box

      // Calculate radius based on available space — larger for tap targets
      const cellW = (bw - inset * 2) / seatsPerRow;
      const cellH = (bh - inset * 2) / Math.max(rowIdxByKey.size, 1);
      const r = Math.max(4, Math.min(cellW, cellH) * 0.44);

      // Single-pass column counter per row — O(n) instead of O(n²) filter.
      const colCounter = new Map<string, number>();
      sorted.forEach((seat) => {
        const rowKey = seat.row ?? "__default";
        const rowIdx = rowIdxByKey.get(rowKey) ?? 0;
        const colIdx = colCounter.get(rowKey) ?? 0;
        colCounter.set(rowKey, colIdx + 1);
        // Center in cells
        const cx = bx + inset + cellW * (colIdx + 0.5);
        const cy = by + inset + cellH * (rowIdx + 0.5);

        result.push({
          seatId: seat.id,
          sectionId: layoutSectionId,
          label: seat.label,
          position: { x: cx, y: cy },
          radius: r,
        });
      });
    }

    return result.length > 0 ? result : null;
  }, [glyphs, seatAvailability, dbToLayoutSectionId, layout.sections]);

  // ── Merged glyph set (real or fallback) ──────────────────────────────
  const effectiveGlyphs = glyphs && glyphs.length > 0 ? glyphs : fallbackGlyphs;
  const hasGlyphs = effectiveGlyphs && effectiveGlyphs.length > 0;

  // ── Uniform seat-label sizing ────────────────────────────────────────
  // Longest label lengths across the WHOLE rendered seat set (full label +
  // trailing-digits tier, mirroring SeatNode's label fallback). SeatNode
  // divides its font size by these instead of each glyph's own length so
  // every seat number renders at an identical size. Min 1 guards empties.
  const { maxFullLabelLen, maxDigitsLabelLen } = useMemo(() => {
    let fullLen = 1;
    let digitsLen = 1;
    for (const glyph of effectiveGlyphs ?? []) {
      fullLen = Math.max(fullLen, glyph.label.length);
      const digits = glyph.label.match(/\d+$/)?.[0] ?? glyph.label.slice(-2);
      digitsLen = Math.max(digitsLen, digits.length);
    }
    return { maxFullLabelLen: fullLen, maxDigitsLabelLen: digitsLen };
  }, [effectiveGlyphs]);

  // ── Click handler for individual seats ───────────────────────────────
  const handleSeatClick = useCallback(
    (seatId: string, sectionId: string) => {
      if (disabled) return;
      const status = seatStatusMap.get(seatId);
      // Only AVAILABLE seats (or already-selected ones) can be toggled
      if (status && status !== "AVAILABLE" && !allSelectedSeatIds.has(seatId))
        return;
      onSeatToggle?.(seatId, sectionId);
    },
    [disabled, seatStatusMap, allSelectedSeatIds, onSeatToggle],
  );

  const { minX, minY, maxX, maxY } = layout.seatIndexBounds;
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const padding = Math.max(width, height) * 0.08;

  // ── Pan / zoom state ─────────────────────────────────────────────────
  const MIN_SCALE = 0.5;
  const isTouch = useIsTouchViewport();
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = React.useRef<{ startX: number; startY: number } | null>(null);
  // Last APPLIED scale. Refreshed from state on render AND updated
  // imperatively inside zoom handlers right after they compute the next
  // scale: wheel ticks / pinch touchmoves / button taps can fire more than
  // once between renders, and anchoring from the rendered `scale` would use
  // a stale value (visible drift while pinching).
  const scaleRef = React.useRef(scale);
  scaleRef.current = scale;
  // Pointer-session movement tracking: a click that follows a real pan/pinch
  // must not select seats or zoom into sections.
  const panSessionRef = React.useRef<{
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = React.useRef(false);
  const activePointersRef = React.useRef<Set<number>>(new Set());
  /** Section highlighted in the mobile jump-chip row. */
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  /** Measured CSS pixel size of the rendered SVG (for px ↔ world math). */
  const [viewportPx, setViewportPx] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // ── Demo synthetic seats when no glyphs/availability exist (dev/demo UX)
  const [demoSelected, setDemoSelected] = useState<Set<string>>(new Set());

  // Merge externally-provided selected seat ids with local demo selections
  const effectiveSelectedSeatIds = useMemo(() => {
    const s = new Set<string>(allSelectedSeatIds);
    demoSelected.forEach((id) => s.add(id));
    return s;
  }, [allSelectedSeatIds, demoSelected]);

  // Pinch-to-zoom tracking
  const pinchRef = React.useRef<{ dist: number; scale: number } | null>(null);

  // ── Seat detail tooltip state ────────────────────────────────────────
  const [seatAnnouncement, setSeatAnnouncement] = useState("");
  const [tooltip, setTooltip] = useState<{
    seatId: string;
    label: string;
    sectionLabel: string;
    status: string;
    isSelected: boolean;
    x: number;
    y: number;
    row?: string | null;
    number?: number | null;
    priceCents?: number;
    /** A pay-what-you-want seat's text (the quick-pick row's label), instead of a figure. */
    priceLabel?: string;
    isPricePending?: boolean;
  } | null>(null);

  const viewBox = `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`;

  // Quantized zoom for seat-label sizing. Seats are memoized; passing the raw
  // continuous `scale` would re-render every glyph on each wheel tick. Rounding
  // to 0.25 steps means they only re-render when crossing a label-size tier.
  const labelScale = Math.round(scale * 4) / 4;

  // Default radius based on density — aim for easily tappable seats (min 44px hit target)
  const defaultRadius = useMemo(() => {
    if (!effectiveGlyphs || effectiveGlyphs.length === 0)
      return Math.min(width, height) * 0.04;
    const area = width * height;
    // Ensure tappable min radius ~10 for mobile and slightly larger otherwise
    return Math.max(
      10,
      Math.min(18, Math.sqrt(area / effectiveGlyphs.length) * 0.52),
    );
  }, [effectiveGlyphs, width, height]);

  // ── Touch zoom model (tap-target floor, viewport-derived limits) ─────
  const viewCenter = useMemo(
    () => ({ x: minX + width / 2, y: minY + height / 2 }),
    [minX, minY, width, height],
  );
  const contentBounds = layout.seatIndexBounds;

  /** Screen px per world unit at scale 1 (0 until the SVG is measured). */
  const baseUnitScale = useMemo(
    () =>
      computeBaseUnitScale(
        { width: width + padding * 2, height: height + padding * 2 },
        viewportPx,
      ),
    [width, height, padding, viewportPx],
  );

  /** Zoom floor at which the median seat reaches a ~22px tap target. */
  const minUsableScale = useMemo(() => {
    if (!effectiveGlyphs || effectiveGlyphs.length === 0 || baseUnitScale <= 0)
      return 1;
    return computeMinUsableScale(
      median(effectiveGlyphs.map((g) => g.radius ?? defaultRadius)),
      baseUnitScale,
    );
  }, [effectiveGlyphs, defaultRadius, baseUnitScale]);

  /** Effective ceiling — raised when needed so the floor stays reachable. */
  const maxScale = useMemo(
    () => computeMaxScale(minUsableScale),
    [minUsableScale],
  );

  /** Are seats comfortable touch targets at the current zoom? */
  const seatsTappable = scale >= minUsableScale * 0.8;
  const isZoomedIn = scale > OVERVIEW_SCALE_THRESHOLD;

  /** Sections that can be focused/hit-tested (have polygon geometry). */
  const focusableSections = useMemo(
    () => layout.sections.filter((s) => s.geometry?.polygons?.length),
    [layout.sections],
  );

  // ── Clamp translate so the viewport centre stays over content ────────
  // (Permits the large translates needed to centre far sections at high
  // zoom, unlike the previous symmetric magnitude clamp.)
  const clampTranslate = useCallback(
    (tx: number, ty: number, s: number): { x: number; y: number } =>
      clampTranslateToContent(tx, ty, s, contentBounds, viewCenter),
    [contentBounds, viewCenter],
  );

  // ── Wheel zoom (desktop) ────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      if (e.ctrlKey) return; // allow browser zoom
      e.preventDefault();
      const factor = -e.deltaY > 0 ? 1.12 : 0.88;
      const next = Math.max(
        MIN_SCALE,
        Math.min(maxScale, scaleRef.current * factor),
      );
      scaleRef.current = next;
      setScale(next);
      // Re-clamp translate at new scale
      setTranslate((t) => clampTranslate(t.x, t.y, next));
    },
    [clampTranslate, maxScale],
  );

  // ── Pointer pan (mouse drag / single-finger touch) ──────────────────
  const svgRef = React.useRef<SVGSVGElement>(null);

  // Measure the rendered SVG so zoom math can convert px ↔ world units.
  useEffect(() => {
    const el = svgRef.current;
    if (el == null || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return; // hidden (list mode)
      setViewportPx((prev) =>
        prev?.width === rect.width && prev?.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only start pan on primary button (or single touch)
    if (e.button !== 0) return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    activePointersRef.current.add(e.pointerId);
    setIsPanning(true);
    panRef.current = { startX: e.clientX, startY: e.clientY };
    if (activePointersRef.current.size === 1) {
      panSessionRef.current = {
        originX: e.clientX,
        originY: e.clientY,
        moved: false,
      };
      suppressClickRef.current = false;
    } else if (panSessionRef.current) {
      // A second finger landed: this is a pinch, never a tap.
      panSessionRef.current.moved = true;
    }
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning || !panRef.current) return;
      const session = panSessionRef.current;
      if (
        session &&
        !session.moved &&
        Math.hypot(e.clientX - session.originX, e.clientY - session.originY) >
          PAN_TAP_SLOP_PX
      ) {
        session.moved = true;
      }
      // While two fingers are down the pinch handler owns the transform.
      if (activePointersRef.current.size > 1) return;
      // Touch: translate is applied after scale in viewBox units, so divide
      // by px-per-unit to track the finger 1:1. Desktop keeps legacy feel.
      const unit = isTouch && baseUnitScale > 0 ? baseUnitScale : scale;
      const dx = (e.clientX - panRef.current.startX) / unit;
      const dy = (e.clientY - panRef.current.startY) / unit;
      setTranslate((t) => clampTranslate(t.x + dx, t.y + dy, scale));
      panRef.current = { startX: e.clientX, startY: e.clientY };
    },
    [isPanning, scale, clampTranslate, isTouch, baseUnitScale],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may not be captured (e.g. cancel) */
    }
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size > 0) {
      // Pinch ending finger-by-finger: stop panning from stale coordinates.
      panRef.current = null;
      return;
    }
    setIsPanning(false);
    panRef.current = null;
    suppressClickRef.current = panSessionRef.current?.moved ?? false;
    panSessionRef.current = null;
  }, []);

  // ── Pinch-to-zoom (touch) ───────────────────────────────────────────
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        pinchRef.current = { dist: Math.hypot(dx, dy), scale: scaleRef.current };
        if (panSessionRef.current) panSessionRef.current.moved = true;
      }
    },
    [],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      if (e.touches.length === 2 && pinchRef.current) {
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        const dist = Math.hypot(dx, dy);
        const ratio = dist / pinchRef.current.dist;
        const prev = scaleRef.current;
        const next = Math.max(
          MIN_SCALE,
          Math.min(maxScale, pinchRef.current.scale * ratio),
        );
        scaleRef.current = next;
        setScale(next);
        // Anchor the zoom at the viewport centre so the area under the
        // fingers doesn't fly away while pinching.
        setTranslate((t) => {
          const anchored = anchorTranslateForScaleChange(
            t,
            prev,
            next,
            viewCenter,
          );
          return clampTranslate(anchored.x, anchored.y, next);
        });
      }
    },
    [clampTranslate, maxScale, viewCenter],
  );

  const handleTouchEnd = useCallback(() => {
    pinchRef.current = null;
  }, []);

  // ── Zoom buttons ─────────────────────────────────────────────────────
  const zoomIn = useCallback(() => {
    const prev = scaleRef.current;
    const next = Math.min(maxScale, prev * 1.3);
    scaleRef.current = next;
    setScale(next);
    setTranslate((t) => {
      const base = isTouch
        ? anchorTranslateForScaleChange(t, prev, next, viewCenter)
        : t;
      return clampTranslate(base.x, base.y, next);
    });
  }, [maxScale, isTouch, viewCenter, clampTranslate]);

  const zoomOut = useCallback(() => {
    const prev = scaleRef.current;
    const next = Math.max(MIN_SCALE, prev * 0.7);
    scaleRef.current = next;
    setScale(next);
    setTranslate((t) => {
      const base = isTouch
        ? anchorTranslateForScaleChange(t, prev, next, viewCenter)
        : t;
      return clampTranslate(base.x, base.y, next);
    });
  }, [isTouch, viewCenter, clampTranslate]);

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    setTooltip(null);
    setActiveSectionId(null);
  }, []);

  // ── Programmatic section focus (cards, chips, touch section taps) ────
  // Centres the section and never lands below the tap-target zoom floor.
  const applySectionFocus = useCallback(
    (sectionId: string) => {
      const section = layout.sections.find((s) => s.sectionId === sectionId);
      let bounds = section?.geometry?.polygons?.length
        ? boundsOfPolygons(section.geometry.polygons)
        : null;
      if (!bounds && effectiveGlyphs) {
        bounds = boundsOfPoints(
          effectiveGlyphs
            .filter((g) => g.sectionId === sectionId)
            .map((g) => g.position),
        );
      }
      if (!bounds) return;
      const focus = computeSectionFocusTransform({
        sectionBounds: bounds,
        contentBounds,
        viewCenter,
        viewSize: { width, height },
        minUsableScale,
        minScale: MIN_SCALE,
        maxScale,
      });
      setScale(focus.scale);
      setTranslate(focus.translate);
      setTooltip(null);
      setActiveSectionId(sectionId);
    },
    [
      layout.sections,
      effectiveGlyphs,
      contentBounds,
      viewCenter,
      width,
      height,
      minUsableScale,
      maxScale,
    ],
  );

  // ── Zoom-to-section (triggered by section card click) ────────────────
  useEffect(() => {
    if (!focusedSectionId) return;

    // Touch: clamped focus that zooms IN (never below the tap-target floor).
    if (isTouch) {
      applySectionFocus(focusedSectionId);
      onFocusHandled?.();
      return;
    }

    // Desktop: legacy ~60%-of-viewport fit animation.
    const section = layout.sections.find(
      (s) => s.sectionId === focusedSectionId,
    );
    if (!section?.geometry?.polygons?.length) {
      onFocusHandled?.();
      return;
    }
    const pts = section.geometry.polygons.flat();
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const sMinX = Math.min(...xs);
    const sMinY = Math.min(...ys);
    const sMaxX = Math.max(...xs);
    const sMaxY = Math.max(...ys);
    const sCenterX = (sMinX + sMaxX) / 2;
    const sCenterY = (sMinY + sMaxY) / 2;
    const viewCenterX = minX + width / 2;
    const viewCenterY = minY + height / 2;

    // Calculate zoom so the section fills ~60% of the viewport
    const sWidth = sMaxX - sMinX || 1;
    const sHeight = sMaxY - sMinY || 1;
    const zoomX = (width * 0.6) / sWidth;
    const zoomY = (height * 0.6) / sHeight;
    const nextScale = Math.max(
      MIN_SCALE,
      Math.min(maxScale, Math.min(zoomX, zoomY)),
    );

    // Translate so section center aligns with viewport center
    const tx = viewCenterX - sCenterX;
    const ty = viewCenterY - sCenterY;

    setScale(nextScale);
    setTranslate(clampTranslate(tx, ty, nextScale));
    setTooltip(null);
    onFocusHandled?.();
  }, [
    focusedSectionId,
    isTouch,
    applySectionFocus,
    layout.sections,
    minX,
    minY,
    width,
    height,
    maxScale,
    clampTranslate,
    onFocusHandled,
  ]);

  // ── Seat click handler with tooltip ──────────────────────────────────
  const handleSeatInteraction = useCallback(
    (glyph: SeatGlyph, e: React.MouseEvent | React.KeyboardEvent) => {
      // A click that concludes a pan/pinch is not a selection.
      if (suppressClickRef.current && e.type === "click") return;
      // Touch overview: seats are too small to be meaningful targets, so a
      // tap on one zooms into its section instead (section-first nav).
      // Keyboard interaction still toggles directly for accessibility.
      if (isTouch && e.type === "click" && !seatsTappable) {
        applySectionFocus(glyph.sectionId);
        return;
      }
      const status = seatStatusMap.get(glyph.seatId);
      const isSelected = effectiveSelectedSeatIds.has(glyph.seatId);
      const isAvailable = !status || status === "AVAILABLE";

      // Find the section label for tooltip
      const sectionIdx = sectionIndexMap.get(glyph.sectionId) ?? 0;
      const section = layout.sections[sectionIdx];
      const sectionLabel = section?.label ?? glyph.sectionId;

      // Find seat availability record for row/number
      const seatRecord = seatAvailability?.find((s) => s.id === glyph.seatId);
      // Find ticket type for price
      const tt = sectionTicketMap.get(glyph.sectionId);

      // Show/toggle tooltip
      if (tooltip?.seatId === glyph.seatId) {
        setTooltip(null);
      } else {
        const basePriceCents =
          seatRecord?.priceOverride?.priceCents ?? tt?.priceCents;
        const displayPriceCents =
          seatRecord?.priceOverride?.buyerTotalCents ??
          (tt
            ? getBuyerAllInDisplayCents(tt, basePriceCents)
            : basePriceCents != null && basePriceCents <= 0
              ? 0
              : null);

        const adjustableLabel = formatPriceProp
          ? adjustableSeatPriceLabel(tt, !!seatRecord?.priceOverride, {
              formatPrice: formatPriceProp,
              t,
            })
          : null;
        setTooltip({
          seatId: glyph.seatId,
          label: glyph.label,
          sectionLabel,
          status: isSelected ? "SELECTED" : (status ?? "AVAILABLE"),
          isSelected,
          x: glyph.position.x,
          y: glyph.position.y,
          row: seatRecord?.row,
          number: seatRecord?.number,
          priceCents: adjustableLabel ? undefined : (displayPriceCents ?? undefined),
          priceLabel: adjustableLabel ?? undefined,
          isPricePending:
            !adjustableLabel &&
            basePriceCents != null &&
            basePriceCents > 0 &&
            displayPriceCents === null,
        });
      }

      // Also toggle the seat if it's clickable. When real seat
      // availability data is present (from the backend), delegate to
      // the parent onSeatToggle so selections flow into the checkout
      // cart. Only fall back to local demoSelected state when there is
      // no backend data (pure preview / demo mode).
      if ((isAvailable || isSelected) && !disabled) {
        const hasBackendData = seatAvailability && seatAvailability.length > 0;
        if (hasBackendData) {
          handleSeatClick(glyph.seatId, glyph.sectionId);
          const ttName = tt?.name ?? sectionLabel;
          setSeatAnnouncement(
            isSelected
              ? String(t("checkout.seatDeselected", { label: glyph.label }))
              : String(
                  t("checkout.seatSelectedIn", {
                    label: glyph.label,
                    section: ttName,
                  }),
                ),
          );
        } else {
          // No backend availability — manage locally for demo UX
          setDemoSelected((prev) => {
            const next = new Set(prev);
            if (next.has(glyph.seatId)) next.delete(glyph.seatId);
            else next.add(glyph.seatId);
            return next;
          });
          setSeatAnnouncement(
            isSelected
              ? String(t("checkout.seatDeselected", { label: glyph.label }))
              : String(
                  t("checkout.seatSelectedIn", {
                    label: glyph.label,
                    section: sectionLabel,
                  }),
                ),
          );
        }
      }
    },
    [
      isTouch,
      seatsTappable,
      applySectionFocus,
      seatStatusMap,
      effectiveSelectedSeatIds,
      sectionIndexMap,
      layout.sections,
      tooltip,
      disabled,
      handleSeatClick,
      seatAvailability,
      sectionTicketMap,
      setSeatAnnouncement,
      t,
      formatPriceProp,
    ],
  );

  // Background taps/clicks. Desktop: dismiss the tooltip. Touch: drive
  // section-first navigation at overview and seat hit-slop when zoomed in.
  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (suppressClickRef.current) return;
      const targetEl = e.target as Element;
      const seatTargetEl = targetEl.closest?.("[data-seat-id]") ?? null;
      const isSeatTarget = Boolean(seatTargetEl);

      if (!isTouch) {
        if (targetEl.tagName === "svg") setTooltip(null);
        return;
      }

      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) {
        if (!isSeatTarget) setTooltip(null);
        return;
      }
      // Client px → viewBox coords → world coords (undo the zoom group).
      const vb = new DOMPoint(e.clientX, e.clientY).matrixTransform(
        ctm.inverse(),
      );
      const world = {
        x: (vb.x - translate.x) / scale,
        y: (vb.y - translate.y) / scale,
      };
      const sectionAtTap = findSectionAtPoint(
        world,
        focusableSections.map((s) => ({
          sectionId: s.sectionId,
          polygons: s.geometry!.polygons!,
        })),
      );

      // Overview: tapping anywhere in a section (including its unavailable
      // seats, which have no click handler) zooms into it. Available seats
      // also route here via SeatNode — applySectionFocus is idempotent.
      if (!seatsTappable) {
        if (sectionAtTap) applySectionFocus(sectionAtTap);
        else if (!isSeatTarget) setTooltip(null);
        return;
      }

      // Zoomed in: direct hits on SELECTABLE seats are handled by the
      // SeatNode itself. Direct hits on unavailable glyphs (which have no
      // click handler) fall through to the slop resolver so a tap on a
      // SOLD seat can still pick an adjacent selectable neighbour — but
      // never one from another section.
      let directHitSectionId: string | null = null;
      if (seatTargetEl) {
        const hitSeatId = seatTargetEl.getAttribute("data-seat-id");
        const hitStatus = hitSeatId ? seatStatusMap.get(hitSeatId) : undefined;
        const hitSelectable =
          !hitStatus ||
          hitStatus === "AVAILABLE" ||
          (hitSeatId != null && effectiveSelectedSeatIds.has(hitSeatId));
        if (hitSelectable) return;
        directHitSectionId =
          effectiveGlyphs?.find((g) => g.seatId === hitSeatId)?.sectionId ??
          null;
      }

      // Forgive near-miss taps with a ~22px screen hit slop,
      // never across section boundaries or onto unavailable seats.
      if (
        !effectiveGlyphs ||
        effectiveGlyphs.length === 0 ||
        baseUnitScale <= 0
      ) {
        setTooltip(null);
        return;
      }
      const slopWorld = TARGET_SEAT_TAP_PX / (baseUnitScale * scale);
      const candidates: SlopSeat[] = effectiveGlyphs.map((g) => {
        const status = seatStatusMap.get(g.seatId);
        return {
          seatId: g.seatId,
          sectionId: g.sectionId,
          x: g.position.x,
          y: g.position.y,
          radius: g.radius ?? defaultRadius,
          selectable:
            !status ||
            status === "AVAILABLE" ||
            effectiveSelectedSeatIds.has(g.seatId),
        };
      });
      const hit = findNearestSeatWithinSlop(
        world,
        candidates,
        slopWorld,
        // Prefer the polygon under the tap; for a direct hit on an
        // unavailable glyph that sits outside every polygon, restrict to
        // that glyph's own section instead.
        sectionAtTap ?? directHitSectionId,
      );
      if (hit) {
        const glyph = effectiveGlyphs.find((g) => g.seatId === hit.seatId);
        if (glyph) {
          handleSeatInteraction(glyph, e);
          return;
        }
      }
      setTooltip(null);
    },
    [
      isTouch,
      translate,
      scale,
      focusableSections,
      seatsTappable,
      applySectionFocus,
      effectiveGlyphs,
      baseUnitScale,
      seatStatusMap,
      effectiveSelectedSeatIds,
      defaultRadius,
      handleSeatInteraction,
    ],
  );
  // ── Hover tooltip for seats ──────────────────────────────────────────
  const handleSeatHover = useCallback(
    (glyph: SeatGlyph) => {
      // Don't update tooltip while panning
      if (isPanning) return;
      const status = seatStatusMap.get(glyph.seatId);
      const isSelected = effectiveSelectedSeatIds.has(glyph.seatId);
      const sectionIdx = sectionIndexMap.get(glyph.sectionId) ?? 0;
      const section = layout.sections[sectionIdx];
      const sectionLabel = section?.label ?? glyph.sectionId;
      const seatRecord = seatAvailability?.find((s) => s.id === glyph.seatId);
      const tt = sectionTicketMap.get(glyph.sectionId);

      const basePriceCents =
        seatRecord?.priceOverride?.priceCents ?? tt?.priceCents;
      const displayPriceCents =
        seatRecord?.priceOverride?.buyerTotalCents ??
        (tt
          ? getBuyerAllInDisplayCents(tt, basePriceCents)
          : basePriceCents != null && basePriceCents <= 0
            ? 0
            : null);

      const adjustableLabel = formatPriceProp
        ? adjustableSeatPriceLabel(tt, !!seatRecord?.priceOverride, {
            formatPrice: formatPriceProp,
            t,
          })
        : null;

      setTooltip({
        seatId: glyph.seatId,
        label: glyph.label,
        sectionLabel,
        status: isSelected ? "SELECTED" : (status ?? "AVAILABLE"),
        isSelected,
        x: glyph.position.x,
        y: glyph.position.y,
        row: seatRecord?.row,
        number: seatRecord?.number,
        priceCents: adjustableLabel ? undefined : (displayPriceCents ?? undefined),
        priceLabel: adjustableLabel ?? undefined,
        isPricePending:
          !adjustableLabel &&
          basePriceCents != null &&
          basePriceCents > 0 &&
          displayPriceCents === null,
      });
    },
    [
      isPanning,
      seatStatusMap,
      effectiveSelectedSeatIds,
      sectionIndexMap,
      layout.sections,
      seatAvailability,
      sectionTicketMap,
      t,
      formatPriceProp,
    ],
  );

  const handleSeatHoverEnd = useCallback(() => {
    setTooltip(null);
  }, []);

  // ── Arrow-key navigation between seats ───────────────────────────────
  const handleArrowNav = useCallback(
    (currentGlyph: SeatGlyph, key: string) => {
      if (!effectiveGlyphs || effectiveGlyphs.length === 0) return;
      const { x, y } = currentGlyph.position;

      // Direction vectors for each arrow key
      const dirs: Record<string, { dx: number; dy: number }> = {
        ArrowRight: { dx: 1, dy: 0 },
        ArrowLeft: { dx: -1, dy: 0 },
        ArrowDown: { dx: 0, dy: 1 },
        ArrowUp: { dx: 0, dy: -1 },
      };
      const dir = dirs[key];
      if (!dir) return;

      let bestGlyph: SeatGlyph | null = null;
      let bestScore = Infinity;

      for (const g of effectiveGlyphs) {
        if (g.seatId === currentGlyph.seatId) continue;
        const gdx = g.position.x - x;
        const gdy = g.position.y - y;
        // Dot product: candidate must be in the desired direction
        const dot = gdx * dir.dx + gdy * dir.dy;
        if (dot <= 0) continue;
        // Distance — weight perpendicular offset more heavily so navigation
        // prefers the seat most aligned with the arrow direction.
        const dist = Math.sqrt(gdx * gdx + gdy * gdy);
        const perp = Math.abs(gdx * dir.dy - gdy * dir.dx);
        const score = dist + perp * 2;
        if (score < bestScore) {
          bestScore = score;
          bestGlyph = g;
        }
      }

      if (bestGlyph && svgRef.current) {
        // Find the <g> element for the target seat and focus it
        const target = svgRef.current.querySelector<SVGGElement>(
          `[data-seat-id="${bestGlyph.seatId}"]`,
        );
        if (target) {
          target.focus();
          handleSeatHover(bestGlyph);
        }
      }
    },
    [effectiveGlyphs, handleSeatHover],
  );

  // ── One-shot "drag / pinch" gesture hint (touch, first zoom-in) ──────
  const gestureHintShownRef = React.useRef(false);
  const [showGestureHint, setShowGestureHint] = useState(false);
  useEffect(() => {
    if (!isTouch || !isZoomedIn || gestureHintShownRef.current) return;
    gestureHintShownRef.current = true;
    setShowGestureHint(true);
    const timer = setTimeout(() => setShowGestureHint(false), 3000);
    return () => clearTimeout(timer);
  }, [isTouch, isZoomedIn]);

  return (
    <div style={{ position: "relative" }}>
      <style>{`
        @keyframes seat-hint-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
          [data-seat-hint] { animation: none !important; }
        }
        .seat-map-section-chips { scrollbar-width: none; }
        .seat-map-section-chips::-webkit-scrollbar { display: none; }
      `}</style>
      {/* Screen-reader announcement for seat selection changes */}
      <div aria-live="polite" aria-atomic="true" style={srOnlyStyle}>
        {seatAnnouncement}
      </div>

      {/* Section jump chips (touch, zoomed in past overview) */}
      {isTouch && isZoomedIn && focusableSections.length > 0 && (
        <div
          className="seat-map-section-chips"
          role="group"
          aria-label={String(t("checkout.sectionJumpNav"))}
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            right: 60, // keep clear of the zoom controls
            zIndex: 10,
            display: "flex",
            gap: 4,
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <button
            type="button"
            onClick={resetView}
            style={sectionChipStyle(false)}
          >
            {String(t("checkout.seatMapOverview"))}
          </button>
          {focusableSections.map((section) => (
            <button
              key={section.sectionId}
              type="button"
              onClick={() => applySectionFocus(section.sectionId)}
              aria-pressed={activeSectionId === section.sectionId}
              style={sectionChipStyle(activeSectionId === section.sectionId)}
            >
              {section.label}
            </button>
          ))}
        </div>
      )}

      {/* Touch guidance hints (bottom centre, never alongside the tooltip) */}
      {isTouch && hasGlyphs && !tooltip && showGestureHint && (
        <div
          data-seat-hint=""
          aria-hidden="true"
          style={{
            ...mapHintStyle,
            animation: "seat-hint-fade 3s ease forwards",
          }}
        >
          {String(t("checkout.dragPinchHint"))}
        </div>
      )}
      {isTouch &&
        hasGlyphs &&
        !tooltip &&
        !showGestureHint &&
        !seatsTappable && (
          <div aria-hidden="true" style={mapHintStyle}>
            {String(t("checkout.tapSectionToZoom"))}
          </div>
        )}

      {/* Zoom controls (HTML overlay, always accessible) */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          gap: 0,
          borderRadius: 0,
          overflow: "hidden",
          border: `1px solid ${fgAlpha(12)}`,
          background: fgAlpha(5),
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        {[
          {
            label: "+",
            action: zoomIn,
            ariaLabel: String(t("checkout.zoomIn")),
          },
          {
            label: "−",
            action: zoomOut,
            ariaLabel: String(t("checkout.zoomOut")),
          },
        ].map(({ label, action, ariaLabel }) => (
          <button
            key={label}
            onClick={action}
            style={{
              // ≥44px touch targets (mobile tap-target floor)
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderBottom: `1px solid ${fgAlpha(8)}`,
              color: fg,
              fontSize: 18,
              fontWeight: 700,
              cursor: "pointer",
              lineHeight: 1,
              transition: "background 0.1s",
            }}
            onPointerEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                fgAlpha(8);
            }}
            onPointerLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "transparent";
            }}
            aria-label={ariaLabel}
          >
            {label}
          </button>
        ))}
        {/* Zoom percentage / reset */}
        <button
          onClick={resetView}
          style={{
            width: 44,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: scale !== 1 ? "rgba(59,130,246,0.08)" : "transparent",
            border: "none",
            color: scale !== 1 ? "#3b82f6" : fgAlpha(60),
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            lineHeight: 1,
            transition: "all 0.15s",
            fontVariantNumeric: "tabular-nums",
          }}
          onPointerEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              fgAlpha(8);
          }}
          onPointerLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              scale !== 1 ? "rgba(59,130,246,0.08)" : "transparent";
          }}
          aria-label={String(t("checkout.zoomReset"))}
          title="Reset zoom"
        >
          {scale === 1 ? "1:1" : `${Math.round(scale * 100)}%`}
        </button>
      </div>

      {/* Tooltip overlay */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 8,
            transform: "translateX(-50%)",
            zIndex: 20,
            background: "rgba(0,0,0,0.88)",
            color: "#fff",
            borderRadius: 0,
            padding: "10px 16px",
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              display: "inline-block",
              height: 10,
              width: 10,
              borderRadius: 0,
              flexShrink: 0,
              backgroundColor: tooltip.isSelected
                ? "#3b82f6"
                : tooltip.status === "AVAILABLE"
                  ? "#10b981"
                  : fgAlpha(30),
            }}
          />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{tooltip.label}</span>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {tooltip.sectionLabel}
          </span>
          {tooltip.row && (
            <span style={{ opacity: 0.65, fontSize: 13 }}>
              {String(
                t("checkout.seatRowNumber", {
                  row: tooltip.row,
                  ...(tooltip.number != null ? { number: tooltip.number } : {}),
                }),
              )}
            </span>
          )}
          {tooltip.priceLabel && (
            <span style={{ fontWeight: 700, fontSize: 14, color: "#a5f3fc" }}>
              {tooltip.priceLabel}
            </span>
          )}
          {tooltip.priceCents != null && formatPriceProp && (
            <span style={{ fontWeight: 700, fontSize: 14, color: "#a5f3fc" }}>
              {formatPriceProp(tooltip.priceCents)}
            </span>
          )}
          {tooltip.isPricePending && (
            <span style={{ fontWeight: 700, fontSize: 14, color: "#a5f3fc" }}>
              {String(t("checkout.calculatingTotal"))}
            </span>
          )}
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            {tooltip.isSelected
              ? String(t("checkout.legendSelected"))
              : tooltip.status === "AVAILABLE"
                ? String(t("checkout.legendAvailable"))
                : String(t("checkout.legendUnavailable"))}
          </span>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={viewBox}
        onClick={handleSvgClick}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          minHeight: 320,
          maxHeight: "70vh",
          aspectRatio: `${width + padding * 2} / ${height + padding * 2}`,
          touchAction: "none",
          userSelect: "none",
          cursor: isPanning ? "grabbing" : "grab",
          // Isolate paint so page scroll doesn't repaint 200+ seat circles
          // every frame. Promotes the SVG to its own compositor layer.
          contain: "layout paint style",
          willChange: "transform",
        }}
        role="img"
        aria-label={`Seat map for ${layout.name}`}
      >
        {/* Transformed content group */}
        <g
          transform={`translate(${translate.x} ${translate.y}) scale(${scale})`}
          style={{
            transition: isPanning ? "none" : "transform 0.35s ease-out",
          }}
        >
          {/* Stage */}
          {layout.stage && (
            <rect
              x={layout.stage.bounds.minX}
              y={layout.stage.bounds.minY}
              width={layout.stage.bounds.maxX - layout.stage.bounds.minX}
              height={layout.stage.bounds.maxY - layout.stage.bounds.minY}
              rx={4}
              fill="var(--foreground, #211C16)"
              fillOpacity={0.06}
              stroke="var(--foreground, #211C16)"
              strokeOpacity={0.15}
              strokeWidth={1}
            />
          )}
          {layout.stage?.label && (
            <text
              x={(layout.stage.bounds.minX + layout.stage.bounds.maxX) / 2}
              y={(layout.stage.bounds.minY + layout.stage.bounds.maxY) / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#211C16"
              fillOpacity={0.65}
              style={{
                fontSize: 14,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              {layout.stage.label}
            </text>
          )}

          {/* Section polygons (dimmed background when individual seats are rendered) */}
          {layout.sections.map((section, idx) => {
            if (!section.geometry?.polygons?.length) return null;

            const tt = sectionTicketMap.get(section.sectionId);
            const qty = tt ? (quantities[tt.id] ?? 0) : 0;
            const isSelected = qty > 0;
            const isSoldOut = tt ? tt.capacity <= 0 : true;
            const color = getSectionColor(section, idx);

            return section.geometry.polygons.map((polygon, pIdx) => {
              const tessellated = tessellateForSvg(
                polygon,
                section.geometry?.smoothing,
              );
              const points = tessellated.map((p) => `${p.x},${p.y}`).join(" ");
              return (
                <polygon
                  key={`${section.sectionId}-${pIdx}`}
                  points={points}
                  fill={isSoldOut ? "var(--foreground)" : color}
                  fillOpacity={
                    hasGlyphs
                      ? 0.06
                      : isSoldOut
                        ? 0.04
                        : isSelected
                          ? 0.35
                          : 0.15
                  }
                  stroke={isSoldOut ? "var(--foreground)" : color}
                  strokeOpacity={
                    hasGlyphs ? 0.18 : isSoldOut ? 0.1 : isSelected ? 0.8 : 0.4
                  }
                  strokeWidth={hasGlyphs ? 0.8 : isSelected ? 2 : 1}
                  style={{ transition: "all 0.2s" }}
                />
              );
            });
          })}

          {/* Section labels */}
          {layout.sections.map((section) => {
            if (!section.geometry?.origin) return null;

            // When individual seat glyphs are rendered, push the label above
            // the section so it doesn't get hidden behind the circles.
            const labelY = hasGlyphs
              ? (() => {
                  const pts = section.geometry?.polygons?.flat() ?? [];
                  if (pts.length === 0) return section.geometry!.origin!.y - 18;
                  return Math.min(...pts.map((p) => p.y)) - 6;
                })()
              : section.geometry.origin.y;

            return (
              <text
                key={`label-${section.sectionId}`}
                x={section.geometry.origin.x}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#211C16"
                fillOpacity={1}
                style={{
                  fontSize: hasGlyphs ? 13 : 22,
                  fontWeight: 800,
                  letterSpacing: "0.03em",
                  textShadow: "0 1px 4px rgba(253,250,243,0.7)",
                }}
              >
                {section.label}
              </text>
            );
          })}

          {/* ── Individual seat glyphs (real or fallback-derived) ───── */}
          {hasGlyphs &&
            effectiveGlyphs.map((glyph) => {
              const status = seatStatusMap.get(glyph.seatId);
              const isSelectedSeat = effectiveSelectedSeatIds.has(glyph.seatId);
              const isAvailable = !status || status === "AVAILABLE";
              const isTooltipTarget = tooltip?.seatId === glyph.seatId;
              const sectionIdx = sectionIndexMap.get(glyph.sectionId) ?? 0;
              const section = layout.sections[sectionIdx];
              const sectionColor = section
                ? getSectionColor(section, sectionIdx)
                : SECTION_COLORS[0]!;
              const ariaLabel = String(
                isSelectedSeat
                  ? t("checkout.seatAriaSelected", { label: glyph.label })
                  : isAvailable
                    ? t("checkout.seatAriaAvailable", { label: glyph.label })
                    : t("checkout.seatAriaUnavailable", { label: glyph.label }),
              );

              return (
                <SeatNode
                  key={glyph.seatId}
                  glyph={glyph}
                  isSelected={isSelectedSeat}
                  isAvailable={isAvailable}
                  isTooltipTarget={isTooltipTarget}
                  defaultRadius={defaultRadius}
                  scale={labelScale}
                  maxFullLabelLen={maxFullLabelLen}
                  maxDigitsLabelLen={maxDigitsLabelLen}
                  sectionColor={sectionColor}
                  disabled={disabled}
                  ariaLabel={ariaLabel}
                  onInteract={handleSeatInteraction}
                  onHover={handleSeatHover}
                  onHoverEnd={handleSeatHoverEnd}
                  onArrowNav={handleArrowNav}
                />
              );
            })}

          {/* Fallback when no geometry and no glyphs: section dots in a row */}
          {!hasGlyphs &&
            !layout.sections.some((s) => s.geometry?.polygons?.length) && (
              <g>
                {layout.sections.map((section, idx) => (
                  <g key={section.sectionId}>
                    <circle
                      cx={minX + (idx + 0.5) * (width / layout.sections.length)}
                      cy={(minY + maxY) / 2}
                      r={Math.min(width, height) * 0.08}
                      fill={getSectionColor(section, idx)}
                      fillOpacity={0.2}
                      stroke={getSectionColor(section, idx)}
                      strokeOpacity={0.5}
                      strokeWidth={1}
                    />
                    <text
                      x={minX + (idx + 0.5) * (width / layout.sections.length)}
                      y={(minY + maxY) / 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#211C16"
                      fillOpacity={1}
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        textShadow: "0 1px 3px rgba(253,250,243,0.6)",
                      }}
                    >
                      {section.label}
                    </text>
                  </g>
                ))}
              </g>
            )}
        </g>
      </svg>
    </div>
  );
};

// ── Seat list view (tabular alternative to the visual map) ─────────────────

type SeatListViewProps = {
  layout: PlaceLayout;
  seatAvailability: SeatAvailability[];
  allSelectedSeatIds: Set<string>;
  seatStatusMap: Map<string, SeatAvailability["status"]>;
  sectionTicketMap: Map<string, TicketTypeForSection>;
  layoutToDbSectionId: Map<string, string>;
  onSeatToggle?: (seatId: string, sectionId: string) => void;
  disabled?: boolean;
  formatPrice?: (cents: number) => string;
};

const SeatListView = ({
  layout,
  seatAvailability,
  allSelectedSeatIds,
  seatStatusMap,
  sectionTicketMap,
  layoutToDbSectionId,
  onSeatToggle,
  disabled = false,
  formatPrice,
}: SeatListViewProps) => {
  const t = useTranslations();
  // Reverse map: DB seatSectionId → layout sectionId
  const dbToLayoutSectionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [layoutId, dbId] of layoutToDbSectionId) {
      map.set(dbId, layoutId);
    }
    return map;
  }, [layoutToDbSectionId]);

  // Group seats by section
  const seatsBySection = useMemo(() => {
    const groups = new Map<string, SeatAvailability[]>();
    for (const seat of seatAvailability) {
      const arr = groups.get(seat.seatSectionId) ?? [];
      arr.push(seat);
      groups.set(seat.seatSectionId, arr);
    }
    // Sort each group by row then number
    for (const [, seats] of groups) {
      seats.sort((a, b) => {
        if (a.row !== b.row) return (a.row ?? "").localeCompare(b.row ?? "");
        return (a.number ?? 0) - (b.number ?? 0);
      });
    }
    return groups;
  }, [seatAvailability]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {layout.sections.map((section, idx) => {
        const dbSectionId = layoutToDbSectionId.get(section.sectionId);
        if (!dbSectionId) return null;
        const seats = seatsBySection.get(dbSectionId);
        if (!seats || seats.length === 0) return null;
        const color = getSectionColor(section, idx);

        return (
          <div
            key={section.sectionId}
            style={{
              borderRadius: 0,
              border: `1px solid ${fgAlpha(8)}`,
              overflow: "hidden",
            }}
          >
            {/* Section header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                background: fgAlpha(3),
                borderBottom: `1px solid ${fgAlpha(6)}`,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  height: 10,
                  width: 10,
                  borderRadius: 0,
                  backgroundColor: color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 14, fontWeight: 700, color: fg }}>
                {section.label}
              </span>
              <span
                style={{ fontSize: 13, color: fgAlpha(70), marginLeft: "auto" }}
              >
                {String(
                  t("common.available", {
                    count: seats.filter(
                      (s) =>
                        s.status === "AVAILABLE" ||
                        allSelectedSeatIds.has(s.id),
                    ).length,
                  }),
                )}
              </span>
            </div>

            {/* Seat rows */}
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {seats.map((seat) => {
                const isSelected = allSelectedSeatIds.has(seat.id);
                const isAvailable = seat.status === "AVAILABLE";
                const isClickable = (isAvailable || isSelected) && !disabled;

                return (
                  <button
                    key={seat.id}
                    type="button"
                    disabled={!isClickable}
                    onClick={() => {
                      if (!isClickable || !onSeatToggle) return;
                      onSeatToggle(seat.id, section.sectionId);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      padding: "8px 14px",
                      border: "none",
                      borderBottom: `1px solid ${fgAlpha(4)}`,
                      background: isSelected
                        ? "rgba(59,130,246,0.08)"
                        : "transparent",
                      cursor: isClickable ? "pointer" : "default",
                      opacity: !isAvailable && !isSelected ? 0.4 : 1,
                      textAlign: "left",
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Selection indicator */}
                    <span
                      style={{
                        display: "inline-block",
                        height: 16,
                        width: 16,
                        borderRadius: 0,
                        flexShrink: 0,
                        border: isSelected
                          ? "2px solid #3b82f6"
                          : isAvailable
                            ? `2px solid ${fgAlpha(25)}`
                            : `2px solid ${fgAlpha(10)}`,
                        background: isSelected ? "#3b82f6" : "transparent",
                        transition: "all 0.1s",
                      }}
                    />

                    {/* Seat label */}
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 500,
                        color: fg,
                        minWidth: 48,
                      }}
                    >
                      {seat.label}
                    </span>

                    {/* Row + number */}
                    {seat.row && (
                      <span style={{ fontSize: 13, color: fgAlpha(70) }}>
                        {String(
                          t("checkout.seatRowNumber", {
                            row: seat.row,
                            ...(seat.number != null
                              ? { number: seat.number }
                              : {}),
                          }),
                        )}
                      </span>
                    )}

                    {/* Per-seat price (override or section ticket-type price) */}
                    {formatPrice &&
                      (() => {
                        const tt = sectionTicketMap.get(
                          dbToLayoutSectionId.get(seat.seatSectionId) ?? "",
                        );
                        const adjustableLabel = adjustableSeatPriceLabel(
                          tt,
                          !!seat.priceOverride,
                          { formatPrice, t },
                        );
                        if (adjustableLabel) {
                          return (
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: fgAlpha(85),
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {adjustableLabel}
                            </span>
                          );
                        }
                        const cents =
                          seat.priceOverride?.priceCents ?? tt?.priceCents;
                        if (cents == null) return null;
                        const displayCents =
                          seat.priceOverride?.buyerTotalCents ??
                          (tt
                            ? getBuyerAllInDisplayCents(tt, cents)
                            : cents <= 0
                              ? 0
                              : null);
                        if (displayCents === null) {
                          return (
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: fgAlpha(70),
                              }}
                            >
                              {String(t("checkout.calculatingTotal"))}
                            </span>
                          );
                        }
                        return (
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: fgAlpha(85),
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {formatPrice(displayCents)}
                          </span>
                        );
                      })()}

                    {/* Status badge */}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 12,
                        fontWeight: 500,
                        color: isSelected
                          ? "#3b82f6"
                          : isAvailable
                            ? "#10b981"
                            : fgAlpha(60),
                      }}
                    >
                      {isSelected
                        ? String(t("checkout.legendSelected"))
                        : isAvailable
                          ? String(t("checkout.legendAvailable"))
                          : String(t("checkout.legendUnavailable"))}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
