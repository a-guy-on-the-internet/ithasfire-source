import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { PromoRecord } from "@th/ports/repos/promos";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { createCheckout } from "../create-checkout";
import { quoteItemRefund } from "../quote-item-refund";
import { refundOrderItems } from "../refund-order-items";
import { allocateRefundTaxSharesByLine } from "../../../lib/orders/refund-tax-share";
import { makeContext as makeCheckoutContext } from "./__fixtures__/create-checkout-harness";

// ─────────────────────────────────────────────────────────────────────────────
// Charge → refund at a Minneapolis venue (55403), with the SHIPPED
// entertainment-tax row. The order, its items and its OrderTaxLines are what
// the REAL createCheckout persisted (no hand-written tax numbers); the refund
// runs through the REAL quoteItemRefund / refundOrderItems over fakes.
//
// 2 × $25, 50¢ platform fee each, Stripe 2.9% + 30¢ grossed up, 903 bps MN
// sales tax on the buyer total:
//   SALES 479 on 5302 (BUYER_TOTAL) + MPLS_ENTERTAINMENT 150 on 5000 (face)
//   = taxAmountCents 629.
// Refunding ONE item splits each line by its own base (the step-1 per-line
// allocator): SALES 479 → 240 / 239, MPLS 150 → 75 / 75.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const NOW = new Date("2025-06-01T12:00:00.000Z");
const STRIPE_FEE_CENTS = 100;

const TT_B = "99999999-9999-4999-8999-999999999999";

/**
 * Charge at 55403 through createCheckout; return what it persisted.
 * Default: 2 × $25. With `secondFaceCents`: 1 × type A at `firstFaceCents`
 * (default $25) + 1 × type B at `secondFaceCents`. `typeBPromoCents` adds an
 * AMOUNT promo scoped to ticket type B only.
 */
async function chargeMinneapolisOrder(
  opts: {
    firstFaceCents?: number;
    secondFaceCents?: number;
    typeBPromoCents?: number;
  } = {},
): Promise<{
  order: OrderRecord;
  taxLines: OrderTaxLineRecord[];
  chargedCents: number;
}> {
  const ctx = makeCheckoutContext({
    feeMode: "PASS_THROUGH",
    buyerFeePct: 0,
    platformFixedCents: 50,
    ticketPriceCents: opts.firstFaceCents ?? 2500,
    admissionTaxRateBps: 903,
    taxSitus: { countryCode: "US", region: "MN", postalCode: "55403" },
    ...(opts.secondFaceCents
      ? { extraTicketTypes: [{ id: TT_B, priceCents: opts.secondFaceCents }] }
      : {}),
  });
  if (opts.typeBPromoCents) {
    const promo: PromoRecord = {
      id: "promo-b",
      code: "BOFF",
      codeNormalized: "BOFF",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "TICKET_TYPE",
      scopeId: TT_B,
      value: opts.typeBPromoCents,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });
  }
  await createCheckout(ctx.deps, {
    ...ctx.input,
    items: opts.secondFaceCents
      ? [
          { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 },
          { ticketTypeId: TT_B, qty: 1 },
        ]
      : [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
    ...(opts.typeBPromoCents ? { promoCodes: ["boff"] } : {}),
  });
  const pending = ctx.state.lastCreatePendingInput!;
  const persisted = ctx.state.lastCreateTaxLinesInput!;
  const piCalls = ctx.mocks.payments.createPaymentIntent.mock.calls;
  const chargedCents = (piCalls.at(-1) as [{ amountCents: number }])[0]
    .amountCents;

  const ticketInputs = pending.items.filter((item) => item.kind === "ticket");
  expect(ticketInputs).toHaveLength(2);
  // Discount lines (negative) stay on the order: the refund base reads them.
  const discountItems = pending.items
    .filter((item) => item.kind !== "ticket")
    .map(
      (item, index) =>
        ({
          id: `dddddddd-dddd-4ddd-8ddd-00000000000${index}`,
          orderId: ORDER_ID,
          kind: item.kind,
          ticketTypeId: item.ticketTypeId ?? null,
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          meta: item.meta ?? {},
          paidOutAt: null,
          refundedAt: null,
          refundedTaxCents: null,
          transferredAt: null,
          status: "active",
        }) as OrderItemRecord,
    );
  const ticketItems = ticketInputs.map(
    (item, index) =>
      ({
        id: ITEM_IDS[index]!,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
        meta: item.meta,
        paidOutAt: null,
        refundedAt: null,
        refundedTaxCents: null,
        transferredAt: null,
        status: "active",
      }) as OrderItemRecord,
  );
  const items = [...ticketItems, ...discountItems];

  const order = {
    id: ORDER_ID,
    eventId: "event-1",
    kind: "TICKETING",
    buyerHumanId: ACTOR_ID,
    amountGrossCents: pending.amountGrossCents,
    feesPlatformCents: pending.feesPlatformCents,
    taxAmountCents: pending.taxAmountCents,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    parentOrderId: null,
    items,
  } as OrderRecord;

  const taxLines = persisted.lines.map(
    (line) =>
      ({
        id: `line-${line.code}`,
        orderId: ORDER_ID,
        ...line,
        createdAt: NOW,
      }) as OrderTaxLineRecord,
  );

  return { order, taxLines, chargedCents };
}

