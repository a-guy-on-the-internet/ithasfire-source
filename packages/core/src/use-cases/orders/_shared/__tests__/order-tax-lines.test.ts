import { describe, expect, it } from "vitest";

import { toOrderTaxLineInputs } from "../order-tax-lines";
import type { SolvedTaxLine } from "../../../../lib/pricing/solve-tax-and-processor-fee";

const sales: SolvedTaxLine = {
  code: "SALES",
  label: "Sales tax",
  jurisdiction: "US/TN",
  rateBps: 975,
  base: "BUYER_TOTAL",
  collector: "PLATFORM",
  taxableAmountCents: 2665,
  amountCents: 260,
};
const organiser: SolvedTaxLine = {
  code: "VENUE_SEAT",
  label: "Venue seat tax",
  jurisdiction: "US/CO/Denver",
  rateBps: 1000,
  base: "TICKET_FACE",
  collector: "ORGANISER",
  taxableAmountCents: 2500,
  amountCents: 250,
};

describe("toOrderTaxLineInputs", () => {
  it("maps every line (PLATFORM and ORGANISER) when Σ PLATFORM === the order tax", () => {
    expect(toOrderTaxLineInputs({ lines: [sales, organiser] }, 260)).toEqual([
      sales,
      organiser,
    ]);
  });

  it("ORGANISER amounts are NOT part of the order tax", () => {
    expect(() =>
      toOrderTaxLineInputs({ lines: [sales, organiser] }, 260 + 250),
    ).toThrow(/Σ PLATFORM lines=260, taxAmountCents=510/);
  });

  it("refuses a breakdown that disagrees with the charged tax (INTERNAL)", () => {
    expect(() => toOrderTaxLineInputs({ lines: [sales] }, 261)).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
  });

  it("no lines ⇔ zero tax", () => {
    expect(toOrderTaxLineInputs({ lines: [] }, 0)).toEqual([]);
    expect(() => toOrderTaxLineInputs({ lines: [] }, 1)).toThrow();
  });
});
