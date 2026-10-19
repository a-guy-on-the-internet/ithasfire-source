import { describe, expect, it } from "vitest";

import { originalPriceLine, originalPriceText } from "../original-price";

const fixed = {
  listPriceCents: 4000,
  pricingMode: "FIXED" as const,
  minimumCents: null,
};

describe("originalPriceLine", () => {
  it("FIXED: the recorded original price", () => {
    expect(
      originalPriceLine({ originalPriceCents: 4000, ticketTypePricing: fixed }),
    ).toEqual({ kind: "fixed", cents: 4000 });
  });

  it("a comp ($0 recorded, list price above 0): the list price, marked given free", () => {
    expect(
      originalPriceLine({ originalPriceCents: 0, ticketTypePricing: fixed }),
    ).toEqual({ kind: "comp", cents: 4000 });
  });

  it("pay what you want: the type's minimum, never the recorded chosen amount", () => {
    expect(
      originalPriceLine({
        originalPriceCents: 6000,
        ticketTypePricing: {
          listPriceCents: 500,
          pricingMode: "ADJUSTABLE",
          minimumCents: 500,
        },
      }),
    ).toEqual({ kind: "from", cents: 500 });
  });

  it("pay what you want with no minimum: no line", () => {
    expect(
      originalPriceLine({
        originalPriceCents: 6000,
        ticketTypePricing: {
          listPriceCents: 0,
          pricingMode: "ADJUSTABLE",
          minimumCents: null,
        },
      }),
    ).toBeNull();
  });

  it("pay what you want, public read (original null, share present): 'from' the minimum", () => {
    expect(
      originalPriceLine({
        originalPriceCents: null,
        eventShareCents: 500,
        ticketTypePricing: {
          listPriceCents: 500,
          pricingMode: "ADJUSTABLE",
          minimumCents: 500,
        },
      }),
    ).toEqual({ kind: "from", cents: 500 });
  });

  it("a legacy listing with no recorded original price: no line", () => {
    expect(
      originalPriceLine({ originalPriceCents: null, ticketTypePricing: fixed }),
    ).toBeNull();
  });

  it("a free ticket that was always free: $0, not 'given free'", () => {
    expect(
      originalPriceLine({
        originalPriceCents: 0,
        ticketTypePricing: { ...fixed, listPriceCents: 0 },
      }),
    ).toEqual({ kind: "fixed", cents: 0 });
  });
});

describe("originalPriceText", () => {
  const t = (key: string, values?: Record<string, string | number>) =>
    `${key}|${values?.amount}`;
  const money = (cents: number) => `$${cents}`;

  it("picks the key for each kind", () => {
    expect(originalPriceText({ kind: "fixed", cents: 1 }, t, money)).toBe(
      "resell.originalPriceFixed|$1",
    );
    expect(originalPriceText({ kind: "comp", cents: 2 }, t, money)).toBe(
      "resell.originalPriceComp|$2",
    );
    expect(originalPriceText({ kind: "from", cents: 3 }, t, money)).toBe(
      "resell.originalPriceFrom|$3",
    );
    expect(originalPriceText(null, t, money)).toBeNull();
  });
});
