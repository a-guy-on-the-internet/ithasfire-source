/**
 * Venue availability as INTERVALS, not day flags.
 *
 * A 2pm matinee does not cost a venue its evening, and a space may open twice
 * in one day (`CalendarAvailability` has no unique index on
 * `(placeId, calendarId, dayOfWeek)`), so every rule here is a span of minutes
 * and a date is only unbookable when the spans leave no room for a set.
 *
 * Everything in this file is PURE and works in **minutes from local midnight**
 * on the day being examined. Converting a UTC instant into that frame is the
 * caller's job — it needs the venue's timezone, which this module deliberately
 * knows nothing about. A close at or before the open means the night runs past
 * midnight, so end values can exceed 1440.
 */

export type Interval = { start: number; end: number };

export type BusyInterval = Interval & {
  /** Public event title, or null for a hold with nothing announced. */
  title: string | null;
  /** The source event had no end time, so this span was assumed. */
  assumedEnd: boolean;
};

export type SlotRules = {
  /** Minutes between offered start times. */
  step: number;
  /** Shortest bookable gap — a slot must leave room for a set. */
  minSlot: number;
  /** Dead time held either side of a booked show, for strike and set-up. */
  changeover: number;
};

export const DEFAULT_SLOT_RULES: SlotRules = {
  step: 30,
  minSlot: 60,
  changeover: 60,
};

const MINUTES_PER_DAY = 1440;

/** "HH:MM" → minutes from midnight, or null when it isn't a valid clock time. */
export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * An opening window in minutes. `close <= open` is not an error — it means the
 * night runs into tomorrow, so the end is pushed past 1440 and every downstream
 * comparison keeps working without a special case.
 */
export function toWindow(open: string, close: string): Interval | null {
  const start = parseClock(open);
  const rawEnd = parseClock(close);
  if (start === null || rawEnd === null) return null;
  const end = rawEnd <= start ? rawEnd + MINUTES_PER_DAY : rawEnd;
  return { start, end };
}

function byStart(a: Interval, b: Interval): number {
  return a.start - b.start;
}

/**
 * Overlapping or touching windows are merged. Two rows saying 6–10 and 9–11 are
 * one 6–11 window, not two — otherwise a slot near the seam gets offered twice.
 */
export function mergeWindows(windows: readonly Interval[]): Interval[] {
  const sorted = [...windows].sort(byStart);
  const out: Interval[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * What a booked show consumes: its own span plus a changeover buffer each side,
 * clipped to the day's last closing time.
 *
 * A show with no end time has to consume *something*. Blocking through to close
 * is the safe read — offering a slot the venue can't honour is worse than
 * hiding one it could — but it does cost the venue its late inventory, which is
 * why the admin nudges owners to set end times.
 */
export function toBusy(
  bookings: ReadonlyArray<{
    start: number;
    end: number | null;
    title?: string | null;
  }>,
  windows: readonly Interval[],
  rules: SlotRules = DEFAULT_SLOT_RULES,
): BusyInterval[] {
  if (windows.length === 0) return [];
  const lastClose = Math.max(...windows.map((w) => w.end));

  return bookings.map((b) => {
    const assumedEnd = b.end === null;
    let end = b.end === null ? lastClose : b.end;
    if (end <= b.start) end += MINUTES_PER_DAY;
    return {
      start: b.start - rules.changeover,
      end: Math.min(end + rules.changeover, lastClose),
      title: b.title ?? null,
      assumedEnd,
    };
  });
}

/** Open windows minus busy spans, keeping only gaps a set could fit inside. */
export function freeGaps(
  windows: readonly Interval[],
  busy: readonly Interval[],
  rules: SlotRules = DEFAULT_SLOT_RULES,
): Interval[] {
  const merged = mergeWindows(windows);
  const sortedBusy = [...busy].sort(byStart);
  const out: Interval[] = [];

  for (const window of merged) {
    let cursor = window.start;
    for (const b of sortedBusy) {
      if (b.end <= cursor || b.start >= window.end) continue;
      if (b.start > cursor) {
        out.push({ start: cursor, end: Math.min(b.start, window.end) });
      }
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < window.end) out.push({ start: cursor, end: window.end });
  }

  return out.filter((g) => g.end - g.start >= rules.minSlot);
}

/** Offered start times inside the free gaps. */
export function slotStarts(
  gaps: readonly Interval[],
  rules: SlotRules = DEFAULT_SLOT_RULES,
): number[] {
  const out: number[] = [];
  for (const gap of gaps) {
    for (let m = gap.start; m <= gap.end - rules.minSlot; m += rules.step) {
      out.push(m);
    }
  }
  return out;
}

/**
 * How much of the night is gone, 0–1. Drives the hatch level on a day cell, so
 * "an hour taken" and "nothing left" read as one language at two heights.
 */
export function takenRatio(
  windows: readonly Interval[],
  gaps: readonly Interval[],
): number {
  const total = mergeWindows(windows).reduce(
    (n, w) => n + (w.end - w.start),
    0,
  );
  if (total <= 0) return 0;
  const free = gaps.reduce((n, g) => n + (g.end - g.start), 0);
  return Math.max(0, Math.min(1, 1 - free / total));
}

export type DayStatus =
  | "past"
  | "blackout"
  | "closed"
  | "full"
  | "partial"
  | "free";

/**
 * Precedence matters and is deliberate:
 *   past → blackout → closed → full → partial → free.
 *
 * `partial` is derived from what a booking actually CONSUMES, not from a
 * booking merely existing: a 2pm matinee at a room that opens at 6pm costs the
 * evening nothing, and painting a 0%-high hatch on it would be a lie.
 */
export function dayStatus(input: {
  isPast: boolean;
  isBlackout: boolean;
  windows: readonly Interval[];
  gaps: readonly Interval[];
  slots: readonly number[];
}): DayStatus {
  if (input.isPast) return "past";
  if (input.isBlackout) return "blackout";
  if (input.windows.length === 0) return "closed";
  if (input.slots.length === 0) return "full";
  return takenRatio(input.windows, input.gaps) > 0 ? "partial" : "free";
}

/** True when the span crosses midnight, i.e. its end lands on the next date. */
export function crossesMidnight(interval: Interval): boolean {
  return interval.end > MINUTES_PER_DAY;
}
