import { describe, expect, it, vi } from "vitest";

import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type { Repos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";

import { quoteItemRefund } from "../quote-item-refund";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeOrder(partial: Partial<OrderRecord> = {}): OrderRecord {
  const now = new Date("2025-01-01T00:00:00.000Z");
  return {
    id: ORDER_ID,
    eventId: "event-1",
    buyerHumanId: ACTOR_ID,
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
      {
        id: ITEM_A,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-ga",
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
        id: ITEM_B,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-ga",
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
        id: ITEM_C,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-vip",
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
    ...partial,
  };
}

/**
 * Ticket fixture per order item. The refund window / scanned / listed rules
 * read the ticket behind each requested item via `tickets.getByOrderItemId`;
 * a missing entry (or `null`) models an item with no ticket row.
 */
type TicketFixture = Pick<TicketRecord, "id" | "status"> &
  Partial<TicketRecord>;

function makeContext(opts?: {
  actorExists?: boolean;
  order?: OrderRecord | null;
  feeCents?: number;
  /** Event start. Default far future so existing cases stay inside the window. */
  eventStartsAt?: Date;
  /** Organizer's explicit refund cutoff (null = none). */
  eventRefundCutoffAt?: Date | null;
  ticketsByItemId?: Record<string, TicketFixture | null>;
}) {
  const actorExists = opts?.actorExists ?? true;
  const order = opts?.order !== undefined ? opts.order : makeOrder();
  const feeCents = opts?.feeCents ?? 300;
  const eventStartsAt =
    opts?.eventStartsAt ?? new Date("2099-01-01T00:00:00.000Z");
  const eventRefundCutoffAt = opts?.eventRefundCutoffAt ?? null;
  const ticketsByItemId: Record<string, TicketFixture | null> =
    opts?.ticketsByItemId ?? {
      [ITEM_A]: { id: "ticket-a", status: "VALID", orderItemId: ITEM_A },
      [ITEM_B]: { id: "ticket-b", status: "VALID", orderItemId: ITEM_B },
      [ITEM_C]: { id: "ticket-c", status: "VALID", orderItemId: ITEM_C },
    };

  const humansRepo: HumansRepo = {
    getById: vi.fn(async (id: string) =>
      actorExists && id === ACTOR_ID ? { id } : null,
    ) as HumansRepo["getById"],
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
      orgId: "org-1",
      humanId: null,
      startsAt: eventStartsAt,
      refundCutoffAt: eventRefundCutoffAt,
    })),
  };

  const payeesRepo = {
    getBySubject: vi.fn(async () => ({ id: "payee-1" })),
    getById: vi.fn(async () => ({
      id: "payee-1",
      stripeAccountId: "acct_123",
    })),
  };

  const ticketsRepo = {
    getByOrderItemId: vi.fn(
      async (orderItemId: string) => ticketsByItemId[orderItemId] ?? null,
    ),
  };

  const repos: Repos = {
    humans: humansRepo,
    orders: ordersRepo,
    events: eventsRepo,
    payees: payeesRepo,
    tickets: ticketsRepo,
  } as unknown as Repos;

  const payments: PaymentProcessorPort = {
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({
      feeCents,
      currency: "usd",
      paymentIntentId: "pi_123",
    })),
  } as unknown as PaymentProcessorPort;

  return { repos, payments, ticketsRepo };
}

