/**
 * Shared event-date formatting utilities.
 *
 * These pure functions replace 9+ duplicate `Intl.DateTimeFormat` wrappers
 * scattered across web, mobile, and email surfaces.
 *
 * They work in any environment (Node, browser, React Email, React Native)
 * because they only depend on the standard `Intl` API.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface FormatEventDateOptions {
  /** BCP 47 locale tag (default `"en"`). */
  locale?: string;
  /** IANA timezone, e.g. `"America/Los_Angeles"`. Falls back to runtime default. */
  timeZone?: string;
}

export interface FormatEventTimeRangeOptions extends FormatEventDateOptions {
  /**
   * When start and end fall on the same calendar day (in the given timezone),
   * collapse the range to `"<full start> – <end time>"`.
   *
   * @default true
   */
  collapseSameDay?: boolean;
}

export interface FormatEventDateShortOptions {
  /** BCP 47 locale tag (default `"en"`). */
  locale?: string;
  /** IANA timezone. Falls back to runtime default. */
  timeZone?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const toDate = (value: Date | string | number): Date =>
  value instanceof Date ? value : new Date(value);

/**
 * Build `Intl.DateTimeFormatOptions` with an optional timezone.
 * Returning `undefined` for `timeZone` lets the runtime use the host default.
 */
const withTz = (
  base: Intl.DateTimeFormatOptions,
  timeZone?: string,
): Intl.DateTimeFormatOptions => ({
  ...base,
  ...(timeZone ? { timeZone } : {}),
});

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Full event date + time, e.g. **"Saturday, September 20, 2025, 6:00 PM"**.
 *
 * Used for event detail pages, email templates, ticket confirmations, etc.
 *
 * Falls back gracefully when the `timeZone` string is invalid.
 */
export function formatEventDate(
  value: Date | string | number,
  options: FormatEventDateOptions = {},
): string {
  const { locale = "en", timeZone } = options;
  const date = toDate(value);

  try {
    return new Intl.DateTimeFormat(
      locale,
      withTz({ dateStyle: "full", timeStyle: "short" }, timeZone),
    ).format(date);
  } catch {
    // Invalid timezone — fall back without it
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
    }).format(date);
  }
}

/**
 * Smart date-time range that collapses same-day events.
 *
 * - Single date → `"Saturday, September 20, 2025, 6:00 PM"`
 * - Same day → `"Saturday, September 20, 2025, 6:00 PM – 11:00 PM"`
 * - Multi-day → `"Saturday, September 20, 2025, 6:00 PM – Sunday, September 21, 2025, 2:00 AM"`
 */
export function formatEventTimeRange(
  startsAt: Date | string | number,
  endsAt?: Date | string | number | null,
  options: FormatEventTimeRangeOptions = {},
): string {
  const { locale = "en", timeZone, collapseSameDay = true } = options;

  const startStr = formatEventDate(startsAt, { locale, timeZone });

  if (!endsAt) return startStr;

  const startDate = toDate(startsAt);
  const endDate = toDate(endsAt);

  if (collapseSameDay && isSameDay(startDate, endDate, locale, timeZone)) {
    // Only show the end time
    try {
      const endTime = new Intl.DateTimeFormat(
        locale,
        withTz({ timeStyle: "short" }, timeZone),
      ).format(endDate);
      return `${startStr} \u2013 ${endTime}`;
    } catch {
      const endTime = new Intl.DateTimeFormat(locale, {
        timeStyle: "short",
      }).format(endDate);
      return `${startStr} \u2013 ${endTime}`;
    }
  }

  return `${startStr} \u2013 ${formatEventDate(endsAt, { locale, timeZone })}`;
}

/**
 * Short card-style date, e.g. **"Sat, Sep 20, 6:00 PM"**.
 *
 * Used on event cards, list rows, and anywhere space is tight.
 */
export function formatEventDateShort(
  value: Date | string | number,
  options: FormatEventDateShortOptions = {},
): string {
  const { locale = "en", timeZone } = options;
  const date = toDate(value);

  try {
    return new Intl.DateTimeFormat(
      locale,
      withTz(
        {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
        },
        timeZone,
      ),
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).format(date);
  }
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Check whether two dates fall on the same calendar day in a given timezone.
 *
 * Uses `Intl.DateTimeFormat` with `dateStyle: "short"` so the comparison
 * respects the target timezone (e.g. an event at 1 AM UTC might still be
 * "yesterday" in America/Los_Angeles).
 */
function isSameDay(
  a: Date,
  b: Date,
  locale: string,
  timeZone?: string,
): boolean {
  try {
    const fmt = new Intl.DateTimeFormat(
      locale,
      withTz({ year: "numeric", month: "2-digit", day: "2-digit" }, timeZone),
    );
    return fmt.format(a) === fmt.format(b);
  } catch {
    // Fallback: compare in local timezone
    return a.toDateString() === b.toDateString();
  }
}
