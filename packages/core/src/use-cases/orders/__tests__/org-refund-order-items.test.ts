import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type {
  OrderItemsRepo,
  OrderItemRecord,
} from "@th/ports/repos/order-items";
import type { TicketsRepo, TicketRecord } from "@th/ports/repos/tickets";
import type { Repos } from "@th/ports/repos";
import type { AuditRepo } from "@th/ports/repos/audit";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { orgRefundOrderItems } from "../org-refund-order-items";

// Org actor is NOT the buyer.
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "99999999-9999-4999-8999-999999999999";
const ORG_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const OTHER_ORG_ID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TICKET_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TICKET_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const TICKET_3 = "33333333-cccc-4ccc-8ccc-333333333333";

const NOW = new Date("2025-06-01T12:00:00.000Z");
const NOTE = "customer emailed support, event moved";

function makeItems(): OrderItemRecord[] {
  return [ITEM_A, ITEM_B, ITEM_C].map((id, i) => ({
    id,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: i === 2 ? "tt-vip" : "tt-ga",
    qty: 1,
    unitPriceCents: 3000,
    amountCents: 3000,
    meta: { buyerTotalCents: 3300 },
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    status: "active",
  })) as OrderItemRecord[];
}

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
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
    occurredAt: new Date("2025-01-01T00:00:00.000Z"),
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
    items: makeItems(),
    ...partial,
  } as OrderRecord;
}

function makeTickets(): Array<
  Pick<TicketRecord, "id" | "status" | "scannedAt">
> {
  return [
    { id: TICKET_1, status: "VALID", scannedAt: null },
    { id: TICKET_2, status: "VALID", scannedAt: null },
    { id: TICKET_3, status: "VALID", scannedAt: null },
  ];
}

function makeFullTickets(): TicketRecord[] {
  const base = {
    eventId: "event-1",
    ownerHumanId: BUYER_ID,
    orderId: ORDER_ID,
    orderItemId: null,
    seatId: null,
    code: "TK-001",
    issuedAt: new Date("2025-01-01"),
    scannedAt: null,
  };
  return [
    { ...base, id: TICKET_1, ticketTypeId: "tt-ga", orderItemId: ITEM_A, status: "VALID", code: "TK-001" },
    { ...base, id: TICKET_2, ticketTypeId: "tt-ga", orderItemId: ITEM_B, status: "VALID", code: "TK-002" },
    { ...base, id: TICKET_3, ticketTypeId: "tt-vip", orderItemId: ITEM_C, status: "VALID", code: "TK-003" },
  ];
}

function makeContext(opts?: {
  order?: OrderRecord | null;
  orderForTx?: OrderRecord | null;
  feeCents?: number;
  itemsForTx?: OrderItemRecord[];
  tickets?: Array<Pick<TicketRecord, "id" | "status" | "scannedAt">>;
  fullTickets?: TicketRecord[];
  allowed?: boolean;
  eventOrgId?: string | null;
  authAccounts?: Array<{ providerId: string; accountId: string; createdAt: Date }>;
}) {
  const order = opts?.order !== undefined ? opts.order : makeOrder();
  const orderForTx = opts?.orderForTx ?? order;
  const feeCents = opts?.feeCents ?? 300;
  const itemsForTx = opts?.itemsForTx ?? makeItems();
  const tickets = opts?.tickets ?? makeTickets();
  const fullTickets = opts?.fullTickets ?? makeFullTickets();
  const allowed = opts?.allowed ?? true;
  const eventOrgId =
    opts?.eventOrgId !== undefined ? opts.eventOrgId : ORG_ID;

  const authAccounts = opts?.authAccounts ?? [
    { providerId: "credential", accountId: BUYER_ID, createdAt: new Date("2025-01-01") },
  ];

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) => ({ id })) as HumansRepo["getById"],
    // A loginable buyer has a VERIFIED email (B2: isLoginableBuyer).
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      human: { id },
      identity: { emailVerified: true },
    })) as unknown as HumansRepo["getByIdWithIdentity"],
    listAuthAccounts: vi.fn(async () => authAccounts) as HumansRepo["listAuthAccounts"],
  } as HumansRepo;

  const ordersRepo: OrdersRepo = {
    listTaxLines: vi.fn(async () => []),
    getById: vi.fn(async (id: string) =>
      id === ORDER_ID ? order : null,
    ) as OrdersRepo["getById"],
    markRefunded: vi.fn(async () => {}),
  } as unknown as OrdersRepo;

  const orderItemsRepo: OrderItemsRepo = {
    updateStatus: vi.fn(async () => {}),
    listByOrderId: vi.fn(async () => itemsForTx),
  } as unknown as OrderItemsRepo;

  const ticketsRepo: TicketsRepo = {
    listByOrderId: vi.fn(async () => tickets),
    getByOrderItemId: vi.fn(
      async (orderItemId: string) =>
        fullTickets.find((t) => t.orderItemId === orderItemId) ?? null,
    ) as unknown as TicketsRepo["getByOrderItemId"],
    setStatus: vi.fn(async () => {}),
  } as unknown as TicketsRepo;

  const auditRepo: AuditRepo = { log: vi.fn(async () => {}) };

  const idempotency = createFakeIdempotencyPort();

  // In-memory payee ledger for the refund rule's REFUND_DEBIT writes (the
  // delegated refundOrderItems core writes them inside the tx).
  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    payeeLedger: payeeLedger.repo,
    orders: {
      listTaxLines: vi.fn(async () => []),
      getById: vi.fn(async (id: string) => (id === ORDER_ID ? orderForTx : null)),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => itemsForTx),
    },
    tickets: {
      getByOrderItemId: vi.fn(
        async (orderItemId: string) =>
          fullTickets.find((t) => t.orderItemId === orderItemId) ?? null,
      ),
      setStatus: vi.fn(async () => {}),
    },
    audit: { log: vi.fn(async () => {}) },
  };

  const eventsRepo = {
    getById: vi.fn(async () => ({ id: "event-1", orgId: eventOrgId, humanId: null })),
  };

  const repos: Repos = {
    humans: humansRepo,
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    audit: auditRepo,
    events: eventsRepo,
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-1" })),
      getById: vi.fn(async () => ({ id: "payee-1", stripeAccountId: "acct_123" })),
    },
    tx: vi.fn(async (fn: any) => fn(txRepos)),
  } as unknown as Repos;

  const payments: PaymentProcessorPort = {
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

  const clock: ClockPort = { now: vi.fn(() => NOW) } as unknown as ClockPort;

  const authz: AuthZPort = {
    canFinanceOrg: vi.fn(async () => ({ allowed })),
  } as unknown as AuthZPort;

  const notify = vi.fn(async () => ({}) as never);

  return {
    repos,
    payments,
    idempotency,
    clock,
    authz,
    txRepos,
    notify,
    payeeLedger,
  };
}

