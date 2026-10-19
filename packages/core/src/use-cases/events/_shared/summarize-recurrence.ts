import type { EventSeriesSchedule } from "@th/types";
import rrulePkg from "rrule";

import { floatingToInstant, wallTimeToFloating } from "./rrule-floating-time";

const { RRule } = rrulePkg;

/**
 * Read-side SUMMARY of a stored recurrence, for pages that want to say
 * "Every Wednesday, 8:00 PM" instead of painting 52 rows.
 *
 * This is a companion to {@link expandRecurrenceDates}, not a second parser:
 * both drive the SAME `rrule` package over the SAME stored
 * `EventSeriesSchedule`, and both treat UNTIL as FLOATING wall-clock in the
 * event's timezone (see `rrule-floating-time.ts` for why rrule must be driven
 * in floating space). Expansion answers "which instants"; this answers "what
 * is the rule, in terms a sentence can be built from".
 *
 * ## Deliberately lossy
 *
 * It describes only the shape a cadence line can render, which is a SUBSET of
 * what an RRULE can express. Anything outside that subset comes back `null`
 * rather than half-described — a caller that gets `null` falls back to showing
 * the dates themselves, which is always correct.
 *
 * Not represented, and therefore dropped (the rule itself is unaffected —
 * expansion still honours all of it):
 *  - `COUNT` — a count-bounded rule reports `until: null`.
 *  - `BYSETPOS` / nth-prefixed BYDAY (`2WE`) — the ordinal is dropped, so the
 *    builder's "second Wednesday of the month" summarises as MONTHLY + `WE`.
 *    The `freq` still says MONTHLY, so the sentence is vague, never wrong by a
 *    week.
 *  - `BYMONTHDAY`, `BYHOUR`, `WKST`, … — ignored; `byday` is `[]` when the rule
 *    carries no BYDAY.
 *
 * ## Never throws
 *
 * This read sits on the public event page's critical path, where the schedule
 * is decoration for a list that already renders. Every failure mode — absent
 * schedule, FIXED_DATES, a rule the `rrule` package refuses, a frequency
 * outside the subset, a BYDAY token that does not map to a weekday, a DAILY
 * rule carrying BYDAY (no cadence line can state both) — returns `null`.
 */

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY";

export interface RecurrenceSummary {
  freq: RecurrenceFreq;
  /** >= 1. 1 means every day/week/month. */
  interval: number;
  /** RRULE two-letter weekday codes, Monday-first; `[]` when absent. */
  byday: string[];
  /** Real instant of the rule's UNTIL bound, or `null` when unbounded. */
  until: Date | null;
}

/**
 * RRULE weekday codes in RFC 5545 order, which is also the index basis of
 * `rrule`'s `Weekday.weekday` (0 = MO … 6 = SU). Mirrors `WEEKDAYS` in the web
 * builder's `recurrence-helpers.ts` — one basis, the event timezone's local
 * calendar day.
 */
const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/**
 * The frequencies a cadence line can phrase. Keyed off `RRule`'s own
 * constants rather than the raw enum ordinals so a `rrule` upgrade cannot
 * silently re-point DAILY at something else. YEARLY / HOURLY / MINUTELY /
 * SECONDLY are deliberately absent → `null`.
 */
const FREQ_LABELS = new Map<number, RecurrenceFreq>([
  [RRule.DAILY, "DAILY"],
  [RRule.WEEKLY, "WEEKLY"],
  [RRule.MONTHLY, "MONTHLY"],
]);

export function summarizeRecurrence(
  schedule: EventSeriesSchedule | null | undefined,
  opts: { timezone: string },
): RecurrenceSummary | null {
  // FIXED_DATES has no cadence to state, and an RRULE kind without a rule
  // string is a corrupt row. Both: show the dates.
  if (!schedule || schedule.kind !== "RRULE" || !schedule.rrule) {
    return null;
  }

  try {
    // `parseString` throws on an unknown RRULE property and on a malformed
    // nth-weekday token; both land in the catch below.
    const parsed = RRule.parseString(schedule.rrule);

    const freq =
      typeof parsed.freq === "number" ? FREQ_LABELS.get(parsed.freq) : undefined;
    if (!freq) {
      return null;
    }

    const byday = toWeekdayCodes(parsed.byweekday);
    if (byday === null) {
      return null;
    }

    // DAILY + BYDAY is out of contract, and half-describing it is worse than
    // refusing: `FREQ=DAILY;BYDAY=MO,WE,FR` means "Mondays, Wednesdays and
    // Fridays", but DAILY has no slot for days in a cadence line, so the
    // sentence comes out "Every day" — a rule that fires 3x a week rendered as
    // one that fires 7x. Nothing emits it (the web builder's own parser refuses
    // the combination, `recurrence-helpers.ts`), so this is the unsupported
    // branch, not a supported one we are declining to phrase.
    if (freq === "DAILY" && byday.length > 0) {
      return null;
    }

    return {
      freq,
      interval: toInterval(parsed.interval),
      byday,
      until: toUntilInstant(schedule, parsed.until, opts.timezone),
    };
  } catch {
    return null;
  }
}

