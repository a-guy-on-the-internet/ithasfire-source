import { describe, expect, it } from "vitest";

import { buyerChargeLines, type BuyerCharges } from "../order-format";

const sum = (charges: BuyerCharges) =>
  buyerChargeLines(charges).reduce((acc, line) => acc + line.cents, 0);

describe("buyerChargeLines", () => {
  it("PASS_THROUGH: shows every fee, and the lines add to the total", () => {
    const charges: BuyerCharges = {
      subtotalCents: 1000,
      platformFeeCents: 33,
      processingFeeCents: 64,
      taxCents: 89,
      creditCents: 0,
      totalCents: 1186,
    };

    expect(buyerChargeLines(charges).map((l) => l.id)).toEqual([
      "subtotal",
      "platformFee",
      "tax",
      "processingFee",
    ]);
    expect(sum(charges)).toBe(charges.totalCents);
  });

  it("ABSORB: no platform or processing line; $10.00 + $0.89 = $10.89", () => {
    // The bug this replaces: the client recomputed processing as
    // total − gross − feesPlatformCents − tax, so an ABSORB order showed a
    // 33¢ platform fee the buyer never paid and a −33¢ processing line.
    const charges: BuyerCharges = {
      subtotalCents: 1000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 89,
      creditCents: 0,
      totalCents: 1089,
    };

    const lines = buyerChargeLines(charges);
    expect(lines.map((l) => l.id)).toEqual(["subtotal", "tax"]);
    expect(lines.some((l) => l.cents < 0)).toBe(false);
    expect(sum(charges)).toBe(1089);
  });

  it("free order: only the subtotal line, at zero", () => {
    const charges: BuyerCharges = {
      subtotalCents: 0,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 0,
      creditCents: 0,
      totalCents: 0,
    };

    expect(buyerChargeLines(charges)).toEqual([
      { id: "subtotal", label: "Subtotal", cents: 0 },
    ]);
    expect(sum(charges)).toBe(0);
  });

  it("a platform credit shows as its own negative line", () => {
    const charges: BuyerCharges = {
      subtotalCents: 1000,
      platformFeeCents: 33,
      processingFeeCents: 64,
      taxCents: 89,
      creditCents: -500,
      totalCents: 686,
    };

    expect(buyerChargeLines(charges).at(-1)).toEqual({
      id: "credit",
      label: "Credit applied",
      cents: -500,
    });
    expect(sum(charges)).toBe(686);
  });
});