function makeDeps(
  ctx: ReturnType<typeof makeContext>,
  opts?: { withNotify?: boolean },
) {
  return {
    repos: ctx.repos,
    payments: ctx.payments,
    idempotency: ctx.idempotency,
    clock: ctx.clock,
    authz: ctx.authz,
    ...(opts?.withNotify ? { notify: ctx.notify } : {}),
  };
}

describe("orgRefundOrderItems", () => {
  it("lets an org-finance actor refund items and writes an org_refund_note audit row", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await orgRefundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
      note: NOTE,
    });

    expect(ctx.authz.canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("PART_REFUNDED");
    expect(out.items).toHaveLength(1);

    // Shared core wrote its items_refunded row...
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "items_refunded" }),
    );
    // ...and the org wrapper appended its own note row with actor + org + note.
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: ORDER_ID,
        action: "org_refund_note",
        data: expect.objectContaining({
          orgId: ORG_ID,
          actorHumanId: ACTOR_ID,
          note: NOTE,
          refundId: "re_test_123",
        }),
      }),
    );
  });

  it("uses a DISTINCT org idempotency key (never the buyer keyspace)", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await orgRefundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
      note: NOTE,
    });

    const orgKey = `order:org-refund-items:${ORG_ID}:${ORDER_ID}:items:${ITEM_A}`;
    const buyerKey = `order:refund-items:${ORDER_ID}:${ACTOR_ID}:items:${ITEM_A}`;

    expect(ctx.idempotency.__store.has(orgKey)).toBe(true);
    expect(ctx.idempotency.__store.has(buyerKey)).toBe(false);
    // Stripe refund used the org-prefixed key too.
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `${orgKey}:refund-payment-intent`,
      }),
    );
  });

  it("refund math for a subset matches the buyer path exactly", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await orgRefundOrderItems(makeDeps(ctx), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A, ITEM_C],
      note: NOTE,
    });

    // Same numbers the buyer refund-order-items test asserts: fee share 100
    // per item → 3200 each → 6400 total.
    expect(out.totalRefundedCents).toBe(6400);
    expect(out.items).toHaveLength(2);
    expect(out.items.every((i) => i.refundedCents === 3200)).toBe(true);
  });

  it("forwards notify to the shared core (single buyer notification, keyed on refundId)", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await orgRefundOrderItems(makeDeps(ctx, { withNotify: true }), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
      orderItemIds: [ITEM_A],
      note: NOTE,
    });

    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: BUYER_ID,
        variant: "order.refund-processed",
        idempotencyKey: `order-refund:${out.refundId}`,
      }),
    );
  });

  it("rejects a non-finance org member before any side-effect", async () => {
    const ctx = makeContext({ allowed: false });

    await expect(
      orgRefundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
        note: NOTE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("rejects an actor authorized for a DIFFERENT org", async () => {
    const ctx = makeContext();
    (ctx.authz.canFinanceOrg as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ orgId }: { orgId: string }) => ({
        allowed: orgId === OTHER_ORG_ID,
      }),
    );

    await expect(
      orgRefundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
        note: NOTE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects when the order's event belongs to a different org", async () => {
    const ctx = makeContext({ eventOrgId: OTHER_ORG_ID });

    await expect(
      orgRefundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
        note: NOTE,
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_IN_ORG" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("prevents a double refund of an already-refunded item", async () => {
    const order = makeOrder();
    order.items[0]!.status = "refunded";
    order.items[0]!.refundedAt = new Date();
    const ctx = makeContext({ order });

    await expect(
      orgRefundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
        note: NOTE,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "items_not_refundable",
    });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("requires a note of at least 3 characters", async () => {
    const ctx = makeContext();

    await expect(
      orgRefundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A],
        note: "no",
      }),
    ).rejects.toBeDefined();

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects a repeated order item id at the org boundary", async () => {
    const ctx = makeContext({ feeCents: 300 });

    await expect(
      orgRefundOrderItems(makeDeps(ctx), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_A],
        note: NOTE,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });
});
