import { describe, expect, it } from "vitest";

import { withBuyerUnitTotals } from "@/lib/pricing/order-estimate";
import {
  PWYW_FLOOR_ALL_IN_CENTS,
  serverRowAt,
} from "@/lib/pricing/__fixtures__/pwyw-floor";

import type { ListedEstimateTicket } from "@/lib/pricing/stale-estimate";

import { adjustableSeatPriceLabel, seatMapPriceLabel } from "./seat-map-price-label";

const STRINGS: Record<string, string> = {
  "checkout.calculatingTotal": "Calculating total…",
  "common.free": "Free",
  "eventDetail.payWhatYouWant": "Pay what you want",
};
const t = (key: string, values?: Record<string, string | number>) =>
  key === "eventDetail.fromPrice"
    ? `From ${values?.value}`
    : key === "eventDetail.suggestedPrice"
      ? `Suggested ${values?.value}`
      : (STRINGS[key] ?? key);
const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const opts = { formatPrice, t };

const price = (tier: ListedEstimateTicket, faceCents: number) =>
  withBuyerUnitTotals([tier], [serverRowAt(tier.id, faceCents)])[0]!;

describe("seatMapPriceLabel", () => {
  it("PWYW with a floor reads 'From' the all-in floor", () => {
    const tt = price(
      { id: "p", priceCents: 0, pricingMode: "ADJUSTABLE", minimumCents: 500 },
      500,
    );
    expect(PWYW_FLOOR_ALL_IN_CENTS).toBe(609);
    expect(seatMapPriceLabel(tt, opts)).toEqual({
      label: "From $6.09",
      hint: null,
    });
  });

  it("PWYW with a floor of 0 reads 'Pay what you want' + suggestion, never Free", () => {
    const tt = price(
      {
        id: "p",
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 0,
        suggestedCents: 1500,
      },
      0,
    );
    expect(seatMapPriceLabel(tt, opts)).toEqual({
      label: "Pay what you want",
      hint: "Suggested $15.00",
    });
  });

  it("PWYW with a stale estimate reads Calculating, never the bare floor", () => {
    const tt = price(
      { id: "p", priceCents: 0, pricingMode: "ADJUSTABLE", minimumCents: 700 },
      500,
    );
    expect(seatMapPriceLabel(tt, opts).label).toBe("Calculating total…");
  });

  it("a fixed tier is unchanged: all-in price, Free at zero, Calculating when unpriced", () => {
    const fixed = price({ id: "f", priceCents: 3000 }, 3000);
    expect(seatMapPriceLabel(fixed, opts)).toEqual({
      label: formatPrice(fixed.buyerUnitTotalCents!),
      hint: null,
    });
    expect(
      seatMapPriceLabel(
        { id: "z", priceCents: 0, buyerUnitTotalCents: 0, buyerUnitPriceCents: 0 },
        opts,
      ).label,
    ).toBe("Free");
    expect(seatMapPriceLabel({ id: "u", priceCents: 3000 }, opts).label).toBe(
      "Calculating total…",
    );
  });
});

describe("adjustableSeatPriceLabel — one seat on a pay-what-you-want tier", () => {
  it("floor 0: 'Pay what you want', not $0.00", () => {
    const tt = price(
      { id: "p", priceCents: 0, pricingMode: "ADJUSTABLE", minimumCents: 0, suggestedCents: 1500 },
      0,
    );
    expect(adjustableSeatPriceLabel(tt, false, opts)).toBe("Pay what you want");
  });

  it("floor above 0: 'From' the all-in floor, matching the quick-pick row", () => {
    const tt = price(
      { id: "p", priceCents: 0, pricingMode: "ADJUSTABLE", minimumCents: 500 },
      500,
    );
    expect(adjustableSeatPriceLabel(tt, false, opts)).toBe("From $6.09");
    expect(adjustableSeatPriceLabel(tt, false, opts)).toBe(seatMapPriceLabel(tt, opts).label);
  });

  it("a seat with its own price override, or a fixed tier, gets null (per-seat figure as before)", () => {
    const pwyw = price(
      { id: "p", priceCents: 0, pricingMode: "ADJUSTABLE", minimumCents: 500 },
      500,
    );
    expect(adjustableSeatPriceLabel(pwyw, true, opts)).toBeNull();
    expect(adjustableSeatPriceLabel(price({ id: "f", priceCents: 3000 }, 3000), false, opts)).toBeNull();
    expect(adjustableSeatPriceLabel(undefined, false, opts)).toBeNull();
  });
});