/** Refund-side fakes (pattern: refund-tax-lines.test.ts). */
function makeRefundContext(
  order: OrderRecord,
  taxLines: OrderTaxLineRecord[],
  reportError = vi.fn(),
) {
  const payeeLedger = createFakePayeeLedgerRepo();
  const listTaxLines = vi.fn(async (orderId: string) =>
    orderId === ORDER_ID ? taxLines : [],
  );
  const txRepos = {
    orders: {
      listTaxLines,
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
    humans: {
      getById: vi.fn(async (id: string) => (id === ACTOR_ID ? { id } : null)),
    },
    orders: {
      listTaxLines,
      getById: vi.fn(async (id: string) => (id === ORDER_ID ? order : null)),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => order.items),
      getById: vi.fn(
        async (id: string) => order.items.find((i) => i.id === id) ?? null,
      ),
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
      getById: vi.fn(async () => ({
        id: "event-1",
        orgId: ORG_ID,
        humanId: null,
        startsAt: new Date("2099-01-01T00:00:00.000Z"),
        refundCutoffAt: null,
      })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-1" })),
      getById: vi.fn(async () => ({
        id: "payee-1",
        stripeAccountId: "acct_123",
      })),
    },
    settlementDisputes: { listByOrderId: vi.fn(async () => []) },
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
    },
    tx: vi.fn(async (fn: (t: unknown) => unknown) => fn(txRepos)),
  } as unknown as Repos;
  const payments = {
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({
      feeCents: STRIPE_FEE_CENTS,
      currency: "usd",
      paymentIntentId: "pi_123",
    })),
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_test_123",
      status: "succeeded",
    })),
  } as unknown as PaymentProcessorPort;
  const deps = {
    repos,
    payments,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) } as unknown as ClockPort,
    reportError,
  };
  return { deps, txRepos, payments };
}

const MISMATCH_MESSAGE = "refund tax lines do not sum to order tax";

describe("Minneapolis order (55403): charge → refund one item, tax split per line", () => {
  it("the charge persisted SALES 479 + MPLS 150 = 629 (the refund's input)", async () => {
    const { order, taxLines } = await chargeMinneapolisOrder();
    expect(order.taxAmountCents).toBe(629);
    expect(
      taxLines.map((line) => [line.code, line.base, line.amountCents]),
    ).toEqual([
      ["SALES", "BUYER_TOTAL", 479],
      ["MPLS_ENTERTAINMENT", "TICKET_FACE", 150],
    ]);
  });

  it("refunding ONE item refunds its per-line share: SALES half + ent. half, as the allocator splits it", async () => {
    const { order, taxLines } = await chargeMinneapolisOrder();
    const reportError = vi.fn();
    const ctx = makeRefundContext(order, taxLines, reportError);
    const [itemA, itemB] = ITEM_IDS as [string, string];

    // The step-1 allocator over the persisted lines.
    const split = allocateRefundTaxSharesByLine(
      order.items,
      order.taxAmountCents ?? 0,
      taxLines,
    );
    expect(split.perLine).toBe(true);
    expect(split.lineMismatch).toBe(false);
    const sales = split.byLine.get("SALES")!;
    const ent = split.byLine.get("MPLS_ENTERTAINMENT")!;
    // Each line is split on its own: SALES 479 → 240 / 239, ent. 150 → 75 / 75.
    expect([...sales.values()].sort()).toEqual([239, 240]);
    expect(ent.get(itemA)).toBe(75);
    expect(ent.get(itemB)).toBe(75);
    const expectedA = sales.get(itemA)! + ent.get(itemA)!;
    expect(split.shares.get(itemA)).toBe(expectedA);

    // Quote both: Σ item tax shares = the order's tax, nothing lost or invented.
    const quote = await quoteItemRefund(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [itemA, itemB],
    });
    const quoted = new Map(quote.items.map((q) => [q.orderItemId, q]));
    expect(quoted.get(itemA)!.taxShareCents).toBe(expectedA);
    expect(
      quoted.get(itemA)!.taxShareCents + quoted.get(itemB)!.taxShareCents,
    ).toBe(629);

    // Execute the refund of A alone.
    const out = await refundOrderItems(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
      orderItemIds: [itemA],
    });
    const stamps = ctx.txRepos.orderItems.updateStatus.mock
      .calls as unknown as Array<[string, string, Date, number | undefined]>;
    const stampedA = stamps.find(([id]) => id === itemA);
    expect(stampedA?.[3]).toBe(expectedA);
    expect(out.totalRefundedCents).toBe(quoted.get(itemA)!.refundableCents);
    const sentToStripe = (
      ctx.payments.refundPaymentIntent as unknown as {
        mock: { calls: Array<[{ amountCents: number }]> };
      }
    ).mock.calls[0]![0].amountCents;
    expect(sentToStripe).toBe(out.totalRefundedCents);
    // Lines sum to the order tax, so the per-line path ran — no mismatch report.
    expect(
      reportError.mock.calls.filter(
        ([err]) => (err as Error).message === MISMATCH_MESSAGE,
      ),
    ).toHaveLength(0);
  });
});

