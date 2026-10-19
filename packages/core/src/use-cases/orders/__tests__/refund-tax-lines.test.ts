import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { getRefundEligibility } from "../get-refund-eligibility";
import { orgQuoteItemRefund } from "../org-quote-item-refund";
import { quoteFullRefund } from "../quote-full-refund";
import { quoteItemRefund } from "../quote-item-refund";
import { refundFullOrder } from "../refund-full-order";
import { refundOrderItems } from "../refund-order-items";

// ---------------------------------------------------------------------------
// Every refund path splits an order's tax PER PLATFORM TAX LINE, each by its
// own base (`allocateRefundTaxSharesByLine`). The worked example is a
// Minneapolis order: SALES 349 on BUYER_TOTAL + MPLS_ENTERTAINMENT 105 on
// TICKET_FACE = 454.
//
//   SALES 349 by buyer-paid (2665 : 1200) → 240.64 / 108.36 → a 241, b 108
//   MPLS  105 by face       (2500 : 1000) →  75    /  30    → a  75, b  30
//   per item                               → a 316, b 138
//
// The old single buyer-paid weight gave 454 × 2665/3865 → a 313, b 141.
// Stripe fee 100 by buyer-paid → a 69, b 31.
// ---------------------------------------------------------------------------

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2025-06-01T12:00:00.000Z");
const FEE_CENTS = 100;

/** `bTransferred`: B was gifted away, so only A is refundable on any path. */
function makeItems(bTransferred = false): OrderItemRecord[] {
  const item = (id: string, face: number, buyerTotal: number) =>
    ({
      id,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: "tt-ga",
      qty: 1,
      unitPriceCents: face,
      amountCents: face,
      meta: { buyerTotalCents: buyerTotal },
      paidOutAt: null,
      refundedAt: null,
      refundedTaxCents: null,
      transferredAt: null,
      status: "active",
    }) as OrderItemRecord;
  const b = item(ITEM_B, 1000, 1200);
  if (bTransferred) {
    Object.assign(b, { status: "transferred", transferredAt: NOW });
  }
  return [item(ITEM_A, 2500, 2665), b];
}

function makeOrder(bTransferred = false): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    kind: "TICKETING",
    buyerHumanId: ACTOR_ID,
    amountGrossCents: 3500,
    feesPlatformCents: 365,
    taxAmountCents: 454,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    parentOrderId: null,
    items: makeItems(bTransferred),
  } as OrderRecord;
}

function taxLine(
  code: string,
  base: "BUYER_TOTAL" | "TICKET_FACE",
  amountCents: number,
): OrderTaxLineRecord {
  return {
    id: `line-${code}`,
    orderId: ORDER_ID,
    code,
    label: code,
    jurisdiction: "US-MN",
    rateBps: 0,
    base,
    collector: "PLATFORM",
    taxableAmountCents: 0,
    amountCents,
    createdAt: NOW,
  } as OrderTaxLineRecord;
}

const MPLS_LINES = [
  taxLine("SALES", "BUYER_TOTAL", 349),
  taxLine("MPLS_ENTERTAINMENT", "TICKET_FACE", 105),
];
/** Lines that sum to 460, not the order's 454. */
const MISMATCHED_LINES = [
  taxLine("SALES", "BUYER_TOTAL", 355),
  taxLine("MPLS_ENTERTAINMENT", "TICKET_FACE", 105),
];

function makeContext(opts: {
  taxLines: OrderTaxLineRecord[];
  reportError?: ReturnType<typeof vi.fn>;
  bTransferred?: boolean;
}) {
  const order = makeOrder(opts.bTransferred);
  const payeeLedger = createFakePayeeLedgerRepo();
  const listTaxLines = vi.fn(async (orderId: string) =>
    orderId === ORDER_ID ? opts.taxLines : [],
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
      feeCents: FEE_CENTS,
      currency: "usd",
      paymentIntentId: "pi_123",
    })),
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_test_123",
      status: "succeeded",
    })),
  } as unknown as PaymentProcessorPort;

  const clock = { now: vi.fn(() => NOW) } as unknown as ClockPort;

  const deps = {
    repos,
    payments,
    idempotency: createFakeIdempotencyPort(),
    clock,
    reportError: opts.reportError,
  };

  return { deps, txRepos, payments, listTaxLines };
}

/** Every `refundedTaxCents` the tx stamped, keyed by order-item id. */
function stampedTax(ctx: ReturnType<typeof makeContext>): Map<string, number> {
  const calls = ctx.txRepos.orderItems.updateStatus.mock
    .calls as unknown as Array<[string, string, Date, number | undefined]>;
  return new Map(calls.map(([itemId, , , tax]) => [itemId, tax ?? Number.NaN]));
}

const refundAmountSentToStripe = (ctx: ReturnType<typeof makeContext>) =>
  (
    ctx.payments.refundPaymentIntent as unknown as {
      mock: { calls: Array<[{ amountCents: number }]> };
    }
  ).mock.calls[0]![0].amountCents;

/**
 * Only the tax-line mismatch reports. The fake ledger has no credits, so the
 * refund-debit writer reports its own (unrelated) swallow through the same
 * reporter.
 */
