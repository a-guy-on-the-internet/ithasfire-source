/**
 * Helpers for `<input type="datetime-local">` <-> ISO 8601 conversion.
 *
 * Native datetime-local works in the browser's local timezone with the
 * format `YYYY-MM-DDTHH:mm`. Our APIs and Prisma schema use ISO 8601
 * strings (UTC). These helpers bridge the two formats consistently.
 */

/**
 * Upper bounds that cap the year at 4 digits. Without a `max`, Chrome's year
 * segment accepts up to 6 digits, so after typing `2026` the focus stays in the
 * year and the next digits spill into it: the value never commits.
 */
export const DATETIME_LOCAL_MAX = "9999-12-31T23:59";
export const DATE_INPUT_MAX = "9999-12-31";

export function isoToLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Shift by the local timezone offset so toISOString() returns local wall-clock.
  const tzOffsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

export function localInputToIso(
  value: string | undefined | null,
): string | undefined {
  if (!value) return undefined;
  // Native datetime-local interprets `YYYY-MM-DDTHH:mm` as local time when
  // passed to the Date constructor.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
