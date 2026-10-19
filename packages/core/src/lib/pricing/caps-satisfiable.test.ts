import { describe, expect, it } from "vitest";

import {
  assessCapSatisfiability,
  isCompleteAllocation,
  SPLITS_TARGET_PCT,
} from "./caps-satisfiable";
import { computeOrderSplits } from "./compute-order-splits";

const line = (
  id: string,
  percent: number,
  capPercent: number | null = null,
) => ({ id, percent, capPercent });

describe("assessCapSatisfiability", () => {
  // The regression this file exists for. `publishEvent` refused this exact
  // deal — Σ min(percent, cap) = 5 + 80 = 85 — while `computeOrderSplits`
  // distributes it to the cent. The gate's premise (a capped line's forgone
  // share is permanently lost) is false whenever any line is uncapped.
  it("accepts a capped line beside an uncapped one — the canonical venue deal", () => {
    const lines = [line("venue", 20, 5), line("organiser", 80)];

    expect(assessCapSatisfiability(lines).satisfiable).toBe(true);

    // Proven against the math it is supposed to describe, not asserted.
    const splits = computeOrderSplits({
      amountCents: 10_000,
      lines: lines.map((l) => ({
        id: l.id,
        payeeId: l.id,
        percent: l.percent,
        capPercent: l.capPercent,
      })),
    });
    expect(splits.totalCents).toBe(10_000);
    expect(splits.unallocatedCents).toBe(0);
  });

  it("accepts however tight the cap gets, as long as one line is uncapped", () => {
    for (const capPercent of [0, 1, 5, 50, 99]) {
      const lines = [line("capped", 50, capPercent), line("uncapped", 50)];
      expect(
        assessCapSatisfiability(lines).satisfiable,
        `cap=${capPercent}`,
      ).toBe(true);

      const splits = computeOrderSplits({
        amountCents: 10_000,
        lines: lines.map((l) => ({
          id: l.id,
          payeeId: l.id,
          percent: l.percent,
          capPercent: l.capPercent,
        })),
      });
      expect(splits.unallocatedCents, `cap=${capPercent}`).toBe(0);
    }
  });

  it("refuses an all-capped set whose caps cannot reach the target", () => {
    const report = assessCapSatisfiability([
      line("a", 60, 10),
      line("b", 40, 40),
    ]);

    expect(report.satisfiable).toBe(false);
    expect(report.everyLineCapped).toBe(true);
    expect(report.totalCapPct).toBe(50);
    expect(report.totalPercent).toBe(100);
    expect(report.cappedLineIds).toEqual(["a"]);
  });

  // The set the ±1 tolerance let through. It publishes, then drops 100c of
  // every 10 000c order — forever, silently. No tolerance on caps.
  it("refuses an all-capped set that is short by exactly one point", () => {
    const lines = [line("a", 50, 50), line("b", 50, 49)];

    expect(assessCapSatisfiability(lines).satisfiable).toBe(false);

    const splits = computeOrderSplits({
      amountCents: 10_000,
      lines: lines.map((l) => ({
        id: l.id,
        payeeId: l.id,
        percent: l.percent,
        capPercent: l.capPercent,
      })),
    });
    expect(splits.totalCents).toBe(9_900);
    expect(splits.unallocatedCents).toBe(100);
  });

  it("accepts an all-capped set whose caps DO reach the target", () => {
    // Σ min(percent, cap) is 20 + 60 = 80 here, so the old predicate refused
    // it; the caps sum to 120, so the remainder pass fills both lines.
    const lines = [line("a", 20, 60), line("b", 80, 60)];

    expect(assessCapSatisfiability(lines).satisfiable).toBe(true);

    const splits = computeOrderSplits({
      amountCents: 10_000,
      lines: lines.map((l) => ({
        id: l.id,
        payeeId: l.id,
        percent: l.percent,
        capPercent: l.capPercent,
      })),
    });
    expect(splits.totalCents).toBe(10_000);
    expect(splits.unallocatedCents).toBe(0);
  });

  it("accepts an all-capped set that lands exactly on the target", () => {
    expect(
      assessCapSatisfiability([line("a", 50, 50), line("b", 50, 50)])
        .satisfiable,
    ).toBe(true);
  });

  // The one place `satisfiable` is not "zero residue on every basis": the
  // ceilings are FLOORED per line, so a set landing exactly on 100 strands up
  // to (lines − 1) cents on a basis that does not divide evenly. Admitted
  // deliberately — the cent cannot be paid without breaching a cap — and NOT
  // silent, which is the whole point of `unallocatedCents`.
  it("still strands the flooring cent when an exact-100 set meets an odd basis", () => {
    const lines = [line("a", 50, 50), line("b", 50, 50)];
    const asSplitLines = lines.map((l) => ({
      id: l.id,
      payeeId: l.id,
      percent: l.percent,
      capPercent: l.capPercent,
    }));

    expect(assessCapSatisfiability(lines).satisfiable).toBe(true);

    expect(
      computeOrderSplits({ amountCents: 1_000, lines: asSplitLines })
        .unallocatedCents,
    ).toBe(0);

    const odd = computeOrderSplits({ amountCents: 1_001, lines: asSplitLines });
    expect(odd.totalCents).toBe(1_000);
    expect(odd.unallocatedCents).toBe(1);
  });

  it("treats undefined capPercent as uncapped, like the split math does", () => {
    expect(
      assessCapSatisfiability([
        { id: "a", percent: 100 },
        { id: "b", percent: 0, capPercent: 0 },
      ]).satisfiable,
    ).toBe(true);
  });

  it("calls an empty set satisfiable — 'no lines' is a different gate", () => {
    const report = assessCapSatisfiability([]);
    expect(report.satisfiable).toBe(true);
    expect(report.everyLineCapped).toBe(false);
  });

  it("agrees with the split math on every shape it judges", () => {
    // The contract in one loop: `satisfiable` is exactly "distributes the
    // whole basis". Anything the predicate accepts must leave zero residue.
    const shapes: Array<Array<ReturnType<typeof line>>> = [
      [line("a", 100)],
      [line("a", 100, 100)],
      [line("a", 100, 50)],
      [line("a", 20, 5), line("b", 80)],
      [line("a", 50, 1), line("b", 50)],
      [line("a", 50, 50), line("b", 50, 50)],
      [line("a", 50, 50), line("b", 50, 49)],
      [line("a", 20, 60), line("b", 80, 60)],
      [line("a", 34, 1), line("b", 33), line("c", 33)],
      [line("a", 34, 34), line("b", 33, 33), line("c", 33, 33)],
      [line("a", 34, 34), line("b", 33, 33), line("c", 33, 32)],
    ];

    for (const lines of shapes) {
      const report = assessCapSatisfiability(lines);
      const splits = computeOrderSplits({
        amountCents: 10_000,
        lines: lines.map((l) => ({
          id: l.id,
          payeeId: l.id,
          percent: l.percent,
          capPercent: l.capPercent,
        })),
      });

      const label = JSON.stringify(lines);
      if (report.satisfiable) {
        // 10 000c divides every percentage in the table evenly, so the
        // flooring edge above cannot fire here.
        expect(splits.unallocatedCents, label).toBe(0);
        expect(splits.totalCents, label).toBe(10_000);
      } else {
        expect(splits.unallocatedCents, label).toBeGreaterThan(0);
      }
    }
  });
});

describe("isCompleteAllocation", () => {
  it("is true at the target and within the integer-storage tolerance", () => {
    expect(isCompleteAllocation([line("a", 100)])).toBe(true);
    expect(
      isCompleteAllocation([line("a", 34), line("b", 33), line("c", 33)]),
    ).toBe(true);
    // 34 + 34 + 33 = 101: the other side of the same rounding.
    expect(
      isCompleteAllocation([line("a", 34), line("b", 34), line("c", 33)]),
    ).toBe(true);
  });

  it("is false for a half-composed draft, so the editors stay usable", () => {
    expect(isCompleteAllocation([line("venue", 20, 5)])).toBe(false);
    expect(isCompleteAllocation([])).toBe(false);
    expect(isCompleteAllocation([line("a", 50), line("b", 20)])).toBe(false);
  });

  it("uses the shared target", () => {
    expect(SPLITS_TARGET_PCT).toBe(100);
  });
});
