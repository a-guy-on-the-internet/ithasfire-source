import type { EventSeriesSchedule } from "@th/types";
import { DateTime } from "luxon";
import rrulePkg from "rrule";

import {
  floatingToInstant,
  instantToFloating,
  wallTimeToFloating,
} from "./rrule-floating-time";

const { RRule } = rrulePkg;

/**
 * Shared, PURE schedule → dates enumeration. Given an `EventSeriesSchedule`
 * (the SAME shape the ticketed EventSeries model uses — RRULE or FIXED_DATES),
 * enumerate the occurrence instants within a [windowStart, windowEnd] window,
 * capped at `max`, deterministically ordered and de-duplicated.
 *
 * This is the ONE community-facing RRULE implementation. It mirrors how
 * `series/expand-series.ts` drives the `rrule` package (parse the RRULE string,
 * stamp a FLOATING wall-clock `dtstart`, iterate with `rule.after`, convert
 * each occurrence back to a real instant) but has NO dependency on the series
 * occurrence tables or a transaction — so the community recurring listing can
 * reuse the exact enumeration logic.
 *
 * Both paths share the floating-wall-clock conversions in
 * `./rrule-floating-time.ts`; read that file's header for why `rrule` must be
 * driven in wall-clock space rather than on real UTC instants.
 *
 * NOTE: `expand-series.ts` is intentionally NOT refactored onto this helper in
 * slice 1 — its enumeration is entangled with ordinal allocation, existing-
 * occurrence dedup, and per-row DB uniqueness checks inside a tx, so sharing it
 * now would risk destabilising the money-bearing ticketed-series path. See the
 * `// TODO: converge with expand-recurrence` marker there.
 *
 * @param opts.durationMs When provided, each occurrence's `endsAt` is
 *   `startsAt + durationMs` (derived by the caller from the base event's
 *   start/end). When null/omitted, `endsAt` is null (matching expand-series,
 *   whose occurrences carry a null endsAt).
 */
export function expandRecurrenceDates(
  schedule: EventSeriesSchedule,
  opts: {
    windowStart: Date;
    windowEnd: Date;
    max: number;
    timezone: string;
    durationMs?: number | null;
  },
): Array<{ startsAt: Date; endsAt: Date | null }> {
  const { windowStart, windowEnd, timezone } = opts;
  const max = Math.max(0, Math.floor(opts.max));
  const durationMs =
    opts.durationMs != null && Number.isFinite(opts.durationMs) && opts.durationMs > 0
      ? opts.durationMs
      : null;

  if (max === 0 || windowStart.getTime() > windowEnd.getTime()) {
    return [];
  }

  const withEnds = (startsAt: Date): { startsAt: Date; endsAt: Date | null } => ({
    startsAt,
    endsAt: durationMs == null ? null : new Date(startsAt.getTime() + durationMs),
  });

  const collected: Date[] = [];

  if (schedule.kind === "RRULE") {
    if (!schedule.rrule || !schedule.dtstart) {
      return [];
    }

    // `rrule` is timezone-blind: it reads/writes a Date's UTC fields and
    // treats them as FLOATING wall-clock. So the rule must be driven entirely
    // in floating space (wall-clock stamped into UTC fields) and converted
    // back to real instants on the way out — otherwise BYDAY/BYHOUR match
    // against the UTC calendar and, in a negative-offset zone, every evening
    // occurrence lands a day early. See `rrule-floating-time.ts` (including
    // its DST spring-forward / fall-back notes).
    const dtstartFloating = wallTimeToFloating(schedule.dtstart, timezone);
    if (!dtstartFloating) {
      return [];
    }
    const untilFloating = schedule.until
      ? wallTimeToFloating(schedule.until, timezone)
      : null;

    // Window bounds arrive as REAL instants; project them into floating space
    // too, or the scan bounds are off by the zone's offset.
    const windowStartFloating = instantToFloating(windowStart, timezone);
    const windowEndFloating = instantToFloating(windowEnd, timezone);
    if (!windowStartFloating || !windowEndFloating) {
      return [];
    }

    // Guard the RRULE parse/construct/iterate: a length-valid but
    // syntactically bad rule (e.g. "FREQ=NONSENSE") throws from the `rrule`
    // package. Swallow it and return [] — the caller
    // (applyRecurrenceForEvent) maps an empty expansion to the typed
    // RECURRENCE_HAS_NO_UPCOMING_DATES (BAD_REQUEST) instead of letting a raw
    // 500 escape.
    try {
      const ruleOptions = RRule.parseString(schedule.rrule);
      ruleOptions.dtstart = dtstartFloating;
      if (untilFloating) {
        ruleOptions.until = untilFloating;
      }
      const rule = new RRule(ruleOptions);

      // Start scanning from the later of the window start and dtstart.
      //
      // These comparisons are between FLOATING values, which is deliberate:
      // the bounds are being used to include/exclude WALL-CLOCK occurrences,
      // and `rule.after` emits floating values, so both sides must be in the
      // same space. Floating order and instant order can differ inside a
      // fall-back overlap hour, where an edge occurrence could fall on the
      // other side of a bound — a one-hour window at one boundary of a scan
      // range, which is why the cheap consistent comparison is preferred over
      // converting every candidate twice.
      const scanStart =
        windowStartFloating.getTime() > dtstartFloating.getTime()
          ? windowStartFloating
          : dtstartFloating;
      const upperBound = untilFloating
        ? untilFloating.getTime() < windowEndFloating.getTime()
          ? untilFloating
          : windowEndFloating
        : windowEndFloating;

      let next = rule.after(scanStart, true);
      let iterations = 0;
      const maxIterations = Math.max(max * 5, max + 50);
      while (next && collected.length < max && iterations < maxIterations) {
        if (next.getTime() > upperBound.getTime()) {
          break;
        }
        // Back out of floating space: the real instant is what callers
        // persist and sort on.
        const instant = floatingToInstant(next, timezone);
        if (instant) {
          collected.push(instant);
        }
        next = rule.after(next, false);
        iterations += 1;
      }
    } catch {
      return [];
    }
  } else {
    // FIXED_DATES
    const dates = schedule.dates ?? [];
    for (const iso of dates) {
      const dt = parseInZone(iso, timezone);
      if (!dt) {
        continue;
      }
      if (dt.getTime() < windowStart.getTime()) {
        continue;
      }
      if (dt.getTime() > windowEnd.getTime()) {
        continue;
      }
      collected.push(dt);
    }
  }

  // Deterministic ascending order + dedupe identical instants, then cap.
  collected.sort((a, b) => a.getTime() - b.getTime());
  const seen = new Set<number>();
  const deduped: Date[] = [];
  for (const d of collected) {
    const ms = d.getTime();
    if (seen.has(ms)) {
      continue;
    }
    seen.add(ms);
    deduped.push(d);
    if (deduped.length >= max) {
      break;
    }
  }

  return deduped.map(withEnds);
}

/** Parse an ISO string as wall-time in `timezone`, returning a UTC JS Date. */
function parseInZone(value: string, timezone: string): Date | null {
  const dt = DateTime.fromISO(value, { zone: timezone });
  if (!dt.isValid) {
    return null;
  }
  return dt.toUTC().toJSDate();
}
