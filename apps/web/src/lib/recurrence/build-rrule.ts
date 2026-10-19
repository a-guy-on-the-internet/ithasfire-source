/**
 * Pure, client-safe RRULE-string builder for community recurring listings
 * (recurring-dates spec, slice 4). Templates an iCal RRULE string from the
 * moderator's structured inputs WITHOUT bundling the `rrule` npm package into
 * the web client — the server (expand-recurrence.ts) is the single source of
 * truth that actually expands the rule into EventDate rows.
 *
 * The community `recurrenceScheduleSchema` accepts `{ kind: "RRULE", rrule,
 * dtstart, until? }`. This helper produces the `rrule` string; the caller
 * (build-recurrence-schedule.ts) supplies the timezone-correct `dtstart` /
 * `until` ISO strings.
 *
 * Kept free of React, Intl timezone math, and any app imports so it is
 * directly unit-testable.
 */

export type RecurrenceFreq = "WEEKLY" | "MONTHLY";

/** RRULE weekday abbreviations. */
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

/** MONTHLY repeats either on the same day-of-month or the same Nth weekday. */
export type MonthlyMode = "DAY_OF_MONTH" | "NTH_WEEKDAY";

/** JS `Date.getUTCDay()` (0 = Sunday) → RRULE weekday. */
const UTC_DAY_TO_WEEKDAY: readonly Weekday[] = [
  "SU",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
];

/** Canonical Monday-first ordering for a stable, readable BYDAY list. */
const RRULE_WEEKDAY_ORDER: readonly Weekday[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
];

export interface BuildRruleArgs {
  freq: RecurrenceFreq;
  /** "Every N weeks/months". Coerced to an integer >= 1. Defaults to 1. */
  interval?: number;
  /**
   * WEEKLY: the weekdays to repeat on. When empty, defaults to the weekday of
   * `startsAt`. Ignored for MONTHLY.
   */
  byWeekday?: Weekday[];
  /**
   * First occurrence, read via UTC accessors — pass a Date whose UTC calendar
   * fields equal the first occurrence's wall-time (day-of-month + weekday are
   * derived from it for MONTHLY / weekly defaulting).
   */
  startsAt: Date;
  /** MONTHLY only. Defaults to DAY_OF_MONTH. */
  monthlyMode?: MonthlyMode;
  /**
   * Optional UNTIL bound as a UTC instant. Encoded into the rule as iCal UTC
   * `YYYYMMDDTHHMMSSZ`. Omitted when null/undefined.
   */
  until?: Date | null;
}

/** RRULE weekday of a Date's UTC calendar day. */
export function weekdayOf(date: Date): Weekday {
  return UTC_DAY_TO_WEEKDAY[date.getUTCDay()]!;
}

/** 1-based ordinal position of the date's weekday within its month (1..5). */
export function nthWeekdayOfMonth(date: Date): number {
  return Math.floor((date.getUTCDate() - 1) / 7) + 1;
}

/** Format a UTC instant as an iCal UTC datetime: `YYYYMMDDTHHMMSSZ`. */
export function toIcalUtc(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/**
 * Build an iCal RRULE string (e.g. `FREQ=WEEKLY;INTERVAL=1;BYDAY=TU`). INTERVAL
 * is always emitted for an explicit, unambiguous rule. UNTIL is appended when a
 * bound is supplied.
 */
export function buildRrule(args: BuildRruleArgs): string {
  const interval = Math.max(1, Math.floor(args.interval ?? 1));
  const parts: string[] = [];

  if (args.freq === "WEEKLY") {
    parts.push("FREQ=WEEKLY", `INTERVAL=${interval}`);
    const requested =
      args.byWeekday && args.byWeekday.length > 0
        ? args.byWeekday
        : [weekdayOf(args.startsAt)];
    const ordered = RRULE_WEEKDAY_ORDER.filter((w) => requested.includes(w));
    parts.push(`BYDAY=${ordered.join(",")}`);
  } else {
    parts.push("FREQ=MONTHLY", `INTERVAL=${interval}`);
    if (args.monthlyMode === "NTH_WEEKDAY") {
      parts.push(
        `BYDAY=${nthWeekdayOfMonth(args.startsAt)}${weekdayOf(args.startsAt)}`,
      );
    } else {
      parts.push(`BYMONTHDAY=${args.startsAt.getUTCDate()}`);
    }
  }

  if (args.until) {
    parts.push(`UNTIL=${toIcalUtc(args.until)}`);
  }

  return parts.join(";");
}
