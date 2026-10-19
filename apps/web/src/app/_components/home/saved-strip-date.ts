import { resolveTimeZone } from "@th/core/lib/venue-local-time";

/** The formatter's `dateTime` (`useFormatters` in `@th/ui`). */
type FormatDate = (
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
) => string;

/**
 * A saved event's start, in the viewer's language but in the EVENT's own zone
 * (`timezone`, or `DEFAULT_VENUE_TIMEZONE` when absent or unusable), never the
 * viewer's: everyone going to one show reads the same door time, and the home
 * cards beside the strip print theirs the same way.
 */
export function formatSavedEventDate(
  formatDate: FormatDate,
  startsAt: Date | string,
  timezone: string | null | undefined,
): string {
  return formatDate(new Date(startsAt), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: resolveTimeZone(timezone),
  });
}
