import { describe, expect, it } from "vitest";

import {
  classifySeatOverride,
  resolveSeatUnitPriceCents,
  seatOverrideCents,
} from "../seat-pricing";

/**
 * The per-seat resolver (seat-price-overrides spec D-002/D-003/D-004).
 */
const NOW = new Date("2026-03-01T12:00:00.000Z");
const BEFORE = new Date("2026-02-01T00:00:00.000Z");

const fixedTier = {
  priceCents: 3000,
  pricingMode: "FIXED" as const,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
};

describe("seatOverrideCents", () => {
  it("returns null for no override", () => {
    expect(seatOverrideCents(null, "seat-1")).toBeNull();
    expect(seatOverrideCents(undefined, "seat-1")).toBeNull();
  });

  it("returns the cents, keeping 0 distinct from absent", () => {
    expect(seatOverrideCents({ priceCents: 5000 }, "seat-1")).toBe(5000);
    expect(seatOverrideCents({ priceCents: 0 }, "seat-1")).toBe(0);
  });

  it("refuses the repo's invalid marker (a corrupt stored value), naming the seat", () => {
    expect(() => seatOverrideCents({ invalid: true }, "seat-9")).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
        message: "seat_price_override_invalid",
        meta: { seatId: "seat-9" },
      }),
    );
  });

  it.each([-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a corrupt stored amount (%s) rather than charging a guess",
    (priceCents) => {
      expect(() => seatOverrideCents({ priceCents }, "seat-1")).toThrow(
        expect.objectContaining({
          code: "INTERNAL",
          message: "seat_price_override_invalid",
        }),
      );
    },
  );
});

describe("classifySeatOverride", () => {
  it("answers like seatOverrideCents, with \"invalid\" where that one throws", () => {
    expect(classifySeatOverride(null)).toBeNull();
    expect(classifySeatOverride(undefined)).toBeNull();
    expect(classifySeatOverride({ priceCents: 5000 })).toBe(5000);
    expect(classifySeatOverride({ priceCents: 0 })).toBe(0);
    expect(classifySeatOverride({ invalid: true })).toBe("invalid");
  });

  it.each([-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "a corrupt stored amount (%s) is \"invalid\", exactly where checkout refuses it",
    (priceCents) => {
      expect(classifySeatOverride({ priceCents })).toBe("invalid");
      expect(() => seatOverrideCents({ priceCents }, "seat-1")).toThrow();
    },
  );
});

describe("resolveSeatUnitPriceCents", () => {
  it("D-002: an override REPLACES the tier price, in both directions", () => {
    expect(resolveSeatUnitPriceCents(fixedTier, 5000, { now: NOW })).toBe(5000);
    expect(resolveSeatUnitPriceCents(fixedTier, 1000, { now: NOW })).toBe(1000);
  });

  it("D-002: an override of 0 is a free seat, not the tier price", () => {
    expect(resolveSeatUnitPriceCents(fixedTier, 0, { now: NOW })).toBe(0);
  });

  it("no override → the tier's resolved price", () => {
    expect(resolveSeatUnitPriceCents(fixedTier, null, { now: NOW })).toBe(3000);
  });

  it("D-003: an override ignores the tier schedule; an unoverridden seat follows it", () => {
    const scheduled = {
      ...fixedTier,
      scheduledPriceCents: 4000,
      scheduledPriceAt: BEFORE,
    };
    expect(resolveSeatUnitPriceCents(scheduled, null, { now: NOW })).toBe(4000);
    expect(resolveSeatUnitPriceCents(scheduled, 5000, { now: NOW })).toBe(5000);
  });

  it("D-004: an ADJUSTABLE tier takes the buyer's amount and ignores the override", () => {
    const pwyw = { ...fixedTier, pricingMode: "ADJUSTABLE" as const };
    expect(
      resolveSeatUnitPriceCents(pwyw, 9999, {
        now: NOW,
        donationAmountCents: 1234,
      }),
    ).toBe(1234);
  });

  it("an ADJUSTABLE tier without a buyer amount is refused", () => {
    const pwyw = { ...fixedTier, pricingMode: "ADJUSTABLE" as const };
    expect(() => resolveSeatUnitPriceCents(pwyw, null, { now: NOW })).toThrow(
      expect.objectContaining({ message: "donation_amount_required" }),
    );
  });
});
