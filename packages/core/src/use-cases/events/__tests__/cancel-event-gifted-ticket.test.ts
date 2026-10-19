import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

// Decision record: docs/decisions/cancellation-refunds-gifted-tickets-to-the-payer.md
//
// On cancellation a GIFTED ticket (transferred, no resale order behind it) is
// refunded to the order that paid for it, on the same per-item allocation as
// its siblings. A RESALE-transferred parent keeps the gate on its resale
// order's refund outcome. Money audit 2026-09-08 #18.
//
// Gift vs resale is decided from the RESALE side (the resale item's
// `resaleOriginalOrderItemId` meta), never from the parent's `resaleListingId`
// — `finalizeResalePurchase` clears that column on the parent. When that
// linkage cannot be established the cancellation FAILS CLOSED for the affected
// PRIMARY order rather than refunding it short and stamping it REFUNDED.

const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const ORG_ID = "40000000-0000-4000-8000-000000000002";
const ACTOR_ID = "40000000-0000-4000-8000-000000000003";
const BUYER_ID = "40000000-0000-4000-8000-000000000004";
const RESALE_BUYER_ID = "40000000-0000-4000-8000-000000000005";
const PRIMARY_ORDER_ID = "40000000-0000-4000-8000-000000000006";
const ACTIVE_ITEM_ID = "40000000-0000-4000-8000-000000000007";
const GIFTED_ITEM_ID = "40000000-0000-4000-8000-000000000008";
const RESALE_PARENT_ITEM_ID = "40000000-0000-4000-8000-000000000009";
const RESALE_ORDER_ID = "40000000-0000-4000-8000-00000000000a";
const RESALE_ITEM_ID = "40000000-0000-4000-8000-00000000000b";
const LISTING_ID = "40000000-0000-4000-8000-00000000000c";
const ACTIVE_TICKET_ID = "40000000-0000-4000-8000-00000000000d";
const GIFTED_TICKET_ID = "40000000-0000-4000-8000-00000000000e";
const RESALE_TICKET_ID = "40000000-0000-4000-8000-00000000000f";
const SETTLEMENT_LINE_ID = "40000000-0000-4000-8000-000000000010";
const SETTLEMENT_ID = "40000000-0000-4000-8000-000000000011";
/** A second, unrelated PRIMARY order on the same event (other buyer). */
const OTHER_BUYER_ID = "40000000-0000-4000-8000-000000000012";
const OTHER_ORDER_ID = "40000000-0000-4000-8000-000000000013";
const OTHER_ACTIVE_ITEM_ID = "40000000-0000-4000-8000-000000000014";
const OTHER_GIFTED_ITEM_ID = "40000000-0000-4000-8000-000000000015";
/** An order the summary scan lists but `getById` cannot load. */
const UNLOADABLE_ORDER_ID = "40000000-0000-4000-8000-000000000016";
const STRIPE_TRANSFER_ID = "tr_gifted_paid_out";
const PRIMARY_PI = "pi_primary_gift";
const RESALE_PI = "pi_resale_gift";
const OTHER_PI = "pi_other_gift";
const UNLOADABLE_PI = "pi_unloadable_gift";
const CLIENT_KEY = "cancel-gifted-key-12345";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Gifted Ticket Event",
    slug: "gifted-ticket-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

type Item = OrderRecord["items"][number];

function makeItem(overrides: Partial<Item> & { id: string; orderId: string }): Item {
  return {
    kind: "ticket",
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: 5000,
    amountCents: 5000,
    meta: { buyerTotalCents: 5500 },
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    resaleListingId: null,
    resaleFaceValueCents: null,
    resaleProcessingPassThroughCents: 0,
    resaleProcessingFeeConfigRef: null,
    resaleSaleCutoffAt: null,
    resalePayoutReleaseAt: null,
    resalePayoutStatus: null,
    resalePayoutHeldAt: null,
    resalePayoutHoldReason: null,
    resalePayoutNoticeSentAt: null,
    resalePayoutReminderSentAt: null,
    resalePayoutFinalNoticeSentAt: null,
    status: "active",
    ...overrides,
  } as Item;
}

function makeOrder(
  overrides: Partial<OrderRecord> & { id: string; items: Item[] },
): OrderRecord {
  return {
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: overrides.items.reduce((s, i) => s + i.amountCents, 0),
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: PRIMARY_PI,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    ...overrides,
  } as OrderRecord;
}

