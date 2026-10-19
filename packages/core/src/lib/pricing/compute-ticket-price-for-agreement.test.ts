import { describe, expect, it } from "vitest";

import { computeOrderSplits } from "./compute-order-splits";
import {
  FeeMode,
  SALE_FEE_MODE,
  computePlatformFeePerTicketCents,
  computeTicketPriceForAgreement,
  type ComputeTicketPriceInput,
} from "./compute-ticket-price-for-agreement";

describe("computeTicketPrice", () => {
  const baseAgreement: ComputeTicketPriceInput["agreement"] = {
    id: "agreement-1",
    policy: {
      id: "policy-1",
      version: 1,
      feeMode: FeeMode.PASS_THROUGH,
      processsorFeePct: 0.03,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
      buyerFeePct: 0.05,
      maxFeeCents: null,
      platformFixedCents: 0,
    },
    lines: [
      {
        id: "line-a",
        payeeId: "payee-a",
        percent: 60,
        priority: 10,
      },
      {
        id: "line-b",
        payeeId: "payee-b",
        percent: 40,
        priority: 5,
      },
    ],
  };

  it("charges buyers for passthrough fees on $1 tickets", () => {
    // $1 ticket, 5% buyer fee = 5c platform fee.
    // Processor fees (pct + flat) are computed at the ORDER level in
    // computeOrderAmounts, NOT per-ticket.
    // buyerUnitTotal = 100 + 5 = 105c
    const result = computeTicketPriceForAgreement({
      qty: 100,
      unitPriceCents: 100,
      agreement: baseAgreement,
    });

    expect(result.platformFeePerTicketCents).toBe(5);
    expect(result.buyerUnitTotalCents).toBe(105);
    expect(result.buyerTotalCents).toBe(10_500);
    expect(result.splitsTotalCents).toBe(10_500);
    expect(result.splits).toEqual([
      { payeeId: "payee-a", amountCents: 6_300 },
      { payeeId: "payee-b", amountCents: 4_200 },
    ]);
    expect(result.effectiveFeeMode).toBe(FeeMode.PASS_THROUGH);
  });

  // ABSORB is removed (docs/decisions/absorb-removed.md). The migration
  // converts the stored rows; these prove a row that slipped through still
  // prices a NEW sale fees-on-top.
  it("SALE_FEE_MODE is PASS_THROUGH", () => {
    expect(SALE_FEE_MODE).toBe(FeeMode.PASS_THROUGH);
  });

  it("terms that still say ABSORB price the sale fees-on-top ($15 tickets)", () => {
    const result = computeTicketPriceForAgreement({
      qty: 100,
      unitPriceCents: 1_500,
      agreement: {
        ...baseAgreement,
        feeMode: FeeMode.ABSORB,
      },
    });

    // 5% of 1500 = 75c, added on top: the buyer pays 1575 a ticket.
    expect(result.platformFeePerTicketCents).toBe(75);
    expect(result.buyerUnitTotalCents).toBe(1_575);
    expect(result.buyerTotalCents).toBe(157_500);
    expect(result.splits).toEqual([
      { payeeId: "payee-a", amountCents: 94_500 },
      { payeeId: "payee-b", amountCents: 63_000 },
    ]);
    expect(result.splitsTotalCents).toBe(157_500);
    expect(result.effectiveFeeMode).toBe(FeeMode.PASS_THROUGH);
  });

  it("adds platformFixedCents on top of percentage fee in pass-through mode", () => {
    // $50 ticket, 5% buyer fee = 250c pct fee, +25c fixed = 275c platform fee
    // Processor fees are handled at the order level.
    // buyer total: 5000 + 275 = 5275c
    const result = computeTicketPriceForAgreement({
      qty: 1,
      unitPriceCents: 5_000,
      agreement: {
        ...baseAgreement,
        policy: {
          ...baseAgreement.policy,
          platformFixedCents: 25,
        },
      },
    });

    expect(result.platformFeePerTicketCents).toBe(275);
    expect(result.buyerUnitTotalCents).toBe(5_275);
    expect(result.effectiveFeeMode).toBe(FeeMode.PASS_THROUGH);
  });

  it("a modeless agreement on an ABSORB policy prices the sale fees-on-top", () => {
    // $50 ticket, 5% = 250c, +25c fixed = 275c platform fee, on top of face.
    // Before the removal a null terms mode inherited the policy's ABSORB and
    // the buyer paid 5000.
    const result = computeTicketPriceForAgreement({
      qty: 2,
      unitPriceCents: 5_000,
      agreement: {
        ...baseAgreement,
        feeMode: null,
        policy: {
          ...baseAgreement.policy,
          feeMode: FeeMode.ABSORB,
          platformFixedCents: 25,
        },
      },
    });

    expect(result.platformFeePerTicketCents).toBe(275);
    expect(result.buyerUnitTotalCents).toBe(5_275);
    expect(result.buyerTotalCents).toBe(10_550);
    expect(result.effectiveFeeMode).toBe(FeeMode.PASS_THROUGH);
  });

  it("caps percentage fee before adding platformFixedCents", () => {
    // $100 ticket, 5% = 500c pct fee, capped to 200c, +50c fixed = 250c platform fee
    const result = computeTicketPriceForAgreement({
      qty: 1,
      unitPriceCents: 10_000,
      agreement: {
        ...baseAgreement,
        policy: {
          ...baseAgreement.policy,
          maxFeeCents: 200,
          platformFixedCents: 50,
        },
      },
    });

    expect(result.platformFeePerTicketCents).toBe(250);
  });

  it("defaults platformFixedCents to 0 when not provided", () => {
    const { platformFixedCents: _, ...policyWithoutFixed } =
      baseAgreement.policy;
    const result = computeTicketPriceForAgreement({
      qty: 1,
      unitPriceCents: 1_000,
      agreement: {
        ...baseAgreement,
        policy:
          policyWithoutFixed as ComputeTicketPriceInput["agreement"]["policy"],
      },
    });

    // 5% of 1000 = 50c platform fee (no fixed addition)
    expect(result.platformFeePerTicketCents).toBe(50);
  });

  // A line's `capPercent` used to be clamped and then handed straight back by
  // the remainder pass, in BOTH this preview and settlement — so the two
  // "agreed", on the wrong number. Both now run the same shared, cap-aware
  // `distributeRemainder`.
  describe("capPercent on a line", () => {
    const zeroFeePolicy: ComputeTicketPriceInput["agreement"]["policy"] = {
      id: "policy-cap",
      version: 1,
      feeMode: FeeMode.ABSORB,
      processsorFeePct: 0,
      processorFixedCents: 0,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
      buyerFeePct: 0,
      maxFeeCents: null,
      minFeeCents: 0,
      platformFixedCents: 0,
    };

    const cappedAgreement = (
      capPercent: number,
      cappedLinePercent: number,
      otherLinePercent: number,
    ): ComputeTicketPriceInput["agreement"] => ({
      id: "agreement-cap",
      feeMode: FeeMode.ABSORB,
      policy: zeroFeePolicy,
      lines: [
        {
          id: "line-venue",
          payeeId: "aaa-venue",
          percent: cappedLinePercent,
          capPercent,
          priority: 0,
          rounding: "FLOOR",
        },
        {
          id: "line-organiser",
          payeeId: "bbb-organiser",
          percent: otherLinePercent,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ],
    });

    it("quotes a 5%-capped line at its cap, not 2.5x it", () => {
      const result = computeTicketPriceForAgreement({
        qty: 1,
        unitPriceCents: 10_000,
        agreement: cappedAgreement(5, 20, 80),
      });

      expect(result.splits).toEqual([
        { payeeId: "aaa-venue", amountCents: 500 },
        { payeeId: "bbb-organiser", amountCents: 9_500 },
      ]);
      expect(result.splitsTotalCents).toBe(10_000);
    });

    it("quotes a 1%-capped line at its cap, not 25.5x it", () => {
      const result = computeTicketPriceForAgreement({
        qty: 1,
        unitPriceCents: 10_000,
        agreement: cappedAgreement(1, 50, 50),
      });

      expect(result.splits).toEqual([
        { payeeId: "aaa-venue", amountCents: 100 },
        { payeeId: "bbb-organiser", amountCents: 9_900 },
      ]);
      expect(result.splitsTotalCents).toBe(10_000);
    });

    it("agrees with computeOrderSplits cent for cent ON THE SAME BASIS", () => {
      // Same lines, same basis, same numbers — asserted against the other
      // implementation rather than a hand-typed constant, so the shared math
      // cannot drift apart again.
      //
      // Read the title literally. This feeds `preview.buyerTotalCents` back in
      // as settlement's basis, so it is TAUTOLOGICAL on the basis axis and
      // proves nothing about the real pipeline, where settlement distributes
      // `computeAgreementBasis` (the order's ticket money, without the
      // buyer-paid fee) instead. That
      // divergence is real, pre-existing, and identical for uncapped
      // percentages — see the note on `computeTicketPriceForAgreement`.
      for (const [capPercent, cappedPercent, otherPercent, qty, unit] of [
        [5, 20, 80, 1, 10_000],
        [1, 50, 50, 1, 10_000],
        [3, 34, 66, 7, 1_337],
        [10, 50, 50, 3, 999],
        [50, 20, 80, 2, 4_999],
      ] as const) {
        const agreement = cappedAgreement(
          capPercent,
          cappedPercent,
          otherPercent,
        );
        const preview = computeTicketPriceForAgreement({
          qty,
          unitPriceCents: unit,
          agreement,
        });
        const settlement = computeOrderSplits({
          amountCents: preview.buyerTotalCents,
          lines: agreement.lines.map((l) => ({
            id: l.id,
            payeeId: l.payeeId,
            percent: l.percent,
            capPercent: l.capPercent ?? null,
            priority: l.priority,
            rounding: l.rounding,
          })),
        });

        expect(
          preview.splits,
          `cap=${capPercent} qty=${qty} unit=${unit}`,
        ).toEqual(settlement.splits);
      }
    });

    it("terminates when every line is capped, leaving the residue unquoted", () => {
      const result = computeTicketPriceForAgreement({
        qty: 1,
        unitPriceCents: 10_000,
        agreement: {
          ...cappedAgreement(10, 50, 50),
          lines: cappedAgreement(10, 50, 50).lines.map((l) => ({
            ...l,
            capPercent: 10,
          })),
        },
      });

      expect(result.splits).toEqual([
        { payeeId: "aaa-venue", amountCents: 1_000 },
        { payeeId: "bbb-organiser", amountCents: 1_000 },
      ]);
      expect(result.splitsTotalCents).toBe(2_000);
      // The quote SAYS it cannot distribute what it charges.
      expect(result.unallocatedCents).toBe(8_000);
    }, 5_000);

    it("quotes zero residue for a capped line beside an uncapped one", () => {
      const result = computeTicketPriceForAgreement({
        qty: 1,
        unitPriceCents: 10_000,
        agreement: cappedAgreement(5, 20, 80),
      });

      expect(result.unallocatedCents).toBe(0);
      expect(result.splitsTotalCents).toBe(result.buyerTotalCents);
    });
  });
});

// Owner ruling, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
// be any fee." The formula's fixed part and floor used to apply at a $0 face
// (`max(0 + fixed, min)`), which a paid cart then charged on its free tickets.
describe("a $0 ticket carries no platform fee", () => {
  type FeeRates = Parameters<typeof computePlatformFeePerTicketCents>[1];

  const POLICIES: Array<[string, FeeRates]> = [
    [
      "5% + 50¢ fixed",
      { buyerFeePct: 0.05, maxFeeCents: null, minFeeCents: 0, platformFixedCents: 50 },
    ],
    [
      "5% with a 50¢ minimum",
      { buyerFeePct: 0.05, maxFeeCents: null, minFeeCents: 50, platformFixedCents: 0 },
    ],
    [
      "5% + 30¢ fixed, 100¢ minimum, 40¢ cap",
      { buyerFeePct: 0.05, maxFeeCents: 40, minFeeCents: 100, platformFixedCents: 30 },
    ],
    [
      "fixed 50¢ only",
      { buyerFeePct: 0, maxFeeCents: null, minFeeCents: 0, platformFixedCents: 50 },
    ],
    [
      "3.33% capped at 50¢ (the live policy's shape)",
      { buyerFeePct: 0.0333, maxFeeCents: 50, minFeeCents: 0, platformFixedCents: 0 },
    ],
  ];

  it.each(POLICIES)("%s: the fee on a $0 face is 0", (_name, rates) => {
    expect(computePlatformFeePerTicketCents(0, rates)).toBe(0);
  });

  it("a paid ticket still pays the fixed part and the floor, down to 1¢", () => {
    const fixed = POLICIES[0]![1];
    const minimum = POLICIES[1]![1];
    const both = POLICIES[2]![1];

    // round(1 × 5%) = 0, + 50¢ fixed.
    expect(computePlatformFeePerTicketCents(1, fixed)).toBe(50);
    // round(3000 × 5%) = 150, + 50¢ fixed.
    expect(computePlatformFeePerTicketCents(3000, fixed)).toBe(200);
    // 0¢ of percentage, floored at 50¢.
    expect(computePlatformFeePerTicketCents(1, minimum)).toBe(50);
    // round(500 × 5%) = 25, floored at 50¢.
    expect(computePlatformFeePerTicketCents(500, minimum)).toBe(50);
    expect(computePlatformFeePerTicketCents(3000, minimum)).toBe(150);
    // min(150, 40) + 30 = 70, floored at 100.
    expect(computePlatformFeePerTicketCents(3000, both)).toBe(100);
  });

  it.each(POLICIES)(
    "%s: the quote for $0 tickets is $0 all the way through, at any quantity",
    (_name, rates) => {
      for (const qty of [1, 2, 7]) {
        const result = computeTicketPriceForAgreement({
          qty,
          unitPriceCents: 0,
          agreement: {
            id: "agreement-free",
            lines: [{ id: "line-a", payeeId: "payee-a", percent: 100 }],
            policy: {
              id: "policy-free",
              version: 1,
              feeMode: FeeMode.PASS_THROUGH,
              processsorFeePct: 0.029,
              processorFixedCents: 30,
              payoutPct: 0,
              payoutFixedCents: 0,
              monthlyPayoutCents: 0,
              ...rates,
            },
          },
        });

        expect(result.platformFeePerTicketCents).toBe(0);
        expect(result.buyerUnitTotalCents).toBe(0);
        expect(result.buyerTotalCents).toBe(0);
        expect(result.splitsTotalCents).toBe(0);
        expect(result.unallocatedCents).toBe(0);
      }
    },
  );

  it("rows that still say ABSORB make no difference: $0 pays no fee", () => {
    const result = computeTicketPriceForAgreement({
      qty: 3,
      unitPriceCents: 0,
      agreement: {
        id: "agreement-absorb",
        feeMode: FeeMode.ABSORB,
        lines: [{ id: "line-a", payeeId: "payee-a", percent: 100 }],
        policy: {
          id: "policy-absorb",
          version: 1,
          feeMode: FeeMode.ABSORB,
          processsorFeePct: 0.029,
          processorFixedCents: 30,
          payoutPct: 0,
          payoutFixedCents: 0,
          monthlyPayoutCents: 0,
          buyerFeePct: 0.05,
          maxFeeCents: null,
          minFeeCents: 50,
          platformFixedCents: 50,
        },
      },
    });

    expect(result.effectiveFeeMode).toBe(SALE_FEE_MODE);
    expect(result.platformFeePerTicketCents).toBe(0);
    expect(result.buyerTotalCents).toBe(0);
  });
});
