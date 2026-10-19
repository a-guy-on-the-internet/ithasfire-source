import { describe, expect, it } from "vitest";

import {
  computeBenefitBreakEven,
  type BenefitBreakEvenInput,
} from "./compute-benefit-break-even";
import { computeAgreementBasis } from "../../use-cases/orders/finalize-from-payment-intent";
import { computePlatformFeePerTicketCents } from "./compute-ticket-price-for-agreement";
import { PLATFORM_FEE_POLICY } from "./platform-fee-policy";

/**
 * The calculator's whole job is to agree with the REAL settlement pipeline
 * for a sale under the 2026-10-11 ruling (the platform fee is taken once, from
 * the buyer; the organiser is credited the ticket price). `credited` is that
 * pipeline: `computeAgreementBasis` on an order stamped the way checkout
 * stamps it, carrying the real fee so a rule that subtracted it would show.
 */
const fee = (faceCents: number) =>
  computePlatformFeePerTicketCents(faceCents, PLATFORM_FEE_POLICY);
const credited = (faceCents: number, discountCents: number) =>
  computeAgreementBasis({
    amountGrossCents: faceCents - discountCents,
    feesPlatformCents: discountCents >= faceCents ? 0 : fee(faceCents),
    feePolicySnapshot: { organiserCredit: "FULL_PRICE" },
  });

const base: BenefitBreakEvenInput = {
  tierPriceCents: 1000,
  interval: "MONTH",
  discountKind: "AMOUNT",
  discountValue: 500,
  typicalTicketFaceCents: 2000,
  discountedTicketsPerPeriod: 0,
};

