/**
 * `iso` when it parses to a real moment, otherwise `undefined`. It accepts any
 * string `Date` can parse; callers pass ISO, and should, since engines parse
 * other forms differently.
 *
 * `Intl.DateTimeFormat#format` and `Date#toISOString` both throw a RangeError
 * on an Invalid Date, so one unreadable date string formatted unchecked takes
 * the whole page down. A caller treats an unreadable date exactly as an absent
 * one, which every date surface already renders ("Date not set", TBA, no
 * calendar link).
 */
export function readableIso(
  iso: string | null | undefined,
): string | undefined {
  if (!iso) return undefined;
  return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
}

/** The ISO string of `date`, or `undefined` for a missing or Invalid Date. */
export function readableDateIso(
  date: Date | null | undefined,
): string | undefined {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}