/** Quote [A, B], then refund [A] alone; return what was quoted, stamped and sent. */
async function refundItemA(order: OrderRecord, taxLines: OrderTaxLineRecord[]) {
  const reportError = vi.fn();
  const ctx = makeRefundContext(order, taxLines, reportError);
  const [itemA, itemB] = ITEM_IDS as [string, string];
  const quote = await quoteItemRefund(ctx.deps, {
    actorHumanId: ACTOR_ID,
    orderId: ORDER_ID,
    orderItemIds: [itemA, itemB],
  });
  const quoted = new Map(quote.items.map((q) => [q.orderItemId, q]));
  const out = await refundOrderItems(ctx.deps, {
    actorHumanId: ACTOR_ID,
    orderId: ORDER_ID,
    orderItemIds: [itemA],
  });
  const stamps = ctx.txRepos.orderItems.updateStatus.mock
    .calls as unknown as Array<[string, string, Date, number | undefined]>;
  const sentToStripe = (
    ctx.payments.refundPaymentIntent as unknown as {
      mock: { calls: Array<[{ amountCents: number }]> };
    }
  ).mock.calls[0]![0].amountCents;
  return {
    quotedTaxA: quoted.get(itemA)!.taxShareCents,
    quotedTaxB: quoted.get(itemB)!.taxShareCents,
    stampedTaxA: stamps.find(([id]) => id === itemA)?.[3],
    refundedCents: out.totalRefundedCents,
    sentToStripe,
    mismatchReports: reportError.mock.calls.filter(
      ([err]) => (err as Error).message === MISMATCH_MESSAGE,
    ).length,
  };
}

const buyerTotals = (order: OrderRecord) =>
  order.items
    .filter((item) => item.kind === "ticket")
    .map((item) => (item.meta as { buyerTotalCents?: number }).buyerTotalCents);

