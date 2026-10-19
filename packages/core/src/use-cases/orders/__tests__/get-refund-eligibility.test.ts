import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { EventsRepo, EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";

import { getRefundEligibility } from "../get-refund-eligibility";
import { quoteItemRefund } from "../quote-item-refund";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_EVENT_ID = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2025-01-15T12:00:00.000Z");
const EVENT_STARTS = new Date("2025-01-20T19:00:00.000Z"); // 5 days from now

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: DEFAULT_ORDER_ID,
    eventId: DEFAULT_EVENT_ID,
    buyerHumanId: DEFAULT_ACTOR_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 500,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2025-01-10T00:00:00.000Z"),
    parentOrderId: null,
    taxAmountCents: 0,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    paidOutAt: null,
    items: [
      {
        id: "item-1",
        orderId: "order-1",
        kind: "ticket",
        ticketTypeId: "ticket-type-1",
        qty: 2,
        unitPriceCents: 2500,
        amountCents: 5000,
        meta: {},
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
    ...partial,
  };
}

function makeEvent(partial: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Test Event",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: EVENT_STARTS,
    endsAt: new Date("2025-01-20T23:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "test-event",
    shortId: "abc123",
    regionCode: null,
    publishedAt: new Date("2025-01-01T00:00:00.000Z"),
    agreementPrimaryId: "agreement-1",
    agreementResaleId: null,
    defaultLocale: null,
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    refundCutoffAt: null, // defaults to startsAt when null
    ...partial,
  };
}

function makeContext(options?: {
  order?: OrderRecord | null;
  event?: EventRecord | null;
  feeCents?: number;
  now?: Date;
  /**
   * Ticket behind each order item, served by `tickets.getByOrderItemId`.
   * Default: none (`null`) — item-only rules, the shape every older case in
   * this file was written against.
   */
  ticketsByItemId?: Record<string, Pick<TicketRecord, "id" | "status">>;
  /** Resale claim status per order item (`claims.getByOrderItemId`). Default: none. */
  claimStatusByItemId?: Record<string, string>;
}) {
  const order =
    options?.order === null ? null : (options?.order ?? makeOrder());
  const event =
    options?.event === null ? null : (options?.event ?? makeEvent());
  const feeCents = options?.feeCents ?? 200;
  const now = options?.now ?? NOW;
  const ticketsByItemId = options?.ticketsByItemId ?? {};

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_ACTOR_ID ? { id } : null,
    ) as HumansRepo["getById"],
  } as HumansRepo;

  const ordersRepo: OrdersRepo = {
    listTaxLines: vi.fn(async () => []),
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_ORDER_ID ? order : null,
    ) as OrdersRepo["getById"],
    createPending: vi.fn(),
    findByPaymentIntent: vi.fn(),
    listForOrg: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    })) as OrdersRepo["listForOrg"],
    listForHumanOwnedEvents: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    })) as OrdersRepo["listForHumanOwnedEvents"],
    listByBuyer: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    })) as OrdersRepo["listByBuyer"],
    linkPaymentIntent: vi.fn(),
    markSucceeded: vi.fn(),
    markProcessing: vi.fn(),
    markRefunded: vi.fn(),
    markPaidOut: vi.fn(),
    cancelProcessingOrder: vi.fn(async () => true),
    setPaymentMethodType: vi.fn(),
    updatePendingItems: vi.fn(
      async () => order,
    ) as OrdersRepo["updatePendingItems"],
  } as OrdersRepo;

  const orderItemsRepo = {
    markItemsPaidOut: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    listByOrderId: vi.fn(async () => order?.items ?? []),
    getById: vi.fn(async () => null),
  } as Repos["orderItems"];

  const eventsRepo: EventsRepo = {
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_EVENT_ID ? event : null,
    ) as EventsRepo["getById"],
  } as EventsRepo;

  const ticketsRepo = {
    getByOrderItemId: vi.fn(
      async (orderItemId: string) => ticketsByItemId[orderItemId] ?? null,
    ),
  };

  const claimStatusByItemId = options?.claimStatusByItemId ?? {};
  const claimsRepo = {
    getByOrderItemId: vi.fn(async (orderItemId: string) => {
      const status = claimStatusByItemId[orderItemId];
      return status ? { id: `claim-${orderItemId}`, orderItemId, status } : null;
    }),
  };

  const repos: Repos = {
    humans: humansRepo,
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    events: eventsRepo,
    tickets: ticketsRepo,
    claims: claimsRepo,
    tx: vi.fn(async (fn) => fn(repos as unknown)) as unknown as Repos["tx"],
  } as unknown as Repos;

  const payments: PaymentProcessorPort = {
    getProcessingFeeForPaymentIntent: vi.fn(
      async ({ paymentIntentId }: { paymentIntentId: string }) => ({
        feeCents,
        currency: "usd",
        paymentIntentId,
      }),
    ),
    refundPaymentIntent: vi.fn(),
    createCheckoutSession: vi.fn(),
    getPaymentForCheckoutSession: vi.fn(),
    verifyWebhookEvent: vi.fn(),
  } as unknown as PaymentProcessorPort;

  const clock: ClockPort = {
    now: () => now,
  };

  return {
    repos,
    payments,
    clock,
    ordersRepo,
    eventsRepo,
    ticketsRepo,
    claimsRepo,
  };
}

