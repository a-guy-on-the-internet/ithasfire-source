import {
  getMonthGrid,
  getWeekDays,
  dayFromInstant,
  zoneParts,
} from "./helpers";
import type { CalendarView } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Mount-side helpers: what a mount FETCHES for a (view, anchor) pair, and how
// a clicked cell becomes a quick-create prefill. Pure; shared by the
// dashboard and place mounts so the fetch window and the painted grid can
// never disagree (the old engine pinned its query to the current month and
// painted empty grids for every other one).
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarDateRange = { from: Date; to: Date };

/**
 * The inclusive window the grid paints, in the paint zone:
 * month → the 42-cell grid span; week → Sunday 00:00 through Saturday
 * 24:00; agenda → the anchor's day through `agendaPageEnd`'s day.
 */
export function visibleRangeFor(
  view: CalendarView,
  anchor: Date,
  timezone: string,
  agendaPageEnd?: Date,
): CalendarDateRange {
  if (view === "month") {
    const days = getMonthGrid(anchor, timezone);
    return { from: days[0]!.start, to: days[41]!.end };
  }
  if (view === "week") {
    const days = getWeekDays(anchor, timezone);
    return { from: days[0]!.start, to: days[6]!.end };
  }
  const start = dayFromInstant(anchor, timezone);
  const end = dayFromInstant(
    agendaPageEnd ?? new Date(anchor.getTime() + 30 * 86_400_000),
    timezone,
  );
  return { from: start.start, to: end.end };
}

export function sameRange(a: CalendarDateRange | null, b: CalendarDateRange): boolean {
  return (
    a !== null && a.from.getTime() === b.from.getTime() && a.to.getTime() === b.to.getTime()
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "HH:mm", 24-hour — the shape `Calendar.defaultStartTime` stores. */
const TIME_24H_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Evening fallback for a date-only cell (mirrors `QUICK_CREATE_FALLBACK_START_TIME`). */
export const CELL_FALLBACK_START_TIME = "19:00";

/**
 * A clicked cell → the quick-create `startsAt` prefill ("YYYY-MM-DDTHH:mm",
 * a wall clock). Read in the PAINT zone, never the browser's: a venue
 * calendar painted in America/Chicago and clicked from London must prefill
 * the Chicago wall clock the reader saw. `dateOnly` cells (month / agenda,
 * whose instant is local midnight) take `defaultStartTime` or the evening
 * fallback; week slots carry a real time and keep it.
 */
export function cellPrefillWallClock(
  instant: Date,
  timezone: string,
  opts: { dateOnly: boolean; defaultStartTime?: string | null },
): string {
  const p = zoneParts(instant, timezone);
  const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  if (!opts.dateOnly) return `${date}T${pad2(p.hour)}:${pad2(p.minute)}`;
  const hhmm =
    opts.defaultStartTime && TIME_24H_RE.test(opts.defaultStartTime)
      ? opts.defaultStartTime
      : CELL_FALLBACK_START_TIME;
  return `${date}T${hhmm}`;
}