/** A gift: `transferred`, and NO resale order points at it. */
function giftedItem(orderId: string, extra: Partial<Item> = {}): Item {
  return makeItem({
    id: GIFTED_ITEM_ID,
    orderId,
    status: "transferred",
    transferredAt: NOW,
    ...extra,
  });
}

/**
 * A resale parent, as `finalizeResalePurchase` leaves it: `transferred` AND
 * `resaleListingId` CLEARED. Only the RESALE order's item still points here.
 */
function resaleParentItem(orderId: string): Item {
  return makeItem({
    id: RESALE_PARENT_ITEM_ID,
    orderId,
    status: "transferred",
    transferredAt: NOW,
    resaleListingId: null,
  });
}

function makeResaleOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return makeOrder({
    id: RESALE_ORDER_ID,
    buyerHumanId: RESALE_BUYER_ID,
    stripePaymentIntentId: RESALE_PI,
    source: "RESALE",
    parentOrderId: PRIMARY_ORDER_ID,
    items: [
      makeItem({
        id: RESALE_ITEM_ID,
        orderId: RESALE_ORDER_ID,
        resaleListingId: LISTING_ID,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: LISTING_ID,
          resaleOriginalOrderId: PRIMARY_ORDER_ID,
          resaleOriginalOrderItemId: RESALE_PARENT_ITEM_ID,
        },
      }),
    ],
    ...overrides,
  });
}

/** The other buyer's PRIMARY order: one active item, optionally one gift. */
function makeOtherOrder(opts: { gifted: boolean }): OrderRecord {
  return makeOrder({
    id: OTHER_ORDER_ID,
    buyerHumanId: OTHER_BUYER_ID,
    stripePaymentIntentId: OTHER_PI,
    items: [
      makeItem({ id: OTHER_ACTIVE_ITEM_ID, orderId: OTHER_ORDER_ID }),
      ...(opts.gifted
        ? [giftedItem(OTHER_ORDER_ID, { id: OTHER_GIFTED_ITEM_ID })]
        : []),
    ],
  });
}

interface HarnessOptions {
  orders: OrderRecord[];
  /** PIs whose Stripe refund throws. */
  failRefundFor?: string[];
  /** Order ids the summary scan lists but `getById` throws for. */
  failLoadFor?: string[];
  /** Tickets returned for the PRIMARY order (voided by markOrderTicketsRefunded). */
  primaryTickets?: Array<{ id: string; orderItemId: string }>;
  /** Wire the settlement chain so `paidOutAt` items resolve to a transfer. */
  paidOutItemId?: string;
}

