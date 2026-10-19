import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ClockPort } from "@th/ports/clock";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { quoteItemRefund } from "../quote-item-refund";
import { refundFullOrder } from "../refund-full-order";
import { refundOrderItems } from "../refund-order-items";

// ---------------------------------------------------------------------------
// `OrderItem.refundedTaxCents` — what portion of an already-issued refund was
// tax.
//
// The load-bearing property is NOT "the shares look proportional". It is that
// the number we RECORD reconciles against the number we SENT TO STRIPE:
//
//     Σ buyerPaid + Σ refundedTaxCents − Σ stripeFeeShare === refund amount
//
// Every test below ties the stamp back to `refundPaymentIntent`'s
// `amountCents` rather than to a re-derived expectation, because a stamp that
// merely agrees with a second copy of the same arithmetic is exactly the
// silent divergence this column exists to prevent.
// ---------------------------------------------------------------------------

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2025-06-01T12:00:00.000Z");

function makeItems(
  buyerTotals: [number, number, number],
  overrides: Array<Partial<OrderItemRecord>> = [],
): OrderItemRecord[] {
  return [ITEM_A, ITEM_B, ITEM_C].map(
    (id, index) =>
      ({
        id,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-ga",
        qty: 1,
        unitPriceCents: buyerTotals[index]!,
        amountCents: buyerTotals[index]!,
        meta: { buyerTotalCents: buyerTotals[index]! },
        paidOutAt: null,
        refundedAt: null,
        refundedTaxCents: null,
        transferredAt: null,
        status: "active",
        ...overrides[index],
      }) as OrderItemRecord,
  );
}

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    kind: "TICKETING",
    buyerHumanId: ACTOR_ID,
    amountGrossCents: 9900,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    parentOrderId: null,
    items: makeItems([3300, 3300, 3300]),
    ...partial,
  } as OrderRecord;
}

function makeContext(opts: { order: OrderRecord; feeCents: number }) {
  const { order, feeCents } = opts;
  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    orders: {
      listTaxLines: vi.fn(async () => []),
      getById: vi.fn(async () => order),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => order.items),
      setResaleListingId: vi.fn(async () => {}),
    },
    tickets: {
      listByOrderId: vi.fn(async () => []),
      getByOrderItemId: vi.fn(async () => null),
      setStatus: vi.fn(async () => {}),
    },
    payeeLedger: payeeLedger.repo,
    splits: { getForOrder: vi.fn(async () => []) },
    promos: { releaseHoldsForOrder: vi.fn(async () => undefined) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    audit: { log: vi.fn(async () => {}) },
  };

  const repos = {
    humans: { getById: vi.fn(async (id: string) => (id === ACTOR_ID ? { id } : null)) },
    orders: {
      listTaxLines: vi.fn(async () => []),
      getById: vi.fn(async (id: string) => (id === ORDER_ID ? order : null)),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      getById: vi.fn(async (id: string) => order.items.find((i) => i.id === id) ?? null),
    },
    tickets: {
      listByOrderId: vi.fn(async () => []),
      getByOrderItemId: vi.fn(async () => null),
      setStatus: vi.fn(async () => {}),
    },
    payeeLedger: payeeLedger.repo,
    splits: { getForOrder: vi.fn(async () => []) },
    audit: { log: vi.fn(async () => {}) },
    events: {
      getById: vi.fn(async () => ({ id: "event-1", orgId: "org-1", humanId: null })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-1" })),
      getById: vi.fn(async () => ({ id: "payee-1", stripeAccountId: "acct_123" })),
    },
    payoutItems: { listTransferredByPlannedOrderItemIds: vi.fn(async () => []) },
    tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(txRepos)),
  } as unknown as Repos;

  const payments = {
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({
      feeCents,
      currency: "usd",
      paymentIntentId: "pi_123",
    })),
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_test_123",
      status: "succeeded",
    })),
  } as unknown as PaymentProcessorPort;

  const clock = { now: vi.fn(() => NOW) } as unknown as ClockPort;

  return {
    repos,
    txRepos,
    payments,
    clock,
    idempotency: createFakeIdempotencyPort(),
  };
}

const makeDeps = (ctx: ReturnType<typeof makeContext>) => ({
  repos: ctx.repos,
  payments: ctx.payments,
  idempotency: ctx.idempotency,
  clock: ctx.clock,
});

/** Every `refundedTaxCents` the tx stamped, keyed by order-item id. */
function stampedTax(ctx: ReturnType<typeof makeContext>): Map<string, number> {
  const calls = ctx.txRepos.orderItems.updateStatus.mock.calls as unknown as Array<
    [string, string, Date, number | undefined]
  >;
  return new Map(calls.map(([itemId, , , tax]) => [itemId, tax ?? Number.NaN]));
}