const MISMATCH_MESSAGE = "refund tax lines do not sum to order tax";
const mismatchReports = (reportError: ReturnType<typeof vi.fn>) =>
  reportError.mock.calls.filter(
    ([err]) => (err as Error).message === MISMATCH_MESSAGE,
  );

const quoteInput = (orderItemIds: string[]) => ({
  actorHumanId: ACTOR_ID,
  orderId: ORDER_ID,
  orderItemIds,
});

describe("item refunds split tax per PLATFORM line", () => {
  it("quotes a=316, b=138 on a two-line order (the single weight gave 313/141)", async () => {
    const ctx = makeContext({ taxLines: MPLS_LINES });

    const quote = await quoteItemRefund(ctx.deps, quoteInput([ITEM_A, ITEM_B]));

    const byId = new Map(quote.items.map((q) => [q.orderItemId, q]));
    expect(byId.get(ITEM_A)!.taxShareCents).toBe(316);
    expect(byId.get(ITEM_B)!.taxShareCents).toBe(138);
    expect(byId.get(ITEM_A)!.stripeFeeShareCents).toBe(69);
    expect(byId.get(ITEM_A)!.refundableCents).toBe(2665 + 316 - 69);
    expect(byId.get(ITEM_B)!.refundableCents).toBe(1200 + 138 - 31);
    expect(ctx.listTaxLines).toHaveBeenCalledWith(ORDER_ID);
  });

  it("refundOrderItems [A] refunds and stamps the per-line share", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ taxLines: MPLS_LINES, reportError });

    const out = await refundOrderItems(ctx.deps, quoteInput([ITEM_A]));

    expect(stampedTax(ctx).get(ITEM_A)).toBe(316);
    expect(out.totalRefundedCents).toBe(2665 + 316 - 69);
    expect(refundAmountSentToStripe(ctx)).toBe(2665 + 316 - 69);
    expect(mismatchReports(reportError)).toHaveLength(0);
  });

  it("a line mismatch is reported and the old single-weight split is refunded", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ taxLines: MISMATCHED_LINES, reportError });

    const out = await refundOrderItems(ctx.deps, quoteInput([ITEM_A]));

    expect(stampedTax(ctx).get(ITEM_A)).toBe(313);
    expect(out.totalRefundedCents).toBe(2665 + 313 - 69);
    expect(refundAmountSentToStripe(ctx)).toBe(2665 + 313 - 69);

    const reports = mismatchReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "quoteItemRefund", reason: "tax_lines_mismatch" },
      extra: {
        orderId: ORDER_ID,
        orderTaxCents: 454,
        platformLinesTotalCents: 460,
      },
    });
  });

  it("a throwing reporter changes nothing", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const ctx = makeContext({ taxLines: MISMATCHED_LINES, reportError });

    const out = await refundOrderItems(ctx.deps, quoteInput([ITEM_A]));

    expect(mismatchReports(reportError)).toHaveLength(1);
    expect(stampedTax(ctx).get(ITEM_A)).toBe(313);
    expect(out.totalRefundedCents).toBe(2665 + 313 - 69);
  });

  it("an order with no tax lines keeps the single-weight split and reports nothing", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ taxLines: [], reportError });

    const quote = await quoteItemRefund(
      ctx.deps,
      quoteInput([ITEM_A, ITEM_B]),
    );

    const byId = new Map(quote.items.map((q) => [q.orderItemId, q]));
    expect(byId.get(ITEM_A)!.taxShareCents).toBe(313);
    expect(byId.get(ITEM_B)!.taxShareCents).toBe(141);
    expect(mismatchReports(reportError)).toHaveLength(0);
  });
});

describe("full-order refund stamps tax per PLATFORM line", () => {
  it("stamps a=316, b=138; the refunded money does not depend on the split", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ taxLines: MPLS_LINES, reportError });

    await refundFullOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const stamped = stampedTax(ctx);
    expect(stamped.get(ITEM_A)).toBe(316);
    expect(stamped.get(ITEM_B)).toBe(138);
    expect(stamped.get(ITEM_A)! + stamped.get(ITEM_B)!).toBe(454);
    // Full refund = everything paid (3865 + 454) less Stripe's fee.
    expect(refundAmountSentToStripe(ctx)).toBe(3865 + 454 - FEE_CENTS);
    expect(ctx.listTaxLines).toHaveBeenCalledWith(ORDER_ID);
    expect(mismatchReports(reportError)).toHaveLength(0);
  });

  it("a line mismatch is reported and the old split is stamped", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ taxLines: MISMATCHED_LINES, reportError });

    await refundFullOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });

    const stamped = stampedTax(ctx);
    expect(stamped.get(ITEM_A)).toBe(313);
    expect(stamped.get(ITEM_B)).toBe(141);
    expect(refundAmountSentToStripe(ctx)).toBe(3865 + 454 - FEE_CENTS);
    const reports = mismatchReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "refundFullOrder", reason: "tax_lines_mismatch" },
      extra: { orderId: ORDER_ID },
    });
  });
});

