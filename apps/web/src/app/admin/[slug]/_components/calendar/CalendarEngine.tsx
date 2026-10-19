"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Text } from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";

import { CalendarAgendaView } from "./CalendarAgendaView";
import { CalendarDayList } from "./CalendarDayList";
import { CalendarDotGrid } from "./CalendarDotGrid";
import { CalendarFilterChips } from "./CalendarFilterChips";
import { CalendarMonthView } from "./CalendarMonthView";
import { CalendarPeek } from "./CalendarPeek";
import { CalendarToolbar } from "./CalendarToolbar";
import { CalendarWeekView } from "./CalendarWeekView";
import {
  applyFilters,
  dayFromInstant,
  dayKey,
  formatRangeLabel,
  getAgendaDays,
  getMonthGrid,
  getMonthGridWeeks,
  getWeekDays,
  groupByDay,
  stepAnchor,
  zoneParts,
} from "./helpers";
import type { CalendarLabels } from "./labels";
import { CAL_BORDER_SOFT } from "./status-colors";
import type {
  CalendarDay,
  CalendarEventItem,
  CalendarFilterOptions,
  CalendarFilters,
  CalendarItem,
  CalendarMode,
  CalendarOverflowAction,
  CalendarPeekVariant,
  CalendarView,
  HoursWindow,
} from "./types";
import { CalendarLabelsProvider, useResolvedCalendarLabels } from "./use-calendar-labels";

import "./calendar.css";

const ALL_VIEWS: CalendarView[] = ["month", "week", "agenda"];

/**
 * Below this the engine paints its narrow layouts (dot grid + day list,
 * compact agenda rows, the collapsed filter menu) and drops the week option.
 * Measured on the ENGINE, not the window — see `useNarrowCalendar`.
 */
export const CALENDAR_NARROW_PX = 600;

/**
 * Below this the toolbar drops the timezone label entirely.
 *
 * The control cluster wants roughly `segmented control + zone + overflow` =
 * ~300px. Under that the zone is the only elastic part, so it takes the WHOLE
 * deficit: on the dashboard at a 390px viewport the engine's box is 272px and
 * "Chicago" (60px of text) rendered 1.53px wide — a sliver of the "C" sitting
 * against the overflow button, which read as stray punctuation rather than a
 * label. Truncating is the right behaviour while some of the word survives;
 * below that the label is better gone, and the segmented control and overflow
 * button then get their full size back. Measured on the ENGINE's box, whose
 * width comes from the page and not from this cluster — so hiding the label
 * cannot widen the box and flip the decision back.
 */
export const CALENDAR_TIGHT_PX = 420;

/**
 * True while the engine's own box is narrower than `CALENDAR_NARROW_PX`.
 *
 * The viewport is a LIAR here: the calendar sits inside the admin shell's
 * padding and (on desktop) a 256px rail, so a 1440px window can hand the
 * engine under 600px — and at 320px the shell's own chrome leaves it ~240px
 * while `matchMedia` is still the only thing anyone asked. Measuring the box
 * is what keeps the agenda's fixed 428px column set from painting into a
 * 240px slot and pushing the whole PAGE sideways.
 *
 * `useIsMobile` remains the fallback for SSR / first paint and for
 * environments without `ResizeObserver` (jsdom), so nothing changes before
 * the first measurement lands.
 */
function useNarrowCalendar(ref: RefObject<HTMLElement | null>): {
  narrow: boolean;
  tight: boolean;
} {
  const isMobile = useIsMobile();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  // 0 = never measured (SSR, jsdom, no ResizeObserver) — not "0px wide".
  const measured = width > 0;
  return {
    narrow: measured ? width < CALENDAR_NARROW_PX : isMobile,
    // `isMobile` is the WRONG fallback for this one: it is `viewport < 600`,
    // the NARROW threshold. Borrowing it makes every 420-600px box start out
    // tight and then un-tighten the moment the observer reports — the zone
    // label painting, vanishing and coming back within one commit. The label
    // present is the undegraded state, so stay un-tight until measured.
    tight: measured && width < CALENDAR_TIGHT_PX,
  };
}

export type CalendarItemPressMeta = {
  /** The view the chip was pressed in. */
  view: CalendarView;
  /** The pressed render (a midnight-crossing show has one per day it touches). */
  renderKey: string;
};

/** `false` / `{ openPeek: false }` = the mount owns this press; no peek. */
export type CalendarItemPressResult = void | boolean | { openPeek: boolean };

