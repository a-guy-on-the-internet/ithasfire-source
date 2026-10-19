/**
 * `VTIMEZONE` generation for the recurring .ics export.
 *
 * ## Why this exists at all
 *
 * A recurring export has to state `DTSTART;TZID=America/Chicago:20260909T200000`
 * rather than a UTC instant — otherwise the series drifts an hour at every DST
 * boundary and `BYDAY` can land on the wrong weekday (`zoned-time.ts` has the
 * worked example). RFC 5545 §3.2.19 then requires that "an individual
 * 'VTIMEZONE' calendar component MUST be specified for each unique 'TZID'
 * parameter value specified in the iCalendar object". A bare `TZID` with no
 * definition is what most producers ship and what every mainstream client
 * happens to resolve, but it is a spec violation and it leaves the wall clock at
 * the client's mercy — so the definition is emitted.
 *
 * ## How the definition is derived
 *
 * There is no timezone database in the browser bundle and none is added. The
 * transitions are DISCOVERED by probing `Intl`: step through the export window
 * a week at a time and, wherever the UTC offset changes, binary-search to the
 * minute. Offsets are the only input, so this works for every zone the runtime
 * knows — including zones with no DST (one `STANDARD`, no `RDATE`s), half-hour
 * offsets, and southern-hemisphere rules.
 *
 * Transitions are emitted as explicit `RDATE`s rather than the synthesised
 * yearly `RRULE`s (`FREQ=YEARLY;BYMONTH=3;BYDAY=2SU`) that hand-written
 * VTIMEZONEs use. Inferring an nth-weekday pattern from probed instants means
 * GUESSING at a rule; listing the instants states only what was measured. The
 * cost is that the definition stops at the end of the window — see
 * {@link VTIMEZONE_WINDOW_YEARS}.
 *
 * ## The one coordinate trap
 *
 * `DTSTART` and `RDATE` inside an observance are LOCAL time (RFC 5545 §3.6.5),
 * read against that observance's `TZOFFSETFROM` — the wall clock *before* the
 * change. Chicago's 2026 spring-forward is the instant `2026-03-08T08:00:00Z`
 * with `TZOFFSETFROM:-0600`, so the emitted value is `20260308T020000`, the
 * canonical "2 AM". Shifting the instant by that offset and then reading its UTC
 * fields is what produces it — reading it back through `Intl` instead would
 * apply the offset twice.
 */

import { createZoneClock, formatUtcOffset, type ZoneClock } from "./zoned-time";

/**
 * How far past the event the transition list runs when the series is unbounded.
 *
 * This is NOT an end date for the series — the `RRULE` stays unbounded and
 * nothing here is ever borrowed as an `UNTIL`. It bounds only how much timezone
 * history is written down. Past the window a client holds the last stated
 * offset, a drift no occurrence inside a human planning horizon reaches.
 */
export const VTIMEZONE_WINDOW_YEARS = 10;

/** One year before the event, so the observance covering DTSTART is present. */
const LOOKBACK_YEARS = 1;

/** Ceiling on the probed span, so a far-future `UNTIL` cannot blow up the loop. */
const MAX_WINDOW_YEARS = 30;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PROBE_STEP = 7 * 24 * HOUR;
const YEAR = 365.2425 * 24 * HOUR;

type Transition = {
  /** The real instant at which the offset changes. */
  at: Date;
  /** Offset in minutes before the change. */
  fromMinutes: number;
  /** Offset in minutes after the change. */
  toMinutes: number;
};

type Observance = {
  kind: "STANDARD" | "DAYLIGHT";
  /** Floating local date-time of the first transition in this group. */
  dtstart: string;
  fromMinutes: number;
  toMinutes: number;
  name: string | null;
  /** Floating local date-times of the group's remaining transitions. */
  rdates: string[];
};

/**
 * The `BEGIN:VTIMEZONE … END:VTIMEZONE` lines for `timeZone`, or `null` when the
 * runtime cannot resolve the zone or an offset read fails.
 *
 * `null` means the caller must fall back to the UTC single-event export: a
 * `TZID` that cannot be defined is not shipped.
 *
 * @param dtstart The event's start instant — anchors the probe window.
 * @param until   The series' end instant when it has one. `null` is normal (an
 *                unbounded rule) and only affects the window's length.
 */
