import { describe, expect, it } from "vitest";

import { distributeRemainder, lineCapCents } from "./distribute-remainder";

/**
 * The remainder pass exactly as it stood before caps were threaded through it
 * (HEAD~ of the 2026-09 cap fix). Kept here as an ORACLE: for any uncapped
 * input the new implementation must emit the identical array. This is the file
 * that would have caught the regression risk of the fix itself — the cap bug
 * was a behaviour change nobody wanted, and so is any drift here.
 */
const legacyDistributeRemainder = (amounts: number[], remainder: number) => {
  if (remainder === 0) return amounts;

  if (remainder > 0) {
    for (let i = 0; remainder > 0; i = (i + 1) % amounts.length) {
      amounts[i] = (amounts[i] ?? 0) + 1;
      remainder -= 1;
    }
  } else {
    const allZero = () => amounts.every((value) => (value ?? 0) === 0);
    for (
      let i = amounts.length - 1;
      remainder < 0;
      i = (i - 1 + amounts.length) % amounts.length
    ) {
      const current = amounts[i] ?? 0;
      if (current === 0) {
        if (allZero()) break;
        continue;
      }
      amounts[i] = current - 1;
      remainder += 1;
    }
  }

  return amounts;
};

const uncapped = (n: number) => Array.from({ length: n }, () => null);

/**
 * `distributeRemainder` returns `{ amounts, unallocatedCents }`. Most of these
 * cases only care about the allocation, so unwrap it — the residue gets its
 * own assertions in the "reports the residue" block below.
 */
const allocate = (
  amounts: number[],
  remainder: number,
  caps: ReadonlyArray<number | null>,
) => distributeRemainder(amounts, remainder, caps).amounts;

describe("lineCapCents", () => {
  it("is null for an uncapped line (null and undefined both mean 'no cap')", () => {
    expect(lineCapCents(10_000, null)).toBeNull();
    expect(lineCapCents(10_000, undefined)).toBeNull();
  });

  // FLOORED, not rounded. The remainder pass fills a capped line UP TO this
  // number, so a ceiling that rounds up is a ceiling that gets exceeded: at
  // half-up, a "10% cap" on a 335c basis pays 34c = 10.15%.
  it("floors the ceiling to the cent — a cap must never round UP", () => {
    expect(lineCapCents(10_000, 5)).toBe(500);
    expect(lineCapCents(333, 10)).toBe(33); // 33.3 → 33
    expect(lineCapCents(335, 10)).toBe(33); // 33.5 → 33, NOT 34
    expect(lineCapCents(999, 50)).toBe(499); // 499.5 → 499, NOT 500
    expect(lineCapCents(10_000, 0)).toBe(0);
    expect(lineCapCents(10_000, 100)).toBe(10_000);
  });

  it("never lets a capped line exceed its stated percentage of the basis", () => {
    for (const basis of [1, 7, 99, 100, 333, 335, 999, 1_337, 10_001]) {
      for (const capPercent of [1, 3, 5, 10, 33, 50, 99]) {
        const cap = lineCapCents(basis, capPercent)!;
        expect(
          cap * 100,
          `basis=${basis} cap=${capPercent}%`,
        ).toBeLessThanOrEqual(basis * capPercent);
      }
    }
  });
});

describe("distributeRemainder — uncapped behaviour is unchanged", () => {
  it("matches the pre-cap implementation across a sweep of shapes", () => {
    const shapes: Array<{ amounts: number[]; remainder: number }> = [];
    for (const amounts of [
      [0],
      [7],
      [0, 0],
      [50, 50],
      [3_300, 3_300, 3_400],
      [2, 2, 2],
      [0, 2],
      [0, 0, 5],
      [10, 0, 10, 0],
      [1, 2, 3, 4, 5],
      // > 5 lines: the round-robin wraps mid-pass here, which is exactly where
      // a rewritten loop is most likely to diverge from the original.
      [0, 0, 0, 0, 0, 0],
      [1, 2, 3, 4, 5, 6, 7],
      [100, 0, 100, 0, 100, 0, 100, 0],
      [5, 4, 3, 2, 1, 0, 1, 2, 3, 4],
      [1_666, 1_666, 1_666, 1_666, 1_666, 1_666],
    ]) {
      for (const remainder of [-7, -3, -2, -1, 0, 1, 2, 3, 7, 13, 29]) {
        shapes.push({ amounts, remainder });
      }
    }

    for (const { amounts, remainder } of shapes) {
      const actual = allocate(
        [...amounts],
        remainder,
        uncapped(amounts.length),
      );
      const expected = legacyDistributeRemainder([...amounts], remainder);
      expect(
        actual,
        `amounts=${JSON.stringify(amounts)} remainder=${remainder}`,
      ).toEqual(expected);
    }
  });

  it("keeps round-robin fairness: one cent each, from the top, then round again", () => {
    expect(allocate([0, 0, 0], 4, uncapped(3))).toEqual([2, 1, 1]);
    expect(allocate([0, 0, 0], 3, uncapped(3))).toEqual([1, 1, 1]);
    expect(allocate([0, 0, 0], 1, uncapped(3))).toEqual([1, 0, 0]);
  });

  it("returns the array untouched when there is nothing to distribute", () => {
    expect(allocate([5, 5], 0, uncapped(2))).toEqual([5, 5]);
  });
});

