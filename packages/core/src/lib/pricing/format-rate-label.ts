/**
 * Format a fee rate as a human-readable label, e.g. "10% + $0.50".
 *
 * - `pct` is a decimal fraction (e.g. 0.10 for 10%).
 * - `fixedCents` is integer cents (e.g. 50 for $0.50).
 *
 * Returns `null` when both components are zero so callers can skip rendering.
 */
export function formatRateLabel(
  pct: number,
  fixedCents: number,
): string | null {
  const pctPart = pct > 0 ? `${+(pct * 100).toFixed(2)}%` : null;
  const fixedPart = fixedCents > 0 ? `$${(fixedCents / 100).toFixed(2)}` : null;

  if (pctPart && fixedPart) return `${pctPart} + ${fixedPart}`;
  if (pctPart) return pctPart;
  if (fixedPart) return fixedPart;
  return null;
}
