/**
 * Pure date helpers for the org volunteer hours date-range filter.
 *
 * Kept free of UI imports so they can be unit-tested without pulling in
 * the Tamagui component tree.
 */

/**
 * Parse a `YYYY-MM-DD` value from `<input type="date">` into a Date at
 * local midnight. Returns null for empty/partial input so a half-typed
 * date never reaches the query.
 */
export function dateInputToLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * The `volunteer.hours.orgSummary` API treats `to` as EXCLUSIVE (rows
 * strictly before it), while the date picker expresses an INCLUSIVE end
 * date. Send local midnight of the NEXT day so the picked day stays in
 * range. The Date constructor normalizes day overflow (e.g. Jan 31 + 1 →
 * Feb 1, Dec 31 + 1 → Jan 1 of the next year).
 */
export function inclusiveEndToExclusive(picked: Date): Date {
  return new Date(
    picked.getFullYear(),
    picked.getMonth(),
    picked.getDate() + 1,
  );
}