/**
 * `INTERVAL` as a usable repeat count. `parseString` hands back whatever the
 * string held — a number, a non-numeric string, or an array for a comma list —
 * so anything that is not a finite integer >= 1 falls back to 1 ("every").
 */
function toInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

/**
 * `BYDAY` as two-letter codes, Monday-first and de-duplicated.
 *
 * Returns `[]` when the rule carries no BYDAY, and `null` — meaning "refuse to
 * summarise" — when ANY entry fails to map to a weekday. `parseString` turns an
 * unrecognised two-letter token into `undefined` instead of throwing, so
 * without that check `FREQ=WEEKLY;BYDAY=XX` would summarise as a bare
 * "every week" and quietly drop the day constraint.
 *
 * An nth-prefixed entry (`2WE`) keeps its weekday and loses its ordinal — see
 * this module's header.
 */
function toWeekdayCodes(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return [];
  }

  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) {
    return [];
  }

  const indices = new Set<number>();
  for (const entry of entries) {
    const index = weekdayIndexOf(entry);
    if (index === null) {
      return null;
    }
    indices.add(index);
  }

  return WEEKDAY_CODES.filter((_code, index) => indices.has(index));
}

/** A `Weekday` instance, a raw weekday ordinal, or a code string → 0..6. */
function weekdayIndexOf(entry: unknown): number | null {
  if (typeof entry === "number") {
    return Number.isInteger(entry) && entry >= 0 && entry <= 6 ? entry : null;
  }
  if (typeof entry === "string") {
    const index = WEEKDAY_CODES.indexOf(
      entry.trim().toUpperCase() as (typeof WEEKDAY_CODES)[number],
    );
    return index === -1 ? null : index;
  }
  if (entry && typeof entry === "object" && "weekday" in entry) {
    const weekday = (entry as { weekday: unknown }).weekday;
    return typeof weekday === "number" &&
      Number.isInteger(weekday) &&
      weekday >= 0 &&
      weekday <= 6
      ? weekday
      : null;
  }
  return null;
}

/**
 * The UNTIL bound as a REAL instant.
 *
 * Source precedence mirrors {@link expandRecurrenceDates} exactly: a
 * `schedule.until` beside the rule WINS (expansion overwrites the rule's own
 * UNTIL with it), else the `UNTIL=` inside the rule string is used. Getting
 * this order wrong would let the page state a different end than the one the
 * dates were enumerated against.
 *
 * That mirroring extends to the FAILED conversion: expansion only overrides the
 * rule when `wallTimeToFloating(schedule.until)` succeeds and otherwise leaves
 * the rule's own `UNTIL=` in force, so an unparseable `schedule.until` falls
 * through to `parsedUntil` here too rather than dropping the bound.
 *
 * Both sources are wall-clock in the event's timezone — `parseString` returns
 * UNTIL as a `Date` whose UTC fields carry the authored wall clock, i.e.
 * already a floating value — so both go through `floatingToInstant`.
 */
function toUntilInstant(
  schedule: EventSeriesSchedule,
  parsedUntil: Date | undefined | null,
  timezone: string,
): Date | null {
  const floating =
    (schedule.until ? wallTimeToFloating(schedule.until, timezone) : null) ??
    (parsedUntil instanceof Date && !Number.isNaN(parsedUntil.getTime())
      ? parsedUntil
      : null);
  if (!floating) {
    return null;
  }

  const instant = floatingToInstant(floating, timezone);
  if (!instant || Number.isNaN(instant.getTime())) {
    return null;
  }
  return instant;
}
