import { describe, expect, it } from "vitest";

import { solveProcessingFee, solveProcessingFeeGrossUp } from "./processing-cost-schedule";
import {
  MAX_TAX_PROCESSOR_ITERATIONS,
  solveTaxAndProcessorFee,
  type TaxAndProcessorFeeInput,
} from "./solve-tax-and-processor-fee";

const CARD = { processorPct: 0.029, processorFixedCents: 30 };

function input(
  overrides: Partial<TaxAndProcessorFeeInput> = {},
): TaxAndProcessorFeeInput {
  return {
    taxableGrossCents: 2500,
    buyerPlatformFeeCents: 50,
    taxRateBps: 975,
    taxableBase: "TICKET_FACE",
    passThrough: true,
    ...CARD,
    ...overrides,
  };
}

/** The arithmetic every call site ran before the table existed. */
function historical(inp: TaxAndProcessorFeeInput) {
  const taxCents =
    inp.taxRateBps > 0 && inp.taxableGrossCents > 0
      ? Math.round((inp.taxableGrossCents * inp.taxRateBps) / 10_000)
      : 0;
  const processorFeeCents = inp.passThrough
    ? solveProcessingFeeGrossUp(
        inp.taxableGrossCents + inp.buyerPlatformFeeCents + taxCents,
        inp.processorPct,
        inp.processorFixedCents,
        inp.processorCapCents,
      )
    : 0;
  return { taxCents, processorFeeCents };
}

describe("solveTaxAndProcessorFee — TICKET_FACE is byte-identical to the historical math", () => {
  it("matches the two-step arithmetic across a grid, with zero iterations", () => {
    for (const taxableGrossCents of [1, 99, 100, 2500, 4500, 123_456]) {
      for (const buyerPlatformFeeCents of [0, 30, 50, 137]) {
        for (const taxRateBps of [0, 500, 825, 862, 888, 975, 1200]) {
          for (const passThrough of [true, false]) {
            const inp = input({
              taxableGrossCents,
              buyerPlatformFeeCents,
              taxRateBps,
              passThrough,
              taxableBase: "TICKET_FACE",
            });
            const expected = historical(inp);
            const actual = solveTaxAndProcessorFee(inp);
            expect({
              taxCents: actual.taxCents,
              processorFeeCents: actual.processorFeeCents,
            }).toEqual(expected);
            expect(actual.iterations).toBe(0);
            expect(actual.taxBasisCents).toBe(
              taxRateBps > 0 ? taxableGrossCents : 0,
            );
          }
        }
      }
    }
  });

  it("honours the ACH cap on the pass-through gross-up", () => {
    const inp = input({
      taxableGrossCents: 100_000,
      processorPct: 0.008,
      processorFixedCents: 0,
      processorCapCents: 500,
    });
    const actual = solveTaxAndProcessorFee(inp);
    expect(actual.processorFeeCents).toBe(500);
    expect(actual).toMatchObject(historical(inp));
  });
});

describe("solveTaxAndProcessorFee — BUYER_TOTAL + ABSORB", () => {
  it("is unaffected: nothing is passed through, so the base IS the face", () => {
    const inp = input({
      taxableBase: "BUYER_TOTAL",
      passThrough: false,
      buyerPlatformFeeCents: 0,
    });
    const actual = solveTaxAndProcessorFee(inp);

    expect(actual.taxCents).toBe(Math.round((2500 * 975) / 10_000));
    expect(actual.taxCents).toBe(244);
    expect(actual.processorFeeCents).toBe(0);
    expect(actual.taxBasisCents).toBe(2500);
    expect(actual.iterations).toBe(0);
    // Identical to the same order under TICKET_FACE.
    expect(actual).toEqual(
      solveTaxAndProcessorFee({ ...inp, taxableBase: "TICKET_FACE" }),
    );
  });
});