describe("getRefundEligibility", () => {
  it("returns eligible when order is paid and event has not started", async () => {
    const ctx = makeContext({ feeCents: 200 });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.orderId).toBe(DEFAULT_ORDER_ID);
    expect(out.isEligible).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.eventStartsAt).toBe(EVENT_STARTS.toISOString());
    expect(out.refundDeadline).toBe(EVENT_STARTS.toISOString());
    expect(out.hasTransferredItems).toBe(false);
    expect(out.refundableItemCount).toBe(1);
    expect(out.totalItemCount).toBe(1);
    expect(out.feeBreakdown).toEqual({
      amountPaidCents: 5500,
      ticketPriceCents: 5000,
      platformFeeCents: 500,
      taxCents: 0,
      stripeFeeCents: 200,
      refundableCents: 5300,
      currency: "usd",
    });
  });

  it("returns not eligible when event has started", async () => {
    const pastEvent = makeEvent({
      startsAt: new Date("2025-01-10T00:00:00.000Z"),
    });
    const ctx = makeContext({ event: pastEvent });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("event_started");
    expect(out.feeBreakdown).toBeNull();
  });

  it("returns not eligible when past refund cutoff but event not started", async () => {
    // Event starts in the future, but organizer set an earlier refund cutoff
    const eventWithCutoff = makeEvent({
      startsAt: new Date("2025-01-20T19:00:00.000Z"), // Event in future
      refundCutoffAt: new Date("2025-01-14T00:00:00.000Z"), // Cutoff was yesterday
    });
    const ctx = makeContext({ event: eventWithCutoff });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("past_refund_deadline");
    expect(out.eventStartsAt).toBe(eventWithCutoff.startsAt.toISOString());
    expect(out.refundDeadline).toBe(
      eventWithCutoff.refundCutoffAt!.toISOString(),
    );
    expect(out.feeBreakdown).toBeNull();
  });

  it("returns eligible when refund cutoff is set but not yet reached", async () => {
    // Event has cutoff in the future
    const eventWithFutureCutoff = makeEvent({
      startsAt: new Date("2025-01-20T19:00:00.000Z"),
      refundCutoffAt: new Date("2025-01-18T00:00:00.000Z"), // Cutoff is 3 days from now
    });
    const ctx = makeContext({ event: eventWithFutureCutoff });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.refundDeadline).toBe(
      eventWithFutureCutoff.refundCutoffAt!.toISOString(),
    );
  });

  it("returns not eligible when order is already refunded", async () => {
    const refundedOrder = makeOrder({ status: "REFUNDED" });
    const ctx = makeContext({ order: refundedOrder });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("already_refunded");
  });

  it("returns not eligible when order is pending", async () => {
    const pendingOrder = makeOrder({
      status: "PENDING",
      stripePaymentIntentId: null,
    });
    const ctx = makeContext({ order: pendingOrder });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("order_not_paid");
  });

  it("returns not eligible when order has been paid out", async () => {
    // Create order with items that have paidOutAt set (item-level settlement tracking)
    const paidOutDate = new Date("2025-01-14T00:00:00.000Z");
    const paidOutOrder = makeOrder({
      items: [
        {
          id: "item-1",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "ticket-type-1",
          qty: 1,
          unitPriceCents: 2500,
          amountCents: 2500,
          meta: {},
          paidOutAt: paidOutDate, // Item marked as paid out
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    });
    const ctx = makeContext({ order: paidOutOrder });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("order_already_paid_out");
  });

  it("returns not found when order does not exist", async () => {
    const ctx = makeContext({ order: null });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("order_not_found");
  });

  it("returns not found when order belongs to different buyer", async () => {
    const otherBuyerOrder = makeOrder({
      buyerHumanId: "44444444-4444-4444-8444-444444444444",
    });
    const ctx = makeContext({ order: otherBuyerOrder });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("order_not_found");
  });

  it("calculates fee breakdown correctly", async () => {
    const order = makeOrder({
      amountGrossCents: 10000,
      feesPlatformCents: 1000,
    });
    const ctx = makeContext({ order, feeCents: 500 });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.hasTransferredItems).toBe(false);
    expect(out.refundableItemCount).toBe(1);
    expect(out.totalItemCount).toBe(1);
    expect(out.feeBreakdown).toEqual({
      amountPaidCents: 11000,
      ticketPriceCents: 10000,
      platformFeeCents: 1000,
      taxCents: 0,
      stripeFeeCents: 500,
      refundableCents: 10500,
      currency: "usd",
    });
  });

  it("excludes transferred items from fee breakdown and flags them", async () => {
    const order = makeOrder({
      amountGrossCents: 6000, // 2 tickets at 3000 each
      feesPlatformCents: 600,
      items: [
        {
          id: "item-a",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          meta: { buyerTotalCents: 3300 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
        {
          id: "item-b",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          meta: { buyerTotalCents: 3300 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: new Date("2025-01-12T00:00:00.000Z"),
          status: "transferred",
        },
      ],
    });
    const ctx = makeContext({ order, feeCents: 200 });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(true);
    expect(out.reason).toBe("eligible");
    expect(out.hasTransferredItems).toBe(true);
    expect(out.refundableItemCount).toBe(1);
    expect(out.totalItemCount).toBe(2);
    // Only half the order is refundable: 3300 of 6600 total
    // Stripe fee share: round(3300/6600 * 200) = 100
    expect(out.feeBreakdown).toEqual({
      amountPaidCents: 3300,
      ticketPriceCents: 3000,
      platformFeeCents: 300,
      taxCents: 0,
      stripeFeeCents: 100,
      refundableCents: 3200,
      currency: "usd",
    });
  });

  it("returns no_refundable_items when all items are transferred", async () => {
    const order = makeOrder({
      items: [
        {
          id: "item-a",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: {},
          paidOutAt: null,
          refundedAt: null,
          transferredAt: new Date("2025-01-12T00:00:00.000Z"),
          status: "transferred",
        },
      ],
    });
    const ctx = makeContext({ order });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("no_refundable_items");
    expect(out.hasTransferredItems).toBe(true);
    expect(out.refundableItemCount).toBe(0);
    expect(out.totalItemCount).toBe(1);
    expect(out.feeBreakdown).toBeNull();
  });

  it("includes proportional tax in fee breakdown", async () => {
    const order = makeOrder({
      amountGrossCents: 6000,
      feesPlatformCents: 600,
      taxAmountCents: 660,
      items: [
        {
          id: "item-a",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          meta: { buyerTotalCents: 3300 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
        {
          id: "item-b",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          meta: { buyerTotalCents: 3300 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    });
    const ctx = makeContext({ order, feeCents: 200 });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(true);
    // orderTotalPaidCents = 3300 + 3300 + 660 = 7260
    // All items refundable → ratio = 1
    expect(out.feeBreakdown).toEqual({
      amountPaidCents: 7260,
      ticketPriceCents: 6000,
      platformFeeCents: 600,
      taxCents: 660,
      stripeFeeCents: 200,
      refundableCents: 7060,
      currency: "usd",
    });
  });

  it("proportionally reduces tax when some items are transferred", async () => {
    const order = makeOrder({
      amountGrossCents: 6000,
      feesPlatformCents: 600,
      taxAmountCents: 660,
      items: [
        {
          id: "item-a",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          meta: { buyerTotalCents: 3300 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
        {
          id: "item-b",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          meta: { buyerTotalCents: 3300 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: new Date("2025-01-12T00:00:00.000Z"),
          status: "transferred",
        },
      ],
    });
    const ctx = makeContext({ order, feeCents: 200 });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(true);
    expect(out.hasTransferredItems).toBe(true);
    // Only item-a refundable: ratio = 3300/6600 = 0.5
    // amountPaidCents = round(0.5 * 7260) = 3630
    // taxCents = round(0.5 * 660) = 330
    // stripeFeeCents = round(0.5 * 200) = 100
    // refundableCents = 3630 - 100 = 3530
    expect(out.feeBreakdown).toEqual({
      amountPaidCents: 3630,
      ticketPriceCents: 3000,
      platformFeeCents: 300,
      taxCents: 330,
      stripeFeeCents: 100,
      refundableCents: 3530,
      currency: "usd",
    });
  });
});

// ── Dispute guard ─────────────────────────────────────────────────────────
describe("getRefundEligibility — dispute guard", () => {
  it.each([
    ["OPEN", "disputed"],
    ["UNDER_REVIEW", "disputed"],
    // LOST is permanent — the cardholder already has the money back.
    ["LOST", "disputed_lost"],
  ] as const)(
    "reports `%s` → `%s` (not eligible) without a fee lookup",
    async (disputeStatus, reason) => {
      const ctx = makeContext({ order: makeOrder({ disputeStatus }) });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(false);
      expect(out.reason).toBe(reason);
      expect(out.feeBreakdown).toBeNull();
      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    "WON",
    "WARNING_OPEN",
    "WARNING_UNDER_REVIEW",
    "WARNING_CLOSED",
    null,
  ] as const)("stays eligible when disputeStatus is %s", async (disputeStatus) => {
    const ctx = makeContext({ order: makeOrder({ disputeStatus }) });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.isEligible).toBe(true);
    expect(out.reason).toBe("eligible");
  });

  it("explains the dispute ahead of the already-refunded gate", async () => {
    const ctx = makeContext({
      order: makeOrder({ status: "REFUNDED", disputeStatus: "OPEN" }),
    });

    const out = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.reason).toBe("disputed");
  });

  // ── Ticket-state parity with the mutations (audit #1 / #2) ────────────────
  // The display must promise exactly what `refundFullOrder` would do for a
  // buyer: a SCANNED or LISTED ticket is not refunded, so it must not be
  // folded into `refundableCents` / `refundableItemCount`.

  describe("ticket-state parity with the refund mutations", () => {
    const twoItemOrder = (
      overrides: [Partial<OrderRecord["items"][number]>, Partial<OrderRecord["items"][number]>] = [{}, {}],
      orderPartial: Partial<OrderRecord> = {},
    ) =>
      makeOrder({
        amountGrossCents: 6000,
        feesPlatformCents: 600,
        items: [
          {
            id: "item-a",
            orderId: DEFAULT_ORDER_ID,
            kind: "ticket",
            ticketTypeId: "tt-1",
            qty: 1,
            unitPriceCents: 3000,
            amountCents: 3000,
            meta: { buyerTotalCents: 3300 },
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
            ...overrides[0],
          },
          {
            id: "item-b",
            orderId: DEFAULT_ORDER_ID,
            kind: "ticket",
            ticketTypeId: "tt-1",
            qty: 1,
            unitPriceCents: 3000,
            amountCents: 3000,
            meta: { buyerTotalCents: 3300 },
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
            ...overrides[1],
          },
        ],
        ...orderPartial,
      });

    // The half-order breakdown the transferred-item case already pins.
    const halfOrderBreakdown = {
      amountPaidCents: 3300,
      ticketPriceCents: 3000,
      platformFeeCents: 300,
      taxCents: 0,
      stripeFeeCents: 100,
      refundableCents: 3200,
      currency: "usd",
    };

    it("excludes a SCANNED ticket's item from the refundable amount and count", async () => {
      const ctx = makeContext({
        order: twoItemOrder(),
        feeCents: 200,
        ticketsByItemId: {
          "item-a": { id: "ticket-a", status: "SCANNED" },
          "item-b": { id: "ticket-b", status: "VALID" },
        },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(true);
      expect(out.refundableItemCount).toBe(1);
      expect(out.totalItemCount).toBe(2);
      expect(out.hasTransferredItems).toBe(false);
      expect(out.feeBreakdown).toEqual(halfOrderBreakdown);
    });

    it("excludes a LISTED ticket's item (resaleListingId linked) from the refundable amount and count", async () => {
      const ctx = makeContext({
        order: twoItemOrder([{ resaleListingId: "listing-1" }, {}]),
        feeCents: 200,
        ticketsByItemId: {
          "item-a": { id: "ticket-a", status: "LISTED" },
          "item-b": { id: "ticket-b", status: "VALID" },
        },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(true);
      expect(out.refundableItemCount).toBe(1);
      expect(out.feeBreakdown).toEqual(halfOrderBreakdown);
    });

    it("a paid-out item is excluded from the count and amount via the shared classifier; the rest of the order stays refundable", async () => {
      // docs/decisions/buyer-refunds-stop-at-payout.md: the classifier now
      // says `already_paid_out` for buyers, so this query no longer needs a
      // private paid-out filter — and the mixed-order breakdown is the SAME
      // half-order number the scanned/listed cases pin.
      const ctx = makeContext({
        order: twoItemOrder([
          { paidOutAt: new Date("2025-01-14T00:00:00.000Z") },
          {},
        ]),
        feeCents: 200,
        ticketsByItemId: {
          "item-a": { id: "ticket-a", status: "VALID" },
          "item-b": { id: "ticket-b", status: "VALID" },
        },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(true);
      expect(out.reason).toBe("eligible");
      expect(out.refundableItemCount).toBe(1);
      expect(out.totalItemCount).toBe(2);
      expect(out.hasTransferredItems).toBe(false);
      expect(out.feeBreakdown).toEqual(halfOrderBreakdown);
    });

    it("an order whose only refundable-looking items are ALL paid out still reports order_already_paid_out (not no_refundable_items)", async () => {
      const ctx = makeContext({
        order: twoItemOrder([
          { paidOutAt: new Date("2025-01-14T00:00:00.000Z") },
          { paidOutAt: new Date("2025-01-14T00:00:00.000Z") },
        ]),
        feeCents: 200,
        ticketsByItemId: {
          "item-a": { id: "ticket-a", status: "VALID" },
          "item-b": { id: "ticket-b", status: "VALID" },
        },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(false);
      expect(out.reason).toBe("order_already_paid_out");
      expect(out.refundableItemCount).toBe(0);
      expect(out.totalItemCount).toBe(2);
      expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
    });

    it("a lone SCANNED ticket reports no_refundable_items (no Stripe fee lookup)", async () => {
      const ctx = makeContext({
        ticketsByItemId: { "item-1": { id: "ticket-1", status: "SCANNED" } },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(false);
      expect(out.reason).toBe("no_refundable_items");
      expect(out.refundableItemCount).toBe(0);
      expect(out.totalItemCount).toBe(1);
      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
    });

    it("a lone LISTED ticket reports no_refundable_items", async () => {
      const ctx = makeContext({
        ticketsByItemId: { "item-1": { id: "ticket-1", status: "LISTED" } },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(false);
      expect(out.reason).toBe("no_refundable_items");
    });

    it("a RESALE-source order stays eligible: its item's resaleListingId is the purchased listing, not an open one", async () => {
      const order = makeOrder({
        source: "RESALE",
        items: [{ ...makeOrder().items[0]!, resaleListingId: "listing-1" }],
      });
      const ctx = makeContext({
        order,
        ticketsByItemId: { "item-1": { id: "ticket-1", status: "VALID" } },
      });

      const out = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.isEligible).toBe(true);
      expect(out.refundableItemCount).toBe(1);
    });

    it("reads exactly one ticket per ticket item on the order", async () => {
      const ctx = makeContext({ order: twoItemOrder() });

      await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(ctx.ticketsRepo.getByOrderItemId).toHaveBeenCalledTimes(2);
      expect(ctx.ticketsRepo.getByOrderItemId).toHaveBeenCalledWith("item-a");
      expect(ctx.ticketsRepo.getByOrderItemId).toHaveBeenCalledWith("item-b");
    });
  });
});

// ── Parity with the item quote ────────────────────────────────────────────
// The eligibility screen fronts `refundFullOrder`; the item quote fronts
// `refundOrderItems`. Both now allocate tax and the processor fee over ALL
// ticket items with the same largest-remainder allocator, so for the same
// set of refundable items they must promise the same cents — not "close".
describe("getRefundEligibility — parity with quoteItemRefund", () => {
  const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  /** 3 × 3300 (ticket 3000 + platform fee 300), tax 800, Stripe fee 341. */
  function taxedOrder(transferred: string[] = []): OrderRecord {
    return makeOrder({
      amountGrossCents: 9000,
      feesPlatformCents: 900,
      taxAmountCents: 800,
      items: [ITEM_A, ITEM_B, ITEM_C].map(
        (id) =>
          ({
        id,
        orderId: DEFAULT_ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 3000,
        amountCents: 3000,
        meta: { buyerTotalCents: 3300 },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: transferred.includes(id)
          ? new Date("2025-01-12T00:00:00.000Z")
          : null,
        status: transferred.includes(id) ? "transferred" : "active",
          }) as OrderItemRecord,
      ),
    });
  }

  function contextWithPayees(order: OrderRecord) {
    const ctx = makeContext({ order, feeCents: 341 });
    // The quote resolves the payee; the eligibility screen does not.
    Object.assign(ctx.repos, {
      payees: {
        getBySubject: vi.fn(async () => ({ id: "payee-1" })),
        getById: vi.fn(async () => ({
          id: "payee-1",
          stripeAccountId: "acct_123",
        })),
      },
    });
    return ctx;
  }

  it.each([
    ["all three refundable", [] as string[], [ITEM_A, ITEM_B, ITEM_C]],
    ["C transferred", [ITEM_C], [ITEM_A, ITEM_B]],
    ["A and C transferred", [ITEM_A, ITEM_C], [ITEM_B]],
  ])(
    "%s: the screen's refundableCents equals the quote for the same items",
    async (_label, transferred, refundable) => {
      const ctx = contextWithPayees(taxedOrder(transferred));

      const screen = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );
      const quote = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
          orderItemIds: refundable,
        },
      );

      expect(screen.isEligible).toBe(true);
      expect(screen.feeBreakdown!.refundableCents).toBe(
        quote.totalRefundableCents,
      );
      expect(screen.feeBreakdown!.taxCents).toBe(
        quote.items.reduce((sum, i) => sum + i.taxShareCents, 0),
      );
      expect(screen.feeBreakdown!.stripeFeeCents).toBe(
        quote.items.reduce((sum, i) => sum + i.stripeFeeShareCents, 0),
      );
      expect(screen.feeBreakdown!.amountPaidCents).toBe(
        quote.items.reduce(
          (sum, i) => sum + i.buyerPaidCents + i.taxShareCents,
          0,
        ),
      );
    },
  );

  it("pins the largest-remainder numbers on the 3 × 3300 / 800 / 341 order", async () => {
    const ctx = contextWithPayees(taxedOrder([ITEM_C]));

    const screen = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    // A and B: tax 267 + 267, fee 114 + 114, paid (3300 + 267) × 2.
    expect(screen.feeBreakdown).toEqual({
      amountPaidCents: 7134,
      ticketPriceCents: 6000,
      platformFeeCents: 600,
      taxCents: 534,
      stripeFeeCents: 228,
      refundableCents: 6906,
      currency: "usd",
    });
  });

  // ── Discounted orders (money review 2026-09-15) ─────────────────────────
  //
  // This screen was NEVER the discount bug. It allocates
  // `computeExpectedPaymentAmount(order)` — which already nets out every
  // negative line item — across the ticket items, so
  // `computeItemBuyerPaid` is only a WEIGHT here, never an item's absolute
  // base. The item quote was the one reading the pre-discount figure as an
  // absolute, and it now takes its base from the shared
  // `allocateRefundItemBases`. These cases pin that the screen's number did
  // not move AND that the quote has come into line with it.

  /** 2 × 2750 less a 1000 platform credit → a 4500 charge. */
  function discountedOrder(): OrderRecord {
    const ticket = (id: string) =>
      ({
        id,
        orderId: DEFAULT_ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 2500,
        amountCents: 2500,
        meta: { buyerTotalCents: 2750 },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      }) as OrderItemRecord;
    return makeOrder({
      amountGrossCents: 5000,
      feesPlatformCents: 500,
      taxAmountCents: 0,
      items: [
        ticket(ITEM_A),
        ticket(ITEM_B),
        {
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          orderId: DEFAULT_ORDER_ID,
          kind: "platform_credit",
          ticketTypeId: null,
          qty: 1,
          unitPriceCents: 0,
          amountCents: -1000,
          meta: {},
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        } as unknown as OrderItemRecord,
      ],
    });
  }

  it("prices a discounted order off the post-discount charge (unchanged — this screen never had the bug)", async () => {
    const ctx = makeContext({ order: discountedOrder(), feeCents: 200 });

    const screen = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    // 4500 charged, split 2250/2250; fee 200 → 100 each. NOT 2750 each.
    expect(screen.feeBreakdown!.amountPaidCents).toBe(4500);
    expect(screen.feeBreakdown!.stripeFeeCents).toBe(200);
    expect(screen.feeBreakdown!.refundableCents).toBe(4300);
  });

  it.each([
    ["both items refundable", [ITEM_A, ITEM_B]],
    ["one item refundable", [ITEM_A]],
  ])(
    "discounted order, %s: the screen and the item quote promise the same cents",
    async (_label, refundable) => {
      const ctx = contextWithPayees(discountedOrder());

      const screen = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );
      const quote = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
          orderItemIds: refundable,
        },
      );

      const quotedForSubset = quote.totalRefundableCents;
      const screenForSubset = screen.feeBreakdown!.refundableCents;
      if (refundable.length === 2) {
        // Same item set → same promise, to the cent.
        expect(screenForSubset).toBe(quotedForSubset);
      }
      // Either way the quote can never exceed the charge net of the fee.
      expect(quotedForSubset).toBeLessThanOrEqual(
        quote.orderTotalPaidCents - quote.orderStripeFeeCents,
      );
      expect(quote.items.map((i) => i.buyerPaidCents)).toEqual(
        refundable.map(() => 2250),
      );
    },
  );
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".
describe("getRefundEligibility — a ticket that cost $0", () => {
  const VIP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const GA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const DISCOUNT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  /**
   * The shape of dev order f425308e: a $125 VIP a 100% VIP code freed beside
   * a paid $50 GA. Charged 5245 + 444 tax = 5689; the processor kept 195.
   */
  function freedOrder(): OrderRecord {
    const item = (
      id: string,
      kind: string,
      amountCents: number,
      meta: Record<string, unknown>,
    ) =>
      ({
        id,
        orderId: DEFAULT_ORDER_ID,
        kind,
        ticketTypeId: kind === "ticket" ? "tt-1" : null,
        qty: 1,
        unitPriceCents: amountCents,
        amountCents,
        meta,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      }) as OrderItemRecord;
    return makeOrder({
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items: [
        item(DISCOUNT, "discount", -12_500, {}),
        item(VIP, "ticket", 12_500, {
          buyerTotalCents: 12_500,
          discountedToZero: true,
          platformFeePerTicketCents: 0,
          processorFeeShareCents: 0,
        }),
        item(GA, "ticket", 5_000, {
          buyerTotalCents: 5_245,
          platformFeePerTicketCents: 50,
          processorFeeShareCents: 195,
        }),
      ],
    });
  }

  /** `scanned`: tickets used at the door, which a buyer's refund skips. */
  function contextWithPayees(scanned: string[] = []) {
    const ctx = makeContext({
      order: freedOrder(),
      feeCents: 195,
      ticketsByItemId: Object.fromEntries(
        [VIP, GA].map((id) => [
          id,
          {
            id: `ticket-${id}`,
            status: scanned.includes(id) ? "SCANNED" : "VALID",
          } as const,
        ]),
      ),
    });
    // The quote resolves the payee; the eligibility screen does not.
    Object.assign(ctx.repos, {
      payees: {
        getBySubject: vi.fn(async () => ({ id: "payee-1" })),
        getById: vi.fn(async () => ({
          id: "payee-1",
          stripeAccountId: "acct_123",
        })),
      },
    });
    return ctx;
  }

  it.each([
    ["both tickets refundable", [] as string[], [VIP, GA], 5_494, 444, 195],
    ["GA used at the door: only the freed VIP is left", [GA], [VIP], 0, 0, 0],
    ["VIP used at the door: only the paid GA is left", [VIP], [GA], 5_494, 444, 195],
  ])(
    "(g) %s: the screen shows the quote's figures",
    async (_label, scanned, refundable, cents, tax, fee) => {
      const ctx = contextWithPayees(scanned);

      const screen = await getRefundEligibility(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );
      const quote = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
        {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
          orderItemIds: refundable,
        },
      );

      expect(screen.isEligible).toBe(true);
      expect(screen.feeBreakdown!.refundableCents).toBe(cents);
      expect(screen.feeBreakdown!.refundableCents).toBe(
        quote.totalRefundableCents,
      );
      expect(screen.feeBreakdown!.taxCents).toBe(tax);
      expect(screen.feeBreakdown!.taxCents).toBe(
        quote.items.reduce((sum, i) => sum + i.taxShareCents, 0),
      );
      expect(screen.feeBreakdown!.stripeFeeCents).toBe(fee);
      expect(screen.feeBreakdown!.stripeFeeCents).toBe(
        quote.items.reduce((sum, i) => sum + i.stripeFeeShareCents, 0),
      );
    },
  );

  it("shows the freed ticket as worth $0 on every line of the breakdown", async () => {
    const ctx = contextWithPayees([GA]);

    const screen = await getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    // Pre-fix: amountPaid 4007, tax 313, stripeFee 137, refundable 3870.
    expect(screen.feeBreakdown).toMatchObject({
      amountPaidCents: 0,
      ticketPriceCents: 0,
      platformFeeCents: 0,
      taxCents: 0,
      stripeFeeCents: 0,
      refundableCents: 0,
    });
  });
});

// ── isResale: the policy card words the refund without a platform fee ─────
// A resale purchase carries no platform fee (charged once, on the primary
// sale), and the refund page's policy card renders for eligible AND
// ineligible results, so every result past the order load must carry it.
describe("getRefundEligibility — isResale", () => {
  const resaleOrder = () =>
    makeOrder({
      source: "RESALE",
      feesPlatformCents: 0,
      items: [{ ...makeOrder().items[0]!, resaleListingId: "listing-1" }],
    });
  const validTicket = { "item-1": { id: "ticket-1", status: "VALID" as const } };
  const call = (ctx: ReturnType<typeof makeContext>) =>
    getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

  it("is true on an eligible RESALE order", async () => {
    const out = await call(
      makeContext({ order: resaleOrder(), ticketsByItemId: validTicket }),
    );

    expect(out.reason).toBe("eligible");
    expect(out.isResale).toBe(true);
    expect(out.feeBreakdown?.platformFeeCents).toBe(0);
  });

  it("is true on a RESALE order whose event has started (ineligible)", async () => {
    const out = await call(
      makeContext({
        order: resaleOrder(),
        ticketsByItemId: validTicket,
        event: makeEvent({ startsAt: new Date("2025-01-10T00:00:00.000Z") }),
      }),
    );

    expect(out.reason).toBe("event_started");
    expect(out.feeBreakdown).toBeNull();
    expect(out.isResale).toBe(true);
  });

  it("is true on an early-gate ineligible RESALE order (already refunded)", async () => {
    const out = await call(
      makeContext({ order: { ...resaleOrder(), status: "REFUNDED" } }),
    );

    expect(out.reason).toBe("already_refunded");
    expect(out.isResale).toBe(true);
  });

  it("is false on a PRIMARY order, eligible and ineligible", async () => {
    const eligible = await call(makeContext());
    const started = await call(
      makeContext({
        event: makeEvent({ startsAt: new Date("2025-01-10T00:00:00.000Z") }),
      }),
    );

    expect(eligible.reason).toBe("eligible");
    expect(eligible.isResale).toBe(false);
    expect(started.reason).toBe("event_started");
    expect(started.isResale).toBe(false);
  });

  it("is false when there is no order to read it from", async () => {
    const out = await call(makeContext({ order: null }));

    expect(out.reason).toBe("order_not_found");
    expect(out.isResale).toBe(false);
  });
});

// ── A resale claim's refund already on its way ────────────────────────────
// Mirrors refund-full-order's buyer gate (CLAIM_REFUND_PENDING): the page
// must not say "eligible" for a refund the server will refuse.
describe("getRefundEligibility — pending resale-claim refund", () => {
  const resaleOrder = () =>
    makeOrder({
      source: "RESALE",
      feesPlatformCents: 0,
      items: [{ ...makeOrder().items[0]!, resaleListingId: "listing-1" }],
    });
  const validTicket = { "item-1": { id: "ticket-1", status: "VALID" as const } };
  const call = (ctx: ReturnType<typeof makeContext>) =>
    getRefundEligibility(
      { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock },
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

  it("an approved claim → claim_refund_pending, before any Stripe fee read", async () => {
    const ctx = makeContext({
      order: resaleOrder(),
      ticketsByItemId: validTicket,
      claimStatusByItemId: { "item-1": "approved" },
    });

    const out = await call(ctx);

    expect(out.isEligible).toBe(false);
    expect(out.reason).toBe("claim_refund_pending");
    expect(out.isResale).toBe(true);
    expect(out.feeBreakdown).toBeNull();
    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
  });

  it.each(["open", "denied"])(
    "a %s claim leaves the order eligible",
    async (status) => {
      const out = await call(
        makeContext({
          order: resaleOrder(),
          ticketsByItemId: validTicket,
          claimStatusByItemId: { "item-1": status },
        }),
      );

      expect(out.reason).toBe("eligible");
    },
  );

  it("a REFUNDED order says already_refunded, not claim_refund_pending (the refund landed)", async () => {
    const out = await call(
      makeContext({
        order: { ...resaleOrder(), status: "REFUNDED" },
        claimStatusByItemId: { "item-1": "approved" },
      }),
    );

    expect(out.reason).toBe("already_refunded");
  });

  it("a PRIMARY order never reads claims", async () => {
    const ctx = makeContext({ claimStatusByItemId: { "item-1": "approved" } });

    const out = await call(ctx);

    expect(out.reason).toBe("eligible");
    expect(ctx.claimsRepo.getByOrderItemId).not.toHaveBeenCalled();
  });
});
