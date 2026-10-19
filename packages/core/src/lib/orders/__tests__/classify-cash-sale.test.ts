import { describe, expect, it } from "vitest";

import { classifyCashSale } from "../classify-cash-sale";

// What `recordCashSale` writes on its ticket items.
const COMP_ITEM = { meta: { comp: true, buyerTotalCents: 0 } };
const PRICED_FREE_ITEM = { meta: { buyerTotalCents: 0 } };
const PRICED_ITEM = { meta: { buyerTotalCents: 3000 } };
// Before the door was priced (2026-10-07): no buyer totals, no comp stamp.
const LEGACY_ITEM = { meta: {} };

describe("classifyCashSale", () => {
  it("the explicit comp (stamped meta.comp) is a comp", () => {
    expect(
      classifyCashSale({ totalCents: 0, promoCodes: [], items: [COMP_ITEM] }),
    ).toEqual({ isComp: true, isFreeWithCode: false });
  });

  it("a $0 sale with a promo code is free with the code, never a comp", () => {
    expect(
      classifyCashSale({
        totalCents: 0,
        promoCodes: ["FREEALL"],
        items: [PRICED_FREE_ITEM, PRICED_FREE_ITEM],
      }),
    ).toEqual({ isComp: false, isFreeWithCode: true });
  });

  it("a paid sale with a partial code is neither", () => {
    expect(
      classifyCashSale({
        totalCents: 2000,
        promoCodes: ["DOOR10"],
        items: [PRICED_ITEM],
      }),
    ).toEqual({ isComp: false, isFreeWithCode: false });
  });

  it("a priced $0 sale with no code (free tier, comp: false) is a sale", () => {
    expect(
      classifyCashSale({
        totalCents: 0,
        promoCodes: [],
        items: [PRICED_FREE_ITEM],
      }),
    ).toEqual({ isComp: false, isFreeWithCode: false });
  });

  it("an order recorded before the door was priced: $0 with no code is a comp", () => {
    expect(
      classifyCashSale({ totalCents: 0, promoCodes: [], items: [LEGACY_ITEM] }),
    ).toEqual({ isComp: true, isFreeWithCode: false });
    expect(
      classifyCashSale({ totalCents: 0, promoCodes: [], items: [] }),
    ).toEqual({ isComp: true, isFreeWithCode: false });
    expect(
      classifyCashSale({
        totalCents: 2500,
        promoCodes: [],
        items: [{ meta: null }],
      }),
    ).toEqual({ isComp: false, isFreeWithCode: false });
  });

  it("a legacy $0 sale that redeemed a code reads as free with it", () => {
    expect(
      classifyCashSale({
        totalCents: 0,
        promoCodes: ["OLD100"],
        items: [LEGACY_ITEM],
      }),
    ).toEqual({ isComp: false, isFreeWithCode: true });
  });
});