describe("quoteItemRefund", () => {
  it("returns correct per-item breakdown for a single item", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    expect(out.orderId).toBe(ORDER_ID);
    expect(out.currency).toBe("usd");
    // 3 items × 3300 = 9900 total
    expect(out.orderTotalPaidCents).toBe(9900);
    expect(out.orderStripeFeeCents).toBe(300);
    expect(out.items).toHaveLength(1);

    const itemA = out.items[0]!;
    expect(itemA.orderItemId).toBe(ITEM_A);
    expect(itemA.buyerPaidCents).toBe(3300);
    expect(itemA.isEligible).toBe(true);
    expect(itemA.ineligibleReason).toBeNull();
    // Fee share: 300 allocated over three equal 3300 items = 100 each
    expect(itemA.stripeFeeShareCents).toBe(100);
    expect(itemA.taxShareCents).toBe(0);
    // Refundable: 3300 + 0 - 100 = 3200
    expect(itemA.refundableCents).toBe(3200);

    expect(out.totalRefundableCents).toBe(3200);
  });

  it("returns breakdown for multiple items", async () => {
    const ctx = makeContext({ feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    expect(out.items).toHaveLength(2);
    // Both items are identical 3300 of 9900, fee share = 100 each
    expect(out.items[0]!.refundableCents).toBe(3200);
    expect(out.items[1]!.refundableCents).toBe(3200);
    expect(out.totalRefundableCents).toBe(6400);
  });

  it("marks already-refunded items as ineligible", async () => {
    const order = makeOrder();
    order.items[0]!.status = "refunded";
    order.items[0]!.refundedAt = new Date();
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    const a = out.items.find((i) => i.orderItemId === ITEM_A)!;
    const b = out.items.find((i) => i.orderItemId === ITEM_B)!;

    expect(a.isEligible).toBe(false);
    expect(a.ineligibleReason).toBe("already_refunded");
    expect(a.refundableCents).toBe(0);

    expect(b.isEligible).toBe(true);
    expect(b.refundableCents).toBe(3200);

    // totalRefundable only includes eligible items
    expect(out.totalRefundableCents).toBe(3200);
  });

  // docs/decisions/buyer-refunds-stop-at-payout.md: once an item's revenue
  // has been paid out, a BUYER cannot self-serve a refund of it. Org / staff
  // (`_skipBuyerCheck`) still may, via a transfer reversal.
  it("a paid-out item is ineligible for the BUYER (already_paid_out): 0 refundable, no reversal flagged", async () => {
    const order = makeOrder();
    order.items[1]!.paidOutAt = new Date();
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    const b = out.items.find((i) => i.orderItemId === ITEM_B)!;
    expect(b).toMatchObject({
      isEligible: false,
      ineligibleReason: "already_paid_out",
      refundableCents: 0,
      requiresTransferReversal: false,
    });
    expect(out.hasTransferReversals).toBe(false);
    // Only the un-paid-out item counts: 3300 − round(1/3 × 300) = 3200.
    expect(out.totalRefundableCents).toBe(3200);
  });

  it("the SAME paid-out item is eligible for org/staff (_skipBuyerCheck) with requiresTransferReversal, at the unchanged 3200", async () => {
    const order = makeOrder();
    order.items[1]!.paidOutAt = new Date();
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments, _skipBuyerCheck: true },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    const b = out.items.find((i) => i.orderItemId === ITEM_B)!;
    expect(b).toMatchObject({
      isEligible: true,
      ineligibleReason: null,
      requiresTransferReversal: true,
      // 3300 buyer-paid − round(3300/9900 × 300) fee share — the amount the
      // pre-decision buyer quote produced; org/staff keep it.
      refundableCents: 3200,
    });
    expect(out.hasTransferReversals).toBe(true);
    expect(out.totalRefundableCents).toBe(6400);
  });

  it("marks transferred items as ineligible", async () => {
    const order = makeOrder();
    order.items[2]!.status = "transferred";
    order.items[2]!.transferredAt = new Date();
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_C] },
    );

    expect(out.items[0]!.isEligible).toBe(false);
    expect(out.items[0]!.ineligibleReason).toBe("already_transferred");
  });

  it("works on PART_REFUNDED orders", async () => {
    const order = makeOrder({ status: "PART_REFUNDED" });
    order.items[0]!.status = "refunded";
    order.items[0]!.refundedAt = new Date();
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_B] },
    );

    expect(out.items[0]!.isEligible).toBe(true);
    expect(out.items[0]!.refundableCents).toBe(3200);
  });

  it("throws not_found for missing actor", async () => {
    const ctx = makeContext({ actorExists: false });

    await expect(
      quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      ),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_FOUND" });
  });

  it("throws not_found for missing order", async () => {
    const ctx = makeContext({ order: null });

    await expect(
      quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("throws not_found when actor is not the order buyer", async () => {
    const otherActorId = "99999999-9999-4999-8999-999999999999";
    const order = makeOrder({
      buyerHumanId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    });
    const ctx = makeContext({ order });

    // The actor exists but doesn't own the order
    (ctx.repos.humans.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: otherActorId,
    });

    await expect(
      quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: otherActorId,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("throws conflict for non-refundable order status (PENDING)", async () => {
    const order = makeOrder({ status: "PENDING" });
    const ctx = makeContext({ order });

    await expect(
      quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_REFUNDABLE" });
  });

  it("throws not_found when order item does not belong to order", async () => {
    const ctx = makeContext();
    const unknownId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await expect(
      quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [unknownId],
        },
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "order_item_not_found",
    });
  });

  it("falls back to amountCents when meta.buyerTotalCents is missing", async () => {
    const order = makeOrder();
    // Strip buyerTotalCents from all items
    for (const item of order.items) {
      item.meta = {};
    }
    // Total falls back to amountGross + platformFees = 9000 + 900 = 9900
    const ctx = makeContext({ order, feeCents: 198 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    // The base is the item's share of the order's post-discount, pre-tax
    // charge — here the 9900 fallback total (gross 9000 + platform fee 900),
    // split by amountCents weight (3000 each) → 3300. That is what
    // `refundFullOrder` pays for this item; before the shared
    // `allocateRefundItemBases` landed the item path used the raw
    // `amountCents` (3000) and silently withheld the item's 300¢ of platform
    // fee that policy says is refundable.
    //
    // The fee is allocated across the three ticket items the same way:
    // 198 / 3 = 66, so the whole 198 is withheld once every item is refunded
    // (the old ratio against the 9900 fallback total withheld 3 × 60 = 180 and
    // left 18c of processor fee on the platform).
    expect(out.items[0]!.buyerPaidCents).toBe(3300);
    expect(out.items[0]!.stripeFeeShareCents).toBe(66);
    expect(out.items[0]!.refundableCents).toBe(3234);
  });

  it("clamps refundable to 0 when Stripe fee exceeds item amount", async () => {
    const ctx = makeContext({ feeCents: 99000 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    expect(out.items[0]!.refundableCents).toBe(0);
  });

  it("includes proportional tax share per item when order has tax", async () => {
    // 3 items × 3300 = 9900, tax = 990 → orderTotalPaidCents = 10890
    const order = makeOrder({ taxAmountCents: 990 });
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    // orderTotalPaidCents = 9900 + 990 = 10890
    expect(out.orderTotalPaidCents).toBe(10890);

    const itemA = out.items[0]!;
    expect(itemA.buyerPaidCents).toBe(3300);
    // Shares are allocated over ALL ticket items by buyer-paid (ex-tax), so
    // `orderTotalPaidCents` is display-only and never enters the ratio:
    // stripeFeeShare = 300 / 3 = 100
    expect(itemA.stripeFeeShareCents).toBe(100);
    // taxShare = 990 / 3 = 330
    expect(itemA.taxShareCents).toBe(330);
    // refundable = 3300 + 330 - 100 = 3530
    expect(itemA.refundableCents).toBe(3530);
  });

  it("distributes tax across multiple items proportionally", async () => {
    const order = makeOrder({ taxAmountCents: 990 });
    const ctx = makeContext({ order, feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
      },
    );

    // All items identical weight → each gets 1/3 of tax, and the three
    // shares sum to the WHOLE tax: refunding every item returns every cent.
    for (const item of out.items) {
      expect(item.taxShareCents).toBe(330);
    }
    expect(out.items.reduce((sum, i) => sum + i.taxShareCents, 0)).toBe(990);
    expect(out.items.reduce((sum, i) => sum + i.stripeFeeShareCents, 0)).toBe(
      300,
    );
    // Each refundable = 3300 + 330 - 100 = 3530
    expect(out.totalRefundableCents).toBe(3530 * 3);
  });

  it("an item's share does not depend on which items are in the request", async () => {
    // 3 × 3300, tax 800, actual Stripe fee 341 — neither divides by 3.
    const order = makeOrder({ taxAmountCents: 800 });
    const quoteFor = async (orderItemIds: string[]) => {
      const ctx = makeContext({ order, feeCents: 341 });
      return quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds },
      );
    };

    const all = await quoteFor([ITEM_A, ITEM_B, ITEM_C]);
    const byId = new Map(all.items.map((i) => [i.orderItemId, i]));

    // Largest-remainder over all three items, ties by id:
    //   tax 800 → 267 / 267 / 266, fee 341 → 114 / 114 / 113.
    expect(byId.get(ITEM_A)!.taxShareCents).toBe(267);
    expect(byId.get(ITEM_B)!.taxShareCents).toBe(267);
    expect(byId.get(ITEM_C)!.taxShareCents).toBe(266);
    expect(byId.get(ITEM_A)!.stripeFeeShareCents).toBe(114);
    expect(byId.get(ITEM_B)!.stripeFeeShareCents).toBe(114);
    expect(byId.get(ITEM_C)!.stripeFeeShareCents).toBe(113);
    expect(all.items.reduce((sum, i) => sum + i.taxShareCents, 0)).toBe(800);
    expect(all.items.reduce((sum, i) => sum + i.stripeFeeShareCents, 0)).toBe(
      341,
    );
    // 10700 charged − 341 fee, to the cent.
    expect(all.totalRefundableCents).toBe(10359);

    // Quoting one item at a time yields the very same per-item numbers.
    let oneAtATime = 0;
    for (const id of [ITEM_C, ITEM_A, ITEM_B]) {
      const single = await quoteFor([id]);
      expect(single.items[0]).toEqual(byId.get(id));
      oneAtATime += single.totalRefundableCents;
    }
    expect(oneAtATime).toBe(all.totalRefundableCents);

    // The tax-inclusive total is still reported for display, but it is no
    // longer the denominator of anything.
    expect(all.orderTotalPaidCents).toBe(10700);
  });

  it("ABSORB: refunds everything except the Stripe fee share", async () => {
    // Default fixture: empty snapshot, no per-item effectiveFeeMode → ABSORB.
    const ctx = makeContext({ feeCents: 300 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    // 3300 + 0 (tax) - 100 (Stripe fee share) = 3200.
    expect(out.items[0]!.refundableCents).toBe(3200);
  });

  it("PASS_THROUGH: refunds ticket + platform, withholding only the Stripe fee", async () => {
    // Single $35 ticket: buyer paid 3687 (3500 + 50 platform + 137 processor),
    // sole item so it carries the full Stripe fee. Platform fee IS refunded now.
    const order = makeOrder({
      amountGrossCents: 3500,
      feesPlatformCents: 50,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [
        {
          id: ITEM_A,
          orderId: ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-ga",
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

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    const item = out.items[0]!;
    expect(item.buyerPaidCents).toBe(3687);
    expect(item.stripeFeeShareCents).toBe(137);
    expect(item.taxShareCents).toBe(0);
    // ticket + platform refunded: 3687 - 137 (processor) = 3550.
    expect(item.refundableCents).toBe(3550);
    expect(out.totalRefundableCents).toBe(3550);
  });

  it("uniform rule: PASS_THROUGH and ABSORB items refund the same buyer-paid minus Stripe fee", async () => {
    // Two items with identical buyer-paid amounts but opposite fee-mode flags;
    // both must refund buyerPaid - their Stripe fee share (no per-mode branch).
    const order = makeOrder({
      amountGrossCents: 7000,
      feesPlatformCents: 100,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items: [
        {
          id: ITEM_A,
          orderId: ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-ga",
          qty: 1,
          unitPriceCents: 3500,
          amountCents: 3500,
          meta: {
            buyerTotalCents: 3550,
            effectiveFeeMode: "PASS_THROUGH",
            platformFeePerTicketCents: 50,
          },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
        {
          id: ITEM_B,
          orderId: ORDER_ID,
          kind: "ticket",
          ticketTypeId: "tt-ga",
          qty: 1,
          unitPriceCents: 3500,
          amountCents: 3500,
          meta: {
            buyerTotalCents: 3550,
            effectiveFeeMode: "ABSORB",
          },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    });
    const ctx = makeContext({ order, feeCents: 200 });

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    // orderTotal = 3550 + 3550 = 7100. Each ratio 0.5 → Stripe share 100 each.
    const a = out.items.find((i) => i.orderItemId === ITEM_A)!;
    const b = out.items.find((i) => i.orderItemId === ITEM_B)!;
    expect(a.stripeFeeShareCents).toBe(100);
    expect(b.stripeFeeShareCents).toBe(100);
    // Both refund 3550 - 100 = 3450 regardless of fee mode.
    expect(a.refundableCents).toBe(3450);
    expect(b.refundableCents).toBe(3450);
    expect(a.refundableCents).toBe(b.refundableCents);
  });

  // ── NFR-003 regression guard ─────────────────────────────────────────────
  //
  // Refunds were already correct — they quote from the OrderItem's purchase
  // snapshot and never re-read `TicketType.priceCents`. Phase 0 moved the
  // resale + wallet-pass paths onto the SAME source; this pins the pattern
  // they were migrated to so a future "shared price resolver" refactor cannot
  // quietly introduce a post-purchase recompute here.
  it("quotes from the item's purchase snapshot and never reads the live ticket type", async () => {
    const ctx = makeContext({ feeCents: 300 });

    // The `tickets` fake answers ONLY `getByOrderItemId` (the ticket-STATE
    // read the eligibility rules need) and no ticket-type repo exists on the
    // context. If the quote ever reached for the live type, this call would
    // throw rather than return.
    expect(Object.keys(ctx.ticketsRepo)).toEqual(["getByOrderItemId"]);

    const out = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    // Straight off `OrderItem.unitPriceCents` — the same field the resale
    // face value and the wallet pass now read.
    expect(out.items[0]!.unitPriceCents).toBe(3000);
  });

  it("rejects a repeated order item id instead of quoting it twice", async () => {
    const ctx = makeContext({ feeCents: 300 });

    // Membership validation passes for a duplicate (the id IS in the order),
    // so without the uniqueness rule this produced two eligible quotes for one
    // item and a doubled `totalRefundableCents` — the number the execution
    // path sends to Stripe.
    await expect(
      quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_A],
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(ctx.payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
  });

  // ── Buyer refund window (audit #1) ────────────────────────────────────────
  // The rule the display query (`get-refund-eligibility.ts`) shows the buyer
  // is the rule the mutation enforces: blocked once `now >= startsAt` OR, when
  // the organizer set one, once `now >= refundCutoffAt`.

  describe("buyer refund window", () => {
    const START = new Date("2026-09-08T20:00:00.000Z");
    const clockAt = (iso: string) => ({ now: () => new Date(iso) });

    it("rejects a buyer quote once the event has started (REFUND_WINDOW_CLOSED) without reaching Stripe", async () => {
      const ctx = makeContext({ eventStartsAt: START });

      await expect(
        quoteItemRefund(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            clock: clockAt("2026-09-09T01:00:00.000Z"),
          },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });

      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
    });

    it("rejects exactly AT the start instant (now >= deadline, not >)", async () => {
      const ctx = makeContext({ eventStartsAt: START });

      await expect(
        quoteItemRefund(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            clock: { now: () => new Date(START) },
          },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });
    });

    it("quotes normally before the deadline", async () => {
      const ctx = makeContext({ eventStartsAt: START });

      const out = await quoteItemRefund(
        {
          repos: ctx.repos,
          payments: ctx.payments,
          clock: clockAt("2026-09-08T19:59:59.000Z"),
        },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );

      expect(out.items[0]!.isEligible).toBe(true);
      expect(out.totalRefundableCents).toBe(3200);
    });

    it("an explicit refundCutoffAt closes the window before startsAt", async () => {
      const ctx = makeContext({
        eventStartsAt: START,
        eventRefundCutoffAt: new Date("2026-09-06T00:00:00.000Z"),
      });

      await expect(
        quoteItemRefund(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            // Past the cutoff, still two days before the show.
            clock: clockAt("2026-09-06T12:00:00.000Z"),
          },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });
    });

    it("a refundCutoffAt AFTER startsAt never reopens the window once the show began (display parity)", async () => {
      const ctx = makeContext({
        eventStartsAt: START,
        eventRefundCutoffAt: new Date("2026-09-10T00:00:00.000Z"),
      });

      await expect(
        quoteItemRefund(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            clock: clockAt("2026-09-08T21:00:00.000Z"),
          },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({ code: "REFUND_WINDOW_CLOSED" });
    });

    it("org/staff callers (_skipBuyerCheck) still quote after the show", async () => {
      const ctx = makeContext({ eventStartsAt: START });

      const out = await quoteItemRefund(
        {
          repos: ctx.repos,
          payments: ctx.payments,
          clock: clockAt("2026-09-09T01:00:00.000Z"),
          _skipBuyerCheck: true,
        },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );

      expect(out.items[0]!.isEligible).toBe(true);
    });

    it("blocks the buyer item path on a nonRefundable order (ORDER_NON_REFUNDABLE); org path unaffected", async () => {
      const buyer = makeContext({ order: makeOrder({ nonRefundable: true }) });
      await expect(
        quoteItemRefund(
          { repos: buyer.repos, payments: buyer.payments },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({ code: "ORDER_NON_REFUNDABLE" });
      expect(
        buyer.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();

      const org = makeContext({ order: makeOrder({ nonRefundable: true }) });
      const out = await quoteItemRefund(
        { repos: org.repos, payments: org.payments, _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );
      expect(out.items[0]!.isEligible).toBe(true);
    });
  });

  // ── Ticket state (audit #1 / #2) ──────────────────────────────────────────

  describe("ticket state eligibility", () => {
    it("a SCANNED ticket is ineligible for the buyer (already_scanned) but refundable for org/staff", async () => {
      const scanned = {
        [ITEM_A]: { id: "ticket-a", status: "SCANNED" as const },
        [ITEM_B]: { id: "ticket-b", status: "VALID" as const },
      };

      const buyer = makeContext({ ticketsByItemId: scanned });
      const buyerOut = await quoteItemRefund(
        { repos: buyer.repos, payments: buyer.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B],
        },
      );
      expect(buyerOut.items[0]).toMatchObject({
        orderItemId: ITEM_A,
        isEligible: false,
        ineligibleReason: "already_scanned",
        refundableCents: 0,
      });
      expect(buyerOut.items[1]!.isEligible).toBe(true);
      expect(buyerOut.totalRefundableCents).toBe(3200);

      const org = makeContext({ ticketsByItemId: scanned });
      const orgOut = await quoteItemRefund(
        { repos: org.repos, payments: org.payments, _skipBuyerCheck: true },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );
      expect(orgOut.items[0]).toMatchObject({
        isEligible: true,
        ineligibleReason: null,
      });
    });

    it("a LISTED ticket is ineligible (listing_active) for buyer AND org", async () => {
      const listed = {
        [ITEM_A]: { id: "ticket-a", status: "LISTED" as const },
      };

      for (const skip of [false, true]) {
        const ctx = makeContext({ ticketsByItemId: listed });
        const out = await quoteItemRefund(
          { repos: ctx.repos, payments: ctx.payments, _skipBuyerCheck: skip },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        );
        expect(out.items[0]).toMatchObject({
          isEligible: false,
          ineligibleReason: "listing_active",
          refundableCents: 0,
        });
        expect(out.totalRefundableCents).toBe(0);
      }
    });

    it("an item still linked to a listing (resaleListingId set) is listing_active even if the ticket reads VALID", async () => {
      const order = makeOrder();
      order.items[0]!.resaleListingId = "listing-1";
      const ctx = makeContext({ order });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );

      expect(out.items[0]).toMatchObject({
        isEligible: false,
        ineligibleReason: "listing_active",
      });
    });

    it("reads exactly one ticket per requested item (bounded by the request, not the order)", async () => {
      const ctx = makeContext();

      await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_B] },
      );

      expect(ctx.ticketsRepo.getByOrderItemId).toHaveBeenCalledTimes(1);
      expect(ctx.ticketsRepo.getByOrderItemId).toHaveBeenCalledWith(ITEM_B);
    });
  });

  // ── Discounted orders (money review 2026-09-15) ───────────────────────────
  //
  // A discount is a separate NEGATIVE line item, not a reduction of each
  // ticket's `meta.buyerTotalCents`. Using the raw per-item figure as the
  // refundable BASE therefore handed the discount back to the buyer once per
  // item. The base is now each item's share of
  // `computeExpectedPaymentAmount(order) − tax` — see `refund-item-base.ts`.

  describe("discounted orders", () => {
    const CREDIT_ITEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    function negativeItem(
      kind: "platform_credit" | "discount",
      amountCents: number,
    ) {
      return {
        id: CREDIT_ITEM,
        orderId: ORDER_ID,
        kind,
        ticketTypeId: null,
        qty: 1,
        unitPriceCents: 0,
        amountCents,
        meta: {},
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      } as unknown as OrderRecord["items"][number];
    }

    /** A ticket item whose pre-discount buyer figure is `buyerTotalCents`. */
    function ticketItem(id: string, buyerTotalCents: number, faceCents: number) {
      return {
        id,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-ga",
        qty: 1,
        unitPriceCents: faceCents,
        amountCents: faceCents,
        meta: { buyerTotalCents },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      } as unknown as OrderRecord["items"][number];
    }

    it("prices one item of a discounted order at its share of what was CHARGED, not its sticker figure", async () => {
      // The worked example: A and B at 2,750 each, less a 1,000 platform
      // credit → the buyer was charged 4,500, not 5,500.
      const order = makeOrder({
        amountGrossCents: 5_000,
        feesPlatformCents: 500,
        items: [
          ticketItem(ITEM_A, 2_750, 2_500),
          ticketItem(ITEM_B, 2_750, 2_500),
          negativeItem("platform_credit", -1_000),
        ],
      });
      const ctx = makeContext({ order, feeCents: 200 });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );

      expect(out.orderTotalPaidCents).toBe(4_500);
      const itemA = out.items[0]!;
      // Base: 4,500 split by equal weight → 2,250 (was 2,750, the
      // PRE-discount figure, which over-refunded the whole 1,000 credit).
      expect(itemA.buyerPaidCents).toBe(2_250);
      expect(itemA.stripeFeeShareCents).toBe(100);
      expect(itemA.refundableCents).toBe(2_150);
      expect(out.totalRefundableCents).toBe(2_150);
    });

    it("Σ over every item of a discounted order is EXACTLY orderTotal − fee (never more)", async () => {
      const order = makeOrder({
        amountGrossCents: 5_000,
        feesPlatformCents: 500,
        items: [
          ticketItem(ITEM_A, 2_750, 2_500),
          ticketItem(ITEM_B, 2_750, 2_500),
          negativeItem("platform_credit", -1_000),
        ],
      });
      const ctx = makeContext({ order, feeCents: 200 });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B],
        },
      );

      // 2,150 + 2,150 = 4,300. Before the fix this was 2,650 + 2,650 = 5,300
      // against a 4,500 charge — the platform ate 1,000.
      expect(out.totalRefundableCents).toBe(
        out.orderTotalPaidCents - out.orderStripeFeeCents,
      );
      expect(out.totalRefundableCents).toBe(4_300);
    });

    it("splits a discount that does not divide evenly with no cent lost or invented", async () => {
      // −1,000 over THREE equal items: 8,900 / 3 = 2,966.67. Largest-remainder
      // gives the two leftover cents to the lowest ids (a…, b…), so the three
      // bases are 2,967 / 2,967 / 2,966 and sum to exactly 8,900.
      const order = makeOrder({
        items: [
          ticketItem(ITEM_A, 3_300, 3_000),
          ticketItem(ITEM_B, 3_300, 3_000),
          ticketItem(ITEM_C, 3_300, 3_000),
          negativeItem("platform_credit", -1_000),
        ],
      });
      const ctx = makeContext({ order, feeCents: 300 });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
        },
      );

      expect(out.orderTotalPaidCents).toBe(8_900);
      expect(out.items.map((i) => i.buyerPaidCents)).toEqual([
        2_967, 2_967, 2_966,
      ]);
      expect(out.items.reduce((sum, i) => sum + i.buyerPaidCents, 0)).toBe(
        8_900,
      );
      expect(out.totalRefundableCents).toBe(8_900 - 300);
    });

    it("is defined by the ORDER TOTAL, so a non-platform_credit discount kind is handled too", async () => {
      const order = makeOrder({
        amountGrossCents: 5_000,
        feesPlatformCents: 500,
        items: [
          ticketItem(ITEM_A, 2_750, 2_500),
          ticketItem(ITEM_B, 2_750, 2_500),
          negativeItem("discount", -1_000),
        ],
      });
      const ctx = makeContext({ order, feeCents: 200 });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );

      expect(out.orderTotalPaidCents).toBe(4_500);
      expect(out.items[0]!.buyerPaidCents).toBe(2_250);
      expect(out.items[0]!.refundableCents).toBe(2_150);
    });

    it("keeps tax whole on a discounted order: Σ(base) = total − tax and Σ(refundable) = total − fee", async () => {
      const order = makeOrder({
        taxAmountCents: 800,
        items: [
          ticketItem(ITEM_A, 3_300, 3_000),
          ticketItem(ITEM_B, 3_300, 3_000),
          ticketItem(ITEM_C, 3_300, 3_000),
          negativeItem("platform_credit", -1_000),
        ],
      });
      const ctx = makeContext({ order, feeCents: 341 });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
        },
      );

      // 9,900 − 1,000 + 800 tax = 9,700 charged.
      expect(out.orderTotalPaidCents).toBe(9_700);
      expect(out.items.reduce((sum, i) => sum + i.buyerPaidCents, 0)).toBe(
        9_700 - 800,
      );
      expect(out.items.reduce((sum, i) => sum + i.taxShareCents, 0)).toBe(800);
      expect(out.items.reduce((sum, i) => sum + i.stripeFeeShareCents, 0)).toBe(
        341,
      );
      expect(out.totalRefundableCents).toBe(9_700 - 341);
    });

    it("REGRESSION GUARD: an UNdiscounted order's numbers do not move", async () => {
      // Same fixture the pre-fix suite used: 3 × 3,300 = 9,900 with no
      // negative line, tax 800, fee 341. With no discount the base collapses
      // back to `computeItemBuyerPaid` exactly, so every figure below is the
      // one this quote returned before `allocateRefundItemBases` existed.
      const order = makeOrder({ taxAmountCents: 800 });
      const ctx = makeContext({ order, feeCents: 341 });

      const out = await quoteItemRefund(
        { repos: ctx.repos, payments: ctx.payments },
        {
          actorHumanId: ACTOR_ID,
          orderId: ORDER_ID,
          orderItemIds: [ITEM_A, ITEM_B, ITEM_C],
        },
      );

      expect(out.orderTotalPaidCents).toBe(10_700);
      expect(out.items.map((i) => i.buyerPaidCents)).toEqual([
        3_300, 3_300, 3_300,
      ]);
      expect(out.items.map((i) => i.taxShareCents)).toEqual([267, 267, 266]);
      expect(out.items.map((i) => i.stripeFeeShareCents)).toEqual([
        114, 114, 113,
      ]);
      expect(out.items.map((i) => i.refundableCents)).toEqual([
        3_453, 3_453, 3_453,
      ]);
      expect(out.totalRefundableCents).toBe(10_700 - 341);
    });
  });

  // ── Resale orders (audit #7) ──────────────────────────────────────────────

  it("refuses the item path on a RESALE order (RESALE_ORDER_USE_FULL_REFUND) for buyer and org", async () => {
    for (const skip of [false, true]) {
      const ctx = makeContext({ order: makeOrder({ source: "RESALE" }) });
      await expect(
        quoteItemRefund(
          { repos: ctx.repos, payments: ctx.payments, _skipBuyerCheck: skip },
          { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
        ),
      ).rejects.toMatchObject({ code: "RESALE_ORDER_USE_FULL_REFUND" });
      expect(
        ctx.payments.getProcessingFeeForPaymentIntent,
      ).not.toHaveBeenCalled();
    }
  });
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".
describe("quoteItemRefund — a ticket that cost $0", () => {
  const DISCOUNT_ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  /**
   * The shape of dev order f425308e: a $125 VIP a 100% VIP code freed (ITEM_A)
   * beside a paid $50 GA (ITEM_B). Charged 5245 + 444 tax = 5689; the
   * processor kept 195.
   */
  function freedOrder(): OrderRecord {
    const template = makeOrder().items[0]!;
    return makeOrder({
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items: [
        {
          ...template,
          id: DISCOUNT_ITEM,
          kind: "discount",
          ticketTypeId: null,
          unitPriceCents: -12_500,
          amountCents: -12_500,
          meta: {},
        },
        {
          ...template,
          id: ITEM_A,
          ticketTypeId: "tt-vip",
          unitPriceCents: 12_500,
          amountCents: 12_500,
          meta: {
            buyerTotalCents: 12_500,
            discountedToZero: true,
            platformFeePerTicketCents: 0,
            processorFeeShareCents: 0,
          },
        },
        {
          ...template,
          id: ITEM_B,
          ticketTypeId: "tt-ga",
          unitPriceCents: 5_000,
          amountCents: 5_000,
          meta: {
            buyerTotalCents: 5_245,
            platformFeePerTicketCents: 50,
            processorFeeShareCents: 195,
          },
        },
      ],
    });
  }

  it("quotes $0 on every term for the ticket a code made free", async () => {
    const ctx = makeContext({ order: freedOrder(), feeCents: 195 });

    const quote = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
    );

    // Pre-fix: { base 3695, tax 313, fee 137, refundable 3871 }.
    expect(quote.items[0]).toMatchObject({
      orderItemId: ITEM_A,
      buyerPaidCents: 0,
      taxShareCents: 0,
      stripeFeeShareCents: 0,
      refundableCents: 0,
      isEligible: true,
    });
    expect(quote.totalRefundableCents).toBe(0);
    expect(quote.orderTotalPaidCents).toBe(5_689);
  });

  it("quotes the whole charge less the processing fee for the paid ticket", async () => {
    const ctx = makeContext({ order: freedOrder(), feeCents: 195 });

    const quote = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID, orderItemIds: [ITEM_B] },
    );

    // Pre-fix: { base 1550, tax 131, fee 58, refundable 1623 }.
    expect(quote.items[0]).toMatchObject({
      orderItemId: ITEM_B,
      buyerPaidCents: 5_245,
      taxShareCents: 444,
      stripeFeeShareCents: 195,
      refundableCents: 5_494,
    });
    expect(quote.totalRefundableCents).toBe(5_494);
  });

  it("both tickets together quote exactly charge − processing fee", async () => {
    const ctx = makeContext({ order: freedOrder(), feeCents: 195 });

    const quote = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    expect(quote.items.map((i) => i.refundableCents)).toEqual([0, 5_494]);
    expect(quote.totalRefundableCents).toBe(5_689 - 195);
  });

  it("a ticket PRICED at $0 in a paid order quotes $0 (no mark needed)", async () => {
    const order = freedOrder();
    // No discount line; ITEM_A is a free tier beside the paid GA.
    order.items = order.items
      .filter((item) => item.id !== DISCOUNT_ITEM)
      .map((item) =>
        item.id === ITEM_A
          ? {
              ...item,
              unitPriceCents: 0,
              amountCents: 0,
              meta: { buyerTotalCents: 0, platformFeePerTicketCents: 0 },
            }
          : item,
      );
    const ctx = makeContext({ order, feeCents: 195 });

    const quote = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    expect(quote.items[0]).toMatchObject({
      buyerPaidCents: 0,
      taxShareCents: 0,
      stripeFeeShareCents: 0,
      refundableCents: 0,
    });
    expect(quote.items[1]!.refundableCents).toBe(5_494);
  });

  it("a ticket discounted to an amount above $0 is quoted as before", async () => {
    // 50% off VIP: no ticket is marked, so the buyer-paid weighting stands.
    const order = freedOrder();
    order.items = order.items.map((item) => {
      if (item.id === DISCOUNT_ITEM) {
        return { ...item, unitPriceCents: -6_250, amountCents: -6_250 };
      }
      if (item.id === ITEM_A) {
        return { ...item, meta: { buyerTotalCents: 12_750 } };
      }
      return item;
    });
    order.taxAmountCents = 0;
    const ctx = makeContext({ order, feeCents: 0 });

    const quote = await quoteItemRefund(
      { repos: ctx.repos, payments: ctx.payments },
      {
        actorHumanId: ACTOR_ID,
        orderId: ORDER_ID,
        orderItemIds: [ITEM_A, ITEM_B],
      },
    );

    // 12750 + 5245 − 6250 = 11745, split 12750 : 5245 (sticker share).
    expect(quote.items.map((i) => i.buyerPaidCents)).toEqual([8_322, 3_423]);
  });
});
