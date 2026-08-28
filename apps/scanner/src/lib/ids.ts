/**
 * Idempotency-key generator. The server is the source of truth for
 * uniqueness; this helper only needs to be collision-resistant within
 * the scanner client so two near-simultaneous scans don't get
 * deduplicated against each other.
 *
 * `Date.now()` alone produces collisions when two scans fall in the
 * same millisecond — common when an operator double-taps or when a
 * bulk-scan flow processes a list. Adding 8 base-36 characters of
 * Math.random pushes the same-ms collision probability to ~1 in 2.8e12
 * per pair, which is well past "practically impossible" for the
 * shift-sized workloads we care about.
 */
export const newClientKey = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