describe("computeBenefitBreakEven", () => {
  it("a partial discount costs the owner exactly the discount", () => {
    // $20 face, $5 off. The buyer pays the 50¢ fee on top; the owner is
    // credited the $15 the buyer paid for the ticket instead of $20.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 2000,
      discountKind: "AMOUNT",
      discountValue: 500,
      discountedTicketsPerPeriod: 1,
    });

    expect(fee(2000)).toBe(50);
    expect(result.discountPerTicketCents).toBe(500);
    expect(result.ownerCostPerTicketCents).toBe(500);
    expect(result.ownerCostPerTicketCents).toBe(
      credited(2000, 0) - credited(2000, 500),
    );
    expect(result.fullyFree).toBe(false);
    // Dues $10 − one $5 give-up = $5 clear.
    expect(result.ownerNetPerMemberCents).toBe(500);
  });

  it("treats a 100% discount as the FREE path: the owner gives up the full face", () => {
    // $20 face, 100% off → $0 order, credited nothing. At full price the
    // owner is credited the whole $20 (the fee is the buyer's, on top), so
    // that is what a free ticket costs them.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 2000,
      discountKind: "PERCENT",
      discountValue: 100,
      discountedTicketsPerPeriod: 1,
    });

    expect(result.fullyFree).toBe(true);
    expect(result.discountPerTicketCents).toBe(2000);
    expect(result.ownerCostPerTicketCents).toBe(2000);
    expect(result.ownerCostPerTicketCents).toBe(
      credited(2000, 0) - credited(2000, 2000),
    );
    // Dues $10 − $20 given up = −$10: this member costs money on show one.
    expect(result.ownerNetPerMemberCents).toBe(-1000);
    expect(result.breakEvenTicketsPerPeriod).toBe(1);
  });

  it("a deep partial discount costs the whole discount: no fee comes off the owner's side", () => {
    // $10 face, $9.90 off. The owner is credited the 10¢ the buyer paid for
    // the ticket instead of $10.00, so the give-up is $9.90. (Before the
    // 2026-10-11 ruling the 33¢ fee came out of the credit and capped this at
    // $9.67.)
    const result = computeBenefitBreakEven({
      ...base,
      tierPriceCents: 500,
      typicalTicketFaceCents: 1000,
      discountKind: "AMOUNT",
      discountValue: 990,
      discountedTicketsPerPeriod: 1,
    });

    expect(fee(1000)).toBe(33);
    expect(result.discountPerTicketCents).toBe(990);
    expect(result.fullyFree).toBe(false);
    expect(result.ownerCostPerTicketCents).toBe(990);
    expect(result.ownerCostPerTicketCents).toBe(
      credited(1000, 0) - credited(1000, 990),
    );
    expect(result.ownerNetPerMemberCents).toBe(500 - 990);
  });

  it("the give-up never exceeds the face", () => {
    // An AMOUNT benefit larger than the ticket: $50 off a $20 ticket gives up
    // $20, the most the owner could have been credited.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 2000,
      discountKind: "AMOUNT",
      discountValue: 5000,
      discountedTicketsPerPeriod: 1,
    });

    expect(result.ownerCostPerTicketCents).toBe(2000);
  });

  it("applies maxDiscountCents after the percent maths", () => {
    // 50% of $30 is $15, clamped to $6.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 3000,
      discountKind: "PERCENT",
      discountValue: 50,
      maxDiscountCents: 600,
      discountedTicketsPerPeriod: 2,
    });

    expect(result.discountPerTicketCents).toBe(600);
    expect(result.ownerCostPerTicketCents).toBe(600);
    expect(result.fullyFree).toBe(false);
    // $10 dues − 2 × $6 = −$2.
    expect(result.ownerNetPerMemberCents).toBe(-200);
  });

  it("a clamped 100% discount is NOT the free path", () => {
    // 100% of $30 clamped to $6 leaves $24 payable — an ordinary paid order
    // that credits the owner $24.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 3000,
      discountKind: "PERCENT",
      discountValue: 100,
      maxDiscountCents: 600,
      discountedTicketsPerPeriod: 1,
    });

    expect(result.fullyFree).toBe(false);
    expect(result.ownerCostPerTicketCents).toBe(600);
  });

  it("floors PERCENT maths to whole cents, matching clampDiscount", () => {
    // 33% of $10.01 = 330.33 → 330, never 331 and never a fractional cent.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 1001,
      discountKind: "PERCENT",
      discountValue: 33,
      discountedTicketsPerPeriod: 1,
    });

    expect(result.discountPerTicketCents).toBe(330);
    expect(Number.isInteger(result.ownerNetPerMemberCents)).toBe(true);
  });

  it("caps an AMOUNT discount at the ticket's face price", () => {
    // $50 off a $20 ticket is $20 off, and that IS the free path.
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 2000,
      discountKind: "AMOUNT",
      discountValue: 5000,
      discountedTicketsPerPeriod: 1,
    });

    expect(result.discountPerTicketCents).toBe(2000);
    expect(result.fullyFree).toBe(true);
  });

  describe("breakEvenTicketsPerPeriod", () => {
    const cases: Array<{
      name: string;
      input: Partial<BenefitBreakEvenInput>;
      expected: number | null;
    }> = [
      {
        // $10 dues, $5 off: two shows exactly repays the dues, the THIRD is
        // where the member starts costing money.
        name: "exact multiple crosses on the next ticket",
        input: { tierPriceCents: 1000, discountValue: 500 },
        expected: 3,
      },
      {
        // $10 dues, $3 off: 3 × $3 = $9 ≤ $10; 4 × $3 = $12 > $10.
        name: "non-multiple crosses when the total first exceeds dues",
        input: { tierPriceCents: 1000, discountValue: 300 },
        expected: 4,
      },
      {
        // $10 dues, $12 off: the first ticket already loses money.
        name: "a discount bigger than the dues crosses immediately",
        input: {
          tierPriceCents: 1000,
          discountValue: 1200,
          typicalTicketFaceCents: 5000,
        },
        expected: 1,
      },
      {
        // A benefit worth nothing on this ticket never crosses.
        name: "a zero-value discount never crosses",
        input: { tierPriceCents: 1000, discountValue: 0 },
        expected: null,
      },
      {
        // A free ticket costs the owner nothing to give away.
        name: "a free ticket never crosses",
        input: {
          tierPriceCents: 1000,
          discountValue: 100,
          discountKind: "PERCENT",
          typicalTicketFaceCents: 0,
        },
        expected: null,
      },
    ];

    for (const { name, input, expected } of cases) {
      it(name, () => {
        expect(
          computeBenefitBreakEven({ ...base, ...input })
            .breakEvenTicketsPerPeriod,
        ).toBe(expected);
      });
    }
  });

  it("denominates everything in the tier's own billing period", () => {
    // Identical terms, different cadence: a YEAR tier's $120 of dues absorbs
    // far more discounted shows than a MONTH tier's $10, and the answer is in
    // tickets per THAT period.
    const monthly = computeBenefitBreakEven({
      ...base,
      interval: "MONTH",
      tierPriceCents: 1000,
      discountValue: 500,
    });
    const yearly = computeBenefitBreakEven({
      ...base,
      interval: "YEAR",
      tierPriceCents: 12_000,
      discountValue: 500,
    });

    expect(monthly.breakEvenTicketsPerPeriod).toBe(3);
    expect(yearly.breakEvenTicketsPerPeriod).toBe(25);
  });

  it("keeps every output an integer number of cents", () => {
    const result = computeBenefitBreakEven({
      ...base,
      typicalTicketFaceCents: 1733,
      discountKind: "PERCENT",
      discountValue: 37,
      discountedTicketsPerPeriod: 3,
    });

    expect(Number.isInteger(result.discountPerTicketCents)).toBe(true);
    expect(Number.isInteger(result.ownerCostPerTicketCents)).toBe(true);
    expect(Number.isInteger(result.ownerNetPerMemberCents)).toBe(true);
  });
});
