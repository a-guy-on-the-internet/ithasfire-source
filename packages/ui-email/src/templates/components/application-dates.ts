import { usableTimeZone } from "../../lib/event-time-zone";

/**
 * Date labels for the application emails, always in the EVENT's timezone so
 * the reader sees the organizer's local clock. A missing, unknown or invalid
 * IANA zone falls back to the platform default (`usableTimeZone`, matching
 * core's plain-text part) rather than throwing mid-render, and an unparseable
 * timestamp returns null so the caller drops the row.
 */
const format = (
  iso: string,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string | null,
): string | null => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: usableTimeZone(timeZone),
  }).format(date);
};

/** "Tue, Sep 29" */
export const formatShortDate = (
  iso: string,
  timeZone?: string | null,
): string | null =>
  format(iso, { weekday: "short", month: "short", day: "numeric" }, timeZone);

/** "Tue, Oct 6, 7:30 PM PDT": the zone abbreviation is part of the label. */
export const formatLinkExpiry = (
  iso: string,
  timeZone?: string | null,
): string | null =>
  format(
    iso,
    {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    },
    timeZone,
  );
