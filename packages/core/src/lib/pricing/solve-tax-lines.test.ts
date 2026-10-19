import { describe, expect, it } from "vitest";

import { legacySolveTaxAndProcessorFee } from "./__fixtures__/legacy-solve-tax-and-processor-fee";
import {
  solveProcessingFee,
  solveProcessingFeeGrossUp,
} from "./processing-cost-schedule";
import {
  MAX_TAX_PROCESSOR_ITERATIONS,
  solveTaxLinesAndProcessorFee,
  type TaxLinesAndProcessorFeeInput,
} from "./solve-tax-and-processor-fee";
import type { TaxImposition } from "./tax-impositions";
import type { TaxableBase } from "./taxable-base";

const CARD = { processorPct: 0.029, processorFixedCents: 30 };

function sales(rateBps: number, base: TaxableBase): TaxImposition {
  return {
    code: "SALES",
    label: "Sales tax",
    jurisdiction: "US/XX",
    rateBps,
    base,
    collector: "PLATFORM",
  };
}

const CITY_TOTAL: TaxImposition = {
  code: "CITY_AMUSEMENT",
  label: "City amusement tax",
  jurisdiction: "US/XX/City",
  rateBps: 900,
  base: "BUYER_TOTAL",
  collector: "PLATFORM",
};

const ORGANISER_TOTAL: TaxImposition = {
  code: "VENUE_SEAT",
  label: "Venue seat tax",
  jurisdiction: "US/XX/City",
  rateBps: 1000,
  base: "BUYER_TOTAL",
  collector: "ORGANISER",
};

function input(
  overrides: Partial<TaxLinesAndProcessorFeeInput> = {},
): TaxLinesAndProcessorFeeInput {
  return {
    taxableGrossCents: 2500,
    buyerPlatformFeeCents: 50,
    taxLines: [sales(975, "TICKET_FACE")],
    passThrough: true,
    ...CARD,
    ...overrides,
  };
}

const round = (cents: number, rateBps: number) =>
  Math.round((cents * rateBps) / 10_000);

/**
 * Independent brute-force oracle for N platform lines: the SMALLEST
 * BUYER_TOTAL tax sum that is self-consistent with the processor fee its own
 * charge implies. Not the production loop, so a drifted loop cannot pass.
 */
function referenceMultiLine(args: {
  gross: number;
  staticFees: number;
  faceRates: number[];
  totalRates: number[];
  pct: number;
  fixed: number;
}) {
  const net = args.gross + args.staticFees;
  const faceTax = args.faceRates.reduce((s, r) => s + round(args.gross, r), 0);
  // Tax on a grossed-up fee can exceed a tiny net (1¢ gross), so search well
  // past it — the answer is found long before the bound.
  for (let totalTax = 0; totalTax <= 2 * net + 1_000; totalTax += 1) {
    const fee = solveProcessingFeeGrossUp(
      net + faceTax + totalTax,
      args.pct,
      args.fixed,
    );
    const implied = args.totalRates.reduce(
      (s, r) => s + round(net + fee, r),
      0,
    );
    if (implied === totalTax) {
      return { faceTax, totalTax, fee };
    }
  }
  throw new Error("no self-consistent solution");
}

// ─────────────────────────────────────────────────────────────────────────────
// Single SALES line ≡ the 2392f1fc solver, byte for byte
// ─────────────────────────────────────────────────────────────────────────────

