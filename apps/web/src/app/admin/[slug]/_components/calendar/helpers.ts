import {
  DEFAULT_CALENDAR_LABELS,
  DEFAULT_CALENDAR_NAMES,
  type CalendarLabels,
  type CalendarNames,
} from "./labels";
import type {
  CalendarDay,
  CalendarEventItem,
  CalendarFilters,
  CalendarHoldItem,
  CalendarItem,
  CalendarMode,
  CalendarView,
  HoursWindow,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the calendar engine. Everything that touches a clock takes
// the PAINT ZONE explicitly — the engine paints in the venue's zone on place /
// embed and in the browser's on dashboards (FR-018), so `Date#getHours()` is
// never the right question. No tRPC, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

export const MINUTES_PER_DAY = 1440;
/** Height of one hour row in the week view (same as the old `HOUR_HEIGHT`). */
export const HOUR_ROW_PX = 44;
/** Floor for the auto-fit hours window (FR-011): 09:00–24:00. */
export const HOURS_FLOOR_START = 9 * 60;
export const HOURS_FLOOR_END = 24 * 60;
/** Smallest painted block in the week view, in minutes. */
export const MIN_BLOCK_MINUTES = 30;
/** Month cells show this many chips before "+N more". */
export const MONTH_CHIP_LIMIT = 3;

/**
 * English day / month names. The views read the localised set from
 * `useCalendarLabels()`; these are the defaults the pure formatters fall back
 * to when a caller passes no `names`.
 */
export const WEEKDAY_SHORT = DEFAULT_CALENDAR_NAMES.weekdaysShort;
export const MONTH_SHORT = DEFAULT_CALENDAR_NAMES.monthsShort;
export const MONTH_LONG = DEFAULT_CALENDAR_NAMES.monthsLong;

// ── Zone arithmetic ──────────────────────────────────────────────────────────

export type ZoneParts = {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
};

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** An instant as wall-clock parts in `timeZone`. */
export function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false yields "24" for midnight in some ICU builds.
  const hour = Number(get("hour")) % 24;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** The zone's UTC offset at `instant`, in minutes (east positive). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/**
 * The instant at which `timeZone` reads the given wall-clock. Two passes so
 * a DST transition between the guess and the answer is corrected; inside a
 * spring-forward gap the later offset wins.
 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  const second = guess - zoneOffsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(second);
}

export function dayKeyFromParts(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `YYYY-MM-DD` of `instant` in the paint zone. */
export function dayKey(instant: Date, timeZone: string): string {
  const p = zoneParts(instant, timeZone);
  return dayKeyFromParts(p.year, p.month, p.day);
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

/** A painted day from calendar parts (month 1–12). */
export function makeDay(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): CalendarDay {
  // Normalise overflowing parts (day 0, day 32, month 13…) via UTC noon,
  // which no DST shift can move across a date line.
  const norm = new Date(Date.UTC(year, month - 1, day, 12));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth() + 1;
  const d = norm.getUTCDate();
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
  return {
    key: dayKeyFromParts(y, m, d),
    year: y,
    month: m,
    day: d,
    weekday: weekdayOf(y, m, d),
    start: zonedInstant(y, m, d, 0, 0, timeZone),
    end: zonedInstant(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      timeZone,
    ),
  };
}

export function dayFromInstant(instant: Date, timeZone: string): CalendarDay {
  const p = zoneParts(instant, timeZone);
  return makeDay(p.year, p.month, p.day, timeZone);
}

export function addDays(day: CalendarDay, n: number, timeZone: string): CalendarDay {
  return makeDay(day.year, day.month, day.day + n, timeZone);
}

/** Days from `from` through `to` inclusive (both as day keys resolved in zone). */
export function daysBetween(
  from: CalendarDay,
  to: CalendarDay,
  timeZone: string,
): CalendarDay[] {
  const out: CalendarDay[] = [];
  let cursor = from;
  // Guard against a reversed range: an empty list, never an infinite loop.
  for (let i = 0; i < 400 && cursor.key <= to.key; i++) {
    out.push(cursor);
    cursor = addDays(cursor, 1, timeZone);
  }
  return out;
}

/**
 * Six-week, Sunday-first month grid (42 cells) around `anchor`'s month in the
 * paint zone. Always six weeks so the grid never changes height month to
 * month and the "+N more" row never jumps.
 */
export function getMonthGrid(anchor: Date, timeZone: string): CalendarDay[] {
  const p = zoneParts(anchor, timeZone);
  const first = makeDay(p.year, p.month, 1, timeZone);
  const start = addDays(first, -first.weekday, timeZone);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i, timeZone));
}

