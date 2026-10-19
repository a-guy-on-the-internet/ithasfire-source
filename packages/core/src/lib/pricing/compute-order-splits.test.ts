import { describe, expect, it } from "vitest";

import { computeOrderSplits } from "./compute-order-splits";

type Line = Parameters<typeof computeOrderSplits>[0]["lines"][number];

const line = (payeeId: string, percent: number): Line => ({
  id: payeeId,
  payeeId,
  percent,
  capPercent: null,
  priority: 0,
  rounding: "FLOOR",
});

describe("computeOrderSplits", () => {
  it("always sums exactly to the order basis (it is a distribution)", () => {
    for (const [amountCents, lines] of [
      [100_000, [line("a", 50), line("b", 50)]],
      [7, [line("a", 33), line("b", 33), line("c", 34)]],
      [0, [line("a", 50), line("b", 50)]],
      [5_000, [line("a", 20), line("b", 80)]],
    ] as const) {
      const out = computeOrderSplits({ amountCents, lines: [...lines] });
      expect(out.totalCents).toBe(amountCents);
    }
  });

  // 2026-08: per-order `floorCents` is no longer honoured. It never could be —
  // raising a line to its floor pushed the total over the basis and
  // `distributeRemainder` eroded it back, so a $600 floor on a 50/50 split of
  // a $1000 order paid $550 and docked the payee with NO floor. Deals are
  // recorded, not executed; minimums are settled off-platform.
  it("ignores a floorCents still present on a stored line (rows are inert, not rejected)", () => {
    const withStaleFloor = {
      ...line("artist", 50),
      floorCents: 60_000, // old $600 floor, above the line's $500 share
    } as Line;

    const out = computeOrderSplits({
      amountCents: 100_000,
      lines: [withStaleFloor, line("venue", 50)],
    });

    expect(out.splits).toEqual([
      { payeeId: "artist", amountCents: 50_000 },
      { payeeId: "venue", amountCents: 50_000 },
    ]);
    expect(out.totalCents).toBe(100_000);
  });

  it("does not throw when a line carries extra persisted fields (Zod strips, checkout keeps working)", () => {
    const dbShaped = {
      ...line("a", 100),
      floorCents: 12_345,
      requiresConfirmation: false,
      confirmationStatus: null,
    } as unknown as Line;

    expect(() =>
      computeOrderSplits({ amountCents: 10_000, lines: [dbShaped] }),
    ).not.toThrow();
  });

  it("orders by priority desc, then payeeId, and hands the odd penny to the first line", () => {
    const out = computeOrderSplits({
      amountCents: 101,
      lines: [
        { ...line("zzz", 50), priority: 0 },
        { ...line("aaa", 50), priority: 0 },
      ],
    });
    expect(out.splits.map((s) => s.payeeId)).toEqual(["aaa", "zzz"]);
    expect(out.splits.map((s) => s.amountCents)).toEqual([51, 50]);
  });

  // Regression pins for the 2026-09 cap fix. These are the exact multi-line,
  // odd-cent shapes the fix could have moved; every number here is the output
  // of the PRE-fix code as well, so a change to any of them is a change to
  // live settlement math.
  it("uncapped splits are unchanged by cap-aware distribution", () => {
    for (const [amountCents, lines, expected] of [
      [100_000, [line("a", 50), line("b", 50)], [50_000, 50_000]],
      [7, [line("a", 33), line("b", 33), line("c", 34)], [3, 2, 2]],
      [
        10_001,
        [line("a", 33), line("b", 33), line("c", 34)],
        [3_301, 3_300, 3_400],
      ],
      [5_000, [line("a", 20), line("b", 80)], [1_000, 4_000]],
      [
        999,
        [line("a", 15), line("b", 35), line("c", 50)],
        [150, 350, 499],
      ],
      [3, [line("a", 25), line("b", 25), line("c", 25), line("d", 25)], [1, 1, 1, 0]],
      [1, [line("a", 50), line("b", 50)], [1, 0]],
      [0, [line("a", 50), line("b", 50)], [0, 0]],
    ] as const) {
      const out = computeOrderSplits({ amountCents, lines: [...lines] });
      expect(
        out.splits.map((s) => s.amountCents),
        `basis=${amountCents}`,
      ).toEqual([...expected]);
      expect(out.totalCents).toBe(amountCents);
    }
  });

  describe("capPercent", () => {
    const capped = (payeeId: string, percent: number, capPercent: number) => ({
      ...line(payeeId, percent),
      capPercent,
    });

    // The live bug (fixed 2026-09): the cap clamped the line, the clamp made a
    // big remainder, and the remainder pass — which had no idea any line had
    // been capped — handed it straight back. "Venue takes 20%, capped at 5%"
    // on a $100 net order paid the venue $12.50 against a $5.00 cap.
    it("pays a 5%-capped line its cap, not 2.5x it", () => {
      const out = computeOrderSplits({
        amountCents: 10_000,
        lines: [capped("aaa-venue", 20, 5), line("bbb-organiser", 80)],
      });

      expect(out.splits).toEqual([
        { payeeId: "aaa-venue", amountCents: 500 },
        { payeeId: "bbb-organiser", amountCents: 9_500 },
      ]);
      expect(out.totalCents).toBe(10_000);
    });

    // The worse arm of the same bug: the tighter the cap, the bigger the
    // remainder handed back. A 1% cap on a 50/50 split paid $25.50 against a
    // $1.00 cap — 25.5x.
    it("pays a 1%-capped line its cap, not 25.5x it", () => {
      const out = computeOrderSplits({
        amountCents: 10_000,
        lines: [capped("aaa-capped", 50, 1), line("bbb", 50)],
      });

      expect(out.splits).toEqual([
        { payeeId: "aaa-capped", amountCents: 100 },
        { payeeId: "bbb", amountCents: 9_900 },
      ]);
      expect(out.totalCents).toBe(10_000);
    });

    it("still sums to the basis when a capped line sits last in sort order", () => {
      const out = computeOrderSplits({
        amountCents: 10_000,
        lines: [line("aaa", 80), capped("zzz-venue", 20, 5)],
      });

      expect(out.splits).toEqual([
        { payeeId: "aaa", amountCents: 9_500 },
        { payeeId: "zzz-venue", amountCents: 500 },
      ]);
      expect(out.totalCents).toBe(10_000);
    });

    it("spreads the withheld remainder round-robin over the uncapped lines", () => {
      const out = computeOrderSplits({
        amountCents: 10_001,
        lines: [capped("aaa", 34, 1), line("bbb", 33), line("ccc", 33)],
      });

      // aaa is pinned to round(10001 * 1%) = 100. bbb/ccc floor to 3300 each
      // and share the 3301c shortfall one cent at a time from the top.
      expect(out.splits).toEqual([
        { payeeId: "aaa", amountCents: 100 },
        { payeeId: "bbb", amountCents: 4_951 },
        { payeeId: "ccc", amountCents: 4_950 },
      ]);
      expect(out.totalCents).toBe(10_001);
    });

    it("is inert when the cap is above the line's own share", () => {
      const withSlackCap = computeOrderSplits({
        amountCents: 10_000,
        lines: [capped("aaa", 20, 50), line("bbb", 80)],
      });
      const withoutCap = computeOrderSplits({
        amountCents: 10_000,
        lines: [line("aaa", 20), line("bbb", 80)],
      });

      expect(withSlackCap.splits).toEqual(withoutCap.splits);
    });

    // Unreachable in practice — `SPLITS_CAPS_UNSATISFIABLE` refuses an
    // all-capped set whose Σ capPercent falls short of 100% at publish AND at
    // every terms editor — but terms predating those gates can still be in
    // force, so the behaviour is pinned: the shortfall stays unallocated, and
    // `unallocatedCents` SAYS SO. It must NOT hang and must NOT throw: this
    // runs inside `finalizePaymentIntent`, after the buyer has been charged.
    it("leaves the residue unallocated when every line is capped (no hang, no throw)", () => {
      const out = computeOrderSplits({
        amountCents: 10_000,
        lines: [capped("aaa", 50, 10), capped("bbb", 50, 10)],
      });

      expect(out.splits).toEqual([
        { payeeId: "aaa", amountCents: 1_000 },
        { payeeId: "bbb", amountCents: 1_000 },
      ]);
      expect(out.totalCents).toBe(2_000);
      expect(out.totalCents).toBeLessThan(10_000);
      // The shortfall is REPORTED, not swallowed. Without this the short rows
      // are written, credited, and then checked against themselves by
      // `verifyLedgerInvariants` — every downstream check green, every payee
      // under-paid.
      expect(out.unallocatedCents).toBe(8_000);
    }, 5_000);

    it("handles a 0% cap without hanging", () => {
      const out = computeOrderSplits({
        amountCents: 10_000,
        lines: [capped("aaa", 100, 0)],
      });

      expect(out.splits).toEqual([{ payeeId: "aaa", amountCents: 0 }]);
      expect(out.totalCents).toBe(0);
      expect(out.unallocatedCents).toBe(10_000);
    }, 5_000);

    // One uncapped line is enough: the remainder pass never skips it, so the
    // basis is always fully allocated. This is the property the publish gate
    // has to encode — its first cut assumed the opposite and refused this set.
    it("allocates the whole basis whenever any line is uncapped", () => {
      for (const [capPercent, cappedPct, otherPct] of [
        [5, 20, 80],
        [1, 50, 50],
        [0, 30, 70],
        [50, 99, 1],
      ] as const) {
        const out = computeOrderSplits({
          amountCents: 10_000,
          lines: [capped("aaa", cappedPct, capPercent), line("bbb", otherPct)],
        });
        expect(out.unallocatedCents, `cap=${capPercent}`).toBe(0);
        expect(out.totalCents, `cap=${capPercent}`).toBe(10_000);
      }
    });
  });
});
