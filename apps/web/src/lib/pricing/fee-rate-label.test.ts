import { describe, expect, it } from "vitest";

import { platformFeeRateLabel } from "./fee-rate-label";

const t = (key: string, values?: Record<string, string | number>) => {
  if (key === "checkout.platformFeeRateCapped") {
    return `${values?.rate}, max ${values?.max}/ticket`;
  }
  if (key === "checkout.platformFeeRatePctCapped") {
    return `${values?.pct} (max ${values?.max}) + ${values?.fixed}`;
  }
  return key;
};
const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const rates = (over: Partial<Parameters<typeof platformFeeRateLabel>[1] & object> = {}) => ({
  buyerFeePct: 0.0333,
  maxFeeCents: 50 as number | null,
  minFeeCents: 0,
  platformFixedCents: 0,
  ...over,
});

describe("platformFeeRateLabel", () => {
  it("regression: a capped rate says so — '3.33%' alone read like 3.33% of the order", () => {
    expect(platformFeeRateLabel("3.33%", rates(), t, formatPrice)).toBe(
      "3.33%, max $0.50/ticket",
    );
  });

  it("regression: a FIXED part sits outside the cap — '3.33% (max $0.50) + $0.30', not 'max $0.50/ticket'", () => {
    expect(
      platformFeeRateLabel(
        "3.33% + $0.30",
        rates({ platformFixedCents: 30 }),
        t,
        formatPrice,
      ),
    ).toBe("3.33% (max $0.50) + $0.30");
  });

  it("a floor above the cap makes 'max' false → the rate label unchanged", () => {
    expect(
      platformFeeRateLabel("3.33%", rates({ minFeeCents: 75 }), t, formatPrice),
    ).toBe("3.33%");
    expect(
      platformFeeRateLabel(
        "3.33% + $0.30",
        rates({ platformFixedCents: 30, minFeeCents: 100 }),
        t,
        formatPrice,
      ),
    ).toBe("3.33% + $0.30");
  });

  it("a floor at or under the cap keeps the capped wording", () => {
    expect(
      platformFeeRateLabel("3.33%", rates({ minFeeCents: 50 }), t, formatPrice),
    ).toBe("3.33%, max $0.50/ticket");
  });

  it("no cap / no percentage / no rates → the rate label unchanged; no rate → nothing", () => {
    expect(
      platformFeeRateLabel("3.33%", rates({ maxFeeCents: null }), t, formatPrice),
    ).toBe("3.33%");
    expect(
      platformFeeRateLabel(
        "$0.30",
        rates({ buyerFeePct: 0, platformFixedCents: 30 }),
        t,
        formatPrice,
      ),
    ).toBe("$0.30");
    expect(platformFeeRateLabel("3.33%", null, t, formatPrice)).toBe("3.33%");
    expect(platformFeeRateLabel(null, rates(), t, formatPrice)).toBeNull();
  });
});
