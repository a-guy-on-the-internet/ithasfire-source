import { describe, expect, it } from "vitest";

import {
  computeOrderCharges,
  shouldShowChargeRow,
} from "../order-format";

describe("computeOrderCharges", () => {
  it("splits a taxed order so the rows sum to the total", () => {
    const charges = computeOrderCharges({
      amountGrossCents: 5000,
      feesPlatformCents: 250,
      taxAmountCents: 440,
      buyerTotalCents: 5900,
    });

    expect(charges).toEqual({
      subtotalCents: 5000,
      platformFeeCents: 250,
      taxCents: 440,
      processingFeeCents: 210,
      totalCents: 5900,
    });

    const summed =
      charges.subtotalCents +
      charges.platformFeeCents +
      charges.taxCents +
      charges.processingFeeCents;
    expect(summed).toBe(charges.totalCents);
  });

  it("does NOT let the processing fee absorb tax", () => {
    // The regression this guards: omitting tax from the subtraction inflates
    // the processing fee by exactly the tax amount, which is the number a
    // buyer is most likely to dispute.
    const taxed = computeOrderCharges({
      amountGrossCents: 10_000,
      feesPlatformCents: 500,
      taxAmountCents: 875,
      buyerTotalCents: 11_800,
    });

    expect(taxed.processingFeeCents).toBe(425);
    expect(taxed.processingFeeCents).not.toBe(425 + 875);
  });

  it("treats a null tax as zero", () => {
    const charges = computeOrderCharges({
      amountGrossCents: 2000,
      feesPlatformCents: 100,
      taxAmountCents: null,
      buyerTotalCents: 2190,
    });

    expect(charges.taxCents).toBe(0);
    expect(charges.processingFeeCents).toBe(90);
  });

  it("treats an undefined tax as zero", () => {
    const charges = computeOrderCharges({
      amountGrossCents: 2000,
      feesPlatformCents: 100,
      taxAmountCents: undefined,
      buyerTotalCents: 2190,
    });

    expect(charges.taxCents).toBe(0);
    expect(charges.processingFeeCents).toBe(90);
  });

  it("handles a fully free order without inventing fees", () => {
    const charges = computeOrderCharges({
      amountGrossCents: 0,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      buyerTotalCents: 0,
    });

    expect(charges).toEqual({
      subtotalCents: 0,
      platformFeeCents: 0,
      taxCents: 0,
      processingFeeCents: 0,
      totalCents: 0,
    });
  });

  it("surfaces a negative processing fee rather than clamping it", () => {
    // Inconsistent stored amounts must stay visible — silently clamping to 0
    // would make the rows stop summing to the total with no signal.
    const charges = computeOrderCharges({
      amountGrossCents: 5000,
      feesPlatformCents: 500,
      taxAmountCents: 0,
      buyerTotalCents: 5200,
    });

    expect(charges.processingFeeCents).toBe(-300);
  });
});

describe("shouldShowChargeRow", () => {
  it("hides zero rows", () => {
    expect(shouldShowChargeRow(0)).toBe(false);
  });

  it("shows non-zero rows, including negatives", () => {
    expect(shouldShowChargeRow(1)).toBe(true);
    expect(shouldShowChargeRow(-1)).toBe(true);
  });
});
