import { describe, expect, it } from "vitest";

import { searchListingPrice, searchPriceLabel } from "../search-price-label";

const paid = (over: Record<string, unknown> = {}) => ({
  lowestPriceCents: 2500,
  lowestBuyerTotalCents: 2862,
  paidTierCount: 1,
  hasFreeTier: false,
  currency: "USD",
  ...over,
});

describe("searchPriceLabel (all-in, same rule as the site cards)", () => {
  it("prints the all-in figure with no From or plus", () => {
    expect(searchPriceLabel(paid())).toBe("$28.62");
    expect(searchPriceLabel(paid({ paidTierCount: 3 }))).toBe("$28.62");
  });

  it("never falls back to the face price when the all-in is unknown", () => {
    expect(searchPriceLabel(paid({ lowestBuyerTotalCents: null }))).toBeNull();
  });

  it("rejects a stale indexed total (below face, or far above it)", () => {
    expect(searchPriceLabel(paid({ lowestBuyerTotalCents: 2000 }))).toBeNull();
    expect(searchPriceLabel(paid({ lowestBuyerTotalCents: 5500 }))).toBeNull();
  });

  it("prints nothing when the face is null even though a total is present", () => {
    expect(
      searchPriceLabel(paid({ lowestPriceCents: null, lowestBuyerTotalCents: 2862 })),
    ).toBeNull();
  });

  it("reads free + paid as Free+, not Free", () => {
    expect(
      searchPriceLabel(
        paid({
          lowestPriceCents: 0,
          lowestBuyerTotalCents: 0,
          paidTierCount: 2,
          hasFreeTier: true,
        }),
      ),
    ).toBe("Free+");
  });

  it("labels free-only Free and no-tier events with no price", () => {
    expect(
      searchPriceLabel(
        paid({
          lowestPriceCents: 0,
          lowestBuyerTotalCents: null,
          paidTierCount: 0,
          hasFreeTier: true,
        }),
      ),
    ).toBe("Free");
    expect(
      searchPriceLabel(
        paid({
          lowestPriceCents: null,
          lowestBuyerTotalCents: null,
          paidTierCount: 0,
        }),
      ),
    ).toBeNull();
  });

  it("is currency-correct and tolerates missing fields", () => {
    expect(
      searchPriceLabel(
        paid({ currency: "JPY", lowestPriceCents: 2500, lowestBuyerTotalCents: 2750 }),
      ),
    ).toBe("¥2,750");
    expect(searchPriceLabel({})).toBeNull();
  });
});

describe("searchPriceLabel: floor-0 pay-what-you-want (F2) and the viewer's language (F3)", () => {
  const SPANISH = {
    free: "Gratis",
    freePlus: "Gratis+",
    payWhatYouWant: "Paga lo que quieras",
    fromPrice: (amount: string) => `Desde ${amount}`,
  };
  const pwyw = paid({
    lowestPriceCents: 0,
    lowestBuyerTotalCents: null,
    paidTierCount: 0,
    hasFreeTier: false,
    hasPayWhatYouWantTier: true,
  });

  it("never says Free for a floor-0 PWYW event", () => {
    expect(searchPriceLabel(pwyw)).toBe("Pay what you want");
    expect(searchListingPrice(pwyw)).toEqual({ kind: "payWhatYouWant" });
    expect(
      searchPriceLabel({ ...pwyw, paidTierCount: 2, lowestBuyerTotalCents: 2862 }),
    ).toBe("Pay what you want");
  });

  it("words every label in Spanish when given the words", () => {
    expect(searchPriceLabel(pwyw, SPANISH)).toBe("Paga lo que quieras");
    expect(
      searchPriceLabel(
        paid({ lowestPriceCents: 0, paidTierCount: 0, hasFreeTier: true, lowestBuyerTotalCents: null }),
        SPANISH,
      ),
    ).toBe("Gratis");
    expect(
      searchPriceLabel(paid({ lowestPriceCents: 0, paidTierCount: 2, hasFreeTier: true }), SPANISH),
    ).toBe("Gratis+");
    expect(searchPriceLabel(paid(), SPANISH)).toBe("$28.62");
  });
});