function suppressesPeek(result: CalendarItemPressResult): boolean {
  if (result === false) return true;
  return typeof result === "object" && result !== null && result.openPeek === false;
}

export type CalendarEngineProps = {
  /** internal = every status plus holds and the peek; public = PUBLISHED only, no chrome. */
  mode: CalendarMode;
  items: CalendarItem[];
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  /** Which views the SegmentedControl offers. Embed passes ["month", "week"]. */
  views?: CalendarView[];
  /** The month / week anchor (agenda rolls from it). */
  anchor: Date;
  onAnchorChange: (anchor: Date) => void;
  /**
   * The paint zone (IANA): venue zone on place / embed, browser zone on
   * dashboards. It must be SERVER-STABLE on the first render — the grid is
   * painted during SSR, so a mount that wants the browser's zone passes a
   * fixed zone (the venue's, or UTC) initially and resolves
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` in an effect. Today
   * affordances (wash, TODAY square, the label) wait for `now`, which is
   * null until the clock mounts, so none of them can drift across hydration.
   */
  timezone: string;
  /** The viewer's browser zone — drives the per-chip mismatch glyph. */
  viewerTimezone: string;
  /** Filters are internal-mode only; hidden entirely in public mode. */
  filters?: CalendarFilters;
  onFiltersChange?: (filters: CalendarFilters) => void;
  filterOptions?: CalendarFilterOptions;
  /** Week hours per visible day (positional with the Sunday-first week). */
  hoursWindow?: HoursWindow;
  /** Week footer caption, e.g. "Hours · Main Calendar · 5:00 PM – 2:00 AM · America/Chicago". */
  hoursCaption?: string;
  /** Fires when the reader toggles "Show all hours" (state lives in the engine). */
  onShowAllHours?: (showAll: boolean) => void;
  loading?: boolean;
  /** Internal only: empty day / slot → a draft (FR-019). */
  onCreateAt?: (date: Date, opts: { view: CalendarView }) => void;
  /**
   * Internal: fires on a chip press, BEFORE the peek decides. Return
   * `false` (or `{ openPeek: false }`) to take the press over — the engine
   * then opens no peek and closes any that is open, so a mount can put its
   * own dialog there instead (the place mount's Confirm / Not mine). Any
   * other return (`undefined`, `true`, `{ openPeek: true }`) toggles the
   * peek as before, so existing handlers need no change.
   */
  onItemPress?: (item: CalendarItem, meta: CalendarItemPressMeta) => CalendarItemPressResult;
  /** Public: the mount's own click behaviour (embed checkout); no peek ever opens. */
  onPublicItemPress?: (item: CalendarItem) => void;
  toolbarLeading?: ReactNode;
  /** The place mount injects its calendar selector here. */
  toolbarTrailing?: ReactNode;
  /** Off when the mount uses the timezone slot for something else. */
  showTimezoneLabel?: boolean;
  /** Overflow menu (webcal / export); omitted in public mode. */
  overflowActions?: CalendarOverflowAction[];
  /** Agenda: rolling window end and pagination (FR-009). */
  agendaPageEnd?: Date;
  onAgendaShowMore?: () => void;
  hasMoreAgenda?: boolean;
  peekVariant?: CalendarPeekVariant;
  onDownloadIcs?: (item: CalendarEventItem) => void;
  /** Clock injection for tests; defaults to the wall clock after mount. */
  now?: Date;
  /**
   * Empty-state copy, painted INSIDE the frame by whichever view is up —
   * agenda, month grid and week grid alike. The narrow month (dot grid + day
   * list) deliberately gets none: the day list already answers with "Nothing
   * on this day", and a second caption under it read as a contradiction.
   */
  emptyLabel?: string;
  /**
   * Copy overrides, merged over the catalog-resolved defaults
   * (`labels.ts`). The engine reads every existing `admin.ec*` key itself;
   * pass this for strings a mount wants to phrase differently.
   */
  labels?: Partial<CalendarLabels>;
};

const srOnly = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

type PeekState = {
  id: string;
  renderKey: string;
  /** The pressed chip itself — the peek positions against it IN PLACE. */
  anchorEl: HTMLElement | null;
};

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** A stable signature so a mount rebuilding its filter object per render cannot close the peek. */
function filtersKey(filters: CalendarFilters | undefined): string {
  if (!filters) return "";
  return [
    [...filters.statuses].sort().join(","),
    filters.owners ? [...filters.owners].sort().join(",") : "*",
    filters.seriesId ?? "all",
    filters.showHolds === false ? "noholds" : "holds",
  ].join("|");
}

