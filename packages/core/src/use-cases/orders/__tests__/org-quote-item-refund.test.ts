import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type { Repos } from "@th/ports/repos";

import { orgQuoteItemRefund } from "../org-quote-item-refund";
import { quoteItemRefund } from "../quote-item-refund";

// Org actor is NOT the buyer — the whole point of the org path.
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "99999999-9999-4999-8999-999999999999";
const ORG_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const OTHER_ORG_ID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeItem(id: string, ticketTypeId: string) {
  return {
    id,
    orderId: ORDER_ID,
    kind: "ticket" as const,
    ticketTypeId,
    qty: 1,
    unitPriceCents: 3000,
    amountCents: 3000,
    meta: { buyerTotalCents: 3300 },
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    status: "active" as const,
  };
}

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  const now = new Date("2025-01-01T00:00:00.000Z");
  return {
    id: ORDER_ID,
    eventId: "event-1",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 9000,
    feesPlatformCents: 900,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: now,
    parentOrderId: null,
    taxAmountCents: 0,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    paymentMethodType: null,
    items: [
      makeItem(ITEM_A, "tt-ga"),
      makeItem(ITEM_B, "tt-ga"),
      makeItem(ITEM_C, "tt-vip"),
    ],
    ...partial,
  } as OrderRecord;
}

function makeContext(opts?: {
  order?: OrderRecord | null;
  feeCents?: number;
  allowed?: boolean;
  eventOrgId?: string | null;
}) {
  const order = opts?.order !== undefined ? opts.order : makeOrder();
  const feeCents = opts?.feeCents ?? 300;
  const allowed = opts?.allowed ?? true;
  const eventOrgId =
    opts?.eventOrgId !== undefined ? opts.eventOrgId : ORG_ID;

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) => ({ id })) as HumansRepo["getById"],
  } as HumansRepo;

  const ordersRepo: OrdersRepo = {
    listTaxLines: vi.fn(async () => []),
    getById: vi.fn(async (id: string) =>
      id === ORDER_ID ? order : null,
    ) as unknown as OrdersRepo["getById"],
  } as OrdersRepo;

  const eventsRepo = {
    getById: vi.fn(async () => ({
      id: "event-1",
      orgId: eventOrgId,
      humanId: null,
    })),
  };

  const payeesRepo = {
    getBySubject: vi.fn(async () => ({ id: "payee-1" })),
    getById: vi.fn(async () => ({
      id: "payee-1",
      stripeAccountId: "acct_123",
    })),
  };

  const repos: Repos = {
    humans: humansRepo,
    orders: ordersRepo,
    events: eventsRepo,
    payees: payeesRepo,
    // quoteItemRefund classifies each requested item against its ticket
    // (scanned / listed); no ticket here = classified on item state alone.
    tickets: { getByOrderItemId: vi.fn(async () => null) },
  } as unknown as Repos;

  const payments: PaymentProcessorPort = {
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({
      feeCents,
      currency: "usd",
      paymentIntentId: "pi_123",
    })),
  } as unknown as PaymentProcessorPort;

  const authz: AuthZPort = {
    canFinanceOrg: vi.fn(async () => ({ allowed })),
  } as unknown as AuthZPort;

  return { repos, payments, authz };
}

describe("orgQuoteItemRefund", () => {
  it("lets an org-finance actor quote a refund even though they are not the buyer", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await orgQuoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
      {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
      },
    );

    expect(ctx.authz.canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(out.orderId).toBe(ORDER_ID);
    expect(out.totalRefundableCents).toBe(3200);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.orderItemId).toBe(ITEM_A);
  });

  it("matches the buyer quote math exactly for a subset of items", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const orgOut = await orgQuoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
      {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_C],
      },
    );

    // Reproduce the buyer path directly against the same order (bypassing the
    // buyer check via the internal flag) to prove the org path is identical.
    const buyerCtx = makeContext({ feeCents: 300 });
    const buyerOut = await quoteItemRefund(
      {
        repos: buyerCtx.repos,
        payments: buyerCtx.payments,
        _skipBuyerCheck: true,
      },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_C],
      },
    );

    expect(orgOut).toEqual(buyerOut);
    expect(orgOut.totalRefundableCents).toBe(6400);
  });

  it("rejects a non-finance org member (EDITOR/VIEWER)", async () => {
    const ctx = makeContext({ allowed: false });

    await expect(
      orgQuoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
        {
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // No fee lookup should happen after the authz rejection.
    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects when the order's event belongs to a different org", async () => {
    const ctx = makeContext({ eventOrgId: OTHER_ORG_ID });

    await expect(
      orgQuoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
        {
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_IN_ORG" });
  });

  it("rejects an actor authorized for a DIFFERENT org (authz scoped to orgId)", async () => {
    const ctx = makeContext();
    // Only allow finance on OTHER_ORG_ID; the request targets ORG_ID.
    (ctx.authz.canFinanceOrg as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ orgId }: { orgId: string }) => ({
        allowed: orgId === OTHER_ORG_ID,
      }),
    );

    await expect(
      orgQuoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
        {
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects when the order does not exist", async () => {
    const ctx = makeContext({ order: null });

    await expect(
      orgQuoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
        {
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("rejects a repeated order item id at the org boundary", async () => {
    const ctx = makeContext();

    await expect(
      orgQuoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, authz: ctx.authz },
        {
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
