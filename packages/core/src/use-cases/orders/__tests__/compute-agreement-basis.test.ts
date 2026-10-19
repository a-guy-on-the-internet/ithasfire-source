import { describe, expect, it } from "vitest";

import {
  buildFeePolicySnapshot,
  type PayoutTermsContext,
} from "../checkout-helpers";
import { computeAgreementBasis } from "../finalize-from-payment-intent";
import { computeOrderSplits } from "../../../lib/pricing/compute-order-splits";
import { computePlatformFeePerTicketCents } from "../../../lib/pricing/compute-ticket-price-for-agreement";
import { solveProcessingFeeGrossUp } from "../../../lib/pricing/processing-cost-schedule";

// ─────────────────────────────────────────────────────────────────────────────
// Settlement-basis math
//
// `computeAgreementBasis` is the *only* place the settlement pipeline decides
// what dollar amount the per-payee percentages multiply against. The rule is
// read from the order's own `feePolicySnapshot.organiserCredit`:
//
//   - `"FULL_PRICE"` (every sale since the owner's 2026-10-11 ruling): the
//     full ticket money, `amountGrossCents`. The platform fee is taken once,
//     from the buyer on top.
//   - no marker (an order sold before the ruling): `amountGrossCents −
//     feesPlatformCents`, the amount it was credited at the time.
//
// Spec: docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml.
//
// The first two describes below run UNMARKED orders (no snapshot), so they pin
// the pre-ruling rule that past orders keep.
// ─────────────────────────────────────────────────────────────────────────────

const FULL_PRICE = { organiserCredit: "FULL_PRICE" } as const;

