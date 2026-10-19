import { describe, expect, it } from "vitest";

import {
  computeBuyerChargeBreakdown,
  type BuyerChargeBreakdown,
  type BuyerChargeOrderInput,
} from "../buyer-charge-breakdown";
import { computeExpectedPaymentAmount } from "../compute-expected-payment-amount";

const sumOfLines = (b: BuyerChargeBreakdown) =>
  b.subtotalCents +
  b.platformFeeCents +
  b.processingFeeCents +
  b.taxCents +
  b.creditCents;

/** The lines add to Total paid, and Total paid is the order's real charge. */
const expectLinesAddUp = (
  order: BuyerChargeOrderInput,
  b: BuyerChargeBreakdown,
  opts: { totalMatchesSharedFn?: boolean } = {},
) => {
  expect(sumOfLines(b)).toBe(b.totalCents);
  expectNoNegativeLine(b);
  if (opts.totalMatchesSharedFn ?? true) {
    expect(b.totalCents).toBe(
      computeExpectedPaymentAmount({
        ...order,
        feesPlatformCents: order.feesPlatformCents ?? 0,
        taxAmountCents: order.taxAmountCents ?? 0,
      }),
    );
  }
};

/** Every line is ≥ 0 except the credit, which is ≤ 0. */
const expectNoNegativeLine = (b: BuyerChargeBreakdown) => {
  expect(b.subtotalCents).toBeGreaterThanOrEqual(0);
  expect(b.platformFeeCents).toBeGreaterThanOrEqual(0);
  expect(b.processingFeeCents).toBeGreaterThanOrEqual(0);
  expect(b.taxCents).toBeGreaterThanOrEqual(0);
  expect(b.creditCents).toBeLessThanOrEqual(0);
  expect(b.totalCents).toBeGreaterThanOrEqual(0);
};

const ticket = (meta: Record<string, unknown>, amountCents = 1000) => ({
  kind: "ticket",
  amountCents,
  meta,
});

/** $10 ticket, 33¢ platform fee, 89¢ tax, 64¢ grossed-up processor fee. */
const passThroughOrder = (): BuyerChargeOrderInput => ({
  amountGrossCents: 1000,
  feesPlatformCents: 33,
  taxAmountCents: 89,
  feePolicySnapshot: { feeMode: "PASS_THROUGH" },
  items: [
    ticket({
      buyerTotalCents: 1000 + 33 + 64,
      platformFeePerTicketCents: 33,
      processorFeeShareCents: 64,
      effectiveFeeMode: "PASS_THROUGH",
    }),
  ],
});

/**
 * The bug report's order: $10 ABSORB ticket, 33¢ fee recorded (the
 * organiser's cost), 89¢ tax. The buyer was charged $10.89.
 */
const absorbOrder = (): BuyerChargeOrderInput => ({
  amountGrossCents: 1000,
  feesPlatformCents: 33,
  taxAmountCents: 89,
  feePolicySnapshot: { feeMode: "ABSORB" },
  items: [
    ticket({
      buyerTotalCents: 1000,
      platformFeePerTicketCents: 33,
      processorFeeShareCents: 62,
      effectiveFeeMode: "ABSORB",
    }),
  ],
});

