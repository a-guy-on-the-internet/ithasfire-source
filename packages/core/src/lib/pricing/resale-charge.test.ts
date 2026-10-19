import { describe, expect, it } from "vitest";

import { solveProcessingFee } from "./processing-cost-schedule";
import { solveResaleCharge } from "./resale-charge";
import { solveTaxLinesAndProcessorFee } from "./solve-tax-and-processor-fee";
import { resolveTaxImpositions } from "./tax-impositions";

const PCT = 0.029;
const FIXED = 30;

const lines = (region: string, postalCode: string, rateBps: number) =>
  resolveTaxImpositions({
    situs: { countryCode: "US", region, postalCode },
    salesTaxRateBps: rateBps,
  });

describe("solveResaleCharge", () => {
  it("is the primary PASS_THROUGH solve with no platform fee, part for part", () => {
    for (const basisCents of [1, 99, 1000, 4000, 5000, 5500, 12_345, 300_000]) {
      for (const taxLines of [
        [],
        lines("NY", "10001", 888),
        lines("TN", "37203", 975),
        lines("IL", "62701", 625),
      ]) {
        const resale = solveResaleCharge({
          basisCents,
          taxLines,
          processorPct: PCT,
          processorFixedCents: FIXED,
        });
        const primary = solveTaxLinesAndProcessorFee({
          taxableGrossCents: basisCents,
          buyerPlatformFeeCents: 0,
          taxLines,
          passThrough: true,
          processorPct: PCT,
          processorFixedCents: FIXED,
        });
        expect(resale.processingPassThroughCents).toBe(primary.processorFeeCents);
        expect(resale.taxCents).toBe(primary.taxCents);
        expect(resale.totalCents).toBe(
          basisCents + primary.processorFeeCents + primary.taxCents,
        );
      }
    }
  });

  it("covers the processor's own fee on the whole charge: nothing is absorbed", () => {
    for (const basisCents of [100, 4000, 5000, 5500, 99_999]) {
      for (const taxLines of [[], lines("NY", "10001", 888), lines("TN", "37203", 975)]) {
        const charge = solveResaleCharge({
          basisCents,
          taxLines,
          processorPct: PCT,
          processorFixedCents: FIXED,
        });
        const stripeFee = solveProcessingFee(charge.totalCents, PCT, FIXED);
        expect(charge.totalCents - stripeFee).toBeGreaterThanOrEqual(
          basisCents + charge.taxCents,
        );
      }
    }
  });

  it("a $50 basis: 181 with no tax, 194 at NY 8.88% (tax 444), 196 at TN 9.75% (tax 507)", () => {
    const at = (taxLines: ReturnType<typeof lines>) =>
      solveResaleCharge({
        basisCents: 5000,
        taxLines,
        processorPct: PCT,
        processorFixedCents: FIXED,
      });
    expect(at([])).toMatchObject({ processingPassThroughCents: 181, taxCents: 0, totalCents: 5181 });
    expect(at(lines("NY", "10001", 888))).toMatchObject({
      processingPassThroughCents: 194,
      taxCents: 444,
      totalCents: 5638,
    });
    expect(at(lines("TN", "37203", 975))).toMatchObject({
      processingPassThroughCents: 196,
      taxCents: 507,
      totalCents: 5703,
    });
  });

  it("a zero basis charges nothing", () => {
    expect(
      solveResaleCharge({
        basisCents: 0,
        taxLines: lines("NY", "10001", 888),
        processorPct: PCT,
        processorFixedCents: FIXED,
      }),
    ).toMatchObject({ processingPassThroughCents: 0, taxCents: 0, totalCents: 0 });
  });
});
