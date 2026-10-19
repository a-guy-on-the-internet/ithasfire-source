"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { XStack, YStack } from "tamagui";

import { Button, Spinner, Text, useTranslations } from "@th/ui";
import { stubTheme } from "@th/ui/colors";

import {
  ACCENT,
  BORDER,
  FOREGROUND,
  MUTED,
  MUTED_TEXT,
  ON_STRUCTURE,
  STRUCTURAL,
} from "@/lib/design-tokens";

import { SeatPriceNotice } from "./SeatPriceNotice";
import {
  sectionPriceText,
  seatCheckboxLabel,
  seatRemarkText,
  seatStatusText,
  type SeatPriceTranslate,
} from "./seat-price-labels";
import {
  defaultSeatRadius,
  nextSeatInDirection,
  rectFromPoints,
  seatLabelFor,
  sectionColor,
  selectableSeatIdsIn,
  type MapSeat,
  type Point,
  type PublicPlaceLayout,
  type Rect,
} from "./seat-price-map-model";
import type { SeatPriceViewProps } from "./seat-price-views";
import { useSeatPriceMapData, type SeatPositions } from "./useSeatPriceMapData";

/**
 * The ink of a label on a SELECTED seat: dark in every theme, like the
 * board's `--seat-ink-fixed` and the buyer's map. A selected seat is the solid
 * section colour, which stays light-to-mid in both themes, so the theme's own
 * ink (near-white on Ember) would vanish on it. Available seats are a tint
 * over the page and keep the theme ink.
 */
const SEAT_INK_FIXED = stubTheme.color;

/**
 * The Map view: the event's seating map with every seat a button.
 *
 * Seat, stage, outline and tooltip treatment follow the buyer's map
 * (`SeatMapPicker`); the zoom buttons and legend follow the builder's
 * seating editor. A mouse drag draws a selection box; on touch, a drag pans
 * and two fingers zoom. Selection is the editor's, through `dispatch`.
 */
export function SeatPriceMap(props: SeatPriceViewProps) {
  const t = useTranslations();
  const data = useSeatPriceMapData(props.model);

  if (data.status === "loading") {
    return (
      <XStack
        gap="$2"
        alignItems="center"
        padding="$4"
        data-testid="seat-price-map-loading"
      >
        <Spinner size="sm" />
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.seatPricesMapLoading"))}
        </Text>
      </XStack>
    );
  }
  if (data.status === "noLayout" || data.status === "failed") {
    return (
      <SeatPriceNotice
        testId="seat-price-map-failed"
        title={String(t("admin.seatPricesMapFailedTitle"))}
        action={
          <XStack gap="$2" flexWrap="wrap">
            {data.status === "failed" ? (
              <Button variant="secondary" size="$2" onPress={data.retry}>
                {String(t("admin.seatPricesRetry"))}
              </Button>
            ) : null}
            {props.onShowList ? (
              <Button variant="secondary" size="$2" onPress={props.onShowList}>
                {String(t("admin.seatPricesMapShowList"))}
              </Button>
            ) : null}
          </XStack>
        }
      >
        {String(t("admin.seatPricesMapFailedBody"))}
      </SeatPriceNotice>
    );
  }
  return (
    <SeatPriceMapCanvas
      {...props}
      layout={data.layout}
      seats={data.seats}
      positions={data.positions}
      retryPositions={data.retryPositions}
    />
  );
}

SeatPriceMap.displayName = "SeatPriceMap";

// ── Canvas ─────────────────────────────────────────────────────────────────

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;
/** Movement (CSS px) before a press becomes a drag. */
const DRAG_SLOP_PX = 6;
/**
 * Below this map width the zoom buttons lie in a row along the bottom edge:
 * a 44px column down the side would cover a third of a phone-width map.
 */
const NARROW_MAP_PX = 480;
/** The selected and focus rings: this many screen px at any zoom. */
const RING_PX = 2;

type View = { zoom: number; x: number; y: number };
const FIT_VIEW: View = { zoom: 1, x: 0, y: 0 };

type Gesture =
  | {
      kind: "press";
      pointerType: string;
      startClient: Point;
      lastClient: Point;
      seatKey: string | null;
      shift: boolean;
    }
  | { kind: "pan"; lastClient: Point }
  | { kind: "marquee"; start: Point; end: Point; additive: boolean }
  | { kind: "pinch"; startDistance: number; startView: View; anchor: Point };

type CanvasProps = SeatPriceViewProps & {
  layout: PublicPlaceLayout;
  seats: MapSeat[];
  positions: SeatPositions;
  retryPositions: () => void;
};