describe("computeBuyerChargeBreakdown", () => {
  it("PASS_THROUGH: itemises the platform and processing fees the buyer paid", () => {
    const order = passThroughOrder();
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 1000,
      platformFeeCents: 33,
      processingFeeCents: 64,
      taxCents: 89,
      creditCents: 0,
      totalCents: 1186,
    });
    expectLinesAddUp(order, b);
  });

  it("ABSORB: no platform or processing fee, and the lines add to $10.89", () => {
    const order = absorbOrder();
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "ABSORB",
      subtotalCents: 1000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 89,
      creditCents: 0,
      totalCents: 1089,
    });
    expectLinesAddUp(order, b);
  });

  it("free order: every line is zero", () => {
    const order: BuyerChargeOrderInput = {
      amountGrossCents: 0,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [ticket({ buyerTotalCents: 0 }, 0), ticket({ buyerTotalCents: 0 }, 0)],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 0,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 0,
      creditCents: 0,
      totalCents: 0,
    });
    expectLinesAddUp(order, b);
  });

  it("multi-ticket ABSORB: no buyer fee however many tickets carry a recorded fee", () => {
    const order: BuyerChargeOrderInput = {
      amountGrossCents: 36000,
      feesPlatformCents: 150,
      taxAmountCents: 3197,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items: [
        ticket({ buyerTotalCents: 12000, platformFeePerTicketCents: 50 }, 12000),
        ticket({ buyerTotalCents: 12000, platformFeePerTicketCents: 50 }, 12000),
        ticket({ buyerTotalCents: 12000, platformFeePerTicketCents: 50 }, 12000),
      ],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b.platformFeeCents).toBe(0);
    expect(b.processingFeeCents).toBe(0);
    expect(b.subtotalCents).toBe(36000);
    expect(b.totalCents).toBe(39197);
    expectLinesAddUp(order, b);
  });

  describe("legacy orders with no feeMode in the snapshot", () => {
    it("decides ABSORB from the charge when the buyer paid no fees", () => {
      const order = { ...absorbOrder(), feePolicySnapshot: {} };
      const b = computeBuyerChargeBreakdown(order);

      expect(b.buyerFeeMode).toBe("ABSORB");
      expect(b.platformFeeCents).toBe(0);
      expect(b.processingFeeCents).toBe(0);
      expectLinesAddUp(order, b);
    });

    it("decides PASS_THROUGH from the charge when the buyer paid fees", () => {
      const order = { ...passThroughOrder(), feePolicySnapshot: null };
      const b = computeBuyerChargeBreakdown(order);

      expect(b.buyerFeeMode).toBe("PASS_THROUGH");
      expect(b.platformFeeCents).toBe(33);
      expect(b.processingFeeCents).toBe(64);
      expectLinesAddUp(order, b);
    });

    it("pre-meta order (no buyerTotalCents): gross + platform fee", () => {
      const order: BuyerChargeOrderInput = {
        amountGrossCents: 1000,
        feesPlatformCents: 50,
        taxAmountCents: 0,
        feePolicySnapshot: undefined,
        items: [ticket({})],
      };
      const b = computeBuyerChargeBreakdown(order);

      expect(b).toMatchObject({
        buyerFeeMode: "PASS_THROUGH",
        subtotalCents: 1000,
        platformFeeCents: 50,
        processingFeeCents: 0,
        totalCents: 1050,
      });
      expectLinesAddUp(order, b);
    });
  });

  it("a platform credit is its own negative line; the rest is unchanged", () => {
    const base = passThroughOrder();
    const order: BuyerChargeOrderInput = {
      ...base,
      items: [
        ...base.items,
        { kind: "platform_credit", amountCents: -500, meta: { creditId: "c" } },
      ],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 1000,
      platformFeeCents: 33,
      processingFeeCents: 64,
      taxCents: 89,
      creditCents: -500,
      totalCents: 686,
    });
    expectLinesAddUp(order, b);
  });

  it("PASS_THROUGH fee waiver: the waived ticket carries no fee, the other still does", () => {
    // What checkout-helpers writes for a 2-ticket order with ONE waived
    // ticket: the waived item's platformFeePerTicketCents is zeroed and its
    // buyerTotalCents drops by the fee, and Order.feesPlatformCents is
    // reduced by the waived fee (33 + 33 − 33 = 33).
    const order: BuyerChargeOrderInput = {
      amountGrossCents: 2000,
      feesPlatformCents: 33,
      taxAmountCents: 0,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [
        ticket({
          buyerTotalCents: 1000 + 31,
          platformFeePerTicketCents: 0,
          platformFeeWaivedCents: 33,
          processorFeeShareCents: 31,
          effectiveFeeMode: "PASS_THROUGH",
        }),
        ticket({
          buyerTotalCents: 1000 + 33 + 32,
          platformFeePerTicketCents: 33,
          processorFeeShareCents: 32,
          effectiveFeeMode: "PASS_THROUGH",
        }),
      ],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 2000,
      platformFeeCents: 33,
      processingFeeCents: 63,
      taxCents: 0,
      creditCents: 0,
      totalCents: 2096,
    });
    expectLinesAddUp(order, b);
  });

  it("promo discount: pre-discount buyer totals, post-discount gross", () => {
    // Two $10 tickets, a $5 promo. Checkout writes the discount as its own
    // negative line, the ticket items keep their PRE-discount buyer totals,
    // and amountGrossCents is the POST-discount gross. The platform fee
    // stays on full face (33 × 2); the processor gross-up is on the real
    // charge (60 split 30/30).
    const order: BuyerChargeOrderInput = {
      amountGrossCents: 1500,
      feesPlatformCents: 66,
      taxAmountCents: 134,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [
        ticket({ buyerTotalCents: 1063, effectiveFeeMode: "PASS_THROUGH" }),
        ticket({ buyerTotalCents: 1063, effectiveFeeMode: "PASS_THROUGH" }),
        { kind: "discount", amountCents: -500, meta: { code: "FIVE" } },
      ],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 1500,
      platformFeeCents: 66,
      processingFeeCents: 60,
      taxCents: 134,
      creditCents: 0,
      totalCents: 1760,
    });
    expectLinesAddUp(order, b);
  });

  it("POS / cash order: `{}` snapshot, no item meta, no fee", () => {
    const order: BuyerChargeOrderInput = {
      amountGrossCents: 2500,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      feePolicySnapshot: {},
      items: [ticket({}, 2500)],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "ABSORB",
      subtotalCents: 2500,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 0,
      creditCents: 0,
      totalCents: 2500,
    });
    expectLinesAddUp(order, b);
  });

  it("resale: no platform fee; the processing pass-through shows as processing", () => {
    // create-resale-checkout: feesPlatformCents 0, snapshot PASS_THROUGH,
    // buyerTotalCents = ask + processing pass-through. The item's own
    // effectiveFeeMode comes from the resale terms and may disagree; the
    // snapshot wins.
    const order: BuyerChargeOrderInput = {
      amountGrossCents: 4000,
      feesPlatformCents: 0,
      taxAmountCents: 300,
      feePolicySnapshot: { feeMode: "PASS_THROUGH", source: "resale_listing_snapshot" },
      items: [
        ticket(
          {
            buyerTotalCents: 4000 + 150,
            platformFeePerTicketCents: 0,
            processorFeeShareCents: 150,
            effectiveFeeMode: "ABSORB",
          },
          4000,
        ),
      ],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 4000,
      platformFeeCents: 0,
      processingFeeCents: 150,
      taxCents: 300,
      creditCents: 0,
      totalCents: 4450,
    });
    expectLinesAddUp(order, b);
  });

  it("ABSORB + platform credit: face + tax − credit, no fee line", () => {
    const base = absorbOrder();
    const order: BuyerChargeOrderInput = {
      ...base,
      items: [
        ...base.items,
        { kind: "platform_credit", amountCents: -400, meta: { creditId: "c" } },
      ],
    };
    const b = computeBuyerChargeBreakdown(order);

    expect(b).toEqual({
      buyerFeeMode: "ABSORB",
      subtotalCents: 1000,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 89,
      creditCents: -400,
      totalCents: 689,
    });
    expectLinesAddUp(order, b);
  });

  describe("meta-less ABSORB (no per-item buyerTotalCents)", () => {
    it("Stripe-paid: Total is what Stripe captured (finalize's figure), fee shown", () => {
      // finalize only accepts a PaymentIntent whose amount EQUALS
      // computeExpectedPaymentAmount(order) = gross + fee + tax here, so that
      // is what the card was charged, whatever the snapshot says.
      const order: BuyerChargeOrderInput = {
        stripePaymentIntentId: "pi_123",
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [ticket({})],
      };
      const b = computeBuyerChargeBreakdown(order);

      expect(b).toEqual({
        buyerFeeMode: "ABSORB",
        subtotalCents: 1000,
        platformFeeCents: 33,
        processingFeeCents: 0,
        taxCents: 89,
        creditCents: 0,
        totalCents: 1122,
      });
      expectLinesAddUp(order, b);
    });

    it("not Stripe-paid, snapshot ABSORB: Total is face + tax ($10.89), not gross + fee + tax", () => {
      const order: BuyerChargeOrderInput = {
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [ticket({})],
      };
      const b = computeBuyerChargeBreakdown(order);

      expect(b).toEqual({
        buyerFeeMode: "ABSORB",
        subtotalCents: 1000,
        platformFeeCents: 0,
        processingFeeCents: 0,
        taxCents: 89,
        creditCents: 0,
        totalCents: 1089,
      });
      // Deliberately NOT computeExpectedPaymentAmount (which says 1122):
      // that shared function feeds finalize and refunds and is left alone.
      expectLinesAddUp(order, b, { totalMatchesSharedFn: false });
    });

    it("no snapshot mode: the items' effectiveFeeMode decides", () => {
      const order: BuyerChargeOrderInput = {
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: {},
        items: [ticket({ effectiveFeeMode: "ABSORB" })],
      };
      const b = computeBuyerChargeBreakdown(order);

      expect(b.buyerFeeMode).toBe("ABSORB");
      expect(b.platformFeeCents).toBe(0);
      expect(b.totalCents).toBe(1089);
      expectLinesAddUp(order, b, { totalMatchesSharedFn: false });
    });

    it("meta-less ABSORB with a credit: face + tax − credit", () => {
      const order: BuyerChargeOrderInput = {
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [
          ticket({}),
          { kind: "platform_credit", amountCents: -300, meta: {} },
        ],
      };
      const b = computeBuyerChargeBreakdown(order);

      expect(b).toMatchObject({
        subtotalCents: 1000,
        platformFeeCents: 0,
        creditCents: -300,
        totalCents: 789,
      });
      expectLinesAddUp(order, b, { totalMatchesSharedFn: false });
    });
  });

  it("randomised: lines always add up and no line is ever negative", () => {
    // Small deterministic PRNG so a failure reproduces.
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const modes = [
      { feeMode: "ABSORB" },
      { feeMode: "PASS_THROUGH" },
      {},
      null,
    ];
    for (let run = 0; run < 2000; run++) {
      const tickets = 1 + rand(4);
      const face = rand(20000);
      const fee = rand(200);
      const withMeta = rand(3) > 0;
      const snapshot = modes[rand(modes.length)];
      const passThrough =
        (snapshot as { feeMode?: string } | null)?.feeMode !== "ABSORB" &&
        rand(2) === 0;
      const items: BuyerChargeOrderInput["items"] = [];
      for (let i = 0; i < tickets; i++) {
        const proc = passThrough ? rand(100) : 0;
        items.push(
          ticket(
            withMeta
              ? { buyerTotalCents: face + (passThrough ? fee + proc : 0) }
              : {},
            face,
          ),
        );
      }
      const gross = face * tickets;
      const discount = rand(3) === 0 ? rand(gross + 1) : 0;
      if (discount > 0) {
        items.push({ kind: "discount", amountCents: -discount, meta: {} });
      }
      const credit = rand(3) === 0 ? rand(gross + 2000) : 0;
      if (credit > 0) {
        items.push({ kind: "platform_credit", amountCents: -credit, meta: {} });
      }
      const stripePaid = rand(2) === 0;
      const order: BuyerChargeOrderInput = {
        stripePaymentIntentId: stripePaid ? "pi_x" : null,
        amountGrossCents: gross - discount,
        feesPlatformCents: fee * tickets,
        taxAmountCents: rand(2000),
        feePolicySnapshot: snapshot,
        items,
      };
      const b = computeBuyerChargeBreakdown(order);
      expect(sumOfLines(b)).toBe(b.totalCents);
      expectNoNegativeLine(b);
      // A Stripe-paid order's total IS what finalize accepted.
      if (stripePaid) {
        expect(b.totalCents).toBe(
          computeExpectedPaymentAmount({
            ...order,
            feesPlatformCents: order.feesPlatformCents ?? 0,
            taxAmountCents: order.taxAmountCents ?? 0,
          }),
        );
      }
      // ABSORB shows no buyer fee, except where a Stripe charge with no
      // per-item buyer totals proves the buyer paid one.
      if (b.buyerFeeMode === "ABSORB" && (withMeta || !stripePaid)) {
        expect(b.platformFeeCents + b.processingFeeCents).toBe(0);
      }
    }
  });
});
