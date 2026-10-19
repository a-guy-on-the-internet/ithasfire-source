import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { TicketsRepo, TicketRecord } from "@th/ports/repos/tickets";
import type { Repos } from "@th/ports/repos";

import { quoteFullRefund } from "../quote-full-refund";

const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "99999999-9999-4999-8999-999999999999";
const DEFAULT_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const TICKET_2 = "22222222-bbbb-4bbb-8bbb-222222222222";

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  const now = new Date("2025-01-01T00:00:00.000Z");
  return {
    id: DEFAULT_ORDER_ID,
    eventId: "event-1",
    buyerHumanId: DEFAULT_ACTOR_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 500,
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
    items: [
      {
        id: "item-1",
        orderId: DEFAULT_ORDER_ID,
        kind: "ticket",
        ticketTypeId: "ticket-type-1",
        qty: 2,
        unitPriceCents: 2500,
        amountCents: 5000,
        meta: { buyerTotalCents: 5500 },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
    ...partial,
  };
}

/**
 * The SAME two-item order `refund-full-order.test.ts` refunds: 2 × 5500
 * buyer-paid, 1000 platform fee, Stripe fee 300 → each item's fee share is
 * 150, so one refundable item nets 5350 and both net 10_700. The quote must
 * land on those exact numbers for the same fixture.
 */
function makeTwoItemOrder(
  overrides: [Partial<OrderItemRecord>, Partial<OrderItemRecord>] = [{}, {}],
): OrderRecord {
  const item = (id: string, o: Partial<OrderItemRecord>): OrderItemRecord =>
    ({
      id,
      orderId: DEFAULT_ORDER_ID,
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
      ...o,
    }) as OrderItemRecord;
  return makeOrder({
    amountGrossCents: 10000,
    feesPlatformCents: 1000,
    items: [item(ITEM_A, overrides[0]), item(ITEM_B, overrides[1])],
  });
}

function ticket(
  id: string,
  orderItemId: string,
  status: TicketRecord["status"],
): TicketRecord {
  return {
    id,
    ownerHumanId: DEFAULT_ACTOR_ID,
    orderId: DEFAULT_ORDER_ID,
    orderItemId,
    status,
  } as TicketRecord;
}

/** The clock the quote judges the refund window on. */
const NOW = new Date("2025-06-01T12:00:00.000Z");

function makeContext(options?: {
  actorExists?: boolean;
  order?: OrderRecord | null;
  feeCents?: number;
  /** Ticket behind each order item (`tickets.getByOrderItemId`). Default: none. */
  ticketByItemId?: Record<string, TicketRecord | null>;
  /** Event start (buyer refund window). Default: far after NOW. */
  eventStartsAt?: Date;
  /** Organizer's explicit refund cutoff (null = none). */
  eventRefundCutoffAt?: Date | null;
  /** Resale claim status per order item (`claims.getByOrderItemId`). Default: none. */
  claimStatusByItemId?: Record<string, string>;
}) {
  const actorExists = options?.actorExists ?? true;
  const order = options?.order ?? makeOrder();
  const feeCents = options?.feeCents ?? 200;
  const ticketByItemId = options?.ticketByItemId ?? {};
  const eventStartsAt =
    options?.eventStartsAt ?? new Date("2025-12-01T00:00:00.000Z");
  const eventRefundCutoffAt = options?.eventRefundCutoffAt ?? null;

  const eventsRepo = {
    getById: vi.fn(async () => ({
      id: "event-1",
      orgId: "org-1",
      humanId: null,
      startsAt: eventStartsAt,
      refundCutoffAt: eventRefundCutoffAt,
    })),
  };

  const clock: ClockPort = { now: vi.fn(() => NOW) } as unknown as ClockPort;

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) =>
      actorExists && (id === DEFAULT_ACTOR_ID || id === STRANGER_ID)
        ? { id }
        : null,
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

  const ticketsRepo: TicketsRepo = {
    getByOrderItemId: vi.fn(
      async (orderItemId: string) => ticketByItemId[orderItemId] ?? null,
    ),
  } as unknown as TicketsRepo;

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
    tickets: ticketsRepo,
    events: eventsRepo,
    claims: claimsRepo,
    tx: vi.fn(async (fn) => fn(repos as any)) as unknown as Repos["tx"],
  } as unknown as Repos;

  const payments: PaymentProcessorPort = {
    getProcessingFeeForPaymentIntent: vi
      .fn(async ({ paymentIntentId }: { paymentIntentId: string }) => ({
        feeCents,
        currency: "usd",
        paymentIntentId,
      }))
      .mockName("getProcessingFeeForPaymentIntent"),
    refundPaymentIntent: vi.fn(),
    createCheckoutSession: vi.fn(),
    getPaymentForCheckoutSession: vi.fn(),
    verifyWebhookEvent: vi.fn(),
  } as unknown as PaymentProcessorPort;

  return {
    repos,
    payments,
    clock,
    humansRepo,
    ordersRepo,
    ticketsRepo,
    eventsRepo,
    claimsRepo,
    paymentsMock: payments,
  };
}

