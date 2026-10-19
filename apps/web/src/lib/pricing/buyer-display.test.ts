import { describe, expect, it } from "vitest";

import {
  getBuyerAllInDisplayCents,
  getBuyerLineTotalDisplayCents,
  getBuyerPriceRange,
  isBuyerAllInPriceKnown,
} from "./buyer-display";

describe("buyer-display", () => {
  it("treats paid fixed-price tickets without buyer estimates as unknown", () => {
    const ticket = { priceCents: 2500, buyerUnitTotalCents: null };

    expect(isBuyerAllInPriceKnown(ticket)).toBe(false);
    expect(getBuyerAllInDisplayCents(ticket)).toBeNull();
    expect(getBuyerLineTotalDisplayCents(ticket, 2)).toBeNull();
  });

  it("treats free tickets as known without buyer estimates", () => {
    const ticket = { priceCents: 0, buyerUnitTotalCents: null };

    expect(isBuyerAllInPriceKnown(ticket)).toBe(true);
    expect(getBuyerAllInDisplayCents(ticket)).toBe(0);
    expect(getBuyerLineTotalDisplayCents(ticket, 3)).toBe(0);
  });

  it("returns buyer totals when estimates are available", () => {
    const ticket = { priceCents: 2500, buyerUnitTotalCents: 3375 };

    expect(isBuyerAllInPriceKnown(ticket)).toBe(true);
    expect(getBuyerAllInDisplayCents(ticket)).toBe(3375);
    expect(getBuyerLineTotalDisplayCents(ticket, 2)).toBe(6750);
  });

  it("treats paid override prices as unknown without exact estimates", () => {
    const ticket = { priceCents: 2500, buyerUnitTotalCents: 3375 };

    expect(isBuyerAllInPriceKnown(ticket, 3000)).toBe(false);
    expect(getBuyerAllInDisplayCents(ticket, 3000)).toBeNull();
    expect(getBuyerLineTotalDisplayCents(ticket, 2, 3000)).toBeNull();
  });

  it("excludes unknown paid prices from ranges", () => {
    const range = getBuyerPriceRange([
      { priceCents: 2500, buyerUnitTotalCents: null },
      { priceCents: 0, buyerUnitTotalCents: null },
      { priceCents: 3000, buyerUnitTotalCents: 4125 },
      { priceCents: 4500, buyerUnitTotalCents: 5625 },
    ]);

    expect(range).toEqual({ minCents: 4125, maxCents: 5625 });
  });
});
