import { describe, expect, it } from "vitest";

import { getMyOrder, getMyOrderOutputSchema } from "../get-my-order";

/**
 * The order page's price lines come from `getMyOrder().charges`. They must
 * add to Total paid on every order, and an ABSORB buyer, who paid face + tax,
 * must see no platform or processing fee even though the order still records
 * `feesPlatformCents` (the organiser's cost).
 */

const now = new Date("2026-09-30T12:00:00Z");
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_TYPE_ID = "55555555-5555-4555-8555-555555555555";

type ItemSpec = {
  amountCents: number;
  meta: Record<string, unknown>;
  status?: string;
  refundedAt?: Date | null;
  /** Refund stamps the repo returns on a refunded item. */
  refundedTaxCents?: number | null;
  refundedPlatformFeeCents?: number | null;
};

const makeOrder = (spec: {
  stripePaymentIntentId?: string | null;
  status: string;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  feePolicySnapshot: unknown;
  items: ItemSpec[];
}) => ({
  id: ORDER_ID,
  eventId: EVENT_ID,
  kind: "TICKETING",
  buyerHumanId: HUMAN_ID,
  currency: "usd",
  stripePaymentIntentId: "pi_test",
  source: "PRIMARY",
  nonRefundable: false,
  occurredAt: now,
  paidOutAt: null,
  parentOrderId: null,
  ...spec,
  items: spec.items.map((item, i) => ({
    id: `44444444-4444-4444-8444-44444444444${i}`,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: TICKET_TYPE_ID,
    resaleListingId: null,
    qty: 1,
    unitPriceCents: item.amountCents,
    amountCents: item.amountCents,
    meta: item.meta,
    paidOutAt: null,
    refundedAt: item.refundedAt ?? null,
    refundedTaxCents: item.refundedTaxCents ?? null,
    refundedPlatformFeeCents: item.refundedPlatformFeeCents ?? null,
    transferredAt: null,
    status: item.status ?? "active",
  })),
});

const run = async (order: ReturnType<typeof makeOrder>) => {
  const deps = {
    repos: {
      orders: { getById: async () => order },
      events: {
        getById: async () => ({
          id: EVENT_ID,
          title: "Event",
          startsAt: new Date("2026-10-04T21:00:00Z"),
          addressText: "123 Main",
          locality: "City",
        }),
        listTicketTypes: async () => [{ id: TICKET_TYPE_ID, name: "GA" }],
      },
      organizations: { getById: async () => null },
      places: { getById: async () => null },
      tickets: { viewerHoldsActiveTicketForEvent: async () => true },
    },
    clock: { now: () => now },
  } as never;
  const result = await getMyOrder(deps, {
    actorHumanId: HUMAN_ID,
    orderId: ORDER_ID,
  });
  // The transport validates against this schema; so does the test.
  return getMyOrderOutputSchema.parse(result);
};

const linesSum = (c: {
  subtotalCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  taxCents: number;
  creditCents: number;
}) =>
  c.subtotalCents +
  c.platformFeeCents +
  c.processingFeeCents +
  c.taxCents +
  c.creditCents;

