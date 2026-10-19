/**
 * Short event dates ("Oct 12") in the EVENT's zone.
 *
 * A Prisma `DateTime` is a UTC instant. An `Intl.DateTimeFormat` with no
 * `timeZone` renders it in the server's zone, which is UTC on Cloud Run, so a
 * 7pm Chicago show (00:00Z the next day) printed tomorrow's date in search
 * results. Every server-side short date for an event goes through here with
 * `Event.timezone`; an unknown or empty zone falls back to
 * `DEFAULT_VENUE_TIMEZONE` via {@link resolveTimeZone}.
 */
import { resolveTimeZone } from "./venue-local-time";

const monthDayFormatters = new Map<string, Intl.DateTimeFormat>();

function monthDayFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = monthDayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
    });
    monthDayFormatters.set(timeZone, f);
  }
  return f;
}

/** "Oct 12": the local month and day of `instant` in the event's zone. */
export function formatEventMonthDay(
  instant: Date,
  timeZone: string | null | undefined,
): string {
  return monthDayFormatterFor(resolveTimeZone(timeZone)).format(instant);
}
