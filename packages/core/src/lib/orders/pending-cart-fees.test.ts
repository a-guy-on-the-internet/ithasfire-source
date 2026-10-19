import { describe, expect, it } from "vitest";

import {
  derivePendingCartFees,
  derivePendingCartPricing,
} from "./pending-cart-fees";

describe("derivePendingCartFees — a held cart's buyer-side fees", () => {
  it("PASS_THROUGH: the buyer funds the whole platform fee", () => {
    expect(
      derivePendingCartFees(
        [{ effectiveFeeMode: "PASS_THROUGH", holdExpiresAt: "x" }, { effectiveFeeMode: "PASS_THROUGH" }],
        100,
      ),
    ).toEqual({ feeMode: "PASS_THROUGH", buyerFeesCents: 100 });
  });

  it("ABSORB: none of it", () => {
    expect(derivePendingCartFees([{ effectiveFeeMode: "ABSORB" }], 100)).toEqual({
      feeMode: "ABSORB",
      buyerFeesCents: 0,
    });
  });

  it("no line recorded a mode (legacy / malformed meta) → unknown, and no fee claimed", () => {
    expect(derivePendingCartFees([null, {}, { effectiveFeeMode: "BOGUS" }], 100)).toEqual({
      feeMode: null,
      buyerFeesCents: 0,
    });
  });
});

describe("derivePendingCartPricing — what a resumed held step starts from", () => {
  // As createCheckout persists a cart: two $50 ticket lines, a member
  // benefit (no code) and a typed code — discount lines carry NEGATIVE
  // amounts, and the order row's gross is AFTER them.
  const lines = [
    { kind: "ticket", amountCents: 5000, meta: { effectiveFeeMode: "PASS_THROUGH" } },
    { kind: "ticket", amountCents: 5000, meta: { effectiveFeeMode: "PASS_THROUGH" } },
    { kind: "discount", amountCents: -1000, meta: { source: "membership", membershipBenefitId: "b1" } },
    { kind: "discount", amountCents: -550, meta: { promoId: "p1", code: "welcome10", normalizedCode: "WELCOME10" } },
  ];

  it("regression: the gross is Σ ticket lines (pre-discount), not the order row's post-discount figure", () => {
    expect(derivePendingCartPricing(lines, 206).preDiscountGrossCents).toBe(10_000);
  });

  it("regression: the TYPED codes are recovered as entered; a member benefit is not a code", () => {
    expect(derivePendingCartPricing(lines, 206).promoCodes).toEqual(["welcome10"]);
  });

  it("carries the buyer-side fees from the ticket lines only", () => {
    expect(derivePendingCartPricing(lines, 206)).toMatchObject({
      feeMode: "PASS_THROUGH",
      buyerFeesCents: 206,
    });
  });

  it("a code on two lines (per-line split) is listed once; blank / non-string codes are ignored", () => {
    expect(
      derivePendingCartPricing(
        [
          { kind: "discount", amountCents: -1, meta: { code: "SAVE" } },
          { kind: "discount", amountCents: -1, meta: { code: "save" } },
          { kind: "discount", amountCents: -1, meta: { code: "  " } },
          { kind: "discount", amountCents: -1, meta: { code: 7 } },
          { kind: "discount", amountCents: -1, meta: null },
        ],
        0,
      ).promoCodes,
    ).toEqual(["SAVE"]);
  });
});
