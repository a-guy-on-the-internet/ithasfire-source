/**
 * The one-line window of a volunteer ask, shared by the dashboard list, the
 * manage page and the public page.
 *
 * An ask with a stated zone renders in THAT zone, with date and time, and
 * names the zone: "Oct 24, 2026, 6:00 – 10:00 PM EDT" when both ends fall on
 * one day (date and zone printed once), "Oct 24, 2026, 6:00 PM EDT – Oct 25,
 * 2026, 10:00 PM EDT" across days, "From Oct 24, 2026, 6:00 PM EDT" with one
 * end. A volunteer in another zone can tell the time is
 * the organiser's, and the server (UTC) and the browser print the same text.
 * An ask with no zone (made before zones existed), or one whose zone this
 * runtime cannot read, keeps the old date-only rendering in the viewer's zone.
 */

type DateTimeFormatter = (
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
) => string;

/** The two members of `useFormatters()` this needs. */
type Formatters = { locale: string; dateTime: DateTimeFormatter };

type Translate = (key: string, values?: Record<string, string>) => unknown;

const ZONED_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

const toValidDate = (value: Date | string | null): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function zonedLabel(
  { locale, dateTime: fmt }: Formatters,
  t: Translate,
  starts: Date | null,
  ends: Date | null,
  timeZone: string,
): string | null {
  const named: Intl.DateTimeFormatOptions = {
    ...ZONED_OPTIONS,
    timeZone,
    timeZoneName: "short",
  };
  if (starts && ends) {
    // formatRange collapses the parts both ends share (the date, and the
    // zone name, which it prints once).
    return new Intl.DateTimeFormat(locale, named).formatRange(starts, ends);
  }
  if (starts)
    return String(t("volunteering.askWindowFrom", { date: fmt(starts, named) }));
  if (ends)
    return String(t("volunteering.askWindowUntil", { date: fmt(ends, named) }));
  return null;
}

function legacyLabel(
  fmt: DateTimeFormatter,
  t: Translate,
  starts: Date | null,
  ends: Date | null,
): string | null {
  if (starts && ends) return `${fmt(starts)} → ${fmt(ends)}`;
  if (starts)
    return String(t("volunteering.askWindowFrom", { date: fmt(starts) }));
  if (ends) return String(t("volunteering.askWindowUntil", { date: fmt(ends) }));
  return null;
}

export function formatAskWindow(
  fmt: Formatters,
  t: Translate,
  ask: {
    startsAt: Date | string | null;
    endsAt: Date | string | null;
    timezone?: string | null;
  },
): string | null {
  const starts = toValidDate(ask.startsAt);
  const ends = toValidDate(ask.endsAt);
  if (ask.timezone) {
    try {
      return zonedLabel(fmt, t, starts, ends, ask.timezone);
    } catch {
      /* unreadable zone: fall through to the viewer's own zone */
    }
  }
  return legacyLabel(fmt.dateTime, t, starts, ends);
}