function makeHarness(opts: HarnessOptions) {
  const event = makeEvent();
  const byId = new Map(opts.orders.map((o) => [o.id, o]));
  const failRefundFor = new Set(opts.failRefundFor ?? []);
  const failLoadFor = new Set(opts.failLoadFor ?? []);
  const primaryTickets = opts.primaryTickets ?? [];

  const summaries = [
    ...opts.orders.map((o) => ({
      id: o.id,
      stripePaymentIntentId: o.stripePaymentIntentId,
      amountGrossCents: o.amountGrossCents,
      feesPlatformCents: 0,
    })),
    ...[...failLoadFor].map((id) => ({
      id,
      stripePaymentIntentId: UNLOADABLE_PI,
      amountGrossCents: 5000,
      feesPlatformCents: 0,
    })),
  ];

  const ordersRepo = {
    listTaxLinesByOrderIds: vi.fn(async () => new Map()),
    listAll: vi.fn(async (input: { statuses?: readonly string[] }) => {
      // Phase 2's PENDING-resale scan: nothing stranded in these fixtures.
      if (input.statuses?.includes("PENDING")) {
        return { items: [], total: 0 };
      }
      return { items: summaries, total: summaries.length };
    }),
    getById: vi.fn(async (orderId: string) => {
      // A TRANSIENT read failure: the load in `processRefunds` throws, the
      // later in-tx read for the pending-refund set (pre-existing) finds
      // nothing and moves on.
      if (failLoadFor.has(orderId)) {
        failLoadFor.delete(orderId);
        throw new Error(`db_read_failed:${orderId}`);
      }
      return byId.get(orderId) ?? null;
    }),
    markRefunded: vi.fn(async () => undefined),
  };
  const orderItemsRepo = {
    listByOrderId: vi.fn(
      async (orderId: string) => byId.get(orderId)?.items ?? [],
    ),
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
  };
  const ticketsRepo = {
    listByOrderId: vi.fn(async (orderId: string) =>
      orderId === PRIMARY_ORDER_ID
        ? primaryTickets.map((t) => ({
            id: t.id,
            status: "VALID",
            scannedAt: null,
            orderItemId: t.orderItemId,
          }))
        : [],
    ),
    getByOrderItemId: vi.fn(async (orderItemId: string) =>
      orderItemId === RESALE_ITEM_ID
        ? {
            id: RESALE_TICKET_ID,
            ownerHumanId: RESALE_BUYER_ID,
            orderId: RESALE_ORDER_ID,
            orderItemId: RESALE_ITEM_ID,
          }
        : null,
    ),
    // The resale unwind locks the ticket row before it moves anything.
    getByIdForUpdate: vi.fn(async (ticketId: string) =>
      ticketId === RESALE_TICKET_ID
        ? {
            id: RESALE_TICKET_ID,
            ownerHumanId: RESALE_BUYER_ID,
            orderId: RESALE_ORDER_ID,
            orderItemId: RESALE_ITEM_ID,
          }
        : null,
    ),
    setStatus: vi.fn(async () => undefined),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => undefined),
  };
  const resaleListingsRepo = {
    cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    getById: vi.fn(async () => ({
      id: LISTING_ID,
      sellerHumanId: BUYER_ID,
      status: "SOLD",
      expiresAt: null,
      saleCutoffAt: null,
      ticketId: RESALE_TICKET_ID,
      buyerOrderId: RESALE_ORDER_ID,
    })),
    // No live listing of the refunded buyer's own.
    getByTicketId: vi.fn(async () => null),
    unwindSale: vi.fn(async () => undefined),
  };
  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => event),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER" as const,
      })),
    },
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    resaleListings: resaleListingsRepo,
    payeeLedger: payeeLedger.repo,
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: { create: vi.fn(async () => undefined) },
    audit: { log: vi.fn(async () => undefined) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    settlements: {
      getByIds: vi.fn(async () => [
        {
          id: SETTLEMENT_ID,
          payeeId: "payee-org",
          stripeTransferId: STRIPE_TRANSFER_ID,
        },
      ]),
    },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
    },
    orderItemSettlementLines: {
      listByOrderItemIds: vi.fn(async () =>
        opts.paidOutItemId
          ? [
              {
                orderItemId: opts.paidOutItemId,
                settlementLineId: SETTLEMENT_LINE_ID,
                amountCents: 4000,
              },
            ]
          : [],
      ),
    },
    settlementLines: {
      getByIds: vi.fn(async () => [
        { id: SETTLEMENT_LINE_ID, settlementId: SETTLEMENT_ID },
      ]),
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const payments = {
    refundPaymentIntent: vi.fn(
      async (input: { paymentIntentId: string; amountCents: number }) => {
        if (failRefundFor.has(input.paymentIntentId)) {
          throw new Error(`stripe_refund_failed:${input.paymentIntentId}`);
        }
        return {
          refundId: `re_${input.paymentIntentId}`,
          status: "succeeded" as const,
        };
      },
    ),
    reverseTransfer: vi.fn(async () => ({ reversalId: "trr_gifted_123" })),
    // Stubbed to 0 so the pinned cents hold on either allocation rule.
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
  };

  const reportError = vi.fn();
  // `cancelEvent` logs through `logger.child({ useCase })`; hold on to that
  // child so the log pins below can see it.
  const scopedLogger = createTestLogger();
  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(scopedLogger);

  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: payments as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger,
    reportError,
  };

  const run = () =>
    cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

  const refundCalls = () =>
    payments.refundPaymentIntent.mock.calls
      .map(([input]) => ({
        paymentIntentId: input.paymentIntentId,
        amountCents: input.amountCents,
      }))
      .sort((a, b) => a.paymentIntentId.localeCompare(b.paymentIntentId));

  const refundedItemIds = () =>
    orderItemsRepo.updateStatus.mock.calls
      .filter(([, status]) => status === "refunded")
      .map(([id]) => id as string)
      .sort();

  // Only the gift-detection reports. The refund-debit writer reports on its
  // own (`step: "refundDebit"`) when the fake ledger has no credits seeded;
  // that is harness noise, not this ruling.
  const giftDetectionReports = () =>
    reportError.mock.calls.filter(
      ([, context]) =>
        (context as { tags?: { stage?: string } } | undefined)?.tags?.stage ===
        "gift_detection",
    );

  return {
    run,
    refundCalls,
    refundedItemIds,
    giftDetectionReports,
    payments,
    reportError,
    scopedLogger,
    ordersRepo,
    orderItemsRepo,
    ticketsRepo,
    resaleListingsRepo,
  };
}

