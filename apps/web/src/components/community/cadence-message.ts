/**
 * "Every Wednesday, 8:00 PM" — the cadence sentence for a recurring community
 * listing's stored rule, shared by the public event page
 * (`CommunityDateList`) and the moderator's schedule page (`ListingSchedule`).
 *
 * Returns the MESSAGE KEY and its ICU values rather than a finished string, so
 * the sentence can be asserted without standing a translator up, and so the
 * keys stay greppable.
 *
 * ── ONE MODULE, ON PURPOSE ────────────────────────────────────────────────
 *
 * The moderator surface and the listing it maintains must not be able to
 * describe one rule in two different sentences — a moderator reading "Every
 * other Wednesday" while the public page says "Every Wednesday" has no way to
 * tell which one is lying. For a while this logic existed twice (the public
 * page's copy was under active rewrite when the moderator page was built);
 * a phrasing fix in one copy left the other lying. Both surfaces now import
 * this. Two rules here are easy to get wrong, and are the reason the module
 * is worth its own tests:
 *
 *  - the weekday NAMES come from real upcoming occurrences, not from a map of
 *    RRULE codes to English words, so they stay locale-correct for free;
 *  - a day list that cannot be filled is DROPPED rather than half-stated: a
 *    MO,WE,FR rule with only Mondays and Wednesdays still ahead would read
 *    "Every Monday and Wednesday", which is confidently wrong about a
 *    three-day rule. The day-less sentence keeps the time, which is the half
 *    that is still true.
 */

export type CadenceSummary = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  /** >= 1. 1 means every day/week/month. */
  interval: number;
  /** RRULE two-letter weekday codes, Monday-first; `[]` when absent. */
  byday: string[];
};

export type CadenceMessage = {
  key: string;
  values: Record<string, string | number>;
};

/**
 * Week position of a weekday, Monday-first (Mon 0 … Sun 6) — the order the
 * server emits `byday` in, so a MO/WE rule reads "Monday and Wednesday"
 * however the next occurrence happens to fall.
 *
 * Keyed off `en-US` short weekday names because that is a stable ICU output
 * and this is an ORDERING key, never copy. `Date#getDay()` would answer in the
 * RUNTIME's zone: a Wednesday 8:00 PM in Nashville is Thursday in Berlin.
 */
const WEEK_POSITION: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/**
 * Joins weekday names the way the reader's locale joins a list ("Wednesdays
 * and Fridays" / "miércoles y viernes"). `Intl.ListFormat` is the newest of
 * the Intl constructors, so a missing one degrades to commas rather than
 * throwing inside a render.
 */
function joinNames(names: string[], locale: string): string {
  if (names.length <= 1) return names[0] ?? "";
  if (typeof Intl.ListFormat !== "function") return names.join(", ");
  return new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(names);
}

export function cadenceMessage(args: {
  recurrence: CadenceSummary | null;
  /** Upcoming occurrences, ascending. CANCELLED rows included — see below. */
  dates: ReadonlyArray<{ startsAt: Date }>;
  /** "8:00 PM", already formatted in the listing's zone. */
  time: string;
  /**
   * The listing's IANA zone. Weekday names are read in it, never in the
   * runtime's — a Wednesday 8:00 PM in Nashville is Thursday in Berlin. A
   * caller without one falls back to the runtime zone, which is the same
   * degrade the public page's date formatting takes.
   */
  timezone?: string;
  locale: string;
}): CadenceMessage | null {
  const { recurrence, dates, time, timezone, locale } = args;
  // No rule the server could phrase, or nothing to read a clock off. A cadence
  // inferred from the gaps between dates would be a guess, and a confidently
  // wrong sentence is worse than no sentence.
  if (!recurrence || dates.length === 0) return null;

  const interval = Math.max(1, Math.trunc(recurrence.interval) || 1);

  if (recurrence.freq === "DAILY") {
    return interval === 1
      ? { key: "rsvp.cadenceEveryDay", values: { time } }
      : { key: "rsvp.cadenceEveryNDays", values: { interval, time } };
  }
  if (recurrence.freq === "MONTHLY") {
    return interval === 1
      ? { key: "rsvp.cadenceEveryMonth", values: { time } }
      : { key: "rsvp.cadenceEveryNMonths", values: { interval, time } };
  }

  // WEEKLY — BYDAY may name several days, so read the distinct weekdays off
  // the upcoming occurrences themselves.
  const dayless: CadenceMessage =
    interval === 1
      ? { key: "rsvp.cadenceEveryWeekNoDays", values: { time } }
      : { key: "rsvp.cadenceEveryNWeeksNoDays", values: { interval, time } };

  const wanted = Math.min(7, Math.max(1, recurrence.byday.length));
  const nameFormat = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    timeZone: timezone,
  });
  const keyFormat = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: timezone,
  });

  /** name → week position, so names order by WEEK, not by which day is next. */
  const byName = new Map<string, number>();
  for (const row of dates) {
    const name = nameFormat.format(row.startsAt);
    if (!byName.has(name)) {
      byName.set(
        name,
        WEEK_POSITION[keyFormat.format(row.startsAt)] ?? byName.size + 7,
      );
    }
    if (byName.size >= wanted) break;
  }
  if (byName.size < wanted) return dayless;

  const days = joinNames(
    [...byName.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name),
    locale,
  );
  return interval === 1
    ? { key: "rsvp.cadenceEveryWeek", values: { days, time } }
    : { key: "rsvp.cadenceEveryNWeeks", values: { interval, days, time } };
}