export function buildVTimezoneLines(
  timeZone: string,
  dtstart: Date,
  until: Date | null,
): string[] | null {
  const clock = createZoneClock(timeZone);
  if (!clock || Number.isNaN(dtstart.getTime())) return null;

  const { from, to } = probeWindow(dtstart, until);

  const baseOffset = clock.offsetMinutes(from);
  if (baseOffset === null) return null;

  const transitions = findTransitions(clock, from, to, baseOffset);
  if (transitions === null) return null;

  const observances =
    transitions.length === 0
      ? fixedOffsetObservance(clock, from, baseOffset)
      : groupTransitions(clock, transitions);
  if (!observances) return null;

  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  for (const observance of observances) {
    lines.push(
      `BEGIN:${observance.kind}`,
      `DTSTART:${observance.dtstart}`,
      `TZOFFSETFROM:${formatUtcOffset(observance.fromMinutes)}`,
      `TZOFFSETTO:${formatUtcOffset(observance.toMinutes)}`,
    );
    if (observance.name) {
      lines.push(`TZNAME:${escapeText(observance.name)}`);
    }
    for (const rdate of observance.rdates) {
      lines.push(`RDATE:${rdate}`);
    }
    lines.push(`END:${observance.kind}`);
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function probeWindow(dtstart: Date, until: Date | null): { from: Date; to: Date } {
  const from = new Date(dtstart.getTime() - LOOKBACK_YEARS * YEAR);
  const unbounded = dtstart.getTime() + VTIMEZONE_WINDOW_YEARS * YEAR;
  const bounded =
    until && !Number.isNaN(until.getTime()) && until.getTime() > dtstart.getTime()
      ? until.getTime()
      : unbounded;
  return {
    from,
    to: new Date(Math.min(bounded, from.getTime() + MAX_WINDOW_YEARS * YEAR)),
  };
}

/**
 * A zone that never changes offset (UTC, America/Phoenix, Asia/Kolkata) still
 * needs one observance — RFC 5545 requires at least one — so state the constant
 * offset as a `STANDARD` that began before the event.
 */
function fixedOffsetObservance(
  clock: ZoneClock,
  from: Date,
  offsetMinutes: number,
): Observance[] | null {
  const dtstart = floatingLocal(from, offsetMinutes);
  if (!dtstart) return null;
  return [
    {
      kind: "STANDARD",
      dtstart,
      fromMinutes: offsetMinutes,
      toMinutes: offsetMinutes,
      name: clock.shortName(from),
      rdates: [],
    },
  ];
}

/**
 * Transitions folded into observances, keyed on the exact
 * (kind, from, to, name) tuple.
 *
 * Every `RDATE` in an observance inherits that observance's offsets and name, so
 * a zone that changed its RULES mid-window (a country abolishing DST) gets a
 * second observance rather than a misfiled `RDATE`. Insertion order is
 * preserved, so each group's `DTSTART` is its earliest transition.
 */
function groupTransitions(
  clock: ZoneClock,
  transitions: readonly Transition[],
): Observance[] | null {
  const groups = new Map<string, Observance>();

  for (const transition of transitions) {
    const local = floatingLocal(transition.at, transition.fromMinutes);
    if (!local) return null;

    // The name is read an hour AFTER the change so it reflects `toMinutes`.
    const name = clock.shortName(new Date(transition.at.getTime() + HOUR));
    const kind: Observance["kind"] =
      transition.toMinutes > transition.fromMinutes ? "DAYLIGHT" : "STANDARD";
    const key = `${kind}|${transition.fromMinutes}|${transition.toMinutes}|${name ?? ""}`;

    const existing = groups.get(key);
    if (existing) {
      existing.rdates.push(local);
    } else {
      groups.set(key, {
        kind,
        dtstart: local,
        fromMinutes: transition.fromMinutes,
        toMinutes: transition.toMinutes,
        name,
        rdates: [],
      });
    }
  }

  return [...groups.values()];
}

/**
 * An instant shifted into local wall-clock space and formatted as a FLOATING
 * iCal date-time. Reading the shifted value's UTC fields is the point — see the
 * coordinate trap in this module's header.
 */
function floatingLocal(at: Date, offsetMinutes: number): string | null {
  const shifted = new Date(at.getTime() + offsetMinutes * MINUTE);
  if (Number.isNaN(shifted.getTime())) return null;
  const iso = shifted.toISOString();
  // A widened year (`+012026-…`) is not a legal iCal DATE.
  if (!/^\d{4}-/.test(iso)) return null;
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

/** TZNAME is a TEXT value; a zone with no abbreviation reports `GMT+5:30`. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Every offset change in `[from, to]`, found by weekly probe plus binary search
 * to the minute. `null` when an offset read fails.
 *
 * A week-wide probe cannot straddle two transitions: the shortest DST period any
 * zone has used is measured in weeks, not days.
 */
function findTransitions(
  clock: ZoneClock,
  from: Date,
  to: Date,
  baseOffset: number,
): Transition[] | null {
  const out: Transition[] = [];
  const end = to.getTime();

  let previousAt = from.getTime();
  let previousOffset = baseOffset;

  for (let cursor = previousAt + PROBE_STEP; ; cursor += PROBE_STEP) {
    const probeAt = Math.min(cursor, end);
    const offset = clock.offsetMinutes(new Date(probeAt));
    if (offset === null) return null;

    if (offset !== previousOffset) {
      const at = bisect(clock, previousAt, probeAt, previousOffset);
      if (at === null) return null;
      out.push({ at, fromMinutes: previousOffset, toMinutes: offset });
      previousOffset = offset;
    }

    previousAt = probeAt;
    if (probeAt >= end) break;
  }

  return out;
}

/** The first whole minute at which the offset is no longer `beforeOffset`. */
function bisect(
  clock: ZoneClock,
  loMs: number,
  hiMs: number,
  beforeOffset: number,
): Date | null {
  let lo = Math.floor(loMs / MINUTE) * MINUTE;
  let hi = Math.ceil(hiMs / MINUTE) * MINUTE;

  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (mid <= lo || mid >= hi) break;
    const offset = clock.offsetMinutes(new Date(mid));
    if (offset === null) return null;
    if (offset === beforeOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return new Date(hi);
}