describe("getMyOrder — buyer charge lines", () => {
  it("PASS_THROUGH: subtotal + platform + processing + tax = Total paid", async () => {
    const result = await run(
      makeOrder({
        status: "SUCCEEDED",
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "PASS_THROUGH" },
        items: [
          {
            amountCents: 1000,
            meta: { buyerTotalCents: 1097, processorFeeShareCents: 64 },
          },
        ],
      }),
    );

    expect(result.charges).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 1000,
      platformFeeCents: 33,
      processingFeeCents: 64,
      taxCents: 89,
      creditCents: 0,
      totalCents: 1186,
    });
    expect(linesSum(result.charges)).toBe(result.buyerTotalCents);
  });

  it("ABSORB: no buyer fee lines; $10.00 + $0.89 = $10.89, not $11.22", async () => {
    const result = await run(
      makeOrder({
        status: "SUCCEEDED",
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [
          {
            amountCents: 1000,
            meta: {
              buyerTotalCents: 1000,
              processorFeeShareCents: 62,
              effectiveFeeMode: "ABSORB",
            },
          },
        ],
      }),
    );

    expect(result.charges.platformFeeCents).toBe(0);
    expect(result.charges.processingFeeCents).toBe(0);
    expect(result.charges.subtotalCents).toBe(1000);
    expect(result.charges.taxCents).toBe(89);
    expect(result.buyerTotalCents).toBe(1089);
    expect(linesSum(result.charges)).toBe(result.buyerTotalCents);
    // The organiser's recorded fee is still on the order, untouched.
    expect(result.feesPlatformCents).toBe(33);
  });

  it("free order: all zero", async () => {
    const result = await run(
      makeOrder({
        status: "SUCCEEDED",
        amountGrossCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        feePolicySnapshot: { feeMode: "PASS_THROUGH" },
        items: [{ amountCents: 0, meta: { buyerTotalCents: 0 } }],
      }),
    );

    expect(result.charges).toEqual({
      buyerFeeMode: "PASS_THROUGH",
      subtotalCents: 0,
      platformFeeCents: 0,
      processingFeeCents: 0,
      taxCents: 0,
      creditCents: 0,
      totalCents: 0,
    });
    expect(result.buyerTotalCents).toBe(0);
  });

  /**
   * A refund does not rewrite what was paid: the price lines are the
   * original charge, and the refund (with its own platform-fee and tax
   * stamps) is reported separately. These pin that a fully refunded order
   * shows the SAME lines as before the refund, and that the refund stamps
   * never leak into them (an ABSORB order's stamped platform fee is the
   * organiser's, returned by the platform, and still must not surface).
   */
  const sameOrderRefunded = (
    spec: Parameters<typeof makeOrder>[0],
  ): Parameters<typeof makeOrder>[0] => ({
    ...spec,
    status: "REFUNDED",
    items: spec.items.map((item) => ({
      ...item,
      status: "refunded",
      refundedAt: now,
      refundedTaxCents: 89,
      refundedPlatformFeeCents: 33,
    })),
  });

  it("refunded ABSORB order: same lines as before the refund, no buyer fee", async () => {
    const paid = {
      status: "SUCCEEDED",
      amountGrossCents: 1000,
      feesPlatformCents: 33,
      taxAmountCents: 89,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items: [{ amountCents: 1000, meta: { buyerTotalCents: 1000 } }],
    };
    const before = await run(makeOrder(paid));
    const after = await run(makeOrder(sameOrderRefunded(paid)));

    expect(after.status).toBe("REFUNDED");
    expect(after.charges).toEqual(before.charges);
    expect(after.charges.platformFeeCents).toBe(0);
    expect(after.charges.processingFeeCents).toBe(0);
    expect(after.buyerTotalCents).toBe(1089);
    expect(linesSum(after.charges)).toBe(after.buyerTotalCents);
  });

  it("refunded PASS_THROUGH order: same lines as before the refund", async () => {
    const paid = {
      status: "SUCCEEDED",
      amountGrossCents: 2000,
      feesPlatformCents: 66,
      taxAmountCents: 178,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [
        { amountCents: 1000, meta: { buyerTotalCents: 1097 } },
        { amountCents: 1000, meta: { buyerTotalCents: 1098 } },
      ],
    };
    const before = await run(makeOrder(paid));
    const after = await run(makeOrder(sameOrderRefunded(paid)));

    expect(after.charges).toEqual(before.charges);
    expect(after.charges.platformFeeCents).toBe(66);
    expect(after.charges.processingFeeCents).toBe(129);
    expect(linesSum(after.charges)).toBe(after.buyerTotalCents);
  });

  it("meta-less ABSORB order not paid through Stripe: Total paid is face + tax", async () => {
    const result = await run(
      makeOrder({
        stripePaymentIntentId: null,
        status: "SUCCEEDED",
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [{ amountCents: 1000, meta: {} }],
      }),
    );

    expect(result.buyerTotalCents).toBe(1089);
    expect(result.charges.platformFeeCents).toBe(0);
    expect(linesSum(result.charges)).toBe(result.buyerTotalCents);
  });

  it("meta-less ABSORB order paid through Stripe: Total paid is what Stripe captured", async () => {
    const result = await run(
      makeOrder({
        status: "SUCCEEDED",
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        taxAmountCents: 89,
        feePolicySnapshot: { feeMode: "ABSORB" },
        items: [{ amountCents: 1000, meta: {} }],
      }),
    );

    expect(result.buyerTotalCents).toBe(1122);
    expect(result.charges.platformFeeCents).toBe(33);
    expect(linesSum(result.charges)).toBe(result.buyerTotalCents);
  });
});