function SeatPriceMapCanvas({
  model,
  selection,
  dispatch,
  formatCents,
  disabled,
  activeSectionId,
  onShowList,
  layout,
  seats,
  positions,
  retryPositions,
}: CanvasProps) {
  const t = useTranslations();
  const tr = t as SeatPriceTranslate;
  const hintId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // ── Geometry ────────────────────────────────────────────────────────
  const bounds = layout.seatIndexBounds;
  const worldWidth = bounds.maxX - bounds.minX || 1;
  const worldHeight = bounds.maxY - bounds.minY || 1;
  const pad = Math.max(worldWidth, worldHeight) * 0.08;
  const box = {
    x: bounds.minX - pad,
    y: bounds.minY - pad,
    width: worldWidth + pad * 2,
    height: worldHeight + pad * 2,
  };
  const radius = useMemo(
    () => defaultSeatRadius(bounds, seats.length),
    [bounds, seats.length],
  );
  const labelLengths = useMemo(() => {
    let full = 1;
    let digits = 1;
    for (const { glyph } of seats) {
      full = Math.max(full, glyph.label.length);
      digits = Math.max(
        digits,
        (glyph.label.match(/\d+$/)?.[0] ?? glyph.label.slice(-2)).length,
      );
    }
    return { full, digits };
  }, [seats]);
  const layoutSectionsById = useMemo(
    () => new Map(layout.sections.map((s) => [s.sectionId, { s }])),
    [layout.sections],
  );

  // ── View (pan / zoom) ───────────────────────────────────────────────
  const [view, setView] = useState<View>(FIT_VIEW);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // CSS px per world unit at zoom 1, for label sizing.
  const [pxPerUnit, setPxPerUnit] = useState(1);
  const [mapWidth, setMapWidth] = useState(0);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0) {
        setPxPerUnit(Math.min(rect.width / box.width, rect.height / box.height));
        setMapWidth(rect.width);
      }
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [box.width, box.height]);

  /** Client px → viewBox units. */
  const toViewBox = useCallback((client: Point): Point | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(client.x, client.y).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);
  const toWorld = useCallback(
    (client: Point): Point | null => {
      const p = toViewBox(client);
      if (!p) return null;
      const v = viewRef.current;
      return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
    },
    [toViewBox],
  );
  const zoomAbout = useCallback((anchor: Point, factor: number, from?: View) => {
    setView((current) => {
      const base = from ?? current;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base.zoom * factor));
      if (zoom === MIN_ZOOM) return FIT_VIEW;
      const ratio = zoom / base.zoom;
      return {
        zoom,
        x: anchor.x - (anchor.x - base.x) * ratio,
        y: anchor.y - (anchor.y - base.y) * ratio,
      };
    });
  }, []);
  const centre = useMemo(
    () => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }),
    [box.x, box.y, box.width, box.height],
  );

  // Ctrl/Cmd + wheel (and a trackpad pinch) zooms; a plain wheel pans a
  // zoomed map and otherwise scrolls the page as usual.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const handleWheel = (event: WheelEvent) => {
      const anchor = toViewBox({ x: event.clientX, y: event.clientY });
      if (!anchor) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAbout(anchor, Math.exp(-event.deltaY * 0.01));
        return;
      }
      if (viewRef.current.zoom <= MIN_ZOOM) return;
      event.preventDefault();
      const ctm = svg.getScreenCTM();
      const perPx = ctm ? 1 / ctm.a : 1;
      setView((v) => ({
        ...v,
        x: v.x - event.deltaX * perPx,
        y: v.y - event.deltaY * perPx,
      }));
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [toViewBox, zoomAbout]);

  // The sidebar's section list points the map at that section.
  useEffect(() => {
    if (!activeSectionId) return;
    // A section of another layout has no outline on this map.
    const section = model.sectionsById.get(activeSectionId);
    if (section?.placeLayoutId !== layout.id) return;
    const layoutSectionId = section.layoutSectionId;
    const points =
      (layoutSectionId &&
        layoutSectionsById.get(layoutSectionId)?.s.geometry?.polygons?.flat()) ||
      seats
        .filter((s) => s.section?.id === activeSectionId)
        .map((s) => s.glyph.position);
    if (!points || points.length === 0) return;
    const r = boundsOf(points);
    const w = Math.max(r.maxX - r.minX, radius * 4);
    const h = Math.max(r.maxY - r.minY, radius * 4);
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(box.width / w, box.height / h) * 0.8),
    );
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    setView(
      zoom === MIN_ZOOM
        ? FIT_VIEW
        : { zoom, x: centre.x - cx * zoom, y: centre.y - cy * zoom },
    );
    // Runs when the sidebar points somewhere new, not on every layout change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSectionId]);

  // ── Pointer gestures ────────────────────────────────────────────────
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const [marquee, setMarquee] = useState<Extract<Gesture, { kind: "marquee" }> | null>(
    null,
  );
  const [panning, setPanning] = useState(false);

  const seatsByKey = useMemo(
    () => new Map(seats.map((seat) => [seat.key, seat])),
    [seats],
  );
  const mapSelectableIds = useMemo(
    () => seats.flatMap((s) => (s.seat?.selectable ? [s.seat.id] : [])),
    [seats],
  );

  const toggleSeat = useCallback(
    (key: string) => {
      const seat = seatsByKey.get(key)?.seat;
      if (disabled || !seat?.selectable) return;
      dispatch({ type: "toggleSeat", seatId: seat.id });
    },
    [disabled, dispatch, seatsByKey],
  );

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const client = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, client);
    try {
      // Keeps a drag that leaves the map ours until the button is released.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not a live pointer (a synthetic event): the drag simply is not captured.
    }
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()] as [Point, Point];
      const mid = toViewBox({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      gestureRef.current = mid
        ? {
            kind: "pinch",
            startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            startView: viewRef.current,
            anchor: mid,
          }
        : null;
      setMarquee(null);
      return;
    }
    const target = event.target as Element;
    gestureRef.current = {
      kind: "press",
      pointerType: event.pointerType,
      startClient: client,
      lastClient: client,
      seatKey: target.closest("[data-map-seat]")?.getAttribute("data-map-seat") ?? null,
      shift: event.shiftKey,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const client = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, client);
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === "pinch") {
      const [a, b] = [...pointersRef.current.values()] as [Point, Point];
      if (!a || !b) return;
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / gesture.startDistance;
      zoomAbout(gesture.anchor, factor, gesture.startView);
      return;
    }
    if (gesture.kind === "press") {
      const moved = Math.hypot(
        client.x - gesture.startClient.x,
        client.y - gesture.startClient.y,
      );
      if (moved < DRAG_SLOP_PX) return;
      if (gesture.pointerType === "mouse") {
        const start = toWorld(gesture.startClient);
        const end = toWorld(client);
        if (!start || !end) return;
        const next = { kind: "marquee", start, end, additive: gesture.shift } as const;
        gestureRef.current = next;
        setMarquee(next);
      } else {
        gestureRef.current = { kind: "pan", lastClient: gesture.startClient };
        setPanning(true);
      }
    }
    const current = gestureRef.current;
    if (current?.kind === "pan") {
      const ctm = svgRef.current?.getScreenCTM();
      const perPx = ctm ? 1 / ctm.a : 1;
      const dx = (client.x - current.lastClient.x) * perPx;
      const dy = (client.y - current.lastClient.y) * perPx;
      current.lastClient = client;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (current?.kind === "marquee") {
      const end = toWorld(client);
      if (!end) return;
      const next = { ...current, end };
      gestureRef.current = next;
      setMarquee(next);
    }
  };

  const endPointer = (event: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
    if (!pointersRef.current.delete(event.pointerId)) return;
    const gesture = gestureRef.current;
    if (pointersRef.current.size > 0) {
      // One finger of a pinch lifted: wait for the other, select nothing.
      if (gesture?.kind === "pinch") gestureRef.current = null;
      return;
    }
    gestureRef.current = null;
    setPanning(false);
    setMarquee(null);
    if (cancelled || !gesture) return;
    if (gesture.kind === "press" && gesture.seatKey) {
      toggleSeat(gesture.seatKey);
    } else if (gesture.kind === "marquee" && !disabled) {
      // The box ends where the button is released, not at the last move.
      const end = toWorld({ x: event.clientX, y: event.clientY }) ?? gesture.end;
      const inside = selectableSeatIdsIn(seats, rectFromPoints(gesture.start, end));
      dispatch({
        type: "replaceWithin",
        // Shift adds to the selection; a plain drag replaces the map's part.
        scopeIds: gesture.additive ? inside : mapSelectableIds,
        next: new Set(inside),
      });
    }
  };

  // While a box is being drawn, the seats inside show as selected.
  const marqueeIds = useMemo(
    () =>
      marquee
        ? new Set(selectableSeatIdsIn(seats, rectFromPoints(marquee.start, marquee.end)))
        : null,
    [marquee, seats],
  );
  const isShownSelected = (seatId: string) =>
    marqueeIds
      ? marqueeIds.has(seatId) || (marquee!.additive && selection.has(seatId))
      : selection.has(seatId);

  // ── Focus, keys and the tooltip ─────────────────────────────────────
  // Only the event's own seats are stops; a glyph with no seat is scenery.
  const firstKey = useMemo(
    () =>
      (seats.find((s) => s.seat?.selectable) ?? seats.find((s) => s.seat))?.key ??
      null,
    [seats],
  );
  const [rovingKey, setRovingKey] = useState<string | null>(null);
  const tabKey =
    rovingKey && seatsByKey.get(rovingKey)?.seat ? rovingKey : firstKey;
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // The focus ring is for the keyboard: a click focuses the seat too, and
  // that must not leave a ring behind.
  const [ringKey, setRingKey] = useState<string | null>(null);
  const tipKey = hoverKey ?? focusKey;

  const focusSeat = useCallback((key: string) => {
    const svg = svgRef.current;
    const node = svg?.querySelector<SVGGElement>(
      `[data-map-seat="${CSS.escape(key)}"]`,
    );
    node?.focus();
  }, []);

  // A seat reached by keyboard outside the zoomed view is brought into it.
  const keepInView = useCallback(
    (seat: MapSeat) => {
      const v = viewRef.current;
      const sx = seat.glyph.position.x * v.zoom + v.x;
      const sy = seat.glyph.position.y * v.zoom + v.y;
      const inside =
        sx > box.x && sx < box.x + box.width && sy > box.y && sy < box.y + box.height;
      if (inside) return;
      setView({
        ...v,
        x: centre.x - seat.glyph.position.x * v.zoom,
        y: centre.y - seat.glyph.position.y * v.zoom,
      });
    },
    [box.height, box.width, box.x, box.y, centre.x, centre.y],
  );

  const seatKeyDown = (event: ReactKeyboardEvent<SVGGElement>) => {
    const key = event.currentTarget.getAttribute("data-map-seat");
    const from = key ? seatsByKey.get(key) : undefined;
    if (!from) return;
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const next = nextSeatInDirection(seats, from, event.key);
      if (next) {
        keepInView(next);
        focusSeat(next.key);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSeat(from.key);
    }
  };
  // Every seat gets the SAME handler, so a pan, hover or box frame does not
  // re-render all of them through `memo`. It reads this render's values
  // through a ref.
  const seatKeyDownRef = useRef(seatKeyDown);
  useLayoutEffect(() => {
    seatKeyDownRef.current = seatKeyDown;
  });
  const handleSeatKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGGElement>) => seatKeyDownRef.current(event),
    [],
  );
  const handleSeatFocus = useCallback((key: string, keyboard: boolean) => {
    setRovingKey(key);
    setFocusKey(key);
    setRingKey(keyboard ? key : null);
  }, []);
  const handleSeatBlur = useCallback(() => {
    setFocusKey(null);
    setRingKey(null);
  }, []);

  // ── Words ───────────────────────────────────────────────────────────
  const describe = useCallback(
    (mapSeat: MapSeat) => {
      const { seat, section, glyph } = mapSeat;
      const sectionName =
        section?.name ?? layoutSectionsById.get(glyph.sectionId)?.s.label ?? "";
      const label = seat?.label ?? glyph.label;
      const price = seat?.customPrice
        ? formatCents(seat.customPrice.priceCents)
        : section
          ? sectionPriceText(section, formatCents, tr)
          : null;
      const name = price
        ? String(t("admin.seatPricesMapSeatAria", { section: sectionName, seat: label, price }))
        : seatCheckboxLabel(sectionName, label, tr);
      // A seat that cannot change says what it is, then why: "Sold. Price stays."
      const locked = seat && (seat.status === "SOLD" || seat.status === "HELD");
      const remarks = [
        seat?.customPrice ? String(t("admin.seatPricesMapSeatCustom")) : null,
        locked ? seatStatusText(seat.status, tr) : null,
        seat ? seatRemarkText(seat, tr) : String(t("admin.seatPricesMapSeatOffEvent")),
      ].filter((part): part is string => Boolean(part));
      return { sectionName, label, price, name, remarks };
    },
    [formatCents, layoutSectionsById, t, tr],
  );
  // One name per seat, worked out when the seats or the words change, not on
  // every hover, pan or zoom.
  const ariaLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const mapSeat of seats) {
      if (!mapSeat.seat) continue;
      const words = describe(mapSeat);
      labels.set(mapSeat.key, [words.name, ...words.remarks].join(". "));
    }
    return labels;
  }, [describe, seats]);

  const coarse = useCoarsePointer();
  const narrow = mapWidth > 0 && mapWidth < NARROW_MAP_PX;
  const labelZoom = Math.round(view.zoom * pxPerUnit * 4) / 4;

  const tipSeat = tipKey ? seatsByKey.get(tipKey) : undefined;
  const tip = tipSeat ? describe(tipSeat) : null;
  const tipPosition = tipSeat
    ? tooltipPosition(tipSeat, view, box, svgRef.current, frameRef.current, radius)
    : null;

  // ── Render ──────────────────────────────────────────────────────────
  const legendColor = sectionColor(layout.sections[0]) ?? MUTED_TEXT;

  return (
    <YStack
      borderWidth={1}
      borderColor="$borderColor"
      data-testid="seat-price-map"
    >
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        borderBottomWidth={1}
        borderBottomColor="$borderColor"
        backgroundColor="$surface"
      >
        {/* Stacks do not shrink by default: without this the hint sets the
            map's width. */}
        <YStack gap="$1" flex={1} minWidth={0}>
          <Text variant="caption" tone="muted" id={hintId}>
            {String(
              t(coarse ? "admin.seatPricesMapHintTouch" : "admin.seatPricesMapHintMouse"),
            )}{" "}
            {/* The keys are for a keyboard: on a phone only a screen reader
                hears them. */}
            <span style={coarse ? visuallyHiddenStyle : undefined}>
              {String(t("admin.seatPricesMapHintKeys"))}
            </span>
          </Text>
          {positions === "none" ? (
            <Text
              variant="caption"
              tone="muted"
              data-testid="seat-price-map-approximate"
            >
              {String(t("admin.seatPricesMapApproximate"))}
            </Text>
          ) : null}
        </YStack>
      </XStack>

      {positions === "failed" ? (
        <SeatPriceNotice
          testId="seat-price-map-positions-failed"
          title={String(t("admin.seatPricesMapPositionsFailedTitle"))}
          action={
            <XStack gap="$2" flexWrap="wrap">
              <Button variant="secondary" size="$2" onPress={retryPositions}>
                {String(t("admin.seatPricesRetry"))}
              </Button>
              {onShowList ? (
                <Button variant="secondary" size="$2" onPress={onShowList}>
                  {String(t("admin.seatPricesMapShowList"))}
                </Button>
              ) : null}
            </XStack>
          }
        >
          {String(t("admin.seatPricesMapPositionsFailedBody"))}
        </SeatPriceNotice>
      ) : null}

      <div ref={frameRef} style={frameStyle}>
        <svg
          ref={svgRef}
          viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
          role="group"
          aria-label={String(t("admin.seatPricesMapLabel"))}
          aria-describedby={hintId}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(e) => endPointer(e, false)}
          onPointerCancel={(e) => endPointer(e, true)}
          onPointerLeave={() => setHoverKey(null)}
          style={{
            ...svgStyle,
            aspectRatio: `${box.width} / ${box.height}`,
            cursor: panning ? "grabbing" : coarse ? "grab" : "crosshair",
          }}
          data-testid="seat-price-map-canvas"
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            {layout.stage ? (
              <g aria-hidden>
                <rect
                  x={layout.stage.bounds.minX}
                  y={layout.stage.bounds.minY}
                  width={layout.stage.bounds.maxX - layout.stage.bounds.minX}
                  height={layout.stage.bounds.maxY - layout.stage.bounds.minY}
                  rx={4}
                  fill={FOREGROUND}
                  fillOpacity={0.06}
                  stroke={FOREGROUND}
                  strokeOpacity={0.15}
                  strokeWidth={1}
                />
                {layout.stage.label ? (
                  <text
                    x={(layout.stage.bounds.minX + layout.stage.bounds.maxX) / 2}
                    y={(layout.stage.bounds.minY + layout.stage.bounds.maxY) / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={FOREGROUND}
                    fillOpacity={0.65}
                    style={stageLabelStyle}
                  >
                    {layout.stage.label}
                  </text>
                ) : null}
              </g>
            ) : null}

            {layout.sections.map((section) =>
              (section.geometry?.polygons ?? []).map((polygon, pIndex) => {
                const color = sectionColor(section) ?? MUTED_TEXT;
                // The public layout read carries no smoothing, so outlines
                // are drawn as stored (the buyer map's tessellation is a no-op).
                const points = polygon.map((p) => `${p.x},${p.y}`).join(" ");
                return (
                  <polygon
                    key={`${section.sectionId}-${pIndex}`}
                    aria-hidden
                    points={points}
                    fill={color}
                    fillOpacity={0.06}
                    stroke={color}
                    strokeOpacity={0.35}
                    strokeWidth={0.8}
                  />
                );
              }),
            )}

            {layout.sections.map((section) => {
              const origin = section.geometry?.origin;
              if (!origin) return null;
              const pts = section.geometry?.polygons?.flat() ?? [];
              const y =
                pts.length > 0 ? Math.min(...pts.map((p) => p.y)) - 6 : origin.y - 18;
              return (
                <text
                  key={`label-${section.sectionId}`}
                  aria-hidden
                  x={origin.x}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={FOREGROUND}
                  style={sectionLabelStyle}
                >
                  {section.label}
                </text>
              );
            })}

            {seats.map((mapSeat) => {
              const { seat, glyph } = mapSeat;
              const selectable = Boolean(seat?.selectable) && !disabled;
              const selected = seat ? isShownSelected(seat.id) : false;
              const entry = layoutSectionsById.get(glyph.sectionId);
              const r = glyph.radius ?? radius;
              const label = seatLabelFor(glyph.label, r, labelZoom, labelLengths);
              return (
                <SeatGlyphNode
                  key={mapSeat.key}
                  seatKey={mapSeat.key}
                  x={glyph.position.x}
                  y={glyph.position.y}
                  r={r}
                  color={sectionColor(entry?.s) ?? MUTED_TEXT}
                  state={
                    !seat
                      ? "offEvent"
                      : !seat.selectable
                        ? "locked"
                        : selected
                          ? "selected"
                          : "available"
                  }
                  custom={Boolean(seat?.customPrice || seat?.priceUnreadable)}
                  emphasised={tipKey === mapSeat.key}
                  focusRing={ringKey === mapSeat.key}
                  labelText={label.text}
                  labelSize={label.fontSize}
                  tabIndex={mapSeat.key === tabKey ? 0 : -1}
                  ariaLabel={ariaLabels.get(mapSeat.key) ?? ""}
                  pressed={seat?.selectable ? selected : undefined}
                  ariaDisabled={!selectable}
                  onKeyDown={handleSeatKeyDown}
                  onFocusSeat={handleSeatFocus}
                  onBlurSeat={handleSeatBlur}
                  onHoverSeat={setHoverKey}
                />
              );
            })}

            {marquee ? (
              <rect
                aria-hidden
                data-testid="seat-price-map-marquee"
                x={Math.min(marquee.start.x, marquee.end.x)}
                y={Math.min(marquee.start.y, marquee.end.y)}
                width={Math.abs(marquee.end.x - marquee.start.x)}
                height={Math.abs(marquee.end.y - marquee.start.y)}
                fill={FOREGROUND}
                fillOpacity={0.06}
                stroke={FOREGROUND}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </g>
        </svg>

        <XStack
          position="absolute"
          right={8}
          {...(narrow
            ? { bottom: 8, flexDirection: "row" as const }
            : { top: 8, flexDirection: "column" as const })}
          borderWidth={1}
          borderColor="$borderColorSoft"
          backgroundColor="$surface"
          data-testid="seat-price-map-zoom"
        >
          {(
            [
              ["in", <Plus key="i" size={18} aria-hidden />, "checkout.zoomIn", () => zoomAbout(centre, ZOOM_STEP)],
              ["out", <Minus key="o" size={18} aria-hidden />, "checkout.zoomOut", () => zoomAbout(centre, 1 / ZOOM_STEP)],
              ["fit", <Maximize2 key="f" size={16} aria-hidden />, "checkout.zoomReset", () => setView(FIT_VIEW)],
            ] as const
          ).map(([key, icon, labelKey, action], index) => (
            <button
              key={key}
              type="button"
              onClick={action}
              aria-label={String(t(labelKey))}
              title={String(t(labelKey))}
              data-testid={`seat-price-map-zoom-${key}`}
              style={{
                ...zoomButtonStyle,
                // Both sides always set: React warns when a side is dropped
                // next to the `border` shorthand.
                borderTop: index > 0 && !narrow ? `1px solid ${BORDER}` : "none",
                borderLeft: index > 0 && narrow ? `1px solid ${BORDER}` : "none",
              }}
            >
              {icon}
            </button>
          ))}
        </XStack>

        {tip && tipPosition ? (
          <div
            role="tooltip"
            data-testid="seat-price-map-tooltip"
            style={{ ...tooltipStyle, left: tipPosition.left, top: tipPosition.top }}
          >
            <strong>{tip.label}</strong>
            <span>{tip.sectionName}</span>
            {tip.price ? <strong>{tip.price}</strong> : null}
            {tip.remarks.length > 0 ? <span>{tip.remarks.join(". ")}</span> : null}
          </div>
        ) : null}
      </div>

      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        columnGap="$4"
        rowGap="$2"
        flexWrap="wrap"
        borderTopWidth={1}
        borderTopColor="$borderColor"
        backgroundColor="$surface"
        data-testid="seat-price-map-legend"
      >
        <LegendItem label={String(t("admin.seatPricesMapLegendAvailable"))}>
          <circle cx={8} cy={8} r={5.5} fill={legendColor} fillOpacity={0.55} stroke={legendColor} />
        </LegendItem>
        <LegendItem label={String(t("admin.seatPricesMapLegendSelected"))}>
          <circle cx={8} cy={8} r={5.5} fill={legendColor} stroke={FOREGROUND} strokeWidth={RING_PX} />
        </LegendItem>
        <LegendItem label={String(t("admin.seatPricesMapLegendCustom"))}>
          <circle cx={8} cy={8} r={4.5} fill={legendColor} fillOpacity={0.55} />
          <circle cx={8} cy={8} r={6.8} fill="none" stroke={ACCENT} strokeWidth={1.6} />
        </LegendItem>
        <LegendItem label={String(t("admin.seatPricesMapLegendLocked"))}>
          <circle cx={8} cy={8} r={5.5} fill={FOREGROUND} fillOpacity={0.12} stroke={FOREGROUND} strokeOpacity={0.2} />
        </LegendItem>
      </XStack>
    </YStack>
  );
}

// ── Seat ───────────────────────────────────────────────────────────────────

type SeatState = "available" | "selected" | "locked" | "offEvent";

type SeatGlyphNodeProps = {
  seatKey: string;
  x: number;
  y: number;
  r: number;
  color: string;
  state: SeatState;
  custom: boolean;
  /** Hovered, or focused: drawn a little larger. */
  emphasised: boolean;
  /** Reached by keyboard: a solid ring. */
  focusRing: boolean;
  labelText: string;
  labelSize: number;
  tabIndex: number;
  ariaLabel: string;
  pressed: boolean | undefined;
  ariaDisabled: boolean;
  onKeyDown: (event: ReactKeyboardEvent<SVGGElement>) => void;
  onFocusSeat: (key: string, keyboard: boolean) => void;
  onBlurSeat: () => void;
  onHoverSeat: (key: string | null) => void;
};

const SEAT_PAINT: Record<
  Exclude<SeatState, "offEvent">,
  (color: string) => {
    fill: string;
    fillOpacity: number;
    stroke: string;
    strokeOpacity: number;
  }
> = {
  locked: () => ({
    fill: FOREGROUND,
    fillOpacity: 0.12,
    stroke: FOREGROUND,
    strokeOpacity: 0.18,
  }),
  selected: (color) => ({ fill: color, fillOpacity: 1, stroke: FOREGROUND, strokeOpacity: 1 }),
  available: (color) => ({ fill: color, fillOpacity: 0.55, stroke: color, strokeOpacity: 0.9 }),
};

const SeatGlyphNode = memo(function SeatGlyphNode({
  seatKey,
  x,
  y,
  r,
  color,
  state,
  custom,
  emphasised,
  focusRing,
  labelText,
  labelSize,
  tabIndex,
  ariaLabel,
  pressed,
  ariaDisabled,
  onKeyDown,
  onFocusSeat,
  onBlurSeat,
  onHoverSeat,
}: SeatGlyphNodeProps) {
  // A glyph with no seat of this event: an outline, not a control. It is not
  // "locked" (the legend's word for sold or in a cart), so it is not filled.
  if (state === "offEvent") {
    return (
      <circle
        aria-hidden
        cx={x}
        cy={y}
        r={r}
        fill="none"
        stroke={FOREGROUND}
        strokeOpacity={0.3}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: "none" }}
      />
    );
  }
  const drawn = emphasised || focusRing ? r * 1.2 : r;
  const selected = state === "selected";
  const customRing = drawn + r * 0.32;
  return (
    <g
      data-map-seat={seatKey}
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      aria-disabled={ariaDisabled || undefined}
      onKeyDown={onKeyDown}
      onFocus={(event) => onFocusSeat(seatKey, isFocusVisible(event.currentTarget))}
      onBlur={onBlurSeat}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") onHoverSeat(seatKey);
      }}
      onPointerLeave={() => onHoverSeat(null)}
      style={{ cursor: state === "locked" ? "not-allowed" : "pointer", outline: "none" }}
    >
      <circle
        r={drawn}
        {...SEAT_PAINT[state](color)}
        // The selected ring is a fixed 2 screen px, so it reads at fit zoom
        // and does not swallow the seat at 8x.
        strokeWidth={selected ? RING_PX : r * 0.06}
        vectorEffect={selected ? "non-scaling-stroke" : undefined}
      />
      {custom ? (
        <circle r={customRing} fill="none" stroke={ACCENT} strokeWidth={r * 0.2} />
      ) : null}
      {focusRing ? (
        <circle
          data-testid="seat-price-map-focus-ring"
          r={(custom ? customRing : drawn) + r * 0.35}
          fill="none"
          stroke={FOREGROUND}
          strokeWidth={RING_PX}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {labelText ? (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fill={selected ? SEAT_INK_FIXED : FOREGROUND}
          fillOpacity={state === "locked" ? 0.55 : 1}
          style={{ fontSize: labelSize, fontWeight: 900, pointerEvents: "none" }}
        >
          {labelText}
        </text>
      ) : null}
    </g>
  );
});

