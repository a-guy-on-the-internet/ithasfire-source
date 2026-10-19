import { DateTime } from "luxon";

/**
 * FLOATING wall-clock conversions for driving the `rrule` npm package.
 *
 * WHY THIS EXISTS
 * ---------------
 * `rrule` has no timezone model. Every `Date` handed to it (`dtstart`,
 * `until`) and every `Date` it returns is treated as FLOATING wall-clock: it
 * reads and writes the Date's **UTC fields** and never applies an offset.
 *
 * So handing it a REAL instant (what `DateTime.toUTC().toJSDate()` produces)
 * makes it evaluate BYDAY/BYHOUR/BYMONTHDAY against the **UTC** calendar
 * instead of the event's local calendar. In a negative-offset zone an evening
 * event has already rolled over to the next UTC day, so a
 * `FREQ=WEEKLY;BYDAY=MO` rule anchored at Mon 19:00 America/Chicago
 * (= Tue 00:00Z) enumerates Tuesdays-in-UTC, which read back as **Sundays**
 * in local time. Every occurrence lands one day early.
 *
 * THE RECIPE
 * ----------
 * Drive rrule entirely in floating space and convert only at the boundaries:
 *
 *   local wall-time string  --wallTimeToFloating-->  rrule input
 *   real instant            --instantToFloating-->   rrule input / bounds
 *   rrule output            --floatingToInstant-->   real instant (persisted)
 *
 * Sorting, dedupe and capping must happen on the REAL instants, after
 * conversion — floating values are not instants and comparing them across a
 * DST boundary is not the same ordering.
 *
 * As a side effect this also makes DST behave: a 19:00-local weekly rule stays
 * 19:00 local across the March/November transitions instead of drifting an
 * hour, because the rule is expressed in wall-clock and the offset is applied
 * per-occurrence on the way out.
 *
 * DST EDGE CASES (`floatingToInstant`)
 * ------------------------------------
 * `floatingToInstant` solves `instant = naiveUtc - offset(instant)`, where the
 * offset depends on the instant. It BRACKETS the transition rather than
 * iterating: zone offsets span -12:00..+14:00, comfortably under a day, so the
 * answer always lies in `[naiveUtc - 1d, naiveUtc + 1d]`. Probing the zone at
 * both ends yields the offsets either side of any transition that could apply,
 * and the true offset is necessarily one of the two — an exhaustive candidate
 * set, with no sensitivity to the sign of the offset. (It assumes at most one
 * transition per 48 hours; no zone in tzdata has ever had two.)
 *
 * - **Fall back / ambiguous local time** (e.g. 01:30 on a US fall-back date,
 *   which happens TWICE): both candidates read back correctly and `Math.min`
 *   takes the EARLIER one — the pre-transition occurrence.
 * - **Spring forward / nonexistent local time** (e.g. 02:30 on a
 *   spring-forward date, which never happens): neither candidate reads back,
 *   so it falls through to the pre-transition offset. The result lands one
 *   transition-step LATER on the wall clock than asked (02:30 resolves to the
 *   instant that reads 03:30). Accepted — the occurrence surfaces rather than
 *   being dropped.
 *
 * WHY THE SOLVE DOES NOT USE `DateTime.fromObject`. It is not deterministic
 * for the ambiguous hour: Luxon seeds its offset guess from the CURRENT
 * instant (`offsetProvis = zoneToUse.offset(Settings.now())`) and `fixOffset`
 * returns that guess unchanged when both probes agree, so an ambiguous wall
 * clock resolves to whichever repetition matches TODAY's offset in that zone.
 * Measured: 01:30 on 2026-11-01 America/Chicago resolves to 06:30Z when the
 * process clock is in September and 07:30Z when it is in December. That
 * seasonal drift is a data-loss bug here — `reconcileSeriesSchedule` matches
 * stored occurrence instants EXACTLY, so a series stored in summer would be
 * orphaned (deleted / detached) when reconciled in winter.
 *
 * BE PRECISE ABOUT THE SCOPE OF THAT BAN — this whole bug class grew out of a
 * header asserting behaviour Luxon does not have.
 *
 *  - The ban is on the SOLVE (wall clock → instant). `floatingToInstant` is
 *    the only place that has to pick between two candidate instants, and it
 *    brackets instead.
 *  - `wallTimeToFloating` DOES still reach `fromObject`: `fromISO` delegates
 *    to it (`parseDataToDateTime` → `DateTime.fromObject(parsed, { zone,
 *    specificOffset })`). It is safe anyway, because the resulting DateTime is
 *    consumed ONLY for its wall-clock fields via `dateTimeToFloating`, and
 *    both offset guesses in an ambiguous hour yield the same wall fields.
 *    Same for the `parseDateTime` / `parseZoned` helpers in the callers.
 *  - Instant → wall (`instantToFloating`) is unambiguous by construction and
 *    still uses Luxon.
 *
 * KNOWN, ACCEPTED RESIDUE. A few call sites take an INSTANT off such a parse
 * rather than its wall fields, and those are clock-dependent for a bare
 * (offset-less) ambiguous wall clock: `convert-event-to-series.ts`'s
 * `dtstartMs` bound, and `expand-series.ts`'s effective-window bounds. To hit
 * it a stored `dtstart` must be offset-less AND land inside the one repeated
 * hour of a fall-back date. It is unreachable from the builder
 * (`toIsoInTimeZone` always emits an offset), it fails CLOSED
 * (EVENT_START_NOT_IN_SCHEDULE / a tighter window, never a wrong date), it
 * predates this module, and the migration script now REFUSES offset-less
 * `dtstart` rows rather than migrating them silently. Left as-is deliberately.
 *
 * This is deliberately the SAME algorithm as the web builder's
 * `zonedWallClockToInstant` (`apps/web/src/lib/template-shift-offset.ts`), so
 * the organizer's preview and the server's expansion cannot disagree. One
 * algorithm, one tie-break: earlier offset wins.
 *
 * Every function here guards validity and returns `null` rather than leaking
 * an `Invalid Date` into a stored occurrence.
 */

