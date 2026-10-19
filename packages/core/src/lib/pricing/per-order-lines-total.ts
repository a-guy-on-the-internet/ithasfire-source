/**
 * What the per-order payout lines of a terms row add up to — and the guard
 * that terms being put in force divide each order the way they should (P4b
 * review B1).
 *
 * A deal write always leaves its per-order lines at exactly 100% (the
 * remainder holder is paid "the rest"), and marks the terms by storing a
 * remainder holder. On DEAL-WRITTEN terms anything but 100% means the lines
 * were changed underneath the deal — two concurrent writes that each added
 * their own set, say — and the per-order engine would quietly normalise it
 * (`distributeRemainder`: over 100% it claws cents back round-robin, under
 * 100% it hands the gap out round-robin). Neither is the deal.
 *
 * LEGACY terms (no stored remainder) have never been held to 100%: the
 * booking line editor caps them at 100 and publish reconciles only
 * split-flow terms, within ±1 (101% publishes today, by design). So:
 *   - booking-agreement finalize (`assertPerOrderLinesForActivation`):
 *     deal-written terms exactly 100%; legacy terms never over 100% — no
 *     booking editor can produce more, and 80% + 10% finalizes as it did;
 *   - event publish: deal-written terms exactly 100%
 *     (`assertPerOrderLinesTotal100`); legacy terms keep publish's own ±1
 *     reconcile, unchanged.
 */
import { fail } from "@th/errors";

export const PER_ORDER_LINES_TARGET_PCT = 100;

export function perOrderLinesTotalPercent(
  lines: ReadonlyArray<{ percent: number }>,
): number {
  return lines.reduce((sum, line) => sum + line.percent, 0);
}

export function assertPerOrderLinesTotal100(
  lines: ReadonlyArray<{ percent: number }>,
  meta: Record<string, unknown> = {},
): void {
  const totalPercent = perOrderLinesTotalPercent(lines);
  if (totalPercent !== PER_ORDER_LINES_TARGET_PCT) {
    throw fail("PAYOUT_LINES_TOTAL_INVALID", {
      meta: { ...meta, totalPercent, targetPct: PER_ORDER_LINES_TARGET_PCT },
    });
  }
}

export function assertPerOrderLinesForActivation(
  lines: ReadonlyArray<{ percent: number }>,
  terms: { remainderPayeeId?: string | null } | null,
  meta: Record<string, unknown> = {},
): void {
  if (terms?.remainderPayeeId) assertPerOrderLinesTotal100(lines, meta);
  else assertPerOrderLinesNotOver100(lines, meta);
}

export function assertPerOrderLinesNotOver100(
  lines: ReadonlyArray<{ percent: number }>,
  meta: Record<string, unknown> = {},
): void {
  const totalPercent = perOrderLinesTotalPercent(lines);
  if (totalPercent > PER_ORDER_LINES_TARGET_PCT) {
    throw fail("PAYOUT_LINES_TOTAL_INVALID", {
      meta: { ...meta, totalPercent, targetPct: PER_ORDER_LINES_TARGET_PCT },
    });
  }
}