export function getMonthGridWeeks(anchor: Date, timeZone: string): CalendarDay[][] {
  const days = getMonthGrid(anchor, timeZone);
  return Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));
}

/** Sunday–Saturday around `anchor` in the paint zone. */
export function getWeekDays(anchor: Date, timeZone: string): CalendarDay[] {
  const today = dayFromInstant(anchor, timeZone);
  const sunday = addDays(today, -today.weekday, timeZone);
  return Array.from({ length: 7 }, (_, i) => addDays(sunday, i, timeZone));
}

/** Rolling agenda days: `anchor`'s day through `pageEnd`'s day. */
export function getAgendaDays(
  anchor: Date,
  pageEnd: Date,
  timeZone: string,
): CalendarDay[] {
  return daysBetween(
    dayFromInstant(anchor, timeZone),
    dayFromInstant(pageEnd, timeZone),
    timeZone,
  );
}

/** Step the anchor by one unit of the view (months keep the day-of-month clamped). */
export function stepAnchor(
  anchor: Date,
  view: CalendarView,
  direction: -1 | 1,
  timeZone: string,
): Date {
  const p = zoneParts(anchor, timeZone);
  if (view === "month") {
    const target = makeDay(p.year, p.month + direction, 1, timeZone);
    const lastOfTarget = makeDay(target.year, target.month + 1, 0, timeZone).day;
    return makeDay(target.year, target.month, Math.min(p.day, lastOfTarget), timeZone)
      .start;
  }
  if (view === "week") {
    return makeDay(p.year, p.month, p.day + 7 * direction, timeZone).start;
  }
  return makeDay(p.year, p.month, p.day + 30 * direction, timeZone).start;
}

// ── Bucketing ────────────────────────────────────────────────────────────────

/** The instant an item stops occupying the grid; a point when `endsAt` is null. */
export function effectiveEnd(item: Pick<CalendarItem, "startsAt" | "endsAt">): Date {
  return item.endsAt && item.endsAt > item.startsAt
    ? item.endsAt
    : new Date(item.startsAt.getTime() + 1);
}

export function itemFallsOnDay(item: CalendarItem, day: CalendarDay): boolean {
  return item.startsAt < day.end && effectiveEnd(item) > day.start;
}

/** The day an item STARTS on — its primary render; any other day is a spill. */
export function startsOnDay(item: Pick<CalendarItem, "startsAt">, day: CalendarDay): boolean {
  return item.startsAt >= day.start && item.startsAt < day.end;
}

/**
 * One item renders as many chips (a 10 PM–1 AM show sits in two month cells;
 * the week paints a primary plus a continuation segment). The render key is
 * unique per CHIP, so the peek, `aria-expanded` and focus return can name
 * exactly one of them.
 */
export function renderKeyFor(day: CalendarDay, item: Pick<CalendarItem, "id">, continuation = false): string {
  return `${day.key}:${item.id}${continuation ? ":cont" : ""}`;
}

/**
 * Test ids stay findable by event id: the primary render keeps the bare
 * `${prefix}-${id}`; a continuation takes `-cont`; a spill into another day's
 * cell takes `-${day.key}`.
 */
export function chipTestId(
  prefix: string,
  item: Pick<CalendarItem, "id" | "startsAt">,
  day: CalendarDay,
  continuation = false,
): string {
  if (continuation) return `${prefix}-${item.id}-cont`;
  return startsOnDay(item, day) ? `${prefix}-${item.id}` : `${prefix}-${item.id}-${day.key}`;
}