/** A `Date` whose UTC fields carry a wall-clock, i.e. `rrule`'s native space. */
export type FloatingDate = Date;

/** Stamp a zoned `DateTime`'s wall-clock fields into a floating `Date`. */
export function dateTimeToFloating(dt: DateTime): FloatingDate | null {
  if (!dt.isValid) {
    return null;
  }
  return new Date(
    Date.UTC(
      dt.year,
      dt.month - 1,
      dt.day,
      dt.hour,
      dt.minute,
      dt.second,
      dt.millisecond,
    ),
  );
}

/**
 * Parse an ISO string as wall-time in `timezone` and return it in floating
 * space. Returns `null` when the string is unparseable.
 */
export function wallTimeToFloating(
  value: string,
  timezone: string,
): FloatingDate | null {
  return dateTimeToFloating(DateTime.fromISO(value, { zone: timezone }));
}

/**
 * Project a REAL instant into floating space by reading its local wall-clock
 * in `timezone`. Use this for every window bound compared against `rrule`
 * output, otherwise the scan bounds are off by the zone's offset.
 */
export function instantToFloating(
  instant: Date | null | undefined,
  timezone: string,
): FloatingDate | null {
  if (!instant) {
    return null;
  }
  return dateTimeToFloating(DateTime.fromJSDate(instant).setZone(timezone));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `timezone`'s offset from UTC, in ms, at a given instant. Reading a wall
 * clock FROM an instant is unambiguous, so this direction is safe to take
 * from Luxon.
 */
function zoneOffsetMs(instantMs: number, timezone: string): number | null {
  const dt = DateTime.fromMillis(instantMs, { zone: "utc" }).setZone(timezone);
  if (!dt.isValid) {
    return null;
  }
  const wallAsUtc = Date.UTC(
    dt.year,
    dt.month - 1,
    dt.day,
    dt.hour,
    dt.minute,
    dt.second,
    dt.millisecond,
  );
  return wallAsUtc - instantMs;
}

/** Does `instantMs` read back in `timezone` as exactly this floating value? */
function readsBackAs(
  instantMs: number,
  floating: Date,
  timezone: string,
): boolean {
  const offset = zoneOffsetMs(instantMs, timezone);
  return offset !== null && instantMs + offset === floating.getTime();
}

/**
 * Convert a floating `Date` produced by `rrule` back into a REAL instant by
 * re-interpreting its UTC fields as wall-clock in `timezone`.
 *
 * Bracketing solve — see this module's header for the DST rulings and for why
 * `DateTime.fromObject` is NOT used here (it is clock-dependent for the
 * ambiguous hour).
 */
export function floatingToInstant(
  floating: Date,
  timezone: string,
): Date | null {
  // A floating Date's UTC fields ARE the wall clock, so its epoch value is
  // already the naive-UTC stamp the solve starts from.
  const naiveUtc = floating.getTime();
  if (Number.isNaN(naiveUtc)) {
    return null;
  }

  const offsetBefore = zoneOffsetMs(naiveUtc - DAY_MS, timezone);
  const offsetAfter = zoneOffsetMs(naiveUtc + DAY_MS, timezone);
  if (offsetBefore === null || offsetAfter === null) {
    return null; // unknown zone
  }

  const candidates =
    offsetBefore === offsetAfter
      ? [naiveUtc - offsetBefore]
      : [naiveUtc - offsetBefore, naiveUtc - offsetAfter];

  const valid = candidates.filter((instant) =>
    readsBackAs(instant, floating, timezone),
  );

  // Fall-back overlap: both candidates are valid, the EARLIER one wins.
  // Spring-forward gap: neither is valid, fall through to the pre-transition
  // offset (lands one step later on the wall clock).
  return new Date(
    valid.length > 0 ? Math.min(...valid) : naiveUtc - offsetBefore,
  );
}
