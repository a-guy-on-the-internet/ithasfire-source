import type { CalendarAvailabilityRow } from "@th/ports/repos/calendars";

import { toWindow, type Interval } from "../../lib/availability-intervals";
import { localDayOfWeek, toLocalParts } from "../../lib/venue-local-time";

// ─────────────────────────────────────────────────────────────────────────────
// computeHoursWindow — the week view's hours window from CalendarAvailability
// (event-calendar-redesign FR-005 / FR-011; docs/specs/2026-09-02).
//
// PURE: rows in, one window (or null) per requested day out. Everything is
// in MINUTES FROM LOCAL MIDNIGHT of the day being examined, in the venue's
// own zone — `startTime`/`endTime` are wall-clock strings in
// `Place.timezone` (CalendarAvailability schema), so the caller passes that
// zone and each `weekDays` instant is resolved to its venue-local date
// before any row is matched. A close at or before the open runs past
// midnight, so `endMinutes` can exceed 1440 (the week view paints the
// continuation into the next column).
//
// SCOPE:
//   · `{ calendarId }` — that calendar's rows PLUS place-wide rows
//     (`calendarId` null applies to every calendar, venue-hierarchy FR-007);
//   · `"all"`          — every calendar's rows plus place-wide, UNIONED:
//     earliest open to latest close across the lot (the toolbar's "All").
//
// PRECEDENCE, per calendar group (each calendar and the place-wide set are
// separate groups):
//   1. rows dated for that exact venue-local day beat that group's weekday
//      rows — a one-off late night or an early close overrides the pattern;
//   2. a closure (`isOpen: false`) in the chosen set closes the GROUP for
//      the day. A PLACE-WIDE closure closes the whole place (a blackout is
//      one row, not N copies — FR-007); a closure on the scoped calendar
//      closes a single-calendar scope. Under "all", one calendar's closure
//      only removes that calendar's contribution;
//   3. open rows without both times contribute nothing (the same rule
//      get-place-booking-availability applies — never guess a span).
//
// No hours at all → null for that day; the engine's auto-fit-with-floor
// fallback (FR-011) is the CALLER's decision, not this function's.
//
// DIVERGENCE — dated OPEN rows: precedence rule 1 honours a dated `isOpen`
// row as a per-day override of the weekday pattern (a one-off late night
// widens the week view's hours). `get-place-booking-availability.ts`
// deliberately does NOT: its picker reads dated rows ONLY as closures and
// ignores dated open rows outright, so an override can never silently widen
// what a requester may book. The two surfaces therefore disagree on a dated
// open row — the week view shows the room open late, the picker does not
// offer the slot. Painting is the safer side to be generous on; booking is
// not.
// TODO(booking-picker): teach get-place-booking-availability the same
// per-day override (dated open row replaces that day's weekday windows) so
// the hours a venue paints are the hours a requester can book.
//
// DATE BUCKETING — `CalendarAvailability.date` is stored UN-NORMALISED: the
// write path (`manage-calendars.ts`, availability upsert input) accepts a raw
// `z.coerce.date()` and persists whatever instant the client sent. A dated row
// buckets to the intended venue-local day here (`toLocalParts(row.date,
// timezone).date`) ONLY when it was stored as venue-local midnight (or any
// instant inside that local day); a row saved as UTC midnight for a venue
// west of Greenwich resolves to the PREVIOUS local day. The fix is the
// precedent in `packages/adapters/src/db/prisma/booking-holds.ts`
// (`isoDateToDb` / `dbDateToIso`): carry the day as ISO `YYYY-MM-DD` across
// the wire and normalise at ONE adapter choke point. Deferred to a later
// pass; until then callers must store venue-local midnight.
// ─────────────────────────────────────────────────────────────────────────────

export type HoursWindow = {
  /** Minutes from venue-local midnight, 0–1439. */
  startMinutes: number;
  /** Minutes from venue-local midnight; > 1440 when the night crosses it. */
  endMinutes: number;
};

export type HoursScope = "all" | { calendarId: string };

export type HoursAvailabilityRow = Pick<
  CalendarAvailabilityRow,
  "calendarId" | "dayOfWeek" | "date" | "startTime" | "endTime" | "isOpen"
>;

export type ComputeHoursWindowInput = {
  rows: readonly HoursAvailabilityRow[];
  scope: HoursScope;
  /**
   * The days to compute, as instants; each is bucketed to its venue-local
   * date in `timezone`. Output is positional — `result[i]` is `weekDays[i]`.
   */
  weekDays: readonly Date[];
  /** The place's IANA zone (`Place.timezone`, already resolved). */
  timezone: string;
};

const PLACE_WIDE = "__place__";

function groupKey(row: HoursAvailabilityRow): string {
  return row.calendarId ?? PLACE_WIDE;
}

/** The window of one open row, or null when it names no usable span. */
function rowWindow(row: HoursAvailabilityRow): Interval | null {
  if (!row.startTime || !row.endTime) return null;
  return toWindow(row.startTime, row.endTime);
}

function windowForDay(
  rows: readonly HoursAvailabilityRow[],
  scope: HoursScope,
  dateKey: string,
  dayOfWeek: number,
  timezone: string,
): HoursWindow | null {
  // Group the in-scope rows by calendar (place-wide is its own group).
  const groups = new Map<
    string,
    { dated: HoursAvailabilityRow[]; weekly: HoursAvailabilityRow[] }
  >();
  for (const row of rows) {
    if (
      scope !== "all" &&
      row.calendarId !== null &&
      row.calendarId !== scope.calendarId
    ) {
      continue;
    }
    const key = groupKey(row);
    const group = groups.get(key) ?? { dated: [], weekly: [] };
    if (row.date) {
      if (toLocalParts(row.date, timezone).date === dateKey) {
        group.dated.push(row);
      }
    } else if (row.dayOfWeek === dayOfWeek) {
      group.weekly.push(row);
    }
    groups.set(key, group);
  }

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const [key, group] of groups) {
    // Rule 1: a dated row for this day beats the weekday pattern, per group.
    const chosen = group.dated.length > 0 ? group.dated : group.weekly;
    // Rule 2: a closure closes the group; place-wide (or the scoped
    // calendar itself) closes the day outright.
    if (chosen.some((row) => !row.isOpen)) {
      if (key === PLACE_WIDE) return null;
      if (scope !== "all" && key === scope.calendarId) return null;
      continue;
    }
    for (const row of chosen) {
      const window = rowWindow(row);
      if (!window) continue;
      start = Math.min(start, window.start);
      end = Math.max(end, window.end);
    }
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { startMinutes: start, endMinutes: end };
}

/**
 * One hours window per requested day (positional with `weekDays`), or null
 * where the scope has no hours that day. See the module header for scope,
 * precedence and the past-midnight convention.
 */
export function computeHoursWindow(
  input: ComputeHoursWindowInput,
): Array<HoursWindow | null> {
  return input.weekDays.map((day) => {
    const dateKey = toLocalParts(day, input.timezone).date;
    return windowForDay(
      input.rows,
      input.scope,
      dateKey,
      localDayOfWeek(dateKey),
      input.timezone,
    );
  });
}