describe("Minneapolis order (55403): the per-line split differs from the single weight", () => {
  // The ent. tax is 3% of face, so moving its weight from buyer-paid to face
  // shifts about a cent per item at most; these fixtures are picked so it does.
  // Allocation is largest remainder (allocateProportionalCents): floor each
  // share, then hand the leftover cents to the largest fractional parts.
  // Checkout's processor-fee shares: floor((face + platform) / Σ × fee) per
  // ticket, the LAST ticket takes the remainder.

  it("$5 + $40, no promo: item A refunds tax 67 (single weight: 68); Stripe refund 627", async () => {
    // CHARGE (by hand):
    //   gross 4500, platform 2 × 50 = 100, ent. round(4500 × 3%) = 135
    //   SALES 432 → processor = ceil((4600 + 432 + 135 + 30) / 0.971)
    //     − 5167 = ceil(5352.21) − 5167 = 186
    //   SALES = round((4600 + 186) × 9.03%) = round(432.18) = 432 ✓
    //   tax 567; charge 4600 + 567 + 186 = 5353
    //   processor shares: A floor(550/4600 × 186) = floor(22.24) = 22,
    //     B 186 − 22 = 164 → buyer-paid A 572, B 4214
    const { order, taxLines, chargedCents } = await chargeMinneapolisOrder({
      firstFaceCents: 500,
      secondFaceCents: 4000,
    });
    expect(chargedCents).toBe(5353);
    expect(order.taxAmountCents).toBe(567);
    expect(
      taxLines.map((l) => [l.code, l.taxableAmountCents, l.amountCents]),
    ).toEqual([
      ["SALES", 4786, 432],
      ["MPLS_ENTERTAINMENT", 4500, 135],
    ]);
    expect(buyerTotals(order)).toEqual([572, 4214]);

    // REFUND A (by hand):
    //   SALES 432 by buyer-paid 572 : 4214 → 51.63 / 380.37 → A 52, B 380
    //   ent.  135 by face       500 : 4000 → 15    / 120    → A 15, B 120
    //   per-line tax: A 67, B 500 (Σ 567)
    //   [single weight: 567 × 572/4786 = 67.76 → A 68, B 499]
    //   base A: 4786 by buyer-paid → 572 (no discount)
    //   Stripe fee 100 by buyer-paid → 11.95 / 88.05 → A 12
    //   refund A = 572 + 67 − 12 = 627
    const r = await refundItemA(order, taxLines);
    expect(r.quotedTaxA).toBe(67);
    expect(r.quotedTaxB).toBe(500);
    expect(r.stampedTaxA).toBe(67);
    expect(r.refundedCents).toBe(627);
    expect(r.sentToStripe).toBe(627);
    expect(r.mismatchReports).toBe(0);
  });

  it("$25 + $40, $10 TICKET_TYPE promo on the $40: item A refunds tax 266 (single weight: 267); Stripe refund 2475", async () => {
    // CHARGE (by hand):
    //   gross 6500 − 1000 = 5500 post-discount; platform 100 (on the
    //   pre-discount lines); ent. round(5500 × 3%) = 165
    //   SALES 525 → processor = ceil((5600 + 525 + 165 + 30) / 0.971)
    //     − 6290 = ceil(6508.75) − 6290 = 219
    //   SALES = round((5600 + 219) × 9.03%) = round(525.46) = 525 ✓
    //   tax 690; charge 5600 + 690 + 219 = 6509
    //   processor shares: A floor(2550/6600 × 219) = floor(84.61) = 84,
    //     B 135 → buyer-paid A 2634, B 4185
    const { order, taxLines, chargedCents } = await chargeMinneapolisOrder({
      firstFaceCents: 2500,
      secondFaceCents: 4000,
      typeBPromoCents: 1000,
    });
    expect(chargedCents).toBe(6509);
    expect(order.taxAmountCents).toBe(690);
    expect(
      taxLines.map((l) => [l.code, l.taxableAmountCents, l.amountCents]),
    ).toEqual([
      ["SALES", 5819, 525],
      ["MPLS_ENTERTAINMENT", 5500, 165],
    ]);
    expect(buyerTotals(order)).toEqual([2634, 4185]);

    // REFUND A (by hand):
    //   SALES 525 by buyer-paid 2634 : 4185 → 202.79 / 322.21 → A 203, B 322
    //   ent.  165 by PRE-discount face 2500 : 4000 → 63.46 / 101.54
    //     → A 63, B 102. Checkout taxed A 75 and B 90 (the promo is on B
    //     only); the refund-tax-share.ts header documents this caveat. Σ is
    //     still exactly 165.
    //   per-line tax: A 266, B 424 (Σ 690)
    //   [single weight: 690 × 2634/6819 = 266.53 → A 267, B 423]
    //   base: paid ex-tax 6509 − 690 = 5819 by buyer-paid
    //     → 2247.73 / 3571.27 → A 2248
    //   Stripe fee 100 → 38.63 / 61.37 → A 39
    //   refund A = 2248 + 266 − 39 = 2475
    const r = await refundItemA(order, taxLines);
    expect(r.quotedTaxA).toBe(266);
    expect(r.quotedTaxB).toBe(424);
    expect(r.stampedTaxA).toBe(266);
    expect(r.refundedCents).toBe(2475);
    expect(r.sentToStripe).toBe(2475);
    expect(r.mismatchReports).toBe(0);
  });
});
