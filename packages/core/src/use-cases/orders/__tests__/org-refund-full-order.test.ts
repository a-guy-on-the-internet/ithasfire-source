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

import { orgRefundFullOrder } from "../org-refund-full-order";

// Org actor is NOT the buyer.
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "99999999-9999-4999-8999-999999999999";
const SELLER_ID = "77777777-7777-4777-8777-777777777777";
const ORG_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const OTHER_ORG_ID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ORIGINAL_ORDER_ID = "33333333-3333-4333-8333-333333333333";
const ORIGINAL_ORDER_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TICKET_2 = "22222222-bbbb-4bbb-8bbb-222222222222";
const RESALE_LISTING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const NOW = new Date("2025-06-01T12:00:00.000Z");
const PAST_START = new Date("2025-05-31T20:00:00.000Z");
const FUTURE_START = new Date("2025-12-01T00:00:00.000Z");
const NOTE = "buyer disputed the resale, unwinding to the seller";

const REFUND_FULL_KEY = `order:refund-full:${ORDER_ID}`;

function makeItems(): OrderItemRecord[] {
  return [ITEM_A, ITEM_B].map((id) => ({
    id,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: "tt-ga",
    qty: 1,
    unitPriceCents: 5000,
    amountCents: 5000,
    meta: { buyerTotalCents: 5500 },
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
    amountGrossCents: 10000,
    feesPlatformCents: 1000,
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

/** A one-item RESALE order whose ticket came from ORIGINAL_ORDER via a listing. */
function makeResaleOrder(): OrderRecord {
  const [first] = makeItems();
  return makeOrder({
    source: "RESALE",
    parentOrderId: ORIGINAL_ORDER_ID,
    items: [
      {
        ...first!,
        resaleListingId: RESALE_LISTING_ID,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: RESALE_LISTING_ID,
          resaleOriginalOrderId: ORIGINAL_ORDER_ID,
          resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
        },
      } as OrderItemRecord,
    ],
  });
}

function makeTickets(): Array<
  Pick<TicketRecord, "id" | "status" | "scannedAt">
> {
  return [
    { id: TICKET_1, status: "VALID", scannedAt: null },
    { id: TICKET_2, status: "VALID", scannedAt: null },
  ];
}

function makeContext(opts?: {
  order?: OrderRecord | null;
  feeCents?: number;
  tickets?: Array<Pick<TicketRecord, "id" | "status" | "scannedAt">>;
  ticketByItemId?: Record<string, TicketRecord | null>;
  allowed?: boolean;
  eventOrgId?: string | null;
  eventStartsAt?: Date;
}) {
  const order = opts?.order !== undefined ? opts.order : makeOrder();
  const feeCents = opts?.feeCents ?? 300;
  const tickets = opts?.tickets ?? makeTickets();
  const allowed = opts?.allowed ?? true;
  const eventOrgId =
    opts?.eventOrgId !== undefined ? opts.eventOrgId : ORG_ID;
  const eventStartsAt = opts?.eventStartsAt ?? FUTURE_START;
  const ticketByItemId: Record<string, TicketRecord | null> =
    opts?.ticketByItemId ?? {
      [ITEM_A]: {
        id: TICKET_1,
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_A,
        status: "VALID",
      } as TicketRecord,
      [ITEM_B]: {
        id: TICKET_2,
        ownerHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ITEM_B,
        status: "VALID",
      } as TicketRecord,
    };
  const getTicketByOrderItemId = async (orderItemId: string) =>
    ticketByItemId[orderItemId] ?? null;

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) => ({
      id,
    })) as unknown as HumansRepo["getById"],
    // A loginable buyer has a VERIFIED email (B2: isLoginableBuyer).
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      human: { id },
      identity: { emailVerified: true },
    })) as unknown as HumansRepo["getByIdWithIdentity"],
    listAuthAccounts: vi.fn(async () => [
      {
        providerId: "credential",
        accountId: BUYER_ID,
        createdAt: new Date("2025-01-01"),
      },
    ]) as HumansRepo["listAuthAccounts"],
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
    setResaleListingId: vi.fn(async () => {}),
    getById: vi.fn(
      async (id: string) => order?.items.find((i) => i.id === id) ?? null,
    ),
  } as unknown as OrderItemsRepo;

  const ticketsRepo: TicketsRepo = {
    listByOrderId: vi.fn(async () => tickets),
    getByOrderItemId: vi.fn(getTicketByOrderItemId),
    setStatus: vi.fn(async () => true),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => {}),
  } as unknown as TicketsRepo;

  const auditRepo = { log: vi.fn(async () => {}) } as unknown as AuditRepo;

  const idempotency = createFakeIdempotencyPort();
  const payeeLedger = createFakePayeeLedgerRepo();

  const resaleListing = {
    id: RESALE_LISTING_ID,
    sellerHumanId: SELLER_ID,
    eventShareCents: 500, // priced under the share (a listing with none is closed, FR-015)
    ticketId: TICKET_1,
    status: "SOLD",
    buyerOrderId: ORDER_ID,
    expiresAt: null,
    saleCutoffAt: null,
  };

  const txRepos = {
    orders: {
      listTaxLines: vi.fn(async () => []),
      getById: vi.fn(async (id: string) => (id === ORDER_ID ? order : null)),
      markRefunded: vi.fn(async () => {}),
    },
    orderItems: {
      updateStatus: vi.fn(async () => {}),
      setResaleListingId: vi.fn(async () => {}),
    },
    tickets: {
      listByOrderId: vi.fn(async () => tickets),
      getByOrderItemId: vi.fn(getTicketByOrderItemId),
      // The resale unwind locks the ticket row, then looks for a live
      // listing of the refunded buyer's own.
      getByIdForUpdate: vi.fn(
        async (id: string) =>
          Object.values(ticketByItemId).find((t) => t.id === id) ?? null,
      ),
      setStatus: vi.fn(async () => true),
      transfer: vi.fn(async () => true),
      restoreAfterResale: vi.fn(async () => {}),
    },
    resaleListings: {
      getById: vi.fn(async () => resaleListing),
      getByTicketId: vi.fn(async () => null),
      unwindSale: vi.fn(async () => {}),
    },
    payeeLedger: payeeLedger.repo,
    splits: { getForOrder: vi.fn(async () => []) },
    promos: { releaseHoldsForOrder: vi.fn(async () => undefined) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    audit: { log: vi.fn(async () => {}) },
  };

  const eventsRepo = {
    getById: vi.fn(async () => ({
      id: "event-1",
      orgId: eventOrgId,
      humanId: null,
      title: "Test Event",
      startsAt: eventStartsAt,
      refundCutoffAt: null,
    })),
  };

  const repos: Repos = {
    humans: humansRepo,
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    payeeLedger: payeeLedger.repo,
    splits: { getForOrder: vi.fn(async () => []) },
    resaleListings: { getById: vi.fn(async () => resaleListing) },
    audit: auditRepo,
    events: eventsRepo,
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-1" })),
      getById: vi.fn(async () => ({
        id: "payee-1",
        stripeAccountId: "acct_123",
      })),
    },
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
    },
    orderItemSettlementLines: { listByOrderItemIds: vi.fn(async () => []) },
    settlementLines: { getByIds: vi.fn(async () => []) },
    settlements: { getByIds: vi.fn(async () => []) },
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
  opts?: { withNotify?: boolean; reportError?: ReturnType<typeof vi.fn> },
) {
  return {
    repos: ctx.repos,
    payments: ctx.payments,
    idempotency: ctx.idempotency,
    clock: ctx.clock,
    authz: ctx.authz,
    ...(opts?.withNotify ? { notify: ctx.notify } : {}),
    ...(opts?.reportError ? { reportError: opts.reportError } : {}),
  };
}