describe("computeAgreementBasis: the order's snapshot picks the rule", () => {
  const AMOUNTS = { amountGrossCents: 7_500, feesPlatformCents: 50 };

  it("credits the full ticket price on an order marked FULL_PRICE", () => {
    expect(
      computeAgreementBasis({ ...AMOUNTS, feePolicySnapshot: FULL_PRICE }),
    ).toBe(7_500);
  });

  it("the snapshot checkout builds is one the basis reads as FULL_PRICE", () => {
    // The stamp site and the read site, joined: if either renames the key or
    // the value, a new sale silently falls back to gross − fee.
    const snapshot = buildFeePolicySnapshot(
      {
        agreement: { id: "terms-1", version: 3 },
        lines: [],
        feePolicy: { id: "policy-1", version: 2 },
      } as unknown as PayoutTermsContext,
      new Date("2026-10-11T00:00:00.000Z"),
    );
    expect(snapshot).toEqual({
      payoutTermsId: "terms-1",
      payoutTermsVersion: 3,
      agreementId: "terms-1",
      agreementVersion: 3,
      feePolicyId: "policy-1",
      feePolicyVersion: 2,
      feeMode: "PASS_THROUGH",
      organiserCredit: "FULL_PRICE",
      computedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(
      computeAgreementBasis({ ...AMOUNTS, feePolicySnapshot: snapshot }),
    ).toBe(7_500);
    // Through the JSON column and back, as Postgres stores it.
    expect(
      computeAgreementBasis({
        ...AMOUNTS,
        feePolicySnapshot: JSON.parse(JSON.stringify(snapshot)),
      }),
    ).toBe(7_500);
  });

  it("reads the marker beside the rest of a real snapshot", () => {
    expect(
      computeAgreementBasis({
        ...AMOUNTS,
        feePolicySnapshot: {
          payoutTermsId: "terms-1",
          feePolicyId: "policy-1",
          feeMode: "PASS_THROUGH",
          organiserCredit: "FULL_PRICE",
          computedAt: "2026-10-11T00:00:00.000Z",
        },
      }),
    ).toBe(7_500);
  });

  it.each([
    ["a null snapshot", null],
    ["an undefined snapshot", undefined],
    ["an empty snapshot (the adapter's default)", {}],
    [
      "a pre-ruling snapshot without the key",
      { payoutTermsId: "terms-1", feeMode: "PASS_THROUGH" },
    ],
    ["an unknown value", { organiserCredit: "NET_OF_FEE" }],
    ["a differently-cased value", { organiserCredit: "full_price" }],
    ["a boolean value", { organiserCredit: true }],
    ["a null value", { organiserCredit: null }],
    ["a string snapshot", "FULL_PRICE"],
    ["a JSON-string snapshot", '{"organiserCredit":"FULL_PRICE"}'],
    ["a number snapshot", 1],
    ["an array snapshot", [{ organiserCredit: "FULL_PRICE" }]],
    ["an array carrying the key", Object.assign([], FULL_PRICE)],
  ])("keeps the pre-ruling rule (gross − fee) for %s", (_name, snapshot) => {
    expect(
      computeAgreementBasis({ ...AMOUNTS, feePolicySnapshot: snapshot }),
    ).toBe(7_450);
  });

  it("does not throw on a nested or oddly-typed marker; it falls back", () => {
    expect(
      computeAgreementBasis({
        ...AMOUNTS,
        feePolicySnapshot: { organiserCredit: { nested: ["FULL_PRICE"] } },
      }),
    ).toBe(7_450);
  });

  it("a marked discounted order credits what the buyer paid for the ticket", () => {
    // Face 7500, $25 off: `amountGrossCents` is the post-discount 5000. The
    // fee is recorded on the full face and is the buyer's, on top.
    expect(
      computeAgreementBasis({
        amountGrossCents: 5_000,
        feesPlatformCents: 50,
        feePolicySnapshot: FULL_PRICE,
      }),
    ).toBe(5_000);
  });

  it("a marked order whose gross is below the fee still credits the gross", () => {
    expect(
      computeAgreementBasis({
        amountGrossCents: 20,
        feesPlatformCents: 50,
        feePolicySnapshot: FULL_PRICE,
      }),
    ).toBe(20);
  });

  it("a marked $0 order credits 0, and a negative gross floors at 0", () => {
    expect(
      computeAgreementBasis({
        amountGrossCents: 0,
        feesPlatformCents: 0,
        feePolicySnapshot: FULL_PRICE,
      }),
    ).toBe(0);
    expect(
      computeAgreementBasis({
        amountGrossCents: -100,
        feesPlatformCents: 0,
        feePolicySnapshot: FULL_PRICE,
      }),
    ).toBe(0);
  });

  it("marked splits sum to the gross; unmarked splits sum to gross − fee", () => {
    const lines = [
      {
        id: "line-performer",
        payeeId: "payee-performer",
        percent: 70,
        floorCents: 0,
        capPercent: null,
        priority: 1,
        rounding: "FLOOR" as const,
      },
      {
        id: "line-owner",
        payeeId: "payee-owner",
        percent: 30,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR" as const,
      },
    ];
    const marked = computeOrderSplits({
      amountCents: computeAgreementBasis({
        ...AMOUNTS,
        feePolicySnapshot: FULL_PRICE,
      }),
      lines,
    });
    const unmarked = computeOrderSplits({
      amountCents: computeAgreementBasis({ ...AMOUNTS, feePolicySnapshot: null }),
      lines,
    });
    expect(marked.totalCents).toBe(7_500);
    expect(marked.splits.map((x) => x.amountCents)).toEqual([5_250, 2_250]);
    expect(unmarked.totalCents).toBe(7_450);
    expect(unmarked.splits.map((x) => x.amountCents)).toEqual([5_215, 2_235]);
  });
});

describe("computeAgreementBasis: an unmarked (pre-ruling) order", () => {
  it("returns gross minus platform fees", () => {
    expect(
      computeAgreementBasis({
        amountGrossCents: 10_000,
        feesPlatformCents: 500,
        feePolicySnapshot: {},
      }),
    ).toBe(9_500);
  });

  it("returns 0 when fees would push the basis negative", () => {
    expect(
      computeAgreementBasis({
        amountGrossCents: 100,
        feesPlatformCents: 500,
        feePolicySnapshot: {},
      }),
    ).toBe(0);
  });

  it("returns the full gross when no platform fees were assessed", () => {
    expect(
      computeAgreementBasis({
        amountGrossCents: 10_000,
        feesPlatformCents: 0,
        feePolicySnapshot: {},
      }),
    ).toBe(10_000);
  });

  it("ignores any other fields on the order record", () => {
    // Stripe processing fees, taxes, etc. live on the order but must NOT
    // affect this computation — only the platform fee is carved off the
    // pool here. Stripe's cut is taken downstream by the processor.
    const orderWithExtras = {
      amountGrossCents: 10_000,
      feesPlatformCents: 500,
      feePolicySnapshot: {},
      // extras the function should ignore:
      processorFeeCents: 320,
      taxCents: 800,
      refundedCents: 200,
    } as const;
    expect(computeAgreementBasis(orderWithExtras)).toBe(9_500);
  });
});

describe("settlement distribution end-to-end: an unmarked (pre-ruling) order", () => {
  // A typical pre-ruling order — $100 gross, $5 platform fee — with no
  // `organiserCredit` marker: the payees divide the $95 it was credited.
  const ORDER = {
    amountGrossCents: 10_000,
    feesPlatformCents: 500,
    feePolicySnapshot: {},
  };

  it("distributes 100% to the owner for a single-line agreement", () => {
    const basis = computeAgreementBasis(ORDER);
    const result = computeOrderSplits({
      amountCents: basis,
      lines: [
        {
          id: "line-owner",
          payeeId: "payee-owner",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ],
    });

    expect(basis).toBe(9_500);
    expect(result.totalCents).toBe(9_500);
    expect(result.splits).toEqual([
      { payeeId: "payee-owner", amountCents: 9_500 },
    ]);
  });

  it("splits the post-fee net 70/30 between performer and owner", () => {
    const basis = computeAgreementBasis(ORDER);
    const result = computeOrderSplits({
      amountCents: basis,
      lines: [
        {
          id: "line-performer",
          payeeId: "payee-performer",
          percent: 70,
          floorCents: 0,
          capPercent: null,
          priority: 1,
          rounding: "FLOOR",
        },
        {
          id: "line-owner",
          payeeId: "payee-owner",
          percent: 30,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ],
    });

    expect(result.totalCents).toBe(9_500);
    // Performer gets 70% of $95 = $66.50
    expect(
      result.splits.find((s) => s.payeeId === "payee-performer")?.amountCents,
    ).toBe(6_650);
    // Owner gets the remaining 30% = $28.50
    expect(
      result.splits.find((s) => s.payeeId === "payee-owner")?.amountCents,
    ).toBe(2_850);
    // Together they exactly equal the post-fee net — the platform fee
    // is NOT charged a second time against payees' shares.
    const total = result.splits.reduce((s, x) => s + x.amountCents, 0);
    expect(total).toBe(ORDER.amountGrossCents - ORDER.feesPlatformCents);
  });

  it("never overpays the seller's net even with awkward % splits", () => {
    // Three-way split that doesn't divide evenly into 9500 cents.
    const basis = computeAgreementBasis(ORDER);
    const result = computeOrderSplits({
      amountCents: basis,
      lines: [
        {
          id: "a",
          payeeId: "a",
          percent: 33,
          floorCents: 0,
          capPercent: null,
          priority: 2,
          rounding: "FLOOR",
        },
        {
          id: "b",
          payeeId: "b",
          percent: 33,
          floorCents: 0,
          capPercent: null,
          priority: 1,
          rounding: "FLOOR",
        },
        {
          id: "c",
          payeeId: "c",
          percent: 34,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ],
    });

    // Distribution sums to *exactly* the basis — no rounding leaks above
    // the seller's net.
    expect(result.totalCents).toBe(9_500);
  });

  it("distributes 100% of the resale ask price to the seller", () => {
    // Resale orders go through the same `computeAgreementBasis` →
    // `computeOrderSplits` path. By design `feesPlatformCents` is 0 on
    // resale orders (the platform fee for resale is captured via the
    // seller-markup-share split at pricing time, not the payee-split
    // pipeline), so the basis is the full ask price and the seller
    // gets 100%.
    const RESALE_ORDER = {
      amountGrossCents: 5_000,
      feesPlatformCents: 0,
      feePolicySnapshot: {},
    };
    const basis = computeAgreementBasis(RESALE_ORDER);
    const result = computeOrderSplits({
      amountCents: basis,
      lines: [
        {
          id: "line-seller",
          payeeId: "payee-seller",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ],
    });

    expect(basis).toBe(5_000);
    expect(result.totalCents).toBe(5_000);
    expect(result.splits[0]?.amountCents).toBe(5_000);
  });

  it("clamps to zero when fees swallow the gross", () => {
    const basis = computeAgreementBasis({
      amountGrossCents: 100,
      feesPlatformCents: 500,
      feePolicySnapshot: {},
    });
    const result = computeOrderSplits({
      amountCents: basis,
      lines: [
        {
          id: "x",
          payeeId: "x",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ],
    });

    expect(result.totalCents).toBe(0);
    expect(result.splits[0]?.amountCents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Where every cent of a PASS_THROUGH sale goes
//
// The buyer pays face + platform fee + tax + a grossed-up processor fee. The
// order's `amountGrossCents` is the face after any discount.
//
//   - An order marked `organiserCredit: "FULL_PRICE"` (every sale since the
//     owner's 2026-10-11 ruling) credits the organiser `amountGrossCents`.
//     The platform keeps the fee ONCE: the unit the buyer paid on top.
//   - An UNMARKED order (sold before the ruling) was credited
//     `amountGrossCents − feesPlatformCents`. The platform kept the fee TWICE:
//     once from the buyer and once out of the organiser's basis. Those orders
//     keep the amounts they were credited, so that case stays pinned here.
//
// The buyer's charge is identical in both cases. This block pins the basis,
// the per-ticket fee and the gross-up solver in literal cents, so a change to
// any of them is deliberate. The charge itself is composed by hand here; how
// the checkout composes it is pinned in
// `packages/core/src/use-cases/orders/_shared/__tests__/price-cart.test.ts`
// and `packages/core/src/use-cases/orders/__tests__/create-checkout.test.ts`.
// Spec: docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml.
//
// The fee policy and processor rate are literals so these cents do not move
// when the shipped policy constant does.
// ─────────────────────────────────────────────────────────────────────────────

describe("where the cents of a PASS_THROUGH sale go, marked and unmarked", () => {
  // 3.33% of face, capped at 50¢ a ticket.
  const FEE_POLICY = {
    buyerFeePct: 0.0333,
    maxFeeCents: 50,
    minFeeCents: 0,
    platformFixedCents: 0,
  };
  // Card rate: 2.9% + 30¢.
  const PROCESSOR_PCT = 0.029;
  const PROCESSOR_FIXED_CENTS = 30;

  // The deduction for a card at the policy rate (2.9% + 30¢, rounded up), as
  // `solveProcessingFee` models it, written out independently of the gross-up
  // solver so the two can be compared. It is that model, not a measured
  // processor deduction: other payment methods the PaymentIntent offers (ACH,
  // Cash App, Amazon Pay) have different rates.
  const processorDeductionCents = (chargeCents: number) =>
    Math.ceil(chargeCents * PROCESSOR_PCT) + PROCESSOR_FIXED_CENTS;

  it("a FULL_PRICE sale keeps the platform fee ONCE: the buyer pays it on top and the organiser is credited the full face", () => {
    // The same $75.00 ticket and the same charge as the unmarked case below.
    const faceCents = 7_500;
    const taxCents = 647;

    const platformFeeCents = computePlatformFeePerTicketCents(
      faceCents,
      FEE_POLICY,
    );
    expect(platformFeeCents).toBe(50);

    const netCents = faceCents + platformFeeCents + taxCents;
    expect(netCents).toBe(8_197);

    const processorFeeCents = solveProcessingFeeGrossUp(
      netCents,
      PROCESSOR_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    expect(processorFeeCents).toBe(276);

    // The buyer's charge does not move with the credit rule.
    const buyerChargeCents = netCents + processorFeeCents;
    expect(buyerChargeCents).toBe(8_473);
    expect(processorDeductionCents(buyerChargeCents)).toBe(processorFeeCents);

    const basisCents = computeAgreementBasis({
      amountGrossCents: faceCents,
      feesPlatformCents: platformFeeCents,
      feePolicySnapshot: FULL_PRICE,
    });
    expect(basisCents).toBe(7_500);
    expect(basisCents).toBe(faceCents);

    const platformKeepsCents =
      buyerChargeCents -
      processorDeductionCents(buyerChargeCents) -
      taxCents -
      basisCents;
    expect(platformKeepsCents).toBe(50);
    expect(platformKeepsCents).toBe(platformFeeCents);
  });

  it("a FULL_PRICE $10.00 ticket with a 33¢ fee credits 1000 and the platform keeps 33", () => {
    const faceCents = 1_000;
    const platformFeeCents = computePlatformFeePerTicketCents(
      faceCents,
      FEE_POLICY,
    );
    expect(platformFeeCents).toBe(33);

    const netCents = faceCents + platformFeeCents;
    const processorFeeCents = solveProcessingFeeGrossUp(
      netCents,
      PROCESSOR_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    const buyerChargeCents = netCents + processorFeeCents;
    expect(buyerChargeCents).toBe(1_095);

    const basisCents = computeAgreementBasis({
      amountGrossCents: faceCents,
      feesPlatformCents: platformFeeCents,
      feePolicySnapshot: FULL_PRICE,
    });
    expect(basisCents).toBe(1_000);
    expect(
      buyerChargeCents - processorDeductionCents(buyerChargeCents) - basisCents,
    ).toBe(33);
  });

  it("a FULL_PRICE sale whose gross is below the fee credits the gross and the platform keeps exactly the fee", () => {
    const platformFeeCents = 50;
    const grossCents = 20;
    const netCents = grossCents + platformFeeCents;
    const processorFeeCents = solveProcessingFeeGrossUp(
      netCents,
      PROCESSOR_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    const buyerChargeCents = netCents + processorFeeCents;
    expect(buyerChargeCents).toBe(103);

    const basisCents = computeAgreementBasis({
      amountGrossCents: grossCents,
      feesPlatformCents: platformFeeCents,
      feePolicySnapshot: FULL_PRICE,
    });
    expect(basisCents).toBe(20);
    expect(
      buyerChargeCents - processorDeductionCents(buyerChargeCents) - basisCents,
    ).toBe(platformFeeCents);
  });

  it("an UNMARKED (pre-ruling) PASS_THROUGH sale kept the platform fee twice: from the buyer and out of the basis", () => {
    // One $75.00 ticket. Tax is 8.62% of the ticket face (taxable 7500),
    // entered as its settled cents rather than solved here.
    const faceCents = 7_500;
    const taxCents = 647;

    // round(7500 × 0.0333) = 250, capped to 50.
    const platformFeeCents = computePlatformFeePerTicketCents(
      faceCents,
      FEE_POLICY,
    );
    expect(platformFeeCents).toBe(50);

    // Everything the charge must cover except the processor fee.
    const netCents = faceCents + platformFeeCents + taxCents;
    expect(netCents).toBe(8_197);

    const processorFeeCents = solveProcessingFeeGrossUp(
      netCents,
      PROCESSOR_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    expect(processorFeeCents).toBe(276);

    const buyerChargeCents = netCents + processorFeeCents;
    expect(buyerChargeCents).toBe(8_473);

    // At the policy's card rate the deduction equals what the buyer funded,
    // so none of the processor fee lands on the platform or the organiser.
    expect(processorDeductionCents(buyerChargeCents)).toBe(processorFeeCents);

    const basisCents = computeAgreementBasis({
      amountGrossCents: faceCents,
      feesPlatformCents: platformFeeCents,
      feePolicySnapshot: {},
    });
    expect(basisCents).toBe(7_450);

    // What is left of the charge once the processor (at the card rate), the
    // tax authority and the organiser have their cents.
    const platformKeepsCents =
      buyerChargeCents -
      processorDeductionCents(buyerChargeCents) -
      taxCents -
      basisCents;
    expect(platformKeepsCents).toBe(100);
    expect(platformKeepsCents).toBe(2 * platformFeeCents);
  });

  it("unmarked: matches the decision record's example, a $10.00 ticket with a 33¢ fee credits 967 and the platform keeps 66",() => {
    // No tax.
    const faceCents = 1_000;

    // round(1000 × 0.0333) = 33, under the 50¢ cap.
    const platformFeeCents = computePlatformFeePerTicketCents(
      faceCents,
      FEE_POLICY,
    );
    expect(platformFeeCents).toBe(33);

    const netCents = faceCents + platformFeeCents;
    expect(netCents).toBe(1_033);

    const processorFeeCents = solveProcessingFeeGrossUp(
      netCents,
      PROCESSOR_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    expect(processorFeeCents).toBe(62);

    const buyerChargeCents = netCents + processorFeeCents;
    expect(buyerChargeCents).toBe(1_095);
    expect(processorDeductionCents(buyerChargeCents)).toBe(processorFeeCents);

    const basisCents = computeAgreementBasis({
      amountGrossCents: faceCents,
      feesPlatformCents: platformFeeCents,
      feePolicySnapshot: {},
    });
    expect(basisCents).toBe(967);

    const platformKeepsCents =
      buyerChargeCents -
      processorDeductionCents(buyerChargeCents) -
      basisCents;
    expect(platformKeepsCents).toBe(66);
    expect(platformKeepsCents).toBe(2 * platformFeeCents);
  });

  it("unmarked: when the gross is below the fee, the basis gives up the gross and the platform keeps less than twice the fee", () => {
    // `amountGrossCents` is the face after any discount; `feesPlatformCents`
    // is recorded on the full face, so it is passed as a literal. No tax.
    const platformFeeCents = 50;
    const grossCents = 20;

    const netCents = grossCents + platformFeeCents;
    expect(netCents).toBe(70);

    const processorFeeCents = solveProcessingFeeGrossUp(
      netCents,
      PROCESSOR_PCT,
      PROCESSOR_FIXED_CENTS,
    );
    expect(processorFeeCents).toBe(33);

    const buyerChargeCents = netCents + processorFeeCents;
    expect(buyerChargeCents).toBe(103);
    expect(processorDeductionCents(buyerChargeCents)).toBe(processorFeeCents);

    const basisCents = computeAgreementBasis({
      amountGrossCents: grossCents,
      feesPlatformCents: platformFeeCents,
      feePolicySnapshot: {},
    });
    expect(basisCents).toBe(0);

    const takenFromBasisCents = grossCents - basisCents;
    expect(takenFromBasisCents).toBe(20);
    expect(takenFromBasisCents).toBeLessThan(platformFeeCents);

    const platformKeepsCents =
      buyerChargeCents -
      processorDeductionCents(buyerChargeCents) -
      basisCents;
    expect(platformKeepsCents).toBe(70);
    expect(platformKeepsCents).toBeLessThan(2 * platformFeeCents);
  });

  it("unmarked: with the gross at or above the fee, the basis gives up exactly the fee", () => {
    const platformFeeCents = 50;

    // Gross equal to the fee: the basis is zero and gives up the whole gross.
    const equalBasisCents = computeAgreementBasis({
      amountGrossCents: platformFeeCents,
      feePolicySnapshot: {},
      feesPlatformCents: platformFeeCents,
    });
    expect(equalBasisCents).toBe(0);
    expect(platformFeeCents - equalBasisCents).toBe(platformFeeCents);

    // Gross above the fee: the basis gives up the whole fee.
    const fullGrossCents = 7_500;
    expect(
      fullGrossCents -
        computeAgreementBasis({
          amountGrossCents: fullGrossCents,
          feesPlatformCents: platformFeeCents,
          feePolicySnapshot: {},
        }),
    ).toBe(platformFeeCents);
  });
});