/** `:focus-visible`, where the browser can say; otherwise treat as keyboard. */
function isFocusVisible(node: Element): boolean {
  try {
    return node.matches(":focus-visible");
  } catch {
    return true;
  }
}

function LegendItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <XStack gap={6} alignItems="center" flexShrink={1} minWidth={0}>
      <svg width={16} height={16} aria-hidden style={{ flexShrink: 0 }}>
        {children}
      </svg>
      <Text variant="caption" tone="muted" flexShrink={1}>
        {label}
      </Text>
    </XStack>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function boundsOf(points: readonly Point[]): Rect {
  return points.reduce<Rect>(
    (r, p) => ({
      minX: Math.min(r.minX, p.x),
      minY: Math.min(r.minY, p.y),
      maxX: Math.max(r.maxX, p.x),
      maxY: Math.max(r.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

/** Where the tooltip sits in the frame: above the seat, kept inside. */
function tooltipPosition(
  seat: MapSeat,
  view: View,
  box: { x: number; y: number; width: number; height: number },
  svg: SVGSVGElement | null,
  frame: HTMLDivElement | null,
  radius: number,
): { left: number; top: number } | null {
  if (!svg || !frame) return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const vx = seat.glyph.position.x * view.zoom + view.x;
  const vy = seat.glyph.position.y * view.zoom + view.y;
  if (vx < box.x || vx > box.x + box.width || vy < box.y || vy > box.y + box.height) {
    return null;
  }
  const client = new DOMPoint(vx, vy).matrixTransform(ctm);
  const frameRect = frame.getBoundingClientRect();
  const r = (seat.glyph.radius ?? radius) * view.zoom * ctm.a;
  const left = Math.min(
    Math.max(8, client.x - frameRect.left - 120),
    Math.max(8, frameRect.width - 248),
  );
  const above = client.y - frameRect.top - r - 12;
  return { left, top: above > 56 ? above - 48 : client.y - frameRect.top + r + 12 };
}

/** `(pointer: coarse)`: a finger, not a mouse. False until mounted. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return coarse;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const visuallyHiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

const frameStyle: CSSProperties = {
  position: "relative",
  background: MUTED,
  overflow: "hidden",
};

const svgStyle: CSSProperties = {
  display: "block",
  width: "100%",
  minHeight: 320,
  maxHeight: "70vh",
  touchAction: "none",
  userSelect: "none",
};

const stageLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: "0.03em",
};

const zoomButtonStyle: CSSProperties = {
  width: 44,
  height: 44,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  borderRight: "none",
  borderBottom: "none",
  borderRadius: 0,
  color: FOREGROUND,
  cursor: "pointer",
  padding: 0,
};

const tooltipStyle: CSSProperties = {
  position: "absolute",
  maxWidth: 240,
  display: "flex",
  flexWrap: "wrap",
  columnGap: 8,
  rowGap: 2,
  padding: "6px 10px",
  background: STRUCTURAL,
  color: ON_STRUCTURE,
  fontSize: 13,
  lineHeight: "18px",
  pointerEvents: "none",
  zIndex: 2,
};
