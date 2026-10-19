// ─────────────────────────────────────────────────────────────────────────────
// /my-volunteering/hours/print — pure helpers
//
// Row SELECTION and hours ARITHMETIC deliberately do not live here: they live
// in `../../../_components/my-volunteering-helpers`, beside the totals band
// that has to agree with this document. A statement whose figure disagreed
// with the page the volunteer read it from is the exact failure this feature
// exists to avoid, so the two share one `sumCreditedHours` rather than two
// implementations of the same sum.
//
// What IS here is the part only a printed record needs: the period the sheet
// covers.
// ─────────────────────────────────────────────────────────────────────────────

import type { StatementShift } from "../../../_components/my-volunteering-helpers";

export type StatementPeriod = {
  /** Earliest shift on the sheet, epoch ms. */
  startMs: number;
  /** Latest shift on the sheet, epoch ms. */
  endMs: number;
  /** True when every shift falls on one calendar day (viewer's zone). */
  singleDay: boolean;
};

/**
 * The range the statement covers, derived from the shifts actually printed —
 * never from "today minus a year" or any other assumed window.
 *
 * This is a truthfulness constraint, not a formatting one. The document is
 * read by someone deciding whether it accounts for a required period, and a
 * stated range that did not come from the rows below it would be an assertion
 * we cannot back. Rows whose date could not be resolved at all are excluded
 * from the bounds (they cannot narrow or widen a range they have no place in);
 * they still print, and still count as shifts.
 *
 * Returns null when no row carries a usable date, in which case the caller
 * must print no period rather than an invented one.
 */
export function deriveStatementPeriod(
  shifts: readonly StatementShift[],
): StatementPeriod | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const shift of shifts) {
    if (shift.workedAtMs === null) continue;
    if (shift.workedAtMs < startMs) startMs = shift.workedAtMs;
    if (shift.workedAtMs > endMs) endMs = shift.workedAtMs;
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  return {
    startMs,
    endMs,
    singleDay: isSameLocalDay(startMs, endMs),
  };
}

/**
 * Same calendar day in the VIEWER's zone — the same zone the Date column
 * renders in, so "1 shift, 4 Aug – 4 Aug" can never appear.
 */
function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * How many printed shifts carry no hours figure.
 *
 * Drives the footnote. A dash in the Hours column has to be EXPLAINED on the
 * sheet when it occurs — an unexplained blank next to a total invites the
 * reader to assume the row contributed zero, which is a different claim from
 * "this shift has no recorded length".
 */
export function countShiftsWithoutHours(
  shifts: readonly StatementShift[],
): number {
  return shifts.reduce(
    (count, shift) => count + (shift.hours === null ? 1 : 0),
    0,
  );
}