/**
 * One calendar engine, two modes (FR-006). Takes normalized items and paints
 * them in `timezone`; the mounts own fetching, filter persistence and the
 * create / edit side effects. Below 600px the month becomes a dot grid with
 * the tapped day's list and the week option disappears (FR-010).
 */
export function CalendarEngine({
  mode,
  items,
  view,
  onViewChange,
  views = ALL_VIEWS,
  anchor,
  onAnchorChange,
  timezone,
  viewerTimezone,
  filters,
  onFiltersChange,
  filterOptions,
  hoursWindow,
  hoursCaption,
  onShowAllHours,
  loading = false,
  onCreateAt,
  onItemPress,
  onPublicItemPress,
  toolbarLeading,
  toolbarTrailing,
  showTimezoneLabel = true,
  overflowActions,
  agendaPageEnd,
  onAgendaShowMore,
  hasMoreAgenda = false,
  peekVariant = "dashboard",
  onDownloadIcs,
  now: nowProp,
  emptyLabel,
  labels: labelOverrides,
}: CalendarEngineProps) {
  const internal = mode === "internal";
  const labels = useResolvedCalendarLabels(labelOverrides);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // "narrow" = the ENGINE's box, not the window (see `useNarrowCalendar`).
  const { narrow, tight } = useNarrowCalendar(rootRef);

  // The now-line and every today affordance need a client clock; SSR paints
  // none (no hydration drift), so `todayKey` is null until the clock mounts.
  const [tick, setTick] = useState<Date | null>(null);
  useEffect(() => {
    if (nowProp) return;
    setTick(new Date());
    const id = window.setInterval(() => setTick(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [nowProp]);
  const now = nowProp ?? tick;
  const todayKey = now ? dayKey(now, timezone) : null;

  const [showAllHours, setShowAllHours] = useState(false);
  const [peek, setPeek] = useState<PeekState | null>(null);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [expandedDayKey, setExpandedDayKey] = useState<string | null>(null);

  const availableViews = useMemo(
    () => (narrow ? views.filter((v) => v !== "week") : views),
    [narrow, views],
  );
  // Week is hidden outright below 600px (FR-010) — the fallback to month is
  // PURELY VISUAL. It deliberately does not call `onViewChange`: the place
  // mount writes that straight back into `?view=`, so a phone-width visit
  // rewrote `?view=week` to `?view=month` and the reader lost the preference
  // on rotate and on the next desktop load. `data-view` already exposes the
  // effective view for anyone who needs it.
  const clampedByWidth = narrow && view === "week";
  const effectiveView: CalendarView = clampedByWidth
    ? "month"
    : views.includes(view)
      ? view
      : (views[0] ?? "month");
  useEffect(() => {
    // A view the MOUNT does not offer at all (a stale stored "day", an embed
    // that only serves month/week) IS a real mismatch — reconcile that one.
    if (!clampedByWidth && !views.includes(view)) onViewChange(views[0] ?? "month");
  }, [clampedByWidth, views, view, onViewChange]);

  const filtered = useMemo(() => applyFilters(items, filters, mode), [items, filters, mode]);

  // Navigating, switching view or filtering closes the peek (and the
  // expanded day list) — a dialog must never re-open on the way back.
  const anchorTime = anchor.getTime();
  const filterSignature = filtersKey(filters);
  useEffect(() => {
    setPeek(null);
    setExpandedDayKey(null);
  }, [anchorTime, effectiveView, filterSignature]);

  // The peek follows the LIVE item (a refetch swaps the objects) and drops
  // when its item leaves the painted set.
  const peekItem = useMemo(
    () => (peek ? (filtered.find((item) => item.id === peek.id) ?? null) : null),
    [filtered, peek],
  );
  useEffect(() => {
    if (peek && !peekItem) setPeek(null);
  }, [peek, peekItem]);

  const monthWeeks = useMemo(() => getMonthGridWeeks(anchor, timezone), [anchor, timezone]);
  const monthDays = useMemo(() => getMonthGrid(anchor, timezone), [anchor, timezone]);
  const weekDays = useMemo(() => getWeekDays(anchor, timezone), [anchor, timezone]);
  const agendaEnd = useMemo(
    () => agendaPageEnd ?? new Date(anchor.getTime() + 30 * 86_400_000),
    [agendaPageEnd, anchor],
  );
  const agendaDays = useMemo(
    () => getAgendaDays(anchor, agendaEnd, timezone),
    [anchor, agendaEnd, timezone],
  );
  const activeDays: CalendarDay[] =
    effectiveView === "month" ? monthDays : effectiveView === "week" ? weekDays : agendaDays;
  const itemsByDay = useMemo(() => groupByDay(filtered, activeDays), [filtered, activeDays]);
  const anchorMonth = zoneParts(anchor, timezone).month;

  const rangeLabel = formatRangeLabel(effectiveView, anchor, timezone, agendaEnd, labels);

  const closePeek = useCallback(() => setPeek(null), []);
  const handleItemPress = useCallback(
    (item: CalendarItem, anchorEl: HTMLButtonElement, renderKey: string) => {
      if (!internal) {
        onPublicItemPress?.(item);
        return;
      }
      const result = onItemPress?.(item, { view: effectiveView, renderKey });
      if (suppressesPeek(result)) {
        setPeek(null);
        return;
      }
      setPeek((current) =>
        current?.renderKey === renderKey ? null : { id: item.id, renderKey, anchorEl },
      );
    },
    [internal, effectiveView, onItemPress, onPublicItemPress],
  );

  const findChip = useCallback(
    (renderKey: string) =>
      rootRef.current?.querySelector<HTMLElement>(
        `[data-render-key="${cssEscape(renderKey)}"]`,
      ) ?? null,
    [],
  );

  // The chip is NOT re-parented into the peek, so the node captured on press
  // stays live. Re-resolve by render key if a re-render ever did replace it —
  // a dialog anchored to a detached node would land at the document origin,
  // which is the class of bug this whole path exists to avoid.
  useEffect(() => {
    if (!peek || peek.anchorEl?.isConnected) return;
    const el = findChip(peek.renderKey);
    setPeek((current) => (current === peek ? (el ? { ...current, anchorEl: el } : null) : current));
  }, [peek, filtered, findChip]);

  // Resolved at close time so focus lands on the live chip.
  const focusTarget = useCallback(
    () => (peek ? findChip(peek.renderKey) : null),
    [peek, findChip],
  );

  const peekRenderKey = peekItem ? (peek?.renderKey ?? null) : null;
  const hasPopup = internal;

  const createAt = onCreateAt && internal
    ? (date: Date) => onCreateAt(date, { view: effectiveView })
    : undefined;

  // "+N more" expands that day's list under the grid on every mount — never
  // a view switch, which on a past day would anchor the agenda in the past.
  const onShowMore = (day: CalendarDay) => {
    setExpandedDayKey((k) => (k === day.key ? null : day.key));
  };

  const toggleAllHours = () => {
    const next = !showAllHours;
    setShowAllHours(next);
    onShowAllHours?.(next);
  };

  const selectedDay: CalendarDay =
    monthDays.find((d) => d.key === selectedDayKey) ??
    (todayKey ? monthDays.find((d) => d.key === todayKey) : undefined) ??
    dayFromInstant(anchor, timezone);
  // "+N more" fires from the month grid AND from the week grid's capped
  // overlap slot, so the expanded day is looked up in whichever set is painted.
  const expandedDay = expandedDayKey
    ? activeDays.find((d) => d.key === expandedDayKey) ?? null
    : null;

  let body: ReactNode;
  if (effectiveView === "agenda") {
    const nextStart = new Date(agendaEnd.getTime() + 86_400_000);
    const nextEnd = new Date(agendaEnd.getTime() + 30 * 86_400_000);
    const nextLabel = formatRangeLabel("agenda", nextStart, timezone, nextEnd, labels);
    body = (
      <CalendarAgendaView
        days={agendaDays}
        todayKey={todayKey}
        itemsByDay={itemsByDay}
        timezone={timezone}
        viewerTimezone={viewerTimezone}
        mode={mode}
        onItemPress={handleItemPress}
        hasMore={hasMoreAgenda}
        onShowMore={onAgendaShowMore}
        nextPageLabel={nextLabel}
        compact={narrow}
        hasPopup={hasPopup}
        peekRenderKey={peekRenderKey}
        emptyLabel={emptyLabel}
      />
    );
  } else if (effectiveView === "week") {
    body = (
      <CalendarWeekView
        days={weekDays}
        todayKey={todayKey}
        now={now}
        items={filtered}
        timezone={timezone}
        viewerTimezone={viewerTimezone}
        mode={mode}
        hoursWindow={hoursWindow}
        showAllHours={showAllHours}
        onShowAllHours={toggleAllHours}
        hoursCaption={hoursCaption}
        onItemPress={handleItemPress}
        onCreateAt={createAt}
        onShowMore={onShowMore}
        hasPopup={hasPopup}
        peekRenderKey={peekRenderKey}
        emptyLabel={emptyLabel}
      />
    );
  } else if (narrow) {
    body = (
      <>
        <CalendarDotGrid
          weeks={monthWeeks}
          month={anchorMonth}
          todayKey={todayKey}
          selectedKey={selectedDay.key}
          onSelectDay={(day) => setSelectedDayKey(day.key)}
          itemsByDay={itemsByDay}
        />
        <CalendarDayList
          day={selectedDay}
          items={itemsByDay.get(selectedDay.key) ?? []}
          timezone={timezone}
          mode={mode}
          onItemPress={handleItemPress}
          onCreateAt={createAt}
          hasPopup={hasPopup}
          peekRenderKey={peekRenderKey}
        />
      </>
    );
  } else {
    body = (
      <CalendarMonthView
        weeks={monthWeeks}
        month={anchorMonth}
        todayKey={todayKey}
        itemsByDay={itemsByDay}
        timezone={timezone}
        viewerTimezone={viewerTimezone}
        mode={mode}
        onItemPress={handleItemPress}
        onCreateAt={createAt}
        onShowMore={onShowMore}
        hasPopup={hasPopup}
        peekRenderKey={peekRenderKey}
        emptyLabel={emptyLabel}
      />
    );
  }

  return (
    <CalendarLabelsProvider value={labels}>
      <div
        ref={rootRef}
        className="th-cal"
        data-testid="event-calendar"
        data-mode={mode}
        data-view={effectiveView}
      >
        <CalendarToolbar
          view={effectiveView}
          views={availableViews}
          onViewChange={onViewChange}
          rangeLabel={rangeLabel}
          showNav={effectiveView !== "agenda"}
          onPrev={() => onAnchorChange(stepAnchor(anchor, effectiveView, -1, timezone))}
          onNext={() => onAnchorChange(stepAnchor(anchor, effectiveView, 1, timezone))}
          onToday={() => onAnchorChange(now ?? new Date())}
          timezone={showTimezoneLabel && !tight ? timezone : undefined}
          overflowActions={internal ? overflowActions : undefined}
          leading={toolbarLeading}
          trailing={toolbarTrailing}
          narrow={narrow}
        />
        {internal && filters && onFiltersChange && (
          <CalendarFilterChips
            filters={filters}
            onChange={onFiltersChange}
            options={filterOptions ?? {}}
            narrow={narrow}
          />
        )}
        <div
          data-testid="calendar-views"
          aria-busy={loading}
          style={{ opacity: loading ? 0.6 : 1, transition: "opacity 150ms ease-out", minWidth: 0 }}
        >
          {/* Always mounted: a live region announces a text CHANGE, not its arrival. */}
          <span role="status" aria-live="polite" style={srOnly} data-testid="calendar-status">
            <Text variant="span">{loading ? labels.loading : ""}</Text>
          </span>
          {body}
          {expandedDay && (
            <div style={{ borderTop: `1px solid ${CAL_BORDER_SOFT}` }}>
              <CalendarDayList
                day={expandedDay}
                items={itemsByDay.get(expandedDay.key) ?? []}
                timezone={timezone}
                mode={mode}
                onItemPress={handleItemPress}
                onCreateAt={createAt}
                hasPopup={hasPopup}
                peekRenderKey={peekRenderKey}
              />
            </div>
          )}
        </div>
        {/*
          ONE peek for the whole engine, positioned against the pressed chip's
          own DOM node. Wrapping the chip instead (the Popover's `anchor` prop
          clones its child to take the Floating UI ref) unmounted and remounted
          that chip on every open.
        */}
        {internal && peekItem && (narrow || peek?.anchorEl) && (
          <CalendarPeek
            item={peekItem}
            anchorElement={peek?.anchorEl ?? null}
            open
            onClose={closePeek}
            variant={peekVariant}
            timezone={timezone}
            viewerTimezone={viewerTimezone}
            sheet={narrow}
            onDownloadIcs={onDownloadIcs}
            returnFocusTo={focusTarget}
          />
        )}
      </div>
    </CalendarLabelsProvider>
  );
}