describe("single SALES line is byte-identical to the frozen HEAD solver", () => {
  // Deterministic LCG so a failure is reproducible from the seed alone.
  function lcg(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it("property: 40,000 random inputs across both bases, both fee modes, caps and fixed-fee-only", () => {
    const rand = lcg(0x5eed_2392);
    const pick = <T,>(xs: readonly T[]): T =>
      xs[Math.floor(rand() * xs.length)] as T;
    let compared = 0;
    let circular = 0;
    for (let i = 0; i < 40_000; i += 1) {
      const taxableGrossCents = pick([
        -500,
        0,
        1,
        Math.floor(rand() * 200),
        Math.floor(rand() * 10_000),
        Math.floor(rand() * 500_000),
      ]);
      const buyerPlatformFeeCents = pick([0, 1, 30, 50, Math.floor(rand() * 3_000)]);
      const otherBuyerFundedFeeCents = pick([undefined, 0, Math.floor(rand() * 500)]);
      const taxRateBps = pick([0, 1, 250, 700, 862, 925, 975, 1200, 2000, Math.floor(rand() * 3_000)]);
      const taxableBase = pick(["TICKET_FACE", "BUYER_TOTAL"] as const);
      const passThrough = rand() < 0.7;
      const [processorPct, processorFixedCents] = pick([
        [0.029, 30],
        [0.008, 0],
        [0.035, 25],
        [0, 30],
        [0.05, 0],
        [0.029 + rand() * 0.02, Math.floor(rand() * 60)],
      ] as const);
      const processorCapCents = pick([undefined, undefined, 500]);

      const legacy = legacySolveTaxAndProcessorFee({
        taxableGrossCents,
        buyerPlatformFeeCents,
        otherBuyerFundedFeeCents,
        taxRateBps,
        taxableBase,
        passThrough,
        processorPct,
        processorFixedCents,
        processorCapCents,
      });
      const next = solveTaxLinesAndProcessorFee({
        taxableGrossCents,
        buyerPlatformFeeCents,
        otherBuyerFundedFeeCents,
        taxLines: [sales(taxRateBps, taxableBase)],
        passThrough,
        processorPct,
        processorFixedCents,
        processorCapCents,
      });

      const line = next.lines[0]!;
      expect({
        taxCents: next.taxCents,
        processorFeeCents: next.processorFeeCents,
        taxBasisCents: line.taxableAmountCents,
        iterations: next.iterations,
      }).toEqual(legacy);
      expect(line.amountCents).toBe(legacy.taxCents);
      compared += 1;
      if (legacy.iterations > 0) circular += 1;
    }
    expect(compared).toBe(40_000);
    // The circular (TN pass-through) branch is genuinely exercised.
    expect(circular).toBeGreaterThan(5_000);
  });

  it("exhaustive grid: every (gross, fee, rate, base, mode) the HEAD suite swept", () => {
    for (const taxableGrossCents of [0, 1, 99, 100, 237, 999, 2500, 4500, 45_000, 123_456, 250_000]) {
      for (const buyerPlatformFeeCents of [0, 1, 30, 50, 137, 250, 1000]) {
        for (const taxRateBps of [0, 1, 250, 500, 700, 825, 862, 888, 925, 975, 1000, 1200, 2000]) {
          for (const taxableBase of ["TICKET_FACE", "BUYER_TOTAL"] as const) {
            for (const passThrough of [true, false]) {
              const common = {
                taxableGrossCents,
                buyerPlatformFeeCents,
                passThrough,
                ...CARD,
              };
              const legacy = legacySolveTaxAndProcessorFee({
                ...common,
                taxRateBps,
                taxableBase,
              });
              const next = solveTaxLinesAndProcessorFee({
                ...common,
                taxLines: [sales(taxRateBps, taxableBase)],
              });
              expect([
                next.taxCents,
                next.processorFeeCents,
                next.lines[0]!.taxableAmountCents,
                next.iterations,
              ]).toEqual([
                legacy.taxCents,
                legacy.processorFeeCents,
                legacy.taxBasisCents,
                legacy.iterations,
              ]);
            }
          }
        }
      }
    }
  });

  it("pinned HEAD literals: $25 Nashville → 260¢ tax / 115¢ fee on a 2665¢ base", () => {
    const out = solveTaxLinesAndProcessorFee(
      input({ taxLines: [sales(975, "BUYER_TOTAL")] }),
    );
    expect(out.taxCents).toBe(260);
    expect(out.processorFeeCents).toBe(115);
    expect(out.lines[0]).toMatchObject({
      code: "SALES",
      taxableAmountCents: 2665,
      amountCents: 260,
    });
    const face = solveTaxLinesAndProcessorFee(input());
    expect(face.taxCents).toBe(244);
    expect(face.processorFeeCents).toBe(115);
  });

  it("empty line list ≡ legacy at a zero rate", () => {
    const next = solveTaxLinesAndProcessorFee(input({ taxLines: [] }));
    const legacy = legacySolveTaxAndProcessorFee({
      taxableGrossCents: 2500,
      buyerPlatformFeeCents: 50,
      taxRateBps: 0,
      taxableBase: "TICKET_FACE",
      passThrough: true,
      ...CARD,
    });
    expect(next).toEqual({
      lines: [],
      taxCents: legacy.taxCents,
      processorFeeCents: legacy.processorFeeCents,
      iterations: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple platform lines
// ─────────────────────────────────────────────────────────────────────────────

describe("two PLATFORM lines with mixed bases", () => {
  it("face line is fixed; total line covers the fee, which is grossed up over ALL tax", () => {
    const out = solveTaxLinesAndProcessorFee(
      input({ taxLines: [sales(1025, "TICKET_FACE"), CITY_TOTAL] }),
    );
    const [face, city] = out.lines;
    const oracle = referenceMultiLine({
      gross: 2500,
      staticFees: 50,
      faceRates: [1025],
      totalRates: [900],
      ...{ pct: CARD.processorPct, fixed: CARD.processorFixedCents },
    });

    expect(face).toMatchObject({ taxableAmountCents: 2500, amountCents: 256 });
    expect(face!.amountCents).toBe(oracle.faceTax);
    expect(city!.amountCents).toBe(oracle.totalTax);
    expect(out.processorFeeCents).toBe(oracle.fee);
    expect(city!.taxableAmountCents).toBe(2550 + out.processorFeeCents);
    expect(out.taxCents).toBe(face!.amountCents + city!.amountCents);
    expect(out.iterations).toBeGreaterThan(0);

    // Sufficiency: the charge nets gross + platform + ALL tax after Stripe.
    const charge = 2550 + out.taxCents + out.processorFeeCents;
    expect(
      charge - solveProcessingFee(charge, CARD.processorPct, CARD.processorFixedCents),
    ).toBeGreaterThanOrEqual(2550 + out.taxCents);
    // Minimal: one cent less fee would not.
    expect(out.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(2550 + out.taxCents, CARD.processorPct, CARD.processorFixedCents),
    );
  });

  it("each line rounds on its own (two remittances, not one blended rate)", () => {
    // 2 lines × 0.5¢ each: blended would round 1¢, separately each rounds to 1¢.
    const out = solveTaxLinesAndProcessorFee(
      input({
        taxableGrossCents: 10,
        buyerPlatformFeeCents: 0,
        passThrough: false,
        taxLines: [
          sales(500, "TICKET_FACE"),
          { ...CITY_TOTAL, base: "TICKET_FACE", rateBps: 500 },
        ],
      }),
    );
    expect(out.lines.map((l) => l.amountCents)).toEqual([1, 1]);
    expect(out.taxCents).toBe(2);
  });

  it("matches the brute-force oracle across a sweep (N=2 and N=3 BUYER_TOTAL lines)", () => {
    for (const gross of [1, 100, 999, 2500, 45_000, 250_000]) {
      for (const fee of [0, 50, 250]) {
        for (const rates of [
          { face: [], total: [925, 300] },
          { face: [625], total: [900] },
          { face: [500, 125], total: [900, 250, 100] },
        ]) {
          const out = solveTaxLinesAndProcessorFee(
            input({
              taxableGrossCents: gross,
              buyerPlatformFeeCents: fee,
              taxLines: [
                ...rates.face.map((r) => sales(r, "TICKET_FACE")),
                ...rates.total.map((r) => ({ ...CITY_TOTAL, rateBps: r })),
              ],
            }),
          );
          const oracle = referenceMultiLine({
            gross,
            staticFees: fee,
            faceRates: rates.face,
            totalRates: rates.total,
            pct: CARD.processorPct,
            fixed: CARD.processorFixedCents,
          });
          expect(out.taxCents).toBe(oracle.faceTax + oracle.totalTax);
          expect(out.processorFeeCents).toBe(oracle.fee);
        }
      }
    }
  });

  it("ABSORB: a BUYER_TOTAL local line taxes the face (nothing passed through)", () => {
    const out = solveTaxLinesAndProcessorFee(
      input({
        passThrough: false,
        buyerPlatformFeeCents: 0,
        taxLines: [sales(1025, "TICKET_FACE"), CITY_TOTAL],
      }),
    );
    expect(out.processorFeeCents).toBe(0);
    expect(out.lines.map((l) => [l.taxableAmountCents, l.amountCents])).toEqual([
      [2500, 256],
      [2500, 225],
    ]);
    expect(out.iterations).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANISER lines
// ─────────────────────────────────────────────────────────────────────────────

describe("ORGANISER lines are disclosed, never charged", () => {
  it("excluded from taxCents AND from the processor gross-up base", () => {
    const withoutOrg = solveTaxLinesAndProcessorFee(
      input({ taxLines: [sales(975, "BUYER_TOTAL")] }),
    );
    const withOrg = solveTaxLinesAndProcessorFee(
      input({ taxLines: [sales(975, "BUYER_TOTAL"), ORGANISER_TOTAL] }),
    );
    expect(withOrg.taxCents).toBe(withoutOrg.taxCents);
    expect(withOrg.processorFeeCents).toBe(withoutOrg.processorFeeCents);
    expect(withOrg.iterations).toBe(withoutOrg.iterations);
    expect(withOrg.lines[0]).toEqual(withoutOrg.lines[0]);

    // …but it IS computed, on the buyer total the charge actually settled at.
    const org = withOrg.lines[1]!;
    expect(org.collector).toBe("ORGANISER");
    expect(org.taxableAmountCents).toBe(2550 + withOrg.processorFeeCents);
    expect(org.amountCents).toBe(round(org.taxableAmountCents, 1000));
    expect(org.amountCents).toBeGreaterThan(0);
  });

  it("an ORGANISER-only order charges no tax and a plain gross-up", () => {
    const out = solveTaxLinesAndProcessorFee(
      input({ taxLines: [{ ...ORGANISER_TOTAL, base: "TICKET_FACE" }] }),
    );
    expect(out.taxCents).toBe(0);
    expect(out.processorFeeCents).toBe(solveProcessingFeeGrossUp(2550, 0.029, 30));
    expect(out.lines[0]).toMatchObject({ taxableAmountCents: 2500, amountCents: 250 });
  });

  it("an ORGANISER rate does not count toward the convergence guard", () => {
    expect(() =>
      solveTaxLinesAndProcessorFee(
        input({
          taxLines: [
            sales(975, "BUYER_TOTAL"),
            { ...ORGANISER_TOTAL, rateBps: 9_800 },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guards and termination
// ─────────────────────────────────────────────────────────────────────────────

describe("guards and convergence", () => {
  it("refuses Σ BUYER_TOTAL platform rates + pct >= 1 even when no single line does", () => {
    expect(() =>
      solveTaxLinesAndProcessorFee(
        input({
          taxLines: [
            sales(5_000, "BUYER_TOTAL"),
            { ...CITY_TOTAL, rateBps: 4_800 },
          ],
          processorPct: 0.05,
        }),
      ),
    ).toThrow(/>= 100% combined/);
  });

  it("face lines do not count toward the guard (they do not move with the fee)", () => {
    expect(() =>
      solveTaxLinesAndProcessorFee(
        input({
          taxLines: [sales(9_000, "TICKET_FACE"), CITY_TOTAL],
          processorPct: 0.05,
        }),
      ),
    ).not.toThrow();
  });

  it("refuses an unknown base or collector rather than guessing", () => {
    expect(() =>
      solveTaxLinesAndProcessorFee(
        input({ taxLines: [{ ...CITY_TOTAL, base: "GROSS" as TaxableBase }] }),
      ),
    ).toThrow(/unknown taxable base/);
    expect(() =>
      solveTaxLinesAndProcessorFee(
        input({
          taxLines: [
            { ...CITY_TOTAL, collector: "VENUE" as TaxImposition["collector"] },
          ],
        }),
      ),
    ).toThrow(/unknown tax collector/);
  });

  it("converges well inside the cap with two BUYER_TOTAL lines across a sweep", () => {
    let worst = 0;
    for (let gross = 1; gross <= 300_000; gross += 1_993) {
      for (const fee of [0, 30, 1000]) {
        for (const [a, b] of [
          [925, 300],
          [700, 900],
          [1200, 1000],
          [2000, 500],
        ] as const) {
          for (const [processorPct, processorFixedCents] of [
            [0.029, 30],
            [0.035, 25],
            [0.05, 0],
          ] as const) {
            const { iterations } = solveTaxLinesAndProcessorFee(
              input({
                taxableGrossCents: gross,
                buyerPlatformFeeCents: fee,
                taxLines: [
                  sales(a, "BUYER_TOTAL"),
                  { ...CITY_TOTAL, rateBps: b },
                ],
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
  });

  it("zero/negative gross: every line is 0 on a 0 base", () => {
    const out = solveTaxLinesAndProcessorFee(
      input({
        taxableGrossCents: 0,
        buyerPlatformFeeCents: 0,
        taxLines: [sales(975, "BUYER_TOTAL"), CITY_TOTAL, ORGANISER_TOTAL],
      }),
    );
    expect(out.taxCents).toBe(0);
    expect(out.lines.every((l) => l.amountCents === 0 && l.taxableAmountCents === 0)).toBe(true);
  });
});