const baseInput = {
  actorHumanId: ACTOR_ID,
  orgId: ORG_ID,
  orderId: ORDER_ID,
  note: NOTE,
};

describe("orgRefundFullOrder", () => {
  // ── Authz / scoping ────────────────────────────────────────────────────────

  it("rejects a non-finance org member before any side-effect", async () => {
    const ctx = makeContext({ allowed: false });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ctx.authz.canFinanceOrg).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
    expect(ctx.idempotency.__mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects an actor authorized for a DIFFERENT org", async () => {
    const ctx = makeContext();
    (ctx.authz.canFinanceOrg as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ orgId }: { orgId: string }) => ({
        allowed: orgId === OTHER_ORG_ID,
      }),
    );

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects when the order's event belongs to a different org", async () => {
    const ctx = makeContext({ eventOrgId: OTHER_ORG_ID });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "ORDER_NOT_IN_ORG" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("rejects a human-owned event (no orgId) — the org cannot claim it", async () => {
    const ctx = makeContext({ eventOrgId: null });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "ORDER_NOT_IN_ORG" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });

  it("throws ORDER_NOT_FOUND for an unknown order (before any refund work)", async () => {
    const ctx = makeContext({ order: null });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("requires a note of at least 3 characters", async () => {
    const ctx = makeContext();

    await expect(
      orgRefundFullOrder(makeDeps(ctx), { ...baseInput, note: "no" }),
    ).rejects.toBeDefined();

    expect(ctx.authz.canFinanceOrg).not.toHaveBeenCalled();
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  // ── RESALE: the gap this use case closes ──────────────────────────────────

  it("RESALE order: runs the resale unwind (ticket back to seller, listing unwound) and writes the org note", async () => {
    const ctx = makeContext({
      order: makeResaleOrder(),
      tickets: [{ id: TICKET_1, status: "VALID", scannedAt: null }],
      ticketByItemId: {
        [ITEM_A]: {
          id: TICKET_1,
          ownerHumanId: BUYER_ID,
          orderId: ORDER_ID,
          orderItemId: ITEM_A,
          status: "VALID",
        } as TicketRecord,
      },
    });

    const out = await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(out.refundedItems).toEqual([
      { orderItemId: ITEM_A, refundedCents: 5500 - 300 },
    ]);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);

    // Pre-flight unwind check ran against the root repos.
    expect(ctx.repos.resaleListings.getById).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
    );

    // The unwind: ticket handed back to the seller, restored onto the
    // original order item, listing reopened.
    expect(ctx.txRepos.tickets.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_1,
        fromHumanId: BUYER_ID,
        toHumanId: SELLER_ID,
        reason: "admin",
        orderId: ORDER_ID,
      }),
    );
    expect(ctx.txRepos.tickets.restoreAfterResale).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_1,
        restoredOrderId: ORIGINAL_ORDER_ID,
        restoredOrderItemId: ORIGINAL_ORDER_ITEM_ID,
      }),
    );
    expect(ctx.txRepos.orderItems.updateStatus).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      "active",
      NOW,
    );
    expect(ctx.txRepos.orderItems.setResaleListingId).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      RESALE_LISTING_ID,
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "LISTED",
      { expectedStatus: "VALID" },
    );
    expect(ctx.txRepos.resaleListings.unwindSale).toHaveBeenCalledWith(
      RESALE_LISTING_ID,
      ORDER_ID,
      "ACTIVE",
    );
    // The resale branch must NOT also kill the ticket as REFUNDED.
    expect(ctx.txRepos.tickets.setStatus).not.toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      expect.anything(),
    );

    // Shared core wrote its refunded row...
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "order", action: "refunded" }),
    );
    // ...and the org wrapper appended its own note row with actor + org + note.
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: ORDER_ID,
        action: "org_full_refund_note",
        data: expect.objectContaining({
          orgId: ORG_ID,
          actorHumanId: ACTOR_ID,
          refundId: "re_test_123",
          note: NOTE,
          // The order was live when the org asked: this refund is the org's own.
          orderStatusAtRequest: "SUCCEEDED",
        }),
        at: NOW,
      }),
    );
  });

  // ── PRIMARY still works ───────────────────────────────────────────────────

  it("PRIMARY order: refunds every item, flips tickets to REFUNDED, writes the org note", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(out.ok).toBe(true);
    expect(out.newOrderStatus).toBe("REFUNDED");
    expect(out.amountPaidCents).toBe(11000);
    expect(out.stripeFeeCents).toBe(300);
    // Same formula as the buyer/staff path: buyer-paid minus the Stripe fee.
    expect(out.refundedCents).toBe(11000 - 300);
    expect(out.refundedItems.map((i) => i.refundedCents)).toEqual([5350, 5350]);
    expect(out.skippedItems).toEqual([]);

    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_123",
        amountCents: 10700,
      }),
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_1,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(ctx.txRepos.tickets.setStatus).toHaveBeenCalledWith(
      TICKET_2,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(ctx.txRepos.resaleListings.unwindSale).not.toHaveBeenCalled();
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org_full_refund_note",
        data: expect.objectContaining({
          orgId: ORG_ID,
          note: NOTE,
          orderStatusAtRequest: "SUCCEEDED",
        }),
      }),
    );
  });

  // ── Buyer-only policy gates are bypassed for the org ──────────────────────

  it("refunds a SCANNED ticket for the org (buyer-only already_scanned skip is bypassed)", async () => {
    const ctx = makeContext({
      ticketByItemId: {
        [ITEM_A]: {
          id: TICKET_1,
          ownerHumanId: BUYER_ID,
          orderItemId: ITEM_A,
          status: "SCANNED",
        } as TicketRecord,
        [ITEM_B]: {
          id: TICKET_2,
          ownerHumanId: BUYER_ID,
          orderItemId: ITEM_B,
          status: "VALID",
        } as TicketRecord,
      },
      tickets: [
        { id: TICKET_1, status: "SCANNED", scannedAt: new Date() },
        { id: TICKET_2, status: "VALID", scannedAt: null },
      ],
    });

    const out = await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(out.skippedItems).toEqual([]);
    expect(out.newOrderStatus).toBe("REFUNDED");
    const flipped = (
      ctx.txRepos.tickets.setStatus as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    expect([...flipped].sort()).toEqual([TICKET_1, TICKET_2].sort());
  });

  it("refunds after the show has started (buyer refund window is bypassed for the org)", async () => {
    const ctx = makeContext({ eventStartsAt: PAST_START });

    const out = await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(out.ok).toBe(true);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("refunds a nonRefundable order for the org (buyer-only gate is bypassed)", async () => {
    const ctx = makeContext({ order: makeOrder({ nonRefundable: true }) });

    const out = await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(out.ok).toBe(true);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
  });

  // ── Policies the org must NOT bypass ──────────────────────────────────────

  it("refuses a disputed order (ORDER_DISPUTED_REFUND_BLOCKED) — the dispute guard ignores _skipBuyerCheck", async () => {
    const ctx = makeContext({ order: makeOrder({ disputeStatus: "OPEN" }) });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "ORDER_DISPUTED_REFUND_BLOCKED" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
    // A refusal is not an attempt: the refund key is never claimed.
    expect(ctx.idempotency.__mocks.begin).not.toHaveBeenCalledWith(
      REFUND_FULL_KEY,
      expect.anything(),
    );
    expect(ctx.txRepos.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "org_full_refund_note" }),
    );
  });

  it("forwards reportError into the core so refund-debit swallows reach Sentry", async () => {
    // The fake ledger holds no SETTLEMENT_CREDIT for the order, so the
    // refund-debit writer takes its loud-swallow branch and must report.
    const reportError = vi.fn();
    const ctx = makeContext();

    const out = await orgRefundFullOrder(
      makeDeps(ctx, { reportError }),
      baseInput,
    );

    expect(out.ok).toBe(true);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "refund_debit_no_credits_for_order" }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "refundFullOrder" }),
      }),
    );
  });

  // ── Idempotency: shares refundFullOrder's per-order key ──────────────────

  it("claims the SHARED order:refund-full key (no org namespace) — a full refund is a full refund", async () => {
    const ctx = makeContext();

    await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(ctx.idempotency.__store.has(REFUND_FULL_KEY)).toBe(true);
    expect(
      [...ctx.idempotency.__store.keys()].filter((k) => k.includes("org")),
    ).toEqual([]);
    expect(ctx.payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `${REFUND_FULL_KEY}:refund-payment-intent`,
      }),
    );
  });

  it("replays a full refund the BUYER already completed instead of refunding twice", async () => {
    const cachedResponse = {
      ok: true as const,
      orderId: ORDER_ID,
      refundId: "re_buyer_already_did_it",
      currency: "usd",
      amountPaidCents: 11000,
      stripeFeeCents: 300,
      refundedCents: 10700,
      refundedItems: [
        { orderItemId: ITEM_A, refundedCents: 5350 },
        { orderItemId: ITEM_B, refundedCents: 5350 },
      ],
      skippedItems: [],
      newOrderStatus: "REFUNDED" as const,
    };
    const ctx = makeContext({ order: makeOrder({ status: "REFUNDED" }) });
    ctx.idempotency.__store.set(REFUND_FULL_KEY, {
      payloadHash: "",
      response: cachedResponse,
    });

    const out = await orgRefundFullOrder(makeDeps(ctx), baseInput);

    expect(out).toEqual(cachedResponse);
    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
    // The org note still lands, pointing at the refund that actually happened.
    expect(ctx.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org_full_refund_note",
        data: expect.objectContaining({
          refundId: "re_buyer_already_did_it",
          note: NOTE,
          // Honest attribution: the order was ALREADY refunded when the org
          // asked, so an auditor can tell a piggyback from the org's own retry.
          orderStatusAtRequest: "REFUNDED",
        }),
      }),
    );
  });

  // ── Notify + failure ──────────────────────────────────────────────────────

  it("forwards notify to the shared core (single buyer notification, keyed on refundId)", async () => {
    const ctx = makeContext();

    const out = await orgRefundFullOrder(
      makeDeps(ctx, { withNotify: true }),
      baseInput,
    );

    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: BUYER_ID,
        variant: "order.refund-processed",
        idempotencyKey: `order-refund:${out.refundId}`,
      }),
    );
  });

  it("refuses an already-refunded order and writes NO org note", async () => {
    const ctx = makeContext({ order: makeOrder({ status: "REFUNDED" }) });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "ORDER_ALREADY_REFUNDED" });

    expect(ctx.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.txRepos.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "org_full_refund_note" }),
    );
  });

  it("does not write the org note when Stripe reports a failed refund", async () => {
    const ctx = makeContext();
    (
      ctx.payments.refundPaymentIntent as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ refundId: "re_failed", status: "failed" });

    await expect(
      orgRefundFullOrder(makeDeps(ctx), baseInput),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    expect(ctx.txRepos.orders.markRefunded).not.toHaveBeenCalled();
    expect(ctx.txRepos.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "org_full_refund_note" }),
    );
  });
});
