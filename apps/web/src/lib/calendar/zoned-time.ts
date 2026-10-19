/**
 * Wall-clock reads for the calendar exporters, on `Intl` alone (no new bundle
 * weight).
 *
 * A one-off appointment can travel as a UTC instant and be right forever. A
 * RECURRING one cannot: RFC 5545 expands an RRULE against DTSTART's own basis,
 * so a UTC DTSTART pins the series to a UTC instant and its LOCAL time slides
 * by an hour at every DST boundary — an 8:00 PM open mic starts reading as
 * 7:00 PM from the first Sunday in November onward. Worse, `BYDAY` is matched
 * against the UTC weekday: the seeded Wednesday-night open mic in
 * America/Chicago starts at `2026-09-10T01:00:00Z`, a **Thursday** in UTC, so
 * `BYDAY=WE` would shift every occurrence after the first onto Tuesday nights.
 *
 * Both go away once the recurring export states DTSTART in the event's own
 * timezone, which needs the wall clock. That is what this module provides.
 */

/** One zone's clock, with its `Intl` formatters built once and reused. */
export type ZoneClock = {
  timeZone: string;
  /**
   * The RFC 5545 "local time" form (`YYYYMMDDTHHMMSS`, no trailing `Z`) of
   * `date` in this zone, or `null` for an invalid date.
   */
  wallTime: (date: Date) => string | null;
  /**
   * Minutes this zone is ahead of UTC at `date` (`-360` for CST, `330` for
   * IST), or `null` for an invalid date.
   */
  offsetMinutes: (date: Date) => number | null;
  /** The zone's short name at `date` (`CST`, `GMT+5:30`), or `null`. */
  shortName: (date: Date) => string | null;
};

/**
 * A {@link ZoneClock} for `timeZone`, or `null` when the runtime cannot resolve
 * it as an IANA zone.
 *
 * `null` is a real answer, not an error: a caller that cannot read the wall
 * clock must fall back to the UTC single-event export rather than guess.
 */
export function createZoneClock(
  timeZone: string | null | undefined,
): ZoneClock | null {
  if (!timeZone) return null;

  let fields: Intl.DateTimeFormat;
  let name: Intl.DateTimeFormat;
  try {
    fields = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // `hourCycle: "h23"` rather than `hour12: false`: the latter still yields
      // hour "24" for midnight on some engines, which is not a legal iCal
      // DATE-TIME. The `% 24` below is belt for older runtimes.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    });
  } catch {
    return null;
  }

  const read = (date: Date): ZonedFields | null => {
    if (Number.isNaN(date.getTime())) return null;
    const parts = fields.formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): string | null =>
      parts.find((part) => part.type === type)?.value ?? null;

    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    if (!year || !month || !day || !hour || !minute || !second) return null;
    // A 4-digit year is an iCal DATE requirement; `Intl` widens it outside
    // 1000–9999, which no event has but a corrupt row could.
    if (year.length !== 4) return null;

    return {
      year,
      month,
      day,
      hour: String(Number(hour) % 24).padStart(2, "0"),
      minute,
      second,
    };
  };

  return {
    timeZone,
    wallTime: (date) => {
      const f = read(date);
      return f
        ? `${f.year}${f.month}${f.day}T${f.hour}${f.minute}${f.second}`
        : null;
    },
    offsetMinutes: (date) => {
      const f = read(date);
      if (!f) return null;
      // The zone's wall clock re-read AS IF it were UTC, minus the real
      // instant, is the offset. Truncating the instant to whole seconds keeps
      // sub-second noise out of the difference.
      const asUtc = Date.UTC(
        Number(f.year),
        Number(f.month) - 1,
        Number(f.day),
        Number(f.hour),
        Number(f.minute),
        Number(f.second),
      );
      const instant = Math.floor(date.getTime() / 1000) * 1000;
      return (asUtc - instant) / 60_000;
    },
    shortName: (date) => {
      if (Number.isNaN(date.getTime())) return null;
      return (
        name
          .formatToParts(date)
          .find((part) => part.type === "timeZoneName")?.value ?? null
      );
    },
  };
}

type ZonedFields = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

/** `-360` → `-0600`, `330` → `+0530`, `0` → `+0000`. The iCal UTC-OFFSET form. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
}