const sum = (values: Iterable<number>) =>
  [...values].reduce((total, value) => total + value, 0);

const refundAmountSentToStripe = (ctx: ReturnType<typeof makeContext>) =>
  (
    ctx.payments.refundPaymentIntent as unknown as {
      mock: { calls: Array<[{ amountCents: number }]> };
    }
  ).mock.calls[0]![0].amountCents;

describe("item refunds record the tax they returned", () => {
  // Three $30 tickets carrying a $3 platform fee each (buyerTotal 3300),
  // subtotal 9900, order tax 800, actual Stripe fee 341.
  const TAXED_ORDER = () =>
    makeOrder({ taxAmountCents: 800, items: makeItems([3300, 3300, 3300]) });

  it("2-of-3 refund: each item carries its own tax share, and the total reconciles", async () => {
    const order = TAXED_ORDER();
    const ctx = makeContext({ order, feeCents: 341 });

    const out = await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B],
    });

    // Worked example. Tax and fee are allocated over ALL THREE ticket items
    // with largest-remainder rounding (weights = buyer-paid, ex-tax):
    //   tax 800 / 3 = 266.67 → 266 each, 2c left → A, B (tie broken by id)
    //   fee 341 / 3 = 113.67 → 113 each, 2c left → A, B
    //   A: 3300 + 267 − 114 = 3453
    //   B: 3300 + 267 − 114 = 3453
    const stamped = stampedTax(ctx);
    expect(stamped.get(ITEM_A)).toBe(267);
    expect(stamped.get(ITEM_B)).toBe(267);
    expect(stamped.has(ITEM_C)).toBe(false);

    expect(out.totalRefundedCents).toBe(6906);
    expect(refundAmountSentToStripe(ctx)).toBe(6906);

    // THE invariant: recorded tax + ticket money − withheld processor fee is
    // exactly what Stripe was asked to return. Stamping any other share (an
    // idealised 800 × 2/3 = 533, say) breaks this line.
    const buyerPaid = 3300 * 2;
    const feeWithheld = 114 * 2;
    expect(buyerPaid + sum(stamped.values()) - feeWithheld).toBe(
      refundAmountSentToStripe(ctx),
    );
  });

  it("stamps the quote's number, not a re-derived one", async () => {
    const order = TAXED_ORDER();
    const ctx = makeContext({ order, feeCents: 341 });

    const quote = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    expect(stampedTax(ctx).get(ITEM_A)).toBe(quote.items[0]!.taxShareCents);
  });

  it("stamps a MEASURED zero on an untaxed order, never null", async () => {
    const ctx = makeContext({ order: makeOrder(), feeCents: 300 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
    });

    // NULL is reserved for "not attributed" — a refund we cannot account for.
    // A no-tax order is attributed, and the amount is 0.
    expect(stampedTax(ctx).get(ITEM_A)).toBe(0);
  });

  it("refunding every item records EXACTLY the tax the order collected", async () => {
    const order = TAXED_ORDER();
    const ctx = makeContext({ order, feeCents: 341 });

    await refundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
    });

    // 800, to the cent. The shares are a largest-remainder allocation over
    // all ticket items, so they sum to the order tax — not 741, which is what
    // the old `buyerPaid / (subtotal + tax)` ratio under-returned.
    const stamped = stampedTax(ctx);
    expect([...stamped.values()].sort()).toEqual([266, 267, 267]);
    expect(sum(stamped.values())).toBe(order.taxAmountCents);
  });

  it("[A] then [B] then [C] returns the same money as one full-order refund, and Σ tax == 800", async () => {
    // Three separate calls (three days, say). Each call sees the statuses the
    // previous ones left behind, and the allocation is over ALL ticket items
    // every time — so an item's share is the same whether it is refunded
    // first, last, or together with its siblings.
    const steps: Array<{ target: string; alreadyRefunded: string[] }> = [
      { target: ITEM_A, alreadyRefunded: [] },
      { target: ITEM_B, alreadyRefunded: [ITEM_A] },
      { target: ITEM_C, alreadyRefunded: [ITEM_A, ITEM_B] },
    ];

    let totalRefundedOneAtATime = 0;
    let totalTaxStampedOneAtATime = 0;
    const perItemRefund = new Map<string, number>();

    for (const step of steps) {
      const refunded = (id: string) =>
        step.alreadyRefunded.includes(id)
          ? { status: "refunded" as const, refundedAt: NOW }
          : {};
      const order = makeOrder({
        taxAmountCents: 800,
        status: step.alreadyRefunded.length > 0 ? "PART_REFUNDED" : "SUCCEEDED",
        items: makeItems(
          [3300, 3300, 3300],
          [refunded(ITEM_A), refunded(ITEM_B), refunded(ITEM_C)],
        ),
      });
      const ctx = makeContext({ order, feeCents: 341 });

      const out = await refundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [step.target],
      });

      expect(out.items).toHaveLength(1);
      expect(out.totalRefundedCents).toBe(refundAmountSentToStripe(ctx));
      perItemRefund.set(step.target, out.totalRefundedCents);
      totalRefundedOneAtATime += out.totalRefundedCents;
      totalTaxStampedOneAtATime += stampedTax(ctx).get(step.target)!;
    }

    // Same fixture, one full-order refund.
    const fullCtx = makeContext({ order: TAXED_ORDER(), feeCents: 341 });
    const full = await refundFullOrder(makeDeps(fullCtx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // 10700 charged − 341 processor fee = 10359, on both paths.
    expect(full.refundedCents).toBe(10359);
    expect(totalRefundedOneAtATime).toBe(full.refundedCents);
    expect(totalTaxStampedOneAtATime).toBe(800);
    expect(sum(stampedTax(fullCtx).values())).toBe(800);

    // Per item too: the item path's `buyerPaid + taxShare − feeShare` lands
    // on the same cents as the full path's `share(total) − share(fee)`.
    for (const item of full.refundedItems) {
      expect(perItemRefund.get(item.orderItemId)).toBe(item.refundedCents);
    }
  });
});

