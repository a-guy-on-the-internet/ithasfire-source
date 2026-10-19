import { describe, expect, it } from "vitest";

import { reconcile, type ReconciliationInput } from "../reconciliation";

const base: ReconciliationInput = {
  balanceCents: 1564,
  payableCents: 500,
  payableResolved: true,
  upcoming: [{ creditCents: 1064 }],
  upcomingTruncated: false,
  upcomingTrancheCount: 1,
  upcomingResolved: true,
};

describe("reconcile", () => {
  it("asserts Σ tranches = balance only when it is exactly true", () => {
    expect(
      reconcile({ ...base, balanceCents: 1064, payableCents: 0 }),
    ).toEqual({ kind: "exact", parts: [1064], balanceCents: 1064 });
  });

  it("adds the ready figure when Σ tranches + payable = balance", () => {
    expect(reconcile(base)).toEqual({
      kind: "with-ready",
      parts: [1064],
      readyCents: 500,
      balanceCents: 1564,
    });
  });

  it("states the share and asserts no equation when neither identity holds", () => {
    // A hold or a carried debt breaks both identities.
    expect(reconcile({ ...base, balanceCents: 1700 })).toEqual({
      kind: "partial",
      sumCents: 1064,
      balanceCents: 1700,
    });
    // An unresolved payable can never be a term in an equation.
    expect(
      reconcile({ ...base, payableCents: null, payableResolved: false }),
    ).toEqual({ kind: "partial", sumCents: 1064, balanceCents: 1564 });
    // A carried debt (negative payable) is not "ready" either.
    expect(
      reconcile({ ...base, payableCents: -200, balanceCents: 864 }),
    ).toEqual({ kind: "partial", sumCents: 1064, balanceCents: 864 });
  });

  it("never sums a list that is cut or unread", () => {
    expect(
      reconcile({ ...base, upcomingTruncated: true, upcomingTrancheCount: 30 }),
    ).toEqual({ kind: "truncated", shown: 1, total: 30 });
    expect(
      reconcile({ ...base, upcomingResolved: false, upcoming: [] }),
    ).toEqual({ kind: "unresolved" });
    // Unresolved wins over truncated: nothing was read to be cut.
    expect(
      reconcile({ ...base, upcomingResolved: false, upcomingTruncated: true }),
    ).toEqual({ kind: "unresolved" });
  });

  it("an empty horizon is its own sentence, not '$0 = $0'", () => {
    expect(
      reconcile({ ...base, upcoming: [], balanceCents: 0, payableCents: 0 }),
    ).toEqual({ kind: "empty" });
  });
});
