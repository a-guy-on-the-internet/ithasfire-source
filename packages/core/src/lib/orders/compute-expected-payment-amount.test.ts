import { describe, expect, it } from "vitest";
import {
  computeExpectedPaymentAmount,
  computeItemBuyerPaid,
  extractNumber,
} from "./compute-expected-payment-amount";

describe("computeExpectedPaymentAmount", () => {
  const baseOrder = {
    amountGrossCents: 5000,
    feesPlatformCents: 500,
    taxAmountCents: 0,
    items: [{ amountCents: 5000, meta: { buyerTotalCents: 5500 } }],
  };

  it("sums buyerTotalCents from item metadata", () => {
    expect(computeExpectedPaymentAmount(baseOrder)).toBe(5500);
  });

  it("falls back to amountGrossCents + feesPlatformCents when no metadata", () => {
    const order = {
      ...baseOrder,
      items: [{ amountCents: 5000, meta: null }],
    };
    expect(computeExpectedPaymentAmount(order)).toBe(5500); // 5000 + 500
  });

  it("adds taxAmountCents on top of item totals", () => {
    const order = { ...baseOrder, taxAmountCents: 400 };
    expect(computeExpectedPaymentAmount(order)).toBe(5900); // 5500 + 400
  });

  it("adds taxAmountCents on top of fallback totals", () => {
    const order = {
      ...baseOrder,
      taxAmountCents: 250,
      items: [{ amountCents: 5000, meta: null }],
    };
    // fallback: 5000 + 500 + 250 = 5750
    expect(computeExpectedPaymentAmount(order)).toBe(5750);
  });

  it("handles undefined taxAmountCents", () => {
    const order = {
      amountGrossCents: 1000,
      feesPlatformCents: 100,
      items: [{ amountCents: 1000, meta: { buyerTotalCents: 1100 } }],
    };
    expect(computeExpectedPaymentAmount(order)).toBe(1100);
  });

  it("returns zero minimum (never negative)", () => {
    const order = {
      amountGrossCents: -500,
      feesPlatformCents: -500,
      taxAmountCents: 0,
      items: [{ amountCents: -500, meta: null }],
    };
    expect(computeExpectedPaymentAmount(order)).toBe(0);
  });

  it("sums multiple items", () => {
    const order = {
      ...baseOrder,
      taxAmountCents: 100,
      items: [
        { amountCents: 2500, meta: { buyerTotalCents: 2750 } },
        { amountCents: 2500, meta: { buyerTotalCents: 2750 } },
      ],
    };
    expect(computeExpectedPaymentAmount(order)).toBe(5600); // 2750+2750+100
  });

  it("truncates fractional totals", () => {
    const order = {
      ...baseOrder,
      items: [{ amountCents: 5000, meta: { buyerTotalCents: "5500.9" } }],
    };
    expect(computeExpectedPaymentAmount(order)).toBe(5500);
  });
});

describe("computeItemBuyerPaid", () => {
  it("prefers buyerTotalCents from meta", () => {
    expect(
      computeItemBuyerPaid({
        amountCents: 1000,
        meta: { buyerTotalCents: 1200 },
      }),
    ).toBe(1200);
  });

  it("falls back to amountCents", () => {
    expect(computeItemBuyerPaid({ amountCents: 1000, meta: null })).toBe(1000);
  });

  it("handles string buyerTotalCents", () => {
    expect(
      computeItemBuyerPaid({
        amountCents: 1000,
        meta: { buyerTotalCents: "1200" },
      }),
    ).toBe(1200);
  });
});

describe("extractNumber", () => {
  it("extracts integers", () => expect(extractNumber(42)).toBe(42));
  it("truncates floats", () => expect(extractNumber(42.7)).toBe(42));
  it("parses numeric strings", () => expect(extractNumber("99")).toBe(99));
  it("returns null for non-numeric strings", () =>
    expect(extractNumber("abc")).toBeNull());
  it("returns null for null", () => expect(extractNumber(null)).toBeNull());
  it("returns null for undefined", () =>
    expect(extractNumber(undefined)).toBeNull());
  it("returns null for NaN", () => expect(extractNumber(NaN)).toBeNull());
  it("returns null for Infinity", () =>
    expect(extractNumber(Infinity)).toBeNull());
});