describe("refund eligibility shows the per-line tax", () => {
  it("with B transferred, taxCents is A's per-line share (316, the single weight gives 313)", async () => {
    const ok = makeContext({ taxLines: MPLS_LINES, bTransferred: true });
    const okOut = await getRefundEligibility(ok.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    expect(okOut.isEligible).toBe(true);
    expect(okOut.feeBreakdown?.taxCents).toBe(316);

    const legacy = makeContext({ taxLines: [], bTransferred: true });
    const legacyOut = await getRefundEligibility(legacy.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    expect(legacyOut.feeBreakdown?.taxCents).toBe(313);
  });

  it("a mismatch is reported", async () => {
    const reportError = vi.fn();
    const bad = makeContext({ taxLines: MISMATCHED_LINES, reportError });
    await getRefundEligibility(bad.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    const reports = mismatchReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "getRefundEligibility" },
    });
  });
});

// ---------------------------------------------------------------------------
// ONE money rule on a per-line order. B is transferred, so A alone is
// refundable on every path:
//
//   paid A = base 2665 + per-line tax 316 = 2981; fee share 69 → 2912
//
// The buyer-paid split of the tax-inclusive 4319 would give 2978 → 2909, a
// 3c disagreement with the item path. Each stamp is the tax term of the money
// moved: 2912 + 69 − 2665 = 316.
// ---------------------------------------------------------------------------
describe("every path moves the same cents for A on a per-line order", () => {
  const A_NET = 2665 + 316 - 69; // 2912

  it("eligibility === quoteItemRefund === refundOrderItems === quoteFullRefund === refundFullOrder", async () => {
    const elig = await getRefundEligibility(
      makeContext({ taxLines: MPLS_LINES, bTransferred: true }).deps,
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );
    expect(elig.feeBreakdown?.refundableCents).toBe(A_NET);
    expect(elig.feeBreakdown?.amountPaidCents).toBe(2665 + 316);

    const quote = await quoteItemRefund(
      makeContext({ taxLines: MPLS_LINES, bTransferred: true }).deps,
      quoteInput([ITEM_A]),
    );
    expect(quote.totalRefundableCents).toBe(A_NET);

    const itemCtx = makeContext({ taxLines: MPLS_LINES, bTransferred: true });
    await refundOrderItems(itemCtx.deps, quoteInput([ITEM_A]));
    expect(refundAmountSentToStripe(itemCtx)).toBe(A_NET);
    expect(stampedTax(itemCtx).get(ITEM_A)).toBe(316);

    const fullQuote = await quoteFullRefund(
      makeContext({ taxLines: MPLS_LINES, bTransferred: true }).deps,
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );
    expect(fullQuote.refundableCents).toBe(A_NET);

    const fullCtx = makeContext({ taxLines: MPLS_LINES, bTransferred: true });
    await refundFullOrder(fullCtx.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    expect(refundAmountSentToStripe(fullCtx)).toBe(A_NET);
    const stamped = stampedTax(fullCtx);
    expect(stamped.get(ITEM_A)).toBe(316);
    expect(stamped.has(ITEM_B)).toBe(false);
    // The stamp is the tax term of the money: net + fee share − base.
    expect(A_NET + 69 - 2665).toBe(stamped.get(ITEM_A));
  });

  it("an order with no lines keeps the buyer-paid split on the full-order paths (2909, unchanged)", async () => {
    const elig = await getRefundEligibility(
      makeContext({ taxLines: [], bTransferred: true }).deps,
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );
    expect(elig.feeBreakdown?.refundableCents).toBe(2978 - 69);

    const fullCtx = makeContext({ taxLines: [], bTransferred: true });
    await refundFullOrder(fullCtx.deps, {
      actorHumanId: ACTOR_ID,
      orderId: ORDER_ID,
    });
    expect(refundAmountSentToStripe(fullCtx)).toBe(2978 - 69);
    expect(stampedTax(fullCtx).get(ITEM_A)).toBe(313);
  });
});

describe("a lone PLATFORM line that disagrees with the order tax", () => {
  it("is reported, and the old single-weight split is refunded", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      taxLines: [taxLine("SALES", "BUYER_TOTAL", 450)],
      reportError,
    });

    const out = await refundOrderItems(ctx.deps, quoteInput([ITEM_A]));

    expect(stampedTax(ctx).get(ITEM_A)).toBe(313);
    expect(out.totalRefundedCents).toBe(2665 + 313 - 69);
    const reports = mismatchReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      extra: { orderTaxCents: 454, platformLinesTotalCents: 450 },
    });
  });
});

describe("orgQuoteItemRefund forwards reportError to the quote", () => {
  it("reports a line mismatch through the org path", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ taxLines: MISMATCHED_LINES, reportError });

    const quote = await orgQuoteItemRefund(
      {
        repos: ctx.deps.repos,
        payments: ctx.deps.payments,
        authz: {
          canFinanceOrg: vi.fn(async () => ({ allowed: true })),
        } as never,
        reportError,
      },
      { ...quoteInput([ITEM_A]), orgId: ORG_ID },
    );

    expect(quote.items[0]!.taxShareCents).toBe(313);
    const reports = mismatchReports(reportError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "quoteItemRefund" },
    });
  });
});