describe("distributeRemainder — the subtract arm (over-allocation)", () => {
  // Reached when NEAREST rounding lifts the lines past the basis. The caps are
  // deliberately NOT consulted here: removing a cent only moves a line further
  // under its ceiling.
  it("takes cents off from the last line backwards", () => {
    expect(allocate([5, 5], -3, uncapped(2))).toEqual([4, 3]);
    expect(allocate([51, 51], -1, uncapped(2))).toEqual([51, 50]);
  });

  it("never drives a line negative — it skips lines already at zero", () => {
    expect(allocate([4, 0, 4], -2, uncapped(3))).toEqual([3, 0, 3]);
  });

  it("stops instead of spinning when every line is already at zero", () => {
    expect(allocate([0, 0], -3, uncapped(2))).toEqual([0, 0]);
  });

  it("stops once it has drained every line, leaving the rest unresolved", () => {
    // Only 2c available against a 3c over-allocation: drains to zero and exits
    // rather than looping forever looking for a cent that does not exist.
    expect(allocate([0, 2], -3, uncapped(2))).toEqual([0, 0]);
  });

  it("ignores a cap on the subtract arm", () => {
    expect(allocate([5, 5], -2, [1, 1])).toEqual([4, 4]);
  });
});

describe("distributeRemainder — the add arm honours caps", () => {
  it("skips a line that is already at its ceiling", () => {
    // Line 0 is capped at 500 and already there; all 1500c go to line 1.
    expect(allocate([500, 8_000], 1_500, [500, null])).toEqual([500, 9_500]);
  });

  it("fills a capped line up to its ceiling and no further", () => {
    // Line 0 has 2c of headroom, then line 1 absorbs the rest.
    expect(allocate([0, 0], 5, [2, null])).toEqual([2, 3]);
  });

  it("keeps sharing round-robin between the lines that still have headroom", () => {
    expect(allocate([0, 0, 0], 5, [1, null, null])).toEqual([1, 2, 2]);
  });

  it("terminates when every line is capped, leaving the residue unallocated", () => {
    // The `progressed` guard. Without it this spins forever — inside a
    // checkout request. Asserted under a timeout so a hang FAILS rather than
    // wedging the run.
    const start = Date.now();
    const out = distributeRemainder([100, 100], 5_000, [100, 100]);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(out.amounts).toEqual([100, 100]);
    // Residue stays with the platform: no split row, no payee credit. See the
    // comment in distribute-remainder.ts.
    expect(out.amounts.reduce((a, b) => a + b, 0)).toBe(200);
    expect(out.unallocatedCents).toBe(5_000);
  }, 5_000);

  it("terminates when a zero cap leaves no headroom at all", () => {
    const out = distributeRemainder([0, 0], 1_000, [0, 0]);
    expect(out.amounts).toEqual([0, 0]);
    expect(out.unallocatedCents).toBe(1_000);
  }, 5_000);
});

/**
 * The property the publish gate has to encode. `SPLITS_CAPS_UNSATISFIABLE`
 * originally refused any set whose Σ min(percent, cap) fell short of 100 —
 * which refuses "20% capped at 5%" + "80% uncapped", a set this pass
 * distributes to the cent. Only an ALL-capped set can leave anything behind.
 */
describe("distributeRemainder — one uncapped line always drains the remainder", () => {
  it("allocates every cent whenever at least one line is uncapped", () => {
    const shapes: Array<{
      amounts: number[];
      remainder: number;
      caps: Array<number | null>;
    }> = [
      // The canonical deal the first cut of the gate refused: 20% cap 5% + 80%.
      { amounts: [500, 8_000], remainder: 1_500, caps: [500, null] },
      { amounts: [0, 0], remainder: 10_000, caps: [0, null] },
      { amounts: [1, 1, 1], remainder: 9_997, caps: [1, 1, null] },
      { amounts: [0, 0, 0, 0], remainder: 7, caps: [0, 0, 0, null] },
      { amounts: [3, 0, 3], remainder: 1_337, caps: [3, null, 3] },
      { amounts: [0], remainder: 999, caps: [null] },
    ];

    for (const { amounts, remainder, caps } of shapes) {
      const before = amounts.reduce((a, b) => a + b, 0);
      const out = distributeRemainder([...amounts], remainder, caps);
      expect(
        out.unallocatedCents,
        `amounts=${JSON.stringify(amounts)} caps=${JSON.stringify(caps)}`,
      ).toBe(0);
      expect(out.amounts.reduce((a, b) => a + b, 0)).toBe(before + remainder);
    }
  });

  it("reports the residue only when EVERY line is capped and the caps fall short", () => {
    // 50 + 49 = 99 ceilings against a 100c basis. The ±1 tolerance the first
    // cut of the gate used admitted exactly this set; here is the cent it
    // drops on every order.
    const out = distributeRemainder([50, 49], 1, [50, 49]);
    expect(out.amounts).toEqual([50, 49]);
    expect(out.unallocatedCents).toBe(1);
  });

  it("reports zero residue for a fully-drained all-capped set", () => {
    const out = distributeRemainder([0, 0], 100, [60, 60]);
    expect(out.amounts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out.unallocatedCents).toBe(0);
  });
});
