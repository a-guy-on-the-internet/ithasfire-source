import { describe, expect, it } from "vitest";

import {
  PROCESSING_COST_SCHEDULE,
  getProcessingCost,
  formatProcessingCostLabel,
  computeProcessingFee,
  solveProcessingFee,
  solveProcessingFeeGrossUp,
} from "./processing-cost-schedule";

describe("processing-cost-schedule", () => {
  describe("PROCESSING_COST_SCHEDULE", () => {
    it("has card as the first entry", () => {
      expect(PROCESSING_COST_SCHEDULE[0]!.methodType).toBe("card");
    });

    it("includes ACH direct debit with a cap", () => {
      const ach = PROCESSING_COST_SCHEDULE.find(
        (e) => e.methodType === "us_bank_account",
      );
      expect(ach).toBeDefined();
      expect(ach!.pct).toBe(0.008);
      expect(ach!.capCents).toBe(500);
    });
  });

  describe("getProcessingCost", () => {
    it("returns the correct entry for known method types", () => {
      expect(getProcessingCost("card").pct).toBe(0.029);
      expect(getProcessingCost("us_bank_account").pct).toBe(0.008);
      expect(getProcessingCost("apple_pay").pct).toBe(0.029);
    });

    it("falls back to card rate for unknown method types", () => {
      const unknown = getProcessingCost("some_future_method");
      expect(unknown.methodType).toBe("card");
      expect(unknown.pct).toBe(0.029);
    });
  });

  describe("formatProcessingCostLabel", () => {
    it("formats card rate as percentage + fixed", () => {
      const card = getProcessingCost("card");
      expect(formatProcessingCostLabel(card)).toBe("2.9% + $0.30");
    });

    it("formats ACH rate with cap", () => {
      const ach = getProcessingCost("us_bank_account");
      expect(formatProcessingCostLabel(ach)).toBe("0.8% (capped at $5.00)");
    });

    it("formats Apple Pay same as card", () => {
      const apple = getProcessingCost("apple_pay");
      expect(formatProcessingCostLabel(apple)).toBe("2.9% + $0.30");
    });
  });

  describe("computeProcessingFee", () => {
    it("computes card fee correctly for $100 base", () => {
      // fee = ceil(10000 * 0.029 + 30) = ceil(320) = 320
      expect(computeProcessingFee(10_000, "card")).toBe(320);
    });

    it("computes ACH fee correctly for $100 base", () => {
      // fee = ceil(10000 * 0.008) = 80
      expect(computeProcessingFee(10_000, "us_bank_account")).toBe(80);
    });

    it("caps ACH fee at $5 for large orders", () => {
      // fee = ceil(100000 * 0.008) = 800, capped at 500
      expect(computeProcessingFee(100_000, "us_bank_account")).toBe(500);
    });

    it("returns exact cap when fee equals cap boundary", () => {
      // fee = ceil(62500 * 0.008) = 500, exactly at cap
      expect(computeProcessingFee(62_500, "us_bank_account")).toBe(500);
    });

    it("falls back to card rate for unknown methods", () => {
      expect(computeProcessingFee(10_000, "unknown_method")).toBe(320);
    });

    it("fee equals what Stripe would charge on the base", () => {
      // For any base, the fee should equal ceil(base * pct + fixed)
      // which is exactly what Stripe charges on that base.
      const bases = [100, 5_000, 10_000, 50_000, 123_456];
      for (const base of bases) {
        const fee = computeProcessingFee(base, "card");
        const stripeCharge = Math.ceil(base * 0.029 + 30);
        expect(fee).toBe(stripeCharge);
      }
    });
  });

  describe("solveProcessingFee", () => {
    it("computes card-like rates", () => {
      // ceil(10000 * 0.029 + 30) = 320
      expect(solveProcessingFee(10_000, 0.029, 30)).toBe(320);
    });

    it("computes zero fixed fee", () => {
      // ceil(10000 * 0.008) = 80
      expect(solveProcessingFee(10_000, 0.008, 0)).toBe(80);
    });

    it("respects capCents", () => {
      expect(solveProcessingFee(100_000, 0.008, 0, 500)).toBe(500);
    });

    it("returns 0 fixed + 0 pct = 0 fee", () => {
      expect(solveProcessingFee(10_000, 0, 0)).toBe(0);
    });

    it("handles zero base amount", () => {
      // Even with $0 base, fixed fee still applies
      // ceil(0 * 0.029 + 30) = 30
      expect(solveProcessingFee(0, 0.029, 30)).toBe(30);
    });
  });

  describe("solveProcessingFeeGrossUp", () => {
    const PCT = 0.029;
    const FIXED = 30;

    it("returns the exact card gross-up for a $35 ticket + $0.50 platform fee", () => {
      // net 3550 → buyer charge 3687, Stripe takes 137, net lands on 3550.
      expect(solveProcessingFeeGrossUp(3550, PCT, FIXED)).toBe(137);
    });

    it("returns the exact card gross-up for a $100 ticket + $0.50 platform fee", () => {
      expect(solveProcessingFeeGrossUp(10_050, PCT, FIXED)).toBe(332);
    });

    it("returns the exact card gross-up for 2× $35 + $1.00 platform fee", () => {
      expect(solveProcessingFeeGrossUp(7100, PCT, FIXED)).toBe(243);
    });

    it("returns 0 for a zero or negative net target", () => {
      expect(solveProcessingFeeGrossUp(0, PCT, FIXED)).toBe(0);
      expect(solveProcessingFeeGrossUp(-1, PCT, FIXED)).toBe(0);
      expect(solveProcessingFeeGrossUp(-9999, PCT, FIXED)).toBe(0);
    });

    it("throws for a processor rate >= 100% (cannot be grossed up)", () => {
      expect(() => solveProcessingFeeGrossUp(1000, 1, FIXED)).toThrow();
      expect(() => solveProcessingFeeGrossUp(1000, 1.5, FIXED)).toThrow();
    });

    it("is exactly sufficient AND minimal for the documented cases", () => {
      for (const net of [3550, 10_050, 7100]) {
        const fee = solveProcessingFeeGrossUp(net, PCT, FIXED);
        const charge = net + fee;
        // sufficient: the charge nets >= the target after Stripe's fee
        expect(charge - solveProcessingFee(charge, PCT, FIXED)).toBeGreaterThanOrEqual(net);
        // minimal: a 1-cent-smaller charge would net < the target
        expect(charge - 1 - solveProcessingFee(charge - 1, PCT, FIXED)).toBeLessThan(net);
      }
    });

    it("is sufficient and minimal across a wide range of net values (property check)", () => {
      for (let net = 100; net <= 20_000; net += 1) {
        const fee = solveProcessingFeeGrossUp(net, PCT, FIXED);
        const charge = net + fee;
        // invariant: charge === net + fee
        expect(charge).toBe(net + fee);
        // sufficient
        expect(charge - solveProcessingFee(charge, PCT, FIXED)).toBeGreaterThanOrEqual(net);
        // minimal
        expect(charge - 1 - solveProcessingFee(charge - 1, PCT, FIXED)).toBeLessThan(net);
      }
    });

    it("caps the gross-up at the processor cap when the cap binds (ACH $5)", () => {
      // ACH 0.8% capped at $5. Uncapped fee on $1000 net would be ~806, but the
      // buyer can only ever fund the capped 500: charge = net + 500, and Stripe
      // deducts the capped 500, so the net lands exactly on target.
      expect(solveProcessingFeeGrossUp(100_000, 0.008, 0, 500)).toBe(500);
      const charge = 100_000 + 500;
      expect(charge - solveProcessingFee(charge, 0.008, 0, 500)).toBe(100_000);
    });

    it("returns the uncapped fee when the cap does not bind", () => {
      // 0.8% on a small net stays well under the $5 cap.
      const fee = solveProcessingFeeGrossUp(1000, 0.008, 0, 500);
      expect(fee).toBeLessThan(500);
      const charge = 1000 + fee;
      expect(charge - solveProcessingFee(charge, 0.008, 0, 500)).toBeGreaterThanOrEqual(1000);
      expect(charge - 1 - solveProcessingFee(charge - 1, 0.008, 0, 500)).toBeLessThan(1000);
    });
  });
});
