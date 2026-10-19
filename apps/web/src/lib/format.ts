// ─────────────────────────────────────────────────────────────────────────────
// Currency formatting is owned by @th/core. Re-export the canonical helpers
// here so the existing `@/lib/format` import path keeps working.
// ─────────────────────────────────────────────────────────────────────────────

import {
  formatCents,
  toMajorUnits,
} from "@th/core/lib/currency-utils";

export {
  ZERO_DECIMAL_CURRENCIES,
  isZeroDecimalCurrency,
  toMinorUnits,
  currencyFractionDigits,
  formatCents,
  formatMoneyCents,
  // COMPACT price-label contract (`4500 → "$45"`). Use for browse/discovery
  // price labels; use `formatCents`/`formatMoneyCents` for exact figures.
  formatPriceCents,
} from "@th/core/lib/currency-utils";
export { toMajorUnits };

/**
 * Backwards-compatible alias for the web app. New code should prefer
 * `formatCents` (or `formatMoneyCents` for the options-bag API) from
 * `@th/core/lib/currency-utils`.
 */
export const formatCurrency = formatCents;

/**
 * Format a date to a short string.
 *
 * @param date - The date to format
 * @param locale - Locale for formatting (default: "en-US")
 * @returns Formatted date string (e.g., "Jan 30, 2026")
 */
export function formatDateShort(date: Date | string, locale = "en-US"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format a date and time.
 *
 * @param date - The date to format
 * @param locale - Locale for formatting (default: "en-US")
 * @returns Formatted date/time string (e.g., "Jan 30, 2026 at 7:00 PM")
 */
export function formatDateTime(date: Date | string, locale = "en-US"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Locale-aware formatters (use with `useFormatters()` from @th/ui)
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of `useFormatters()` needed by the date helpers. */
type DateFmt = {
  dateTime: (date: Date, options: Intl.DateTimeFormatOptions) => string;
};

/** Same shape as `DateFmt`, exported for helpers that take a calendar date. */
export type CalendarDateFmt = DateFmt;

/** The subset of `useFormatters()` needed by the currency helper. */
type CurrencyFmt = {
  currency: (amount: number, currency: string) => string;
};

/**
 * Locale-aware currency formatter.
 * Converts minor units (cents) to a display string via the i18n layer.
 * Handles zero-decimal currencies (JPY, KRW, etc.) automatically.
 *
 * @example
 * const fmt = useFormatters();
 * <Text>{fmtCurrency(fmt, order.amountCents, order.currency)}</Text>
 */
export function fmtCurrency(
  fmt: CurrencyFmt,
  minorUnits: number,
  currency: string,
): string {
  return fmt.currency(toMajorUnits(minorUnits, currency), currency);
}

/**
 * Locale-aware date+time formatter.
 * Returns "\u2014" for nullish values.
 *
 * @example
 * const fmt = useFormatters();
 * <Text>{fmtDate(fmt, row.issuedAt)}</Text>
 */
export function fmtDate(
  fmt: DateFmt,
  date: Date | string | null | undefined,
): string {
  if (!date) return "\u2014";
  return fmt.dateTime(new Date(date), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Locale-aware date-only formatter (no time component).
 * Returns "\u2014" for nullish values.
 *
 * @example
 * const fmt = useFormatters();
 * <Text>{fmtDateShort(fmt, row.scheduledPayoutDate)}</Text>
 */
export function fmtDateShort(
  fmt: DateFmt,
  date: Date | string | null | undefined,
): string {
  if (!date) return "\u2014";
  return fmt.dateTime(new Date(date), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Like `fmtDateShort`, for a CALENDAR date (`YYYY-MM-DD`) rather than an
 * instant. Built from UTC noon and pinned to UTC, so the viewer's zone cannot
 * move the day (`new Date("2026-10-12")` is UTC midnight and reads as the 11th
 * anywhere west of Greenwich). Null when the string is malformed or rolls over
 * (`2026-02-31`).
 */
export function fmtCalendarDateShort(
  fmt: DateFmt,
  isoDate: string,
): string | null {
  const match = CALENDAR_DATE.exec(isoDate);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(Number(match[1]), month - 1, day, 12));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return fmt.dateTime(date, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Compact locale-aware date+time formatter for tight table columns.
 * Produces a short numeric date with a 2-digit year and 12-hour time,
 * e.g. "1/30/26, 7:00 PM".
 * Returns "\u2014" for nullish values.
 *
 * @example
 * const fmt = useFormatters();
 * <Text>{fmtDateCompact(fmt, row.occurredAt)}</Text>
 */
export function fmtDateCompact(
  fmt: DateFmt,
  date: Date | string | null | undefined,
): string {
  if (!date) return "\u2014";
  return fmt.dateTime(new Date(date), {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── ID helpers ──────────────────────────────────────────────────────────────

/**
 * Truncate a UUID or long ID for display.
 *
 * @example
 * truncateId("a1b2c3d4-e5f6-7890-abcd-ef1234567890") // "a1b2c3d4..."
 */
export function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/**
 * Truncate a *provider* id (Stripe `evt_`/`pi_`/`acct_`…) keeping BOTH ends.
 *
 * `truncateId` head-truncates, which is right for the v4 UUIDs this codebase
 * mints (random from the first character) and wrong for Stripe ids: they are
 * roughly time-ordered, so events that fail near each other share a long
 * prefix. Three real webhook-DLQ rows captured minutes apart all rendered as
 * `evt_1U1s...` under `truncateId` — indistinguishable in exactly the
 * situation (an incident) where an operator most needs to tell them apart.
 * The *head* is the shared part, so keep an unshared part: the tail.
 *
 * Applies to any time-ordered id, not just Stripe's — cuid v1 (`c` + a base36
 * timestamp) has the same shape. Nothing renders a cuid through `truncateId`
 * today; if one ever lands in an admin table, it belongs here instead.
 *
 * @example
 * truncateProviderId("evt_1U1sWHPGkPy72rZv8YHYiMRp") // "evt_1U1sWH…YiMRp"
 */
export function truncateProviderId(id: string): string {
  // Below this, head+ellipsis+tail is no shorter than the id itself.
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-5)}`;
}

/**
 * Human-readable file-size string (B / KB / MB / GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Quota value formatting ───────────────────────────────────────────────────

export function isStorageKind(kind: string): boolean {
  return kind.startsWith("STORAGE_BYTES");
}

/**
 * Format a quota value for display.
 * Storage kinds (STORAGE_BYTES_*) are shown as MiB / GiB;
 * everything else is a plain locale-formatted number.
 */
export function formatQuotaValue(kind: string, value: string): string {
  const n = BigInt(value);
  if (isStorageKind(kind)) {
    const mb = Number(n) / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`;
    return `${mb.toFixed(0)} MiB`;
  }
  return n.toLocaleString();
}