function makeDeps(ctx: ReturnType<typeof makeContext>) {
  return { repos: ctx.repos, payments: ctx.payments, clock: ctx.clock };
}

describe("quoteFullRefund", () => {
  it("returns amountPaid - actual Stripe fee", async () => {
    const ctx = makeContext({ feeCents: 321 });

    const out = await quoteFullRefund(
      makeDeps(ctx),
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.orderId).toBe(DEFAULT_ORDER_ID);
    expect(out.currency).toBe("usd");
    expect(out.amountPaidCents).toBe(5500);
    expect(out.stripeFeeCents).toBe(321);
    expect(out.refundableCents).toBe(5179);
    expect(out.refundableItemCount).toBe(1);
    expect(out.skippedItemCount).toBe(0);

    expect(
      ctx.paymentsMock.getProcessingFeeForPaymentIntent,
    ).toHaveBeenCalledWith({ paymentIntentId: "pi_123" });
  });

  it("falls back to amountGross + platformFees when items have no buyerTotalCents", async () => {
    const order = makeOrder({
      amountGrossCents: 5000,
      feesPlatformCents: 700,
      items: [
        {
          id: "item-1",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "ticket-type-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: {},
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    });

    const ctx = makeContext({ order, feeCents: 200 });

    const out = await quoteFullRefund(
      makeDeps(ctx),
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.amountPaidCents).toBe(5700);
    expect(out.refundableCents).toBe(5500);
  });

  it("throws not_found when actor is missing", async () => {
    const ctx = makeContext({ actorExists: false });

    await expect(
      quoteFullRefund(
        makeDeps(ctx),
        {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
          orderItemId: null,
        },
      ),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_FOUND" });
  });

  it("throws conflict when order isn't succeeded", async () => {
    const order = makeOrder({ status: "PENDING" });
    const ctx = makeContext({ order });

    await expect(
      quoteFullRefund(
        makeDeps(ctx),
        {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
          orderItemId: null,
        },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_REFUNDABLE" });
  });

  it("PASS_THROUGH: refunds everything except the Stripe fee (platform fee refunded)", async () => {
    // $35 ticket + $0.50 platform fee, buyer also funded the processor fee
    // (137) → buyer paid 3687. Stripe fee 137 is the only non-refundable part.
    const order = makeOrder({
      amountGrossCents: 3500,
      feesPlatformCents: 50,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [
        {
          id: "item-1",
          orderId: DEFAULT_ORDER_ID,
          kind: "ticket",
          ticketTypeId: "ticket-type-1",
          qty: 1,
          unitPriceCents: 3500,
          amountCents: 3500,
          meta: {
            buyerTotalCents: 3687,
            effectiveFeeMode: "PASS_THROUGH",
            platformFeePerTicketCents: 50,
          },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    });
    const ctx = makeContext({ order, feeCents: 137 });

    const out = await quoteFullRefund(
      makeDeps(ctx),
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.amountPaidCents).toBe(3687);
    expect(out.stripeFeeCents).toBe(137);
    // ticket + platform refunded: 3687 - 137 (processor) = 3550.
    expect(out.refundableCents).toBe(3550);
  });

  it("ABSORB: refunds everything except the Stripe fee", async () => {
    // Default fixture is ABSORB (empty snapshot, no per-item effectiveFeeMode).
    const ctx = makeContext({ feeCents: 321 });

    const out = await quoteFullRefund(
      makeDeps(ctx),
      { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
    );

    expect(out.refundableCents).toBe(5500 - 321);
  });

  it("clamps refundable to 0 when fee is greater than amount paid", async () => {
    const ctx = makeContext({ feeCents: 99999 });

    const out = await quoteFullRefund(
      makeDeps(ctx),
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        orderId: DEFAULT_ORDER_ID,
        orderItemId: null,
      },
    );

    expect(out.refundableCents).toBe(0);
  });

  // ── Ownership ────────────────────────────────────────────────────────────
  // A buyer endpoint: only the buyer who placed the order may read what it
  // would refund. Before this guard any signed-in user could read any order's
  // paid amount and processor fee by id. The answer is ORDER_NOT_FOUND — the
  // same one `refundFullOrder` and `quoteItemRefund` give a stranger — so
  // none of the three buyer endpoints confirms the order exists.
  describe("ownership", () => {
    it("a signed-in stranger gets ORDER_NOT_FOUND (no meta) and no Stripe / ticket / event read happens", async () => {
      const ctx = makeContext({ feeCents: 321 });

      await expect(
        quoteFullRefund(
          makeDeps(ctx),
          { actorHumanId: STRANGER_ID, orderId: DEFAULT_ORDER_ID },
        ),
      ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

      expect(
        ctx.paymentsMock.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
      expect(ctx.ticketsRepo.getByOrderItemId).not.toHaveBeenCalled();
      expect(ctx.eventsRepo.getById).not.toHaveBeenCalled();
    });

    it("the owner is quoted", async () => {
      const ctx = makeContext({ feeCents: 321 });

      const out = await quoteFullRefund(
        makeDeps(ctx),
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.refundableCents).toBe(5179);
    });
  });

  // ── Gates ────────────────────────────────────────────────────────────────
  // The quote refuses what `refundFullOrder`'s buyer path refuses, in the
  // same order: owner → nonRefundable → dispute → window → order state.
  // Every refusal happens before the Stripe fee read.
  describe("gates (same as refundFullOrder's buyer path)", () => {
    function expectNoMoneyRead(ctx: ReturnType<typeof makeContext>) {
      expect(
        ctx.paymentsMock.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
    }

    it("a nonRefundable order → ORDER_NON_REFUNDABLE", async () => {
      const ctx = makeContext({ order: makeOrder({ nonRefundable: true }) });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "ORDER_NON_REFUNDABLE" });
      expectNoMoneyRead(ctx);
    });

    it("a disputed order → ORDER_DISPUTED_REFUND_BLOCKED, the code the refund throws", async () => {
      const ctx = makeContext({
        order: makeOrder({ disputeStatus: "OPEN" }),
      });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({
        code: "ORDER_DISPUTED_REFUND_BLOCKED",
        meta: {
          orderId: DEFAULT_ORDER_ID,
          paymentIntentId: "pi_123",
          disputeStatus: "OPEN",
        },
      });
      expectNoMoneyRead(ctx);
    });

    it("the dispute wins over the state gates, as in the refund: DISPUTED status + OPEN dispute explains the dispute, not ORDER_NOT_REFUNDABLE", async () => {
      const ctx = makeContext({
        order: makeOrder({ status: "DISPUTED", disputeStatus: "OPEN" }),
      });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "ORDER_DISPUTED_REFUND_BLOCKED" });
    });

    it("an event that already started → REFUND_WINDOW_CLOSED, judged on the injected clock", async () => {
      // NOW is 2025-06-01T12:00Z; the show started the evening before.
      const ctx = makeContext({
        eventStartsAt: new Date("2025-05-31T20:00:00.000Z"),
      });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({
        code: "REFUND_WINDOW_CLOSED",
        meta: { now: NOW.toISOString() },
      });
      expect(ctx.clock.now).toHaveBeenCalled();
      expectNoMoneyRead(ctx);
    });

    it("an organizer cutoff that passed → REFUND_WINDOW_CLOSED even though the show hasn't started", async () => {
      const ctx = makeContext({
        eventRefundCutoffAt: new Date("2025-05-30T00:00:00.000Z"),
      });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });
    });

    it("without a clock dep the window falls back to the wall clock (a 2099 show is open; the pinned NOW is not consulted)", async () => {
      const ctx = makeContext({
        feeCents: 321,
        eventStartsAt: new Date("2099-01-01T00:00:00.000Z"),
      });

      // No `clock` — the historical deps shape (repos + payments only).
      const out = await quoteFullRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.refundableCents).toBe(5179);
      expect(ctx.clock.now).not.toHaveBeenCalled();
    });

    it("a missing event → EVENT_NOT_FOUND", async () => {
      const ctx = makeContext();
      ctx.eventsRepo.getById.mockResolvedValueOnce(null as never);

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    });

    it("a REFUNDED order → ORDER_ALREADY_REFUNDED (state gate shared with the refund)", async () => {
      const ctx = makeContext({ order: makeOrder({ status: "REFUNDED" }) });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "ORDER_ALREADY_REFUNDED" });
      expectNoMoneyRead(ctx);
    });

    it("an unpaid order → ORDER_NOT_PAID", async () => {
      const ctx = makeContext({
        order: makeOrder({ stripePaymentIntentId: null }),
      });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    });

    it("a RESALE order with an approved claim → CLAIM_REFUND_PENDING, the code the refund throws", async () => {
      const ctx = makeContext({
        order: makeOrder({ source: "RESALE" }),
        claimStatusByItemId: { "item-1": "approved" },
      });

      await expect(
        quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        }),
      ).rejects.toMatchObject({ code: "CLAIM_REFUND_PENDING" });
      expectNoMoneyRead(ctx);
    });

    it.each(["open", "denied"])(
      "a RESALE order whose claim is %s still quotes",
      async (status) => {
        const ctx = makeContext({
          order: makeOrder({ source: "RESALE" }),
          claimStatusByItemId: { "item-1": status },
        });

        const out = await quoteFullRefund(makeDeps(ctx), {
          actorHumanId: DEFAULT_ACTOR_ID,
          orderId: DEFAULT_ORDER_ID,
        });

        expect(out.refundableItemCount).toBe(1);
      },
    );
  });

  // ── Item rules ───────────────────────────────────────────────────────────
  // The quote must be what `refundFullOrder` would ACTUALLY refund for the
  // same buyer: the same `classifyRefundItem({ buyerInitiated: true })` rule,
  // the same allocation of buyer-paid and Stripe fee across ALL ticket items,
  // summed over the refundable ones only. Numbers below are the literal pins
  // from refund-full-order.test.ts on the identical two-item fixture.
  describe("item rules (same fixture as refund-full-order.test.ts)", () => {
    it("fully refundable two-item order quotes 10_700 — Σ per-item nets equals amountPaid − stripeFee to the cent", async () => {
      const ctx = makeContext({
        order: makeTwoItemOrder(),
        feeCents: 300,
        ticketByItemId: {
          [ITEM_A]: ticket(TICKET_1, ITEM_A, "VALID"),
          [ITEM_B]: ticket(TICKET_2, ITEM_B, "VALID"),
        },
      });

      const out = await quoteFullRefund(
        makeDeps(ctx),
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.amountPaidCents).toBe(11_000);
      expect(out.stripeFeeCents).toBe(300);
      // refund-full-order.test.ts "staff … refund BOTH items for the
      // unchanged 10_700": 2 × 5500 − 300.
      expect(out.refundableCents).toBe(10_700);
      expect(out.refundableCents).toBe(out.amountPaidCents - out.stripeFeeCents);
      expect(out.refundableItemCount).toBe(2);
      expect(out.skippedItemCount).toBe(0);
    });

    it("a SCANNED ticket is excluded: quotes 5350, exactly what refundFullOrder refunds for that fixture", async () => {
      const ctx = makeContext({
        order: makeTwoItemOrder(),
        feeCents: 300,
        ticketByItemId: {
          [ITEM_A]: {
            ...ticket(TICKET_1, ITEM_A, "SCANNED"),
            scannedAt: new Date("2025-06-01T11:00:00.000Z"),
          } as TicketRecord,
          [ITEM_B]: ticket(TICKET_2, ITEM_B, "VALID"),
        },
      });

      const out = await quoteFullRefund(
        makeDeps(ctx),
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      // refund-full-order.test.ts "a buyer's SCANNED ticket is skipped":
      // item B's 5500 buyer-paid minus its 150 fee share. NOT 10_700 (the
      // pre-fix over-quote: amountPaid − fee across the whole order).
      expect(out.refundableCents).toBe(5350);
      expect(out.amountPaidCents).toBe(11_000);
      expect(out.stripeFeeCents).toBe(300);
      expect(out.refundableItemCount).toBe(1);
      expect(out.skippedItemCount).toBe(1);
    });

    it("a paid-out item is excluded for the buyer (buyer refunds stop at payout): 5350", async () => {
      const ctx = makeContext({
        order: makeTwoItemOrder([
          { paidOutAt: new Date("2025-05-20T00:00:00.000Z") },
          {},
        ]),
        feeCents: 300,
        ticketByItemId: {
          [ITEM_A]: ticket(TICKET_1, ITEM_A, "VALID"),
          [ITEM_B]: ticket(TICKET_2, ITEM_B, "VALID"),
        },
      });

      const out = await quoteFullRefund(
        makeDeps(ctx),
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      // refund-full-order.test.ts "a buyer's full refund SKIPS the paid-out
      // item (already_paid_out)": 5350 for item B.
      expect(out.refundableCents).toBe(5350);
      expect(out.refundableItemCount).toBe(1);
      expect(out.skippedItemCount).toBe(1);
    });

    it("a gifted (transferred) item and a listed ticket are excluded", async () => {
      const ctx = makeContext({
        order: makeTwoItemOrder([
          { status: "transferred", transferredAt: new Date("2025-05-01") },
          {},
        ]),
        feeCents: 300,
        ticketByItemId: {
          [ITEM_A]: ticket(TICKET_1, ITEM_A, "VALID"),
          [ITEM_B]: ticket(TICKET_2, ITEM_B, "LISTED"),
        },
      });

      const out = await quoteFullRefund(
        makeDeps(ctx),
        { actorHumanId: DEFAULT_ACTOR_ID, orderId: DEFAULT_ORDER_ID },
      );

      expect(out.refundableCents).toBe(0);
      expect(out.refundableItemCount).toBe(0);
      expect(out.skippedItemCount).toBe(2);
    });
  });
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".
describe("quoteFullRefund — a ticket that cost $0", () => {
  /**
   * The shape of dev order f425308e: a $125 VIP a 100% VIP code freed (ITEM_A)
   * beside a paid $50 GA (ITEM_B). Charged 5245 + 444 tax = 5689; the
   * processor kept 195.
   */
  function freedOrder(): OrderRecord {
    const order = makeTwoItemOrder([
      {
        unitPriceCents: 12_500,
        amountCents: 12_500,
        meta: {
          buyerTotalCents: 12_500,
          discountedToZero: true,
          platformFeePerTicketCents: 0,
        },
      },
      { meta: { buyerTotalCents: 5_245, platformFeePerTicketCents: 50 } },
    ]);
    return {
      ...order,
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items: [
        {
          ...order.items[0]!,
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          kind: "discount",
          ticketTypeId: null,
          unitPriceCents: -12_500,
          amountCents: -12_500,
          meta: {},
        } as unknown as OrderItemRecord,
        ...order.items,
      ],
    };
  }

  it("quotes charge − processing fee for the whole order, as before", async () => {
    const ctx = makeContext({
      order: freedOrder(),
      feeCents: 195,
      ticketByItemId: {
        [ITEM_A]: ticket("t-a", ITEM_A, "VALID"),
        [ITEM_B]: ticket("t-b", ITEM_B, "VALID"),
      },
    });

    const quote = await quoteFullRefund(makeDeps(ctx), {
      actorHumanId: DEFAULT_ACTOR_ID,
      orderId: DEFAULT_ORDER_ID,
    });

    expect(quote.amountPaidCents).toBe(5_689);
    expect(quote.refundableCents).toBe(5_689 - 195);
    expect(quote.refundableItemCount).toBe(2);
  });

  it("quotes $0 when the freed ticket is the only refundable one", async () => {
    // The paid GA was used at the door, so the buyer's refund skips it.
    // Pre-fix this quoted 3870 for a ticket that cost nothing.
    const ctx = makeContext({
      order: freedOrder(),
      feeCents: 195,
      ticketByItemId: {
        [ITEM_A]: ticket("t-a", ITEM_A, "VALID"),
        [ITEM_B]: ticket("t-b", ITEM_B, "SCANNED"),
      },
    });

    const quote = await quoteFullRefund(makeDeps(ctx), {
      actorHumanId: DEFAULT_ACTOR_ID,
      orderId: DEFAULT_ORDER_ID,
    });

    expect(quote.refundableCents).toBe(0);
    expect(quote.refundableItemCount).toBe(1);
    expect(quote.skippedItemCount).toBe(1);
  });
});
