import { describe, expect, it } from "vitest";

import {
  trancheAttributionOptions,
  type TrancheKey,
} from "../tranche-attribution";

// THE INVARIANT under test: the options this returns select exactly the
// credit rows `listUpcomingMaturities` counted into ONE tranche — no more
// (11 Oct rows under a 4 Oct heading) and no fewer (a consumption filter the
// tranche read does not apply).

const AS_OF = new Date("2026-09-16T00:00:00.000Z");
const OCT_4 = new Date("2026-10-04T00:00:00.000Z");
const OCT_11 = new Date("2026-10-11T00:00:00.000Z");

const PAYEE = "payee_1";

const tranche = (over: Partial<TrancheKey> = {}): TrancheKey => ({
  payeeId: PAYEE,
  currency: "usd",
  maturesAt: OCT_4,
  ...over,
});

describe("trancheAttributionOptions", () => {
  it("bounds the FIRST tranche at asOf — the same instant the tranche read used", () => {
    const opts = trancheAttributionOptions({
      tranche: tranche({ maturesAt: OCT_4 }),
      previousTranche: null,
      asOf: AS_OF,
    });

    expect(opts).toEqual({
      currency: "usd",
      types: ["SETTLEMENT_CREDIT"],
      availableAtAfter: AS_OF,
      availableAtBefore: OCT_4,
      excludeBlockedCredits: true,
      limit: undefined,
    });
  });

  it("treats an OMITTED previousTranche as the first tranche", () => {
    const opts = trancheAttributionOptions({
      tranche: tranche(),
      asOf: AS_OF,
    });
    expect(opts.availableAtAfter).toEqual(AS_OF);
  });

  it("bounds a LATER tranche at the previous tranche's maturity, NOT at asOf", () => {
    // The whole point. With `asOf` as the lower bound, this window would also
    // contain every 4 Oct credit, and the 11 Oct heading would be itemised
    // with rows that belong to the tranche above it.
    const opts = trancheAttributionOptions({
      tranche: tranche({ maturesAt: OCT_11 }),
      previousTranche: tranche({ maturesAt: OCT_4 }),
      asOf: AS_OF,
    });

    expect(opts.availableAtAfter).toEqual(OCT_4);
    expect(opts.availableAtBefore).toEqual(OCT_11);
    expect(opts.availableAtAfter).not.toEqual(AS_OF);
  });

  it("produces windows that PARTITION the feed — half-open, nothing shared or dropped", () => {
    const first = trancheAttributionOptions({
      tranche: tranche({ maturesAt: OCT_4 }),
      asOf: AS_OF,
    });
    const second = trancheAttributionOptions({
      tranche: tranche({ maturesAt: OCT_11 }),
      previousTranche: tranche({ maturesAt: OCT_4 }),
      asOf: AS_OF,
    });

    // The first window's INCLUSIVE upper bound is the second's STRICT lower
    // bound. A credit maturing exactly on 4 Oct lands in the first and only
    // the first; that is the asymmetry the options type documents, and it is
    // what makes adjacent tranches a partition rather than an overlap.
    expect(first.availableAtBefore).toEqual(second.availableAtAfter);
  });

  it("always carries the blocked-credit exclusion and the credit type", () => {
    // Both have a counterpart in the tranche read. Anything in this bundle
    // without one breaks the sum.
    const opts = trancheAttributionOptions({ tranche: tranche(), asOf: AS_OF });
    expect(opts.excludeBlockedCredits).toBe(true);
    expect(opts.types).toEqual(["SETTLEMENT_CREDIT"]);
  });

  it("NEVER sets unconsumedOnly — the tranche read applies no consumption filter", () => {
    // Regression guard for the exact divergence this bundle was rewritten to
    // remove: a consumed immature credit is still inside the tranche total,
    // so filtering it out here shows a heading with no sub-lines.
    const opts = trancheAttributionOptions({
      tranche: tranche(),
      previousTranche: tranche({ maturesAt: AS_OF }),
      asOf: AS_OF,
    });
    expect(opts.unconsumedOnly).toBeUndefined();
    expect(Object.keys(opts).sort()).toEqual([
      "availableAtAfter",
      "availableAtBefore",
      "currency",
      "excludeBlockedCredits",
      "limit",
      "types",
    ]);
  });

  it("carries the tranche's own currency, not a default", () => {
    const opts = trancheAttributionOptions({
      tranche: tranche({ currency: "eur" }),
      asOf: AS_OF,
    });
    expect(opts.currency).toBe("eur");
  });

  it("passes limit straight through", () => {
    const opts = trancheAttributionOptions({
      tranche: tranche(),
      asOf: AS_OF,
      limit: 25,
    });
    expect(opts.limit).toBe(25);
  });

  it("REFUSES a previous tranche from another currency", () => {
    // The feed is ordered maturesAt ASC then payeeId then currency, so the
    // previous ROW is routinely another currency. Taking its date would move
    // the window's floor to an unrelated instant.
    expect(() =>
      trancheAttributionOptions({
        tranche: tranche({ currency: "usd", maturesAt: OCT_11 }),
        previousTranche: tranche({ currency: "eur", maturesAt: OCT_4 }),
        asOf: AS_OF,
      }),
    ).toThrow(/tranche_attribution_currency_mismatch/);
  });

  it("REFUSES a previous tranche from another payee", () => {
    expect(() =>
      trancheAttributionOptions({
        tranche: tranche({ maturesAt: OCT_11 }),
        previousTranche: tranche({ payeeId: "payee_2", maturesAt: OCT_4 }),
        asOf: AS_OF,
      }),
    ).toThrow(/tranche_attribution_payee_mismatch/);
  });

  it("REFUSES a non-ascending window rather than returning an empty one", () => {
    // An inverted or empty window renders as "this tranche is made of
    // nothing" — a money view silently showing zero, which is worse than an
    // error a human sees.
    expect(() =>
      trancheAttributionOptions({
        tranche: tranche({ maturesAt: OCT_4 }),
        previousTranche: tranche({ maturesAt: OCT_11 }),
        asOf: AS_OF,
      }),
    ).toThrow(/tranche_attribution_window_not_ascending/);

    expect(() =>
      trancheAttributionOptions({
        tranche: tranche({ maturesAt: OCT_4 }),
        previousTranche: tranche({ maturesAt: OCT_4 }),
        asOf: AS_OF,
      }),
    ).toThrow(/tranche_attribution_window_not_ascending/);
  });
});
