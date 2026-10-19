// The one date rule: times are ALWAYS venue-local.
//
// An event happens where it happens. A show at Riverfront Park starts at 8pm
// Central whether the person reading the page is in Nashville, Denver or
// Lisbon, and converting that to the viewer's zone produces a time that is
// technically correct and operationally useless — someone shows up an hour
// late holding a screenshot that agreed with them.
//
// So `timeZone` is a REQUIRED argument here, not an option with a default. A
// call site that doesn't have the venue's zone has a bug upstream, and the
// type error is the cheapest place to find that out. There is deliberately no
// "viewer local" mode to reach for.
//
// This module is the string half of the contract; `<DateTime>` in @th/ui is
// the render half. Both go through `formatDateTime`, so a date on a page, in a
// CSV export, in an email and on a printed ticket cannot disagree.

/**
 * Last-resort venue zone when nothing else is known. Matches the
 * `Event.timezone` column default in `event.prisma` AND the final fallback in
 * `finalizeSaveEvent`; keep the three in step. Lives here rather than in
 * `@th/core` so `@th/ui` (which cannot import core) renders the same fallback
 * the server formatted with. `@th/core/lib/venue-local-time` re-exports it.
 */
export const DEFAULT_VENUE_TIMEZONE = "America/Chicago";

/** What a caller can hand us. */
export type DateTimeInput = Date | string | number;

export type DateTimeFormat =
  /** `Aug 19, 2026` */
  | "date"
  /** `Wed, Aug 19` — the browse/listing idiom, no year */
  | "dateShort"
  /** `Wednesday, August 19, 2026` */
  | "dateLong"
  /** `08/19/2026` — zero-padded, for tables and dense rows */
  | "dateNumeric"
  /** `8:00 PM` */
  | "time"
  /** `Aug 19, 2026, 8:00 PM` */
  | "datetime"
  /** `Wed, Aug 19 · 8:00 PM` — the meta-line idiom */
  | "meta"
  /** `Wednesday` */
  | "weekday"
  /** `AUG` — for the torn-off date column on a stub */
  | "monthAbbr"
  /** `19` — zero-padded day, for the same */
  | "day";

export interface FormatDateTimeOptions {
  /**
   * IANA zone for the VENUE, e.g. "America/Chicago". Required — see the note
   * at the top of this file.
   */
  timeZone: string;
  /** BCP-47 locale tag. Default "en-US". */
  locale?: string;
  /**
   * Append the zone abbreviation (`8:00 PM CDT`). Worth it wherever someone
   * might be reading from another zone — confirmation emails, tickets, a
   * shared link — and noise inside a venue's own dashboard.
   */
  showTimeZone?: boolean;
}

/**
 * Parse a caller's value into a Date without shifting the day.
 *
 * A date-only string (`"2026-08-19"`) is parsed by the JS engine as UTC
 * midnight per spec. West of UTC that is the previous day once rendered in a
 * western zone, so a naive `new Date("2026-08-19")` shows "Aug 18" across the
 * Americas.
 *
 * Rebuilding it as a LOCAL-time date does not fix that — it only moves the bug
 * to machines whose system zone differs from the venue's. On a UTC box (every
 * CI runner) local midnight formatted for Chicago is 19:00 the day before, and
 * the date slips back exactly as it did before.
 *
 * A date-only value denotes a calendar day, not an instant, so it is anchored
 * at NOON UTC. Noon is far enough from both midnights that every zone from
 * UTC-11 to UTC+11 renders the intended day regardless of the host's clock,
 * which makes the result identical on a laptop in Chicago and a runner in UTC.
 *
 * A full timestamp is an instant and is passed through untouched.
 */
export function parseDateTime(value: DateTimeInput): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value);
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0),
    );
  }

  return new Date(value);
}

const PARTS: Record<DateTimeFormat, Intl.DateTimeFormatOptions> = {
  date: { month: "short", day: "numeric", year: "numeric" },
  dateShort: { weekday: "short", month: "short", day: "numeric" },
  dateLong: {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  },
  dateNumeric: { month: "2-digit", day: "2-digit", year: "numeric" },
  time: { hour: "numeric", minute: "2-digit" },
  datetime: {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  meta: {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  weekday: { weekday: "long" },
  monthAbbr: { month: "short" },
  day: { day: "2-digit" },
};

/** Formats that carry a clock time, and so can carry a zone abbreviation. */
const HAS_TIME = new Set<DateTimeFormat>(["time", "datetime", "meta"]);

function formatWith(
  date: Date,
  locale: string,
  timeZone: string,
  showTimeZone: boolean,
  fmt: DateTimeFormat = "datetime",
): string {
  const options: Intl.DateTimeFormatOptions = {
    ...PARTS[fmt],
    timeZone,
    ...(showTimeZone && HAS_TIME.has(fmt)
      ? { timeZoneName: "short" as const }
      : {}),
  };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * The `meta` idiom joins its date and time with a middot rather than the
 * locale's comma — `Wed, Aug 19 · 8:00 PM`. Intl has no pattern for that, so
 * the two halves are formatted separately and joined.
 */
function formatMeta(
  date: Date,
  locale: string,
  timeZone: string,
  showTimeZone: boolean,
): string {
  const datePart = new Intl.DateTimeFormat(locale, {
    ...PARTS.dateShort,
    timeZone,
  }).format(date);
  const timePart = new Intl.DateTimeFormat(locale, {
    ...PARTS.time,
    timeZone,
    ...(showTimeZone ? { timeZoneName: "short" as const } : {}),
  }).format(date);
  return `${datePart} · ${timePart}`;
}

/**
 * Format a value in the venue's zone, in one of the named idioms.
 *
 * This is the function everything else calls. `formatDateTime` below is the
 * two-argument convenience for the common `datetime` case.
 */
export function formatDateTimeAs(
  value: DateTimeInput,
  format: DateTimeFormat,
  { timeZone, locale = "en-US", showTimeZone = false }: FormatDateTimeOptions,
): string {
  const date = parseDateTime(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  if (format === "meta") {
    return formatMeta(date, locale, timeZone, showTimeZone);
  }
  return formatWith(date, locale, timeZone, showTimeZone, format);
}

/**
 * The date-only value for a venue-local instant, as `YYYY-MM-DD`.
 *
 * Use this for grouping and comparison — "which day is this event on" — rather
 * than slicing an ISO string, which answers the question in UTC and puts a 9pm
 * Central show on the following day.
 */
export function toVenueLocalDate(
  value: DateTimeInput,
  timeZone: string,
): string {
  const date = parseDateTime(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  // `en-CA` yields ISO-ordered `YYYY-MM-DD`, which is the point of using it.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Format a value in the venue's zone.
 *
 * Returns an empty string for an unparseable input rather than "Invalid Date".
 * A blank cell is a visible gap someone will report; "Invalid Date" printed on
 * a ticket looks like a system that is broken in a more alarming way than it is.
 */
export function formatDateTime(
  value: DateTimeInput,
  options: FormatDateTimeOptions,
): string {
  return formatDateTimeAs(value, "datetime", options);
}