describe("cancelEvent — gifted tickets are refunded to the payer", () => {
  it("(a) refunds a gifted item alongside its active sibling, on the same per-item allocation", async () => {
    // 2 × 5500 buyer-paid + 200 tax split 100/100 → 5600 + 5600.
    // Before the ruling this refunded ONE item (5600) and voided both passes.
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          taxAmountCents: 200,
          items: [
            makeItem({ id: ACTIVE_ITEM_ID, orderId: PRIMARY_ORDER_ID }),
            giftedItem(PRIMARY_ORDER_ID),
          ],
        }),
      ],
      primaryTickets: [
        { id: ACTIVE_TICKET_ID, orderItemId: ACTIVE_ITEM_ID },
        { id: GIFTED_TICKET_ID, orderItemId: GIFTED_ITEM_ID },
      ],
    });

    const result = await h.run();

    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(0);
    // Money direction: the PRIMARY order's PaymentIntent — the payer.
    expect(h.refundCalls()).toEqual([
      { paymentIntentId: PRIMARY_PI, amountCents: 11_200 },
    ]);
    expect(h.refundedItemIds()).toEqual(
      [ACTIVE_ITEM_ID, GIFTED_ITEM_ID].sort(),
    );
    expect(h.ticketsRepo.setStatus).toHaveBeenCalledWith(
      ACTIVE_TICKET_ID,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(h.ticketsRepo.setStatus).toHaveBeenCalledWith(
      GIFTED_TICKET_ID,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(h.ordersRepo.markRefunded).toHaveBeenCalledWith(PRIMARY_ORDER_ID);
    expect(h.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(h.giftDetectionReports()).toEqual([]);
  });

  it("(b) a resale parent whose resale refund SUCCEEDED is refunded exactly as before, next to a gifted sibling", async () => {
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          items: [resaleParentItem(PRIMARY_ORDER_ID), giftedItem(PRIMARY_ORDER_ID)],
        }),
        makeResaleOrder(),
      ],
      primaryTickets: [{ id: GIFTED_TICKET_ID, orderItemId: GIFTED_ITEM_ID }],
    });

    const result = await h.run();

    expect(result.refundedOrderCount).toBe(2);
    expect(result.failedRefundCount).toBe(0);
    // Resale buyer: 5500 on the resale PI. Payer: parent 5500 + gift 5500.
    expect(h.refundCalls()).toEqual([
      { paymentIntentId: PRIMARY_PI, amountCents: 11_000 },
      { paymentIntentId: RESALE_PI, amountCents: 5_500 },
    ]);
    expect(h.refundedItemIds()).toEqual(
      [RESALE_ITEM_ID, RESALE_PARENT_ITEM_ID, GIFTED_ITEM_ID].sort(),
    );
    expect(h.resaleListingsRepo.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      RESALE_ORDER_ID,
      "CANCELLED",
    );
  });

  it("(c) a resale parent whose resale refund FAILED stays skipped — the resale buyer still holds a paid claim", async () => {
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          items: [
            makeItem({ id: ACTIVE_ITEM_ID, orderId: PRIMARY_ORDER_ID }),
            resaleParentItem(PRIMARY_ORDER_ID),
          ],
        }),
        makeResaleOrder(),
      ],
      failRefundFor: [RESALE_PI],
      primaryTickets: [{ id: ACTIVE_TICKET_ID, orderItemId: ACTIVE_ITEM_ID }],
    });

    const result = await h.run();

    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(1);
    // Only the active item; the parent is NOT a gift, so 5500 not 11000.
    expect(h.refundCalls()).toEqual([
      { paymentIntentId: PRIMARY_PI, amountCents: 5_500 },
      { paymentIntentId: RESALE_PI, amountCents: 5_500 },
    ]);
    expect(h.refundedItemIds()).toEqual([ACTIVE_ITEM_ID]);
    expect(h.resaleListingsRepo.unwindSale).not.toHaveBeenCalled();
    expect(h.giftDetectionReports()).toEqual([]);
  });

  it("(d) a gifted item that was already paid out goes through transfer reversal like any other item", async () => {
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          items: [
            makeItem({ id: ACTIVE_ITEM_ID, orderId: PRIMARY_ORDER_ID }),
            giftedItem(PRIMARY_ORDER_ID, { paidOutAt: NOW }),
          ],
        }),
      ],
      paidOutItemId: GIFTED_ITEM_ID,
      primaryTickets: [
        { id: ACTIVE_TICKET_ID, orderItemId: ACTIVE_ITEM_ID },
        { id: GIFTED_TICKET_ID, orderItemId: GIFTED_ITEM_ID },
      ],
    });

    const result = await h.run();

    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(0);
    expect(h.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(h.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: STRIPE_TRANSFER_ID,
        amountCents: 5_500,
        idempotencyKey: `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${PRIMARY_ORDER_ID}:reverse-transfer:${STRIPE_TRANSFER_ID}`,
      }),
    );
    expect(h.refundCalls()).toEqual([
      { paymentIntentId: PRIMARY_PI, amountCents: 11_000 },
    ]);
    expect(h.refundedItemIds()).toEqual(
      [ACTIVE_ITEM_ID, GIFTED_ITEM_ID].sort(),
    );
  });

  it("(e) a RESALE order whose buyer gifted the ticket onward is left exactly as before: skipped, not refunded, not unwound", async () => {
    // Today's RESALE branch passes no transferred-item allowance at all, so
    // a resale order whose only item is `transferred` plans to 0 cents and is
    // SKIPPED (not failed, not refunded). The ruling does not touch this
    // branch; pin it so a change here is deliberate.
    const h = makeHarness({
      orders: [
        makeResaleOrder({
          items: [
            makeItem({
              id: RESALE_ITEM_ID,
              orderId: RESALE_ORDER_ID,
              resaleListingId: LISTING_ID,
              status: "transferred",
              transferredAt: NOW,
              meta: {
                buyerTotalCents: 5500,
                resaleListingId: LISTING_ID,
                resaleOriginalOrderId: PRIMARY_ORDER_ID,
                resaleOriginalOrderItemId: RESALE_PARENT_ITEM_ID,
              },
            }),
          ],
        }),
      ],
    });

    const result = await h.run();

    expect(result.refundedOrderCount).toBe(0);
    expect(result.failedRefundCount).toBe(0);
    expect(h.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(h.ordersRepo.markRefunded).not.toHaveBeenCalled();
    expect(h.resaleListingsRepo.unwindSale).not.toHaveBeenCalled();
    expect(h.orderItemsRepo.updateStatus).not.toHaveBeenCalled();
    expect(h.giftDetectionReports()).toEqual([]);
  });
});