describe("solveTaxAndProcessorFee — BUYER_TOTAL + PASS_THROUGH (the joint solve)", () => {
  it("$25 Nashville ticket: taxes face + platform + processor, not the face alone", () => {
    const face = solveTaxAndProcessorFee(input({ taxableBase: "TICKET_FACE" }));
    const all = solveTaxAndProcessorFee(input({ taxableBase: "BUYER_TOTAL" }));

    // Today (face-only): 244¢ tax on a 2500¢ face.
    expect(face.taxCents).toBe(244);
    expect(face.processorFeeCents).toBe(115);

    // TN: the base is 2500 + 50 + 115 = 2665 → round(2665 × 9.75%) = 260.
    expect(all.taxBasisCents).toBe(2665);
    expect(all.taxCents).toBe(260);
    expect(all.processorFeeCents).toBe(115);
    expect(all.taxCents - face.taxCents).toBe(16);
  });

  it("the returned numbers satisfy BOTH equations simultaneously", () => {
    for (const taxableGrossCents of [100, 237, 999, 2500, 45_000, 250_000]) {
      for (const buyerPlatformFeeCents of [0, 30, 50, 250]) {
        for (const taxRateBps of [500, 700, 925, 975, 1000]) {
          const inp = input({
            taxableGrossCents,
            buyerPlatformFeeCents,
            taxRateBps,
            taxableBase: "BUYER_TOTAL",
          });
          const { taxCents, processorFeeCents, taxBasisCents } =
            solveTaxAndProcessorFee(inp);
          const netBase = taxableGrossCents + buyerPlatformFeeCents;

          // 1. the base really is everything the buyer pays for admission
          expect(taxBasisCents).toBe(netBase + processorFeeCents);
          // 2. tax is one rounding over that base
          expect(taxCents).toBe(Math.round((taxBasisCents * taxRateBps) / 10_000));
          // 3. the processor fee is the minimal gross-up over base + tax
          expect(processorFeeCents).toBe(
            solveProcessingFeeGrossUp(
              netBase + taxCents,
              inp.processorPct,
              inp.processorFixedCents,
            ),
          );
          // 4. sufficiency: after the processor deducts its own (ceil'd) fee
          //    from the charge, the net still covers gross + platform + tax
          const chargeCents = netBase + taxCents + processorFeeCents;
          expect(
            chargeCents -
              solveProcessingFee(
                chargeCents,
                inp.processorPct,
                inp.processorFixedCents,
              ),
          ).toBeGreaterThanOrEqual(netBase + taxCents);
        }
      }
    }
  });

  it("a naive ONE-PASS computation is a cent short (gross 100¢ @ 10%)", () => {
    const inp = input({
      taxableGrossCents: 100,
      buyerPlatformFeeCents: 0,
      taxRateBps: 1000,
      taxableBase: "BUYER_TOTAL",
    });

    // One pass: seed the processor fee with tax excluded, tax over that, stop.
    const seedProcessorFeeCents = solveProcessingFeeGrossUp(100, 0.029, 30);
    const onePassTaxCents = Math.round(
      ((100 + seedProcessorFeeCents) * 1000) / 10_000,
    );
    expect(seedProcessorFeeCents).toBe(34);
    expect(onePassTaxCents).toBe(13);

    const solved = solveTaxAndProcessorFee(inp);
    expect(solved.processorFeeCents).toBe(35);
    expect(solved.taxCents).toBe(14);
    expect(solved.taxCents - onePassTaxCents).toBe(1);
    // …and the one-pass answer is NOT self-consistent: the fee it charges makes
    // the base 135¢, which taxes to 14¢, not the 13¢ it quoted.
    expect(Math.round(((100 + solved.processorFeeCents) * 1000) / 10_000)).toBe(
      14,
    );
  });

  it("is MINIMAL: dropping either cent breaks an equation", () => {
    const inp = input({ taxableBase: "BUYER_TOTAL" });
    const { taxCents, processorFeeCents } = solveTaxAndProcessorFee(inp);
    const netBase = inp.taxableGrossCents + inp.buyerPlatformFeeCents;

    // One cent less tax is not the rounding of its own base.
    expect(
      Math.round(((netBase + processorFeeCents) * inp.taxRateBps) / 10_000),
    ).not.toBe(taxCents - 1);
    // One cent less processor fee no longer nets the target.
    const shortCharge = netBase + taxCents + processorFeeCents - 1;
    expect(
      shortCharge -
        solveProcessingFee(
          shortCharge,
          inp.processorPct,
          inp.processorFixedCents,
        ),
    ).toBeLessThan(netBase + taxCents);
  });

  it("no tax at a zero rate, and the processor fee is then the plain gross-up", () => {
    const inp = input({ taxRateBps: 0, taxableBase: "BUYER_TOTAL" });
    const actual = solveTaxAndProcessorFee(inp);
    expect(actual.taxCents).toBe(0);
    expect(actual.taxBasisCents).toBe(0);
    expect(actual.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(2550, 0.029, 30),
    );
    expect(actual.iterations).toBe(0);
  });

  it("no tax and no fee on a zero/negative taxable gross", () => {
    for (const taxableGrossCents of [0, -500]) {
      const actual = solveTaxAndProcessorFee(
        input({ taxableGrossCents, buyerPlatformFeeCents: 0, taxableBase: "BUYER_TOTAL" }),
      );
      expect(actual).toEqual({
        taxCents: 0,
        processorFeeCents: 0,
        taxBasisCents: 0,
        iterations: 0,
      });
    }
  });

  it("stays stable under a processor cap (the fee stops moving, so the tax does)", () => {
    const actual = solveTaxAndProcessorFee(
      input({
        taxableGrossCents: 100_000,
        taxableBase: "BUYER_TOTAL",
        processorPct: 0.008,
        processorFixedCents: 0,
        processorCapCents: 500,
      }),
    );
    expect(actual.processorFeeCents).toBe(500);
    expect(actual.taxBasisCents).toBe(100_000 + 50 + 500);
    expect(actual.taxCents).toBe(Math.round((100_550 * 975) / 10_000));
    expect(actual.iterations).toBeLessThanOrEqual(3);
  });
});

describe("solveTaxAndProcessorFee — termination", () => {
  it("converges well inside the cap across a wide sweep", () => {
    let worst = 0;
    for (let taxableGrossCents = 1; taxableGrossCents <= 300_000; taxableGrossCents += 997) {
      for (const buyerPlatformFeeCents of [0, 1, 30, 50, 1000]) {
        for (const taxRateBps of [1, 250, 700, 862, 888, 925, 975, 1200, 2000]) {
          for (const [processorPct, processorFixedCents] of [
            [0.029, 30],
            [0.008, 0],
            [0.035, 25],
            [0, 30],
            [0.05, 0],
          ] as const) {
            const { iterations } = solveTaxAndProcessorFee(
              input({
                taxableGrossCents,
                buyerPlatformFeeCents,
                taxRateBps,
                taxableBase: "BUYER_TOTAL",
                processorPct,
                processorFixedCents,
              }),
            );
            worst = Math.max(worst, iterations);
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(MAX_TAX_PROCESSOR_ITERATIONS);
    // Pinned so a regression in the seed/iteration order is visible.
    expect(worst).toBe(5);
  });

  it("refuses a combined rate that can never be grossed up", () => {
    expect(() =>
      solveTaxAndProcessorFee(
        input({ taxableBase: "BUYER_TOTAL", taxRateBps: 9_900, processorPct: 0.05 }),
      ),
    ).toThrow(/>= 100% combined/);
  });
});