describe("full-order refunds record the tax they returned", () => {
  it("returns ALL the tax and records ALL of it, to the cent", async () => {
    const order = makeOrder({
      amountGrossCents: 3000,
      taxAmountCents: 100,
      items: makeItems([1000, 1000, 1000]),
    });
    const ctx = makeContext({ order, feeCents: 87 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    // This path allocates the whole tax-inclusive charge, so the buyer gets
    // every cent of tax back: 3000 + 100 − 87.
    expect(out.refundedCents).toBe(3013);
    expect(out.newOrderStatus).toBe("REFUNDED");

    // 100 does not divide by 3. Largest-remainder allocation means the shares
    // still sum to exactly 100 — no cent is lost, none invented.
    const stamped = stampedTax(ctx);
    expect([...stamped.values()].sort()).toEqual([33, 33, 34]);
    expect(sum(stamped.values())).toBe(order.taxAmountCents);
  });

  it("attributes nothing to a skipped item — its tax was not refunded", async () => {
    const order = makeOrder({
      amountGrossCents: 3000,
      taxAmountCents: 100,
      items: makeItems([1000, 1000, 1000], [{}, {}, { status: "transferred" }]),
    });
    const ctx = makeContext({ order, feeCents: 87 });

    const out = await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const stamped = stampedTax(ctx);
    expect(stamped.has(ITEM_C)).toBe(false);
    expect(sum(stamped.values())).toBe(67);
    expect(sum(stamped.values())).toBeLessThan(order.taxAmountCents);
    expect(out.newOrderStatus).toBe("REFUNDED");
  });

  it("an item's share does not depend on which siblings were refundable", async () => {
    const allRefundable = makeContext({
      order: makeOrder({
        amountGrossCents: 3000,
        taxAmountCents: 100,
        items: makeItems([1000, 1000, 1000]),
      }),
      feeCents: 87,
    });
    const oneTransferred = makeContext({
      order: makeOrder({
        amountGrossCents: 3000,
        taxAmountCents: 100,
        items: makeItems([1000, 1000, 1000], [{}, {}, { status: "transferred" }]),
      }),
      feeCents: 87,
    });

    for (const ctx of [allRefundable, oneTransferred]) {
      await refundFullOrder(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
      });
    }

    // Allocation is over ALL ticket items, so dropping C from the refund does
    // not inflate A and B's recorded tax to cover it.
    expect(stampedTax(oneTransferred).get(ITEM_A)).toBe(
      stampedTax(allRefundable).get(ITEM_A),
    );
    expect(stampedTax(oneTransferred).get(ITEM_B)).toBe(
      stampedTax(allRefundable).get(ITEM_B),
    );
  });

  it("stamps 0 across an untaxed order", async () => {
    const ctx = makeContext({ order: makeOrder(), feeCents: 300 });

    await refundFullOrder(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    expect([...stampedTax(ctx).values()]).toEqual([0, 0, 0]);
  });
});
