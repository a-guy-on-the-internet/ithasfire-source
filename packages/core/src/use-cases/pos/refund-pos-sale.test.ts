import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { refundPosSale } from "./refund-pos-sale";

// ---------------------------------------------------------------------------
// refundPosSale is a thin gate (ORG_EDIT_ROLES, POS card only, 15-minute
// window) over `refundFullOrder`. Its first direct test, written when a door
// card sale started charging platform fee, processing fee and tax like an
// online one (spec 2026-10-07 FR-002 / FR-008): the gate refund must return
// the tax through refundFullOrder's per-line tax path, exactly as online.
//
// The order is the TN parity cart from `__tests__/door-card-parity.test.ts`:
// 2 × $25 + 1 × $40, platform fee 600, SALES 970 on a 9947 buyer-total base,
// processor fee 347, charged 10917.
// ---------------------------------------------------------------------------

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const PHANTOM_ID = "11111111-1111-4111-8111-111111111112";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-07T21:00:00.000Z");
/** Stripe's actual processing fee on the charge (what refunds keep back). */
const STRIPE_FEE_CENTS = 347;
const CHARGED_CENTS = 10_917;
const TAX_CENTS = 970;

function makeItems(): OrderItemRecord[] {
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
  return [item(ITEM_A, 2500, 2771), item(ITEM_B, 2500, 2771), item(ITEM_C, 4000, 4405)];
}

function makeOrder(overrides: Partial<Record<string, unknown>> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-1",
    kind: "TICKETING",
    buyerHumanId: PHANTOM_ID,
    amountGrossCents: 9000,
    feesPlatformCents: 600,
    taxAmountCents: TAX_CENTS,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_door_card",
    source: "PRIMARY",
    nonRefundable: false,
    paymentChannel: "POS",
    // Sold five minutes ago: inside the 15-minute gate window.
    occurredAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    parentOrderId: null,
    items: makeItems(),
    ...overrides,
  } as OrderRecord;
}

const SALES_LINE = {
  id: "line-SALES",
  orderId: ORDER_ID,
  code: "SALES",
  label: "Sales tax",
  jurisdiction: "US-TN",
  rateBps: 975,
  base: "BUYER_TOTAL",
  collector: "PLATFORM",
  taxableAmountCents: 9947,
  amountCents: TAX_CENTS,
  createdAt: NOW,
} as OrderTaxLineRecord;

function makeContext(opts: {
  order?: OrderRecord;
  role?: "OWNER" | "ADMIN" | "EDITOR" | "SCANNER" | null;
} = {}) {
  const order = opts.order ?? makeOrder();
  const payeeLedger = createFakePayeeLedgerRepo();
  const listTaxLines = vi.fn(async () => [SALES_LINE]);
  const role = opts.role === undefined ? "EDITOR" : opts.role;

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
      getById: vi.fn(async (id: string) => (id === OPERATOR_ID ? { id } : null)),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        role ? { orgId: ORG_ID, humanId: OPERATOR_ID, role } : null,
      ),
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
        startsAt: new Date("2026-10-07T20:00:00.000Z"),
        refundCutoffAt: null,
      })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-1" })),
      getById: vi.fn(async () => ({ id: "payee-1", stripeAccountId: "acct_123" })),
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
      paymentIntentId: "pi_door_card",
    })),
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_door_1",
      status: "succeeded",
    })),
  } as unknown as PaymentProcessorPort;

  const clock = { now: vi.fn(() => NOW) } as unknown as ClockPort;

  return {
    deps: {
      repos,
      payments,
      idempotency: createFakeIdempotencyPort(),
      clock,
      reportError: vi.fn(),
    },
    txRepos,
    payments,
    listTaxLines,
  };
}

const refundedToStripe = (ctx: ReturnType<typeof makeContext>) =>
  (
    ctx.payments.refundPaymentIntent as unknown as {
      mock: { calls: Array<[{ amountCents: number; paymentIntentId: string }]> };
    }
  ).mock.calls[0]![0];

describe("refundPosSale", () => {
  it("refunds a door card sale as online: everything charged (fees and tax included) less Stripe's fee", async () => {
    const ctx = makeContext();

    const out = await refundPosSale(ctx.deps, {
      actorHumanId: OPERATOR_ID,
      orderId: ORDER_ID,
    });

    // 10917 charged = 9947 buyer totals (face + platform fee + processor
    // share) + 970 tax. The same "everything paid less Stripe's fee" an
    // online full refund returns (refund-tax-lines.test.ts).
    expect(refundedToStripe(ctx)).toMatchObject({
      paymentIntentId: "pi_door_card",
      amountCents: CHARGED_CENTS - STRIPE_FEE_CENTS,
    });
    expect(out.refundedCents).toBe(CHARGED_CENTS - STRIPE_FEE_CENTS);

    // The tax share is returned through refundFullOrder's per-line path:
    // read from the order's tax lines and stamped per item, summing to the
    // order's tax.
    expect(ctx.listTaxLines).toHaveBeenCalledWith(ORDER_ID);
    const calls = ctx.txRepos.orderItems.updateStatus.mock
      .calls as unknown as Array<[string, string, Date, number | undefined]>;
    const stamped = new Map(calls.map(([id, , , tax]) => [id, tax ?? 0]));
    expect(stamped.get(ITEM_A)! + stamped.get(ITEM_B)! + stamped.get(ITEM_C)!).toBe(
      TAX_CENTS,
    );
    expect(ctx.txRepos.orders.markRefunded).toHaveBeenCalled();
  });

  it("refuses a CASH sale (cash refunds go through refundCashSale)", async () => {
    const ctx = makeContext({ order: makeOrder({ paymentChannel: "CASH" }) });
    await expect(
      refundPosSale(ctx.deps, { actorHumanId: OPERATOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "NOT_A_POS_CARD_ORDER" });
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses after the 15-minute gate window", async () => {
    const ctx = makeContext({
      order: makeOrder({ occurredAt: new Date(NOW.getTime() - 16 * 60 * 1000) }),
    });
    await expect(
      refundPosSale(ctx.deps, { actorHumanId: OPERATOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ message: "gate_refund_window_expired" });
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses a SCANNER-role operator (refunds need ORG_EDIT_ROLES)", async () => {
    const ctx = makeContext({ role: "SCANNER" });
    await expect(
      refundPosSale(ctx.deps, { actorHumanId: OPERATOR_ID, orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });
});