function compareItems(a: CalendarItem, b: CalendarItem): number {
  const byStart = a.startsAt.getTime() - b.startsAt.getTime();
  if (byStart !== 0) return byStart;
  if (a.kind !== b.kind) return a.kind === "event" ? -1 : 1;
  if (a.kind === "hold" && b.kind === "hold") return a.position - b.position;
  return a.title.localeCompare(b.title);
}

/** `day.key` → that day's items, start-ordered, events before holds. */
export function groupByDay(
  items: readonly CalendarItem[],
  days: readonly CalendarDay[],
): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const day of days) {
    const list = items.filter((item) => itemFallsOnDay(item, day)).sort(compareItems);
    map.set(day.key, list);
  }
  return map;
}

export function isEvent(item: CalendarItem): item is CalendarEventItem {
  return item.kind === "event";
}

export function isHold(item: CalendarItem): item is CalendarHoldItem {
  return item.kind === "hold";
}

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * What the views paint after the filter chips. Public mode ignores filters
 * entirely (the read is already PUBLISHED-only, NFR-001) and never paints a
 * hold (FR-016).
 */
/**
 * The DISTINCT series among `items`, by name, for a mount's series select
 * (FR-015): built from what was fetched, so the select never offers a series
 * that would empty the grid. A series without a name shows `fallbackName`.
 */
export function distinctSeries(
  items: readonly CalendarItem[],
  fallbackName: string,
): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "event" || !item.seriesId || seen.has(item.seriesId)) continue;
    seen.set(item.seriesId, item.seriesName || fallbackName);
  }
  return [...seen]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function applyFilters(
  items: readonly CalendarItem[],
  filters: CalendarFilters | undefined,
  mode: CalendarMode,
): CalendarItem[] {
  if (mode === "public") return items.filter(isEvent);
  if (!filters) return [...items];
  return items.filter((item) => {
    if (item.kind === "hold") return filters.showHolds !== false;
    if (!filters.statuses.has(item.status)) return false;
    // An EMPTY owner set means "every owner", never "no owner": unticking the
    // last owner chip otherwise painted an empty calendar over a full fetch.
    if (
      filters.owners &&
      filters.owners.size > 0 &&
      item.ownerKey !== undefined &&
      !filters.owners.has(item.ownerKey)
    ) {
      return false;
    }
    if (filters.seriesId && filters.seriesId !== "all" && item.seriesId !== filters.seriesId) {
      return false;
    }
    return true;
  });
}

// ── Week layout ──────────────────────────────────────────────────────────────

export type VisibleHours = { startMinutes: number; endMinutes: number };

/** Wall-clock minutes from `day`'s midnight for an instant, in the paint zone. */
export function wallMinutes(instant: Date, day: CalendarDay, timeZone: string): number {
  if (instant >= day.start && instant < day.end) {
    const p = zoneParts(instant, timeZone);
    return p.hour * 60 + p.minute;
  }
  if (instant < day.start) {
    return -Math.round((day.start.getTime() - instant.getTime()) / 60_000);
  }
  return MINUTES_PER_DAY + Math.round((instant.getTime() - day.end.getTime()) / 60_000);
}

type Segment = {
  item: CalendarItem;
  startMinutes: number;
  endMinutes: number;
  continuation: boolean;
};

/**
 * The segments a day column paints: every item that STARTS on the day, plus a
 * continuation for an item that started the previous day and crosses
 * midnight into this one (FR-011). Minutes are wall-clock from the column's
 * own midnight and may run past 1440 for a late show — the column paints
 * them when the hours window extends that far.
 */
