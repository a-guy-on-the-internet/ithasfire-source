// ─────────────────────────────────────────────────────────────────────────────
// The reconciliation line: does "Owed to you" equal the dates listed under it?
//
// It equals them ONLY sometimes. `balanceCents` is everything owed, matured or
// not; the tranches are the part that has NOT matured yet. Money that has
// already matured (the payable) is inside the balance and outside every
// tranche, so the honest identity is usually `Σ tranches + ready = balance`,
// and sometimes neither identity holds (a hold, a carried debt). This helper
// tries the two true equations and, when neither holds, says what the dates
// DO account for rather than asserting a sum the reader could disprove with a
// calculator.
// ─────────────────────────────────────────────────────────────────────────────

export type ReconciliationInput = {
  balanceCents: number;
  payableCents: number | null;
  payableResolved: boolean;
  upcoming: ReadonlyArray<{ creditCents: number }>;
  upcomingTruncated: boolean;
  upcomingTrancheCount: number | null;
  upcomingResolved: boolean;
};

export type Reconciliation =
  /** The maturity read failed: nothing below can be summed. */
  | { kind: "unresolved" }
  /** The list was cut, so the visible rows do not sum to anything. */
  | { kind: "truncated"; shown: number; total: number | null }
  /** Nothing is waiting to mature. */
  | { kind: "empty" }
  /** Σ tranches = balance, exactly. */
  | { kind: "exact"; parts: number[]; balanceCents: number }
  /** Σ tranches + ready now = balance, exactly. */
  | {
      kind: "with-ready";
      parts: number[];
      readyCents: number;
      balanceCents: number;
    }
  /** Neither identity holds; state the share, assert no equation. */
  | { kind: "partial"; sumCents: number; balanceCents: number };

export function reconcile(input: ReconciliationInput): Reconciliation {
  if (!input.upcomingResolved) return { kind: "unresolved" };
  if (input.upcomingTruncated) {
    return {
      kind: "truncated",
      shown: input.upcoming.length,
      total: input.upcomingTrancheCount,
    };
  }
  if (input.upcoming.length === 0) return { kind: "empty" };

  const parts = input.upcoming.map((tranche) => tranche.creditCents);
  const sumCents = parts.reduce((sum, cents) => sum + cents, 0);
  if (sumCents === input.balanceCents) {
    return { kind: "exact", parts, balanceCents: input.balanceCents };
  }
  if (
    input.payableResolved &&
    input.payableCents !== null &&
    input.payableCents > 0 &&
    sumCents + input.payableCents === input.balanceCents
  ) {
    return {
      kind: "with-ready",
      parts,
      readyCents: input.payableCents,
      balanceCents: input.balanceCents,
    };
  }
  return { kind: "partial", sumCents, balanceCents: input.balanceCents };
}