describe("cancelEvent — gift detection fails CLOSED when the resale linkage is incomplete", () => {
  it("(f) a RESALE item with no parent link narrows the failure to ITS parent order; an unrelated payer's gift is still refunded", async () => {
    // `createResaleCheckout` writes `resaleOriginalOrderItemId` conditionally,
    // so a resale row can exist without it. Its parent's `transferred` item
    // then cannot be told from a gift — and the resale buyer still holds a
    // paid claim (their refund FAILED here). Refunding the parent order short
    // and stamping it REFUNDED would strand the payer forever (the cancel
    // never re-runs; no other path refunds a transferred item), so the parent
    // order is FAILED instead. The resale order names its parent
    // (`parentOrderId`), so only that parent is affected: the other buyer's
    // gift is still detected and refunded.
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          items: [
            makeItem({ id: ACTIVE_ITEM_ID, orderId: PRIMARY_ORDER_ID }),
            resaleParentItem(PRIMARY_ORDER_ID),
          ],
        }),
        makeResaleOrder({
          items: [
            makeItem({
              id: RESALE_ITEM_ID,
              orderId: RESALE_ORDER_ID,
              resaleListingId: LISTING_ID,
              // No resaleOriginalOrderItemId / resaleOriginalOrderId.
              meta: { buyerTotalCents: 5500, resaleListingId: LISTING_ID },
            }),
          ],
        }),
        makeOtherOrder({ gifted: true }),
      ],
      failRefundFor: [RESALE_PI],
      primaryTickets: [{ id: ACTIVE_TICKET_ID, orderItemId: ACTIVE_ITEM_ID }],
    });

    const result = await h.run();

    // Resale refund failed (1) + parent order failed closed (1).
    expect(result.failedRefundCount).toBe(2);
    expect(result.refundedOrderCount).toBe(1);
    // The parent's PI is never touched; the other buyer gets 5500 + 5500.
    expect(h.refundCalls()).toEqual([
      { paymentIntentId: OTHER_PI, amountCents: 11_000 },
      { paymentIntentId: RESALE_PI, amountCents: 5_500 },
    ]);
    expect(h.refundedItemIds()).toEqual(
      [OTHER_ACTIVE_ITEM_ID, OTHER_GIFTED_ITEM_ID].sort(),
    );
    expect(h.ordersRepo.markRefunded).not.toHaveBeenCalledWith(
      PRIMARY_ORDER_ID,
    );
    expect(h.ordersRepo.markRefunded).toHaveBeenCalledWith(OTHER_ORDER_ID);
    expect(h.resaleListingsRepo.unwindSale).not.toHaveBeenCalled();

    expect(h.giftDetectionReports()).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "cancelEvent",
          stage: "gift_detection",
        }),
        extra: expect.objectContaining({
          orderId: PRIMARY_ORDER_ID,
          unlinkedResaleOrderIds: [RESALE_ORDER_ID],
          unloadedOrderIds: [],
        }),
      }),
    );
  });

  it("(g) an order that fails to LOAD disables gift detection for the whole event: gifted orders fail, plain orders still refund", async () => {
    // The unloadable order might have been the RESALE order behind ANY
    // transferred item, so no transferred item can be called a gift. An order
    // with a transferred item of unknown origin is FAILED (stays SUCCEEDED,
    // buyer in the pending-refund set, surfaced via failedRefundCount); an
    // order with no transferred item is refunded exactly as before.
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          items: [
            makeItem({ id: ACTIVE_ITEM_ID, orderId: PRIMARY_ORDER_ID }),
            giftedItem(PRIMARY_ORDER_ID),
          ],
        }),
        makeOtherOrder({ gifted: false }),
      ],
      failLoadFor: [UNLOADABLE_ORDER_ID],
      primaryTickets: [
        { id: ACTIVE_TICKET_ID, orderItemId: ACTIVE_ITEM_ID },
        { id: GIFTED_TICKET_ID, orderItemId: GIFTED_ITEM_ID },
      ],
    });

    const result = await h.run();

    // Unloadable order (1) + gifted order failed closed (1).
    expect(result.failedRefundCount).toBe(2);
    expect(result.refundedOrderCount).toBe(1);
    expect(h.refundCalls()).toEqual([
      { paymentIntentId: OTHER_PI, amountCents: 5_500 },
    ]);
    expect(h.refundedItemIds()).toEqual([OTHER_ACTIVE_ITEM_ID]);
    expect(h.ordersRepo.markRefunded).not.toHaveBeenCalledWith(
      PRIMARY_ORDER_ID,
    );
    // The gifted pass is NOT voided: its order was not refunded.
    expect(h.ticketsRepo.setStatus).not.toHaveBeenCalled();

    expect(h.giftDetectionReports()).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "cancelEvent",
          stage: "gift_detection",
        }),
        extra: expect.objectContaining({
          orderId: PRIMARY_ORDER_ID,
          unloadedOrderIds: [UNLOADABLE_ORDER_ID],
          unlinkedResaleOrderIds: [],
        }),
      }),
    );
    expect(h.scopedLogger.error).toHaveBeenCalledWith(
      "cancel_event_gift_detection_disabled",
      expect.objectContaining({ orderId: PRIMARY_ORDER_ID }),
    );
  });

  it("(h) a throwing reporter never changes the outcome", async () => {
    const h = makeHarness({
      orders: [
        makeOrder({
          id: PRIMARY_ORDER_ID,
          items: [
            makeItem({ id: ACTIVE_ITEM_ID, orderId: PRIMARY_ORDER_ID }),
            giftedItem(PRIMARY_ORDER_ID),
          ],
        }),
      ],
      failLoadFor: [UNLOADABLE_ORDER_ID],
    });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await h.run();

    expect(result.status).toBe("CANCELLED");
    expect(result.failedRefundCount).toBe(2);
    expect(result.refundedOrderCount).toBe(0);
    expect(h.payments.refundPaymentIntent).not.toHaveBeenCalled();
  });
});