export function daySegments(
  items: readonly CalendarItem[],
  day: CalendarDay,
  timeZone: string,
): Segment[] {
  const out: Segment[] = [];
  for (const item of items) {
    if (item.kind === "hold") continue;
    const end = effectiveEnd(item);
    if (item.startsAt >= day.start && item.startsAt < day.end) {
      const s = wallMinutes(item.startsAt, day, timeZone);
      const e = Math.max(wallMinutes(end, day, timeZone), s + MIN_BLOCK_MINUTES);
      out.push({ item, startMinutes: s, endMinutes: e, continuation: false });
    } else if (item.startsAt < day.start && end > day.start) {
      const e = Math.min(wallMinutes(end, day, timeZone), MINUTES_PER_DAY);
      out.push({
        item,
        startMinutes: 0,
        endMinutes: Math.max(e, MIN_BLOCK_MINUTES),
        continuation: true,
      });
    }
  }
  return out.sort(
    (a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes,
  );
}

/**
 * The week's painted hours (FR-011). "Show all" → the whole day. A venue
 * window → the union across the visible week (earliest open, latest close),
 * widened to cover every visible segment so a 10:00 matinee at a 17:00–02:00
 * venue never vanishes. No window at all → auto-fit to the segments, floored
 * at 09:00–24:00 so an empty week still shows an evening. Snapped outward to
 * whole hours.
 */
export function visibleHours(
  window: HoursWindow | undefined,
  segments: readonly Pick<Segment, "startMinutes" | "endMinutes">[],
  showAll = false,
): VisibleHours {
  if (showAll) return { startMinutes: 0, endMinutes: MINUTES_PER_DAY };
  const windows = (window ?? []).filter(
    (w): w is { startMinutes: number; endMinutes: number } => w !== null,
  );
  let start: number;
  let end: number;
  if (windows.length > 0) {
    start = Math.min(...windows.map((w) => w.startMinutes));
    end = Math.max(...windows.map((w) => w.endMinutes));
  } else {
    start = HOURS_FLOOR_START;
    end = HOURS_FLOOR_END;
  }
  for (const s of segments) {
    start = Math.min(start, Math.max(0, s.startMinutes));
    end = Math.max(end, s.endMinutes);
  }
  start = Math.max(0, Math.floor(start / 60) * 60);
  end = Math.min(MINUTES_PER_DAY * 2, Math.ceil(end / 60) * 60);
  if (end <= start) end = Math.min(MINUTES_PER_DAY * 2, start + 60);
  return { startMinutes: start, endMinutes: end };
}

export type PositionedItem = {
  item: CalendarItem;
  /** Minutes from the top of the painted window. */
  top: number;
  /** Painted height in minutes (≥ MIN_BLOCK_MINUTES unless clipped). */
  height: number;
  /** Left edge as a share of the day column. */
  leftPercent: number;
  /** Width as a share of the day column — every chip in a group is equal. */
  widthPercent: number;
  zIndex: number;
  continuation: boolean;
};

/** The capped "+N" slot standing in for the items a group had no room for. */
export type WeekOverflow = {
  /** How many items in the group are not painted. */
  count: number;
  top: number;
  height: number;
  leftPercent: number;
  widthPercent: number;
};

export type WeekLayout = {
  placed: PositionedItem[];
  overflows: WeekOverflow[];
};

/** A day column narrower than this cannot paint two blocks side by side. */
export const WEEK_MIN_COLUMN_PX = 120;

/**
 * The narrowest a week block may be painted. Below it the block shows neither
 * its time ("2:28 PM" is ~52px at the chip's 10px mono) nor enough of its
 * title to identify the show, which is what the old 0 / 34 / 68% cascade
 * produced: three same-time shows at 145 / 95 / 45px in one 149px column.
 */
export const WEEK_CHIP_MIN_PX = 96;

/** The share of the column the capped "+N" slot takes when a group overflows. */
const OVERFLOW_SLOT_PERCENT = 28;

type WeekBox = { seg: Segment; top: number; bottom: number };

/**
 * Positions one column's segments inside the hours window.
 *
 * Overlapping items form a GROUP (a run of segments joined transitively by
 * overlap) and are laid out as equal side-by-side columns — Google Calendar's
 * model — so every block in the group is the same width. The number of columns
 * is the group's peak concurrency, capped so no block is painted narrower than
 * `WEEK_CHIP_MIN_PX`; when the cap bites, the columns that fit are painted and
 * the rest collapse into one "+N" slot on the right of the group, which opens
 * that day's list.
 *
 * `columnWidthPx` is what the day column actually measures — the floor is a
 * pixel promise, so a caller that cannot measure gets the grid's own minimum.
 */
export function layoutWeekItems(
  segments: readonly Segment[],
  hours: VisibleHours,
  columnWidthPx: number = WEEK_MIN_COLUMN_PX,
): WeekLayout {
  const boxes: WeekBox[] = [];
  for (const seg of segments) {
    const top = Math.max(seg.startMinutes, hours.startMinutes);
    const bottom = Math.min(seg.endMinutes, hours.endMinutes);
    if (bottom <= top) continue;
    boxes.push({ seg, top, bottom });
  }

  const placed: PositionedItem[] = [];
  const overflows: WeekOverflow[] = [];
  const maxSlots = Math.max(1, Math.floor(columnWidthPx / WEEK_CHIP_MIN_PX));

  // `daySegments` sorts by start, so a group is a run that stays connected to
  // the running latest end.
  let i = 0;
  while (i < boxes.length) {
    let groupEnd = boxes[i]!.bottom;
    let j = i + 1;
    while (j < boxes.length && boxes[j]!.top < groupEnd) {
      groupEnd = Math.max(groupEnd, boxes[j]!.bottom);
      j += 1;
    }
    const group = boxes.slice(i, j);

    // Greedy leftmost-free column. On intervals sorted by start this uses
    // exactly the peak concurrency, no more.
    const columnEnds: number[] = [];
    const columnOf = group.map((box) => {
      const free = columnEnds.findIndex((end) => end <= box.top);
      const column = free === -1 ? columnEnds.length : free;
      columnEnds[column] = box.bottom;
      return column;
    });
    const columns = columnEnds.length;
    const capped = columns > maxSlots;
    const slots = capped ? maxSlots : columns;
    const usable = capped ? 100 - OVERFLOW_SLOT_PERCENT : 100;
    const width = usable / slots;

    let hidden = 0;
    group.forEach((box, k) => {
      const column = columnOf[k]!;
      if (column >= slots) {
        hidden += 1;
        return;
      }
      placed.push({
        item: box.seg.item,
        top: box.top - hours.startMinutes,
        height: box.bottom - box.top,
        leftPercent: column * width,
        widthPercent: width,
        zIndex: 1 + column,
        continuation: box.seg.continuation,
      });
    });

    if (hidden > 0) {
      const groupTop = Math.min(...group.map((b) => b.top));
      overflows.push({
        count: hidden,
        top: groupTop - hours.startMinutes,
        height: groupEnd - groupTop,
        leftPercent: usable,
        widthPercent: OVERFLOW_SLOT_PERCENT,
      });
    }

    i = j;
  }

  return { placed, overflows };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string, withZone: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withZone ? "z" : ""}`;
  let f = timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(withZone ? { timeZoneName: "short" as const } : {}),
    });
    timeFormatters.set(key, f);
  }
  return f;
}

/**
 * "8:00 PM" in the paint zone. ICU 72+ separates the period with U+202F
 * (narrow no-break space) and older builds with U+00A0; both are folded to a
 * plain space so accessible names, tests and the mono column agree.
 */
export function formatTime(instant: Date, timeZone: string): string {
  return timeFormatter(timeZone, false).format(instant).replace(/[\u202F\u00A0]/g, " ");
}

/** "CDT" / "EST" — the zone's short name at `instant`. */
export function zoneAbbreviation(instant: Date, timeZone: string): string {
  const part = timeFormatter(timeZone, true)
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/**
 * "8:00–11:00 PM" when both ends share a period, "11:00 AM–2:00 PM" when they
 * don't, "8:00 PM" with no end. En dash, no spaces — the mono time column
 * has 150px to work with.
 */
export function formatTimeRange(
  start: Date,
  end: Date | null,
  timeZone: string,
): string {
  const a = formatTime(start, timeZone);
  if (!end || end <= start) return a;
  const b = formatTime(end, timeZone);
  const periodA = a.slice(-2);
  const periodB = b.slice(-2);
  if (periodA === periodB) {
    return `${a.slice(0, -3)}–${b}`;
  }
  return `${a}–${b}`;
}

/** "45m" / "2h" / "1h 30m"; empty with no end. */
export function formatDuration(start: Date, end: Date | null): string {
  if (!end || end <= start) return "";
  const mins = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Hour-row label: "9 AM", "12 PM", and past midnight "1 AM". */
export function formatHourLabel(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60) % 24;
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function shortDate(p: ZoneParts, names: CalendarNames): string {
  return `${names.monthsShort[p.month - 1]} ${p.day}`;
}

function spanLabel(a: ZoneParts, b: ZoneParts, names: CalendarNames): string {
  if (a.year !== b.year) {
    return `${shortDate(a, names)}, ${a.year} – ${shortDate(b, names)}, ${b.year}`;
  }
  if (a.month !== b.month) {
    return `${shortDate(a, names)} – ${shortDate(b, names)}, ${a.year}`;
  }
  return `${names.monthsShort[a.month - 1]} ${a.day} – ${b.day}, ${a.year}`;
}

/**
 * The toolbar's range label: month → "September 2026"; week →
 * "Aug 30 – Sep 5, 2026"; agenda → "Sep 2 – Oct 2, 2026" (anchor to the
 * agenda page end).
 */
export function formatRangeLabel(
  view: CalendarView,
  anchor: Date,
  timeZone: string,
  agendaPageEnd?: Date,
  names: CalendarNames = DEFAULT_CALENDAR_NAMES,
): string {
  const p = zoneParts(anchor, timeZone);
  if (view === "month") return `${names.monthsLong[p.month - 1]} ${p.year}`;
  if (view === "week") {
    const days = getWeekDays(anchor, timeZone);
    const a = days[0]!;
    const b = days[6]!;
    return spanLabel(
      { ...p, year: a.year, month: a.month, day: a.day },
      { ...p, year: b.year, month: b.month, day: b.day },
      names,
    );
  }
  const end = agendaPageEnd ?? new Date(anchor.getTime() + 30 * 86_400_000);
  return spanLabel(p, zoneParts(end, timeZone), names);
}

/** "September 5" — the long-form day used in accessible names. */
export function formatLongDay(day: CalendarDay, names: CalendarNames = DEFAULT_CALENDAR_NAMES): string {
  return `${names.monthsLong[day.month - 1]} ${day.day}`;
}

/** "Sat · Sep 5" for a painted day. */
export function formatDayLabel(day: CalendarDay, names: CalendarNames = DEFAULT_CALENDAR_NAMES): string {
  return `${names.weekdaysShort[day.weekday]} · ${names.monthsShort[day.month - 1]} ${day.day}`;
}

/**
 * "Thu · Sep 3" plus a relative key for today / tomorrow only (the view maps
 * the key to its label). `todayKey` is null until the clock has mounted, so
 * SSR paints no relative word.
 */
export function formatDayHeading(
  day: CalendarDay,
  todayKey: string | null,
  timeZone: string,
  names: CalendarNames = DEFAULT_CALENDAR_NAMES,
): { label: string; relative: "today" | "tomorrow" | null } {
  const label = formatDayLabel(day, names);
  if (todayKey === null) return { label, relative: null };
  if (day.key === todayKey) return { label, relative: "today" };
  const yesterday = addDays(day, -1, timeZone);
  if (yesterday.key === todayKey) return { label, relative: "tomorrow" };
  return { label, relative: null };
}

/** "Sat · Sep 5" for an instant. */
export function formatShortDay(
  instant: Date,
  timeZone: string,
  names: CalendarNames = DEFAULT_CALENDAR_NAMES,
): string {
  const p = zoneParts(instant, timeZone);
  return `${names.weekdaysShort[p.weekday]} · ${names.monthsShort[p.month - 1]} ${p.day}`;
}

/** "Aug 28" for a placed-at / respond-by stamp. */
export function formatMonthDay(
  instant: Date,
  timeZone: string,
  names: CalendarNames = DEFAULT_CALENDAR_NAMES,
): string {
  const p = zoneParts(instant, timeZone);
  return `${names.monthsShort[p.month - 1]} ${p.day}`;
}

/** "Fri · 5:00 PM" — the challenge respond-by stamp. */
export function formatRespondBy(
  instant: Date,
  timeZone: string,
  names: CalendarNames = DEFAULT_CALENDAR_NAMES,
): string {
  const p = zoneParts(instant, timeZone);
  return `${names.weekdaysShort[p.weekday]} · ${formatTime(instant, timeZone)}`;
}

type CountLabels = Pick<CalendarLabels, "eventCount" | "holdCount">;

const DEFAULT_COUNT_LABELS: CountLabels = DEFAULT_CALENDAR_LABELS;

/** "1 event · 1 hold" — omits a zero half; "0 events" when both are empty. */
export function dayCountLabel(
  items: readonly CalendarItem[],
  labels: CountLabels = DEFAULT_COUNT_LABELS,
): string {
  const events = items.filter(isEvent).length;
  const holds = items.filter(isHold).length;
  const parts: string[] = [];
  if (events > 0 || holds === 0) parts.push(labels.eventCount(events));
  if (holds > 0) parts.push(labels.holdCount(holds));
  return parts.join(" · ");
}

// ── Timezone mismatch ────────────────────────────────────────────────────────

/**
 * FR-013: the event's stored zone differs from the viewer's. Compared by the
 * clock, not the name — `US/Central` and `America/Chicago` read the same
 * time, and flagging them would be noise, not signal.
 */
export function tzMismatch(
  item: Pick<CalendarEventItem, "timezone" | "startsAt">,
  viewerTimezone: string,
): boolean {
  if (!item.timezone || item.timezone === viewerTimezone) return false;
  try {
    return (
      zoneOffsetMinutes(item.startsAt, item.timezone) !==
      zoneOffsetMinutes(item.startsAt, viewerTimezone)
    );
  } catch {
    return item.timezone !== viewerTimezone;
  }
}

/** "5:00 PM EDT" — the start in the event's own zone. */
export function venueLocalTime(
  item: Pick<CalendarEventItem, "timezone" | "startsAt">,
): string {
  return `${formatTime(item.startsAt, item.timezone)} ${zoneAbbreviation(item.startsAt, item.timezone)}`;
}

// ── Sold / capacity ──────────────────────────────────────────────────────────

export function isSoldOut(
  item: Pick<CalendarEventItem, "soldOut" | "ticketsSold" | "totalCapacity">,
): boolean {
  if (item.soldOut !== undefined) return item.soldOut;
  return (
    item.ticketsSold != null &&
    item.totalCapacity != null &&
    item.totalCapacity > 0 &&
    item.ticketsSold >= item.totalCapacity
  );
}

/**
 * "148 / 200"; "— / 120" when sold is unknown; "148" alone when there is no
 * capacity (an RSVP/community listing counts "going"); "—" when neither.
 */
export function formatSold(
  item: Pick<CalendarEventItem, "ticketsSold" | "totalCapacity">,
): string {
  const sold = item.ticketsSold == null ? "—" : String(item.ticketsSold);
  if (item.totalCapacity == null) return sold;
  return `${sold} / ${item.totalCapacity}`;
}

type NameLabels = CalendarNames & Pick<CalendarLabels, "holdTag">;

const DEFAULT_NAME_LABELS: NameLabels = DEFAULT_CALENDAR_LABELS;

/**
 * Accessible name for a chip: "{time} {title}" for an event (the time is the
 * normalised `formatTime` text), "{day} · Hold · #{n} {title}" for a hold.
 *
 * `soldOut` appends the localised "Sold out" (FR-022). An `aria-label` REPLACES
 * a button's text content, so without this the tag the chip and the day-list
 * row paint is visible-only — a screen-reader buyer heard "8:00 PM Jazz Night"
 * for a show they cannot buy. Callers pass it only where the tag renders
 * (public mode), so every internal name is byte-identical to before.
 */
export function chipAccessibleName(
  item: CalendarItem,
  timeZone: string,
  labels: NameLabels = DEFAULT_NAME_LABELS,
  soldOut?: string | null,
): string {
  if (item.kind === "hold") {
    return `${formatShortDay(item.startsAt, timeZone, labels)} · ${labels.holdTag(item.position)} ${item.title}`;
  }
  const name = `${formatTime(item.startsAt, timeZone)} ${item.title}`;
  return soldOut ? `${name}, ${soldOut}` : name;
}
