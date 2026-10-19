/**
 * Aggregate suppression primitives.
 *
 * Pure, dependency-free math for anonymity-preserving public aggregates:
 * k-threshold gating, bucket rounding, percentage stepping, top-coding, and
 * count-band display. Shared per FR-009 of the place-review-anonymization
 * spec: domain constants (thresholds, bucket sizes, cadences) live in each
 * domain's policy module (e.g. place-reviews/anonymization-policy.ts,
 * deal-terms suppression-policy) — only the math lives here.
 *
 * Everything in this module is deterministic and side-effect free.
 */

// ---------------------------------------------------------------------------
// k-threshold gating
// ---------------------------------------------------------------------------

/**
 * True when a slice backed by `distinctCount` underlying contributions meets
 * the k-anonymity threshold `min`.
 */
export function passesThreshold(distinctCount: number, min: number): boolean {
  return distinctCount >= min;
}

/**
 * Slice-or-omit helper: returns `value` when the threshold is met, otherwise
 * `undefined`. Callers spread the result so a suppressed slice is ABSENT from
 * the output object — never zeroed, nulled, or placeholder-ed (an explicit
 * null still tells a watcher "there is data here, just below k").
 *
 * Usage: `...gateSlice(n, MIN, { payout: {...} })`
 */
export function gateSlice<T extends object>(
  distinctCount: number,
  min: number,
  value: T,
): T | Record<string, never> {
  return passesThreshold(distinctCount, min) ? value : {};
}

// ---------------------------------------------------------------------------
// Bucket rounding
// ---------------------------------------------------------------------------

/**
 * Rounds `value` to the nearest multiple of `bucketSize` using round-half-up
 * (`Math.round` semantics on the bucket quotient: exact halves round toward
 * +Infinity, so 1250 with a 2500 bucket → 2500). Chosen over half-to-even
 * for predictability — the goal is lossiness, not statistical neutrality.
 *
 * Negative values are accepted (this module is shared; future callers may
 * feed signed values, e.g. deltas or refunds) and follow the same
 * toward-+Infinity half rule: -3750/2500 → -2500, while -1250/2500 → 0.
 * The magnitude of a negative half-bucket therefore rounds toward zero —
 * NOT symmetric with the positive side. A value in (-bucketSize/2, 0]
 * yields JavaScript's -0, which compares equal to 0 (`-0 === 0`).
 *
 * Integer math on integer inputs (e.g. cents): no floats leak into results
 * as long as `bucketSize` is a positive integer.
 */
export function roundToBucket(value: number, bucketSize: number): number {
  if (!Number.isFinite(value)) throw new Error("roundToBucket: value not finite");
  if (!Number.isInteger(bucketSize) || bucketSize <= 0) {
    throw new Error("roundToBucket: bucketSize must be a positive integer");
  }
  return Math.round(value / bucketSize) * bucketSize;
}

/**
 * Rounds a percentage to the nearest multiple of `step` (round-half-up, same
 * semantics as {@link roundToBucket}) and clamps the result to [0, 100].
 */
export function roundPercentToStep(pct: number, step: number): number {
  const rounded = roundToBucket(pct, step);
  return Math.min(100, Math.max(0, rounded));
}

// ---------------------------------------------------------------------------
// Top-coding
// ---------------------------------------------------------------------------

/**
 * Top-codes an outlier: values above `ceiling` collapse to the ceiling so a
 * single extreme contribution can't identify its contributor. The flag lets
 * display layers render "$500+" style affordances.
 */
export function topCode(
  value: number,
  ceiling: number,
): { value: number; topCoded: boolean } {
  if (value > ceiling) return { value: ceiling, topCoded: true };
  return { value, topCoded: false };
}

// ---------------------------------------------------------------------------
// Count bands
// ---------------------------------------------------------------------------

/**
 * Displays a count as a band once it passes the first band boundary:
 * exact below `bands[0]`, otherwise "<band>+" for the largest band ≤ n.
 *
 * `bands` must be ascending positive integers, e.g. [20, 50]:
 *   19 → "19", 20 → "20+", 49 → "20+", 50 → "50+", 500 → "50+".
 */
export function toCountBand(n: number, bands: readonly number[]): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("toCountBand: n must be a non-negative integer");
  }
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]!;
    if (!Number.isInteger(band) || band <= 0 || (i > 0 && band <= bands[i - 1]!)) {
      throw new Error("toCountBand: bands must be ascending positive integers");
    }
  }
  let matched: number | null = null;
  for (const band of bands) {
    if (n >= band) matched = band;
  }
  return matched === null ? String(n) : `${matched}+`;
}
