import { describe, expect, it } from "vitest";

import {
  PLATFORM_FEE_POLICY,
  PLATFORM_FEE_POLICY_FIELDS,
} from "./platform-fee-policy";
import {
  FeeMode,
  computeTicketPriceForAgreement,
  type ComputeTicketPriceInput,
} from "./compute-ticket-price-for-agreement";

/**
 * An agreement whose policy IS the shipped constant, so these assertions move
 * the moment someone edits the fee. A single payee at 100% keeps the split
 * arithmetic out of the way — this file is about the per-ticket fee.
 */
const agreementUnderPlatformPolicy: ComputeTicketPriceInput["agreement"] = {
  id: "agreement-1",
  policy: {
    id: "policy-1",
    version: 1,
    feeMode: FeeMode.PASS_THROUGH,
    processsorFeePct: PLATFORM_FEE_POLICY.processsorFeePct,
    processorFixedCents: PLATFORM_FEE_POLICY.processorFixedCents,
    payoutPct: PLATFORM_FEE_POLICY.payoutPct,
    payoutFixedCents: PLATFORM_FEE_POLICY.payoutFixedCents,
    monthlyPayoutCents: PLATFORM_FEE_POLICY.monthlyPayoutCents,
    buyerFeePct: PLATFORM_FEE_POLICY.buyerFeePct,
    maxFeeCents: PLATFORM_FEE_POLICY.maxFeeCents,
    minFeeCents: PLATFORM_FEE_POLICY.minFeeCents,
    platformFixedCents: PLATFORM_FEE_POLICY.platformFixedCents,
  },
  lines: [{ id: "line-a", payeeId: "payee-a", percent: 100, priority: 0 }],
};

const feeFor = (unitPriceCents: number) =>
  computeTicketPriceForAgreement({
    qty: 1,
    unitPriceCents,
    agreement: agreementUnderPlatformPolicy,
  }).platformFeePerTicketCents;

describe("PLATFORM_FEE_POLICY shape", () => {
  it("is scoped GLOBAL with a null scopeId", () => {
    expect(PLATFORM_FEE_POLICY.scopeType).toBe("GLOBAL");
    expect(PLATFORM_FEE_POLICY.scopeId).toBeNull();
  });

  it("keeps every percentage inside Decimal(5, 4)", () => {
    // THE FOOTGUN THIS GUARDS: buyerFeePct / processsorFeePct / payoutPct are
    // `Decimal(5, 4)` columns. A fifth decimal place would be ROUNDED on write,
    // seed-platform-fee-policy.ts would read back a value different from the
    // one it wrote, and EVERY deploy would mint a fresh policy version forever
    // — silently, because the write itself succeeds.
    const percentFields = [
      "buyerFeePct",
      "processsorFeePct",
      "payoutPct",
    ] as const;

    for (const field of percentFields) {
      const value = PLATFORM_FEE_POLICY[field];
      expect(value, `${field} must be >= 0`).toBeGreaterThanOrEqual(0);
      expect(value, `${field} must be < 10 (Decimal(5, 4))`).toBeLessThan(10);
      // `value * 10_000` is NOT integral in binary floating point even for a
      // clean 4dp decimal (0.0333 × 10000 = 332.99999999999994), so compare
      // against the nearest integer with a tolerance rather than using
      // Number.isInteger — otherwise this guard fails on values it should pass.
      const scaled = value * 10_000;
      expect(
        Math.abs(scaled - Math.round(scaled)) < 1e-6,
        `${field}=${value} has more than 4 decimal places and would be rounded on write`,
      ).toBe(true);
    }
  });

  it("keeps every cents field a non-negative integer", () => {
    const centsFields = [
      "maxFeeCents",
      "minFeeCents",
      "maxPlatformFeeCents",
      "platformFixedCents",
      "processorFixedCents",
      "payoutFixedCents",
      "monthlyPayoutCents",
      "payoutMinimumCents",
      "connectAccountFeeCents",
    ] as const;

    for (const field of centsFields) {
      const value = PLATFORM_FEE_POLICY[field];
      if (value === null) continue; // nullable caps
      expect(
        Number.isInteger(value),
        `${field}=${value} must be an integer`,
      ).toBe(true);
      expect(value, `${field} must be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it("lists every field of the constant in PLATFORM_FEE_POLICY_FIELDS", () => {
    // The compile-time check in platform-fee-policy.ts catches a field missing
    // from the list; this catches the runtime mirror of the same mistake (a
    // field present in the list but absent from the object literal), which is
    // what the reconciler actually iterates.
    expect([...PLATFORM_FEE_POLICY_FIELDS].sort()).toEqual(
      Object.keys(PLATFORM_FEE_POLICY).sort(),
    );
  });
});

describe("PLATFORM_FEE_POLICY per-ticket fee math", () => {
  // fee = max( min(round(face × 0.0333), 50) + 0, 0 )
  it.each([
    ["$1.00 → 3¢", 100, 3],
    ["$5.00 → 17¢", 500, 17],
    ["$10.00 → 33¢", 1000, 33],
    ["$14.99 → 50¢ (already at the cap)", 1499, 50],
    ["$15.00 → 50¢ (cap binds)", 1500, 50],
    ["$20.00 → 50¢", 2000, 50],
    ["$50.00 → 50¢", 5000, 50],
    ["$500.00 → 50¢", 50_000, 50],
  ])("charges %s", (_label, faceCents, expectedFee) => {
    expect(feeFor(faceCents)).toBe(expectedFee);
  });

  it("never exceeds the 50¢ per-ticket cap, at any face value", () => {
    for (let face = 0; face <= 200_00; face += 137) {
      expect(feeFor(face)).toBeLessThanOrEqual(
        PLATFORM_FEE_POLICY.maxFeeCents!,
      );
    }
  });

  it("caps PER TICKET, not per order — a 10-ticket order pays 10 × the cap", () => {
    // maxPlatformFeeCents is deliberately null (order-wide cap OFF). Guard it,
    // because confusing the two caps would quietly cut platform revenue by ~90%
    // on a group order.
    expect(PLATFORM_FEE_POLICY.maxPlatformFeeCents).toBeNull();

    const result = computeTicketPriceForAgreement({
      qty: 10,
      unitPriceCents: 5000,
      agreement: agreementUnderPlatformPolicy,
    });
    expect(result.platformFeePerTicketCents).toBe(50);
    expect(result.buyerUnitTotalCents).toBe(5050);
    expect(result.buyerTotalCents).toBe(50_500);
  });

  it("has no flat component — a free ticket carries no fee", () => {
    expect(PLATFORM_FEE_POLICY.platformFixedCents).toBe(0);
    expect(PLATFORM_FEE_POLICY.minFeeCents).toBe(0);
    expect(feeFor(0)).toBe(0);
  });
});
