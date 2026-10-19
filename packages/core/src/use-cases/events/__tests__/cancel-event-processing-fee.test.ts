import { describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";
import {
  refundFullOrder,
  type RefundFullOrderDeps,
} from "../../orders/refund-full-order";
import {
  refundOrderItems,
  type RefundOrderItemsDeps,
} from "../../orders/refund-order-items";

/**
 * The cancellation refund rule: a refund returns everything the buyer paid
 * (ticket price + platform fee + tax) EXCEPT the Stripe processing fee, which
 * Stripe keeps on a refund. `refundFullOrder` is the source of truth for the
 * rule; until 2026-09 `cancelEvent` refunded the gross (fee included) and was
 * the one path that disagreed. These tests pin:
 *
 *  (a) a paid order is refunded NET of the fee, read off Stripe per order;
 *  (b) free / comp orders and nothing-left-to-refund orders never trigger a
 *      fee read and are left exactly as before;
 *  (c) a failed fee read is a `dependency_failed` for that order — it goes to
 *      the failed list and NO Stripe refund is issued for it;
 *  (d) PARITY — the REAL `refundFullOrder` (staff actor) and the REAL
 *      `cancelEvent`, driven through their public entry points against the
 *      same order and the same fake payments port, ask Stripe for the SAME
 *      refund cents, reverse the SAME cents for a paid-out item, and stamp
 *      the SAME per-item tax / platform-fee attribution;
 *  (e) the refund names every refunded item (`useCase: "cancelEvent"`) so
 *      the `charge.refunded` reconciler's partial arm can heal a
 *      cancellation whose marking tx died;
 *  (f) a known gap, pinned: on a discounted PART_REFUNDED order the item
 *      path (pre-discount `buyerTotalCents`) and the full-order allocator
 *      (post-discount `computeExpectedPaymentAmount`) can together exceed
 *      `orderTotal − fee`.
 */

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const STAFF_ID = "30000000-0000-4000-8000-000000000004";
const BUYER_ID = "30000000-0000-4000-8000-000000000005";
const ORDER_ID = "30000000-0000-4000-8000-000000000006";
const ITEM_A = "30000000-0000-4000-8000-00000000000a";
const ITEM_B = "30000000-0000-4000-8000-00000000000b";
const ITEM_C = "30000000-0000-4000-8000-00000000000c";
const TICKET_A = "30000000-0000-4000-8000-00000000001a";
const TICKET_B = "30000000-0000-4000-8000-00000000001b";
const TICKET_C = "30000000-0000-4000-8000-00000000001c";
const PAYMENT_INTENT_ID = "pi_cancel_fee_123";
const CLIENT_KEY = "cancel-processing-fee-key-12345";
const NOW = new Date("2026-09-15T12:00:00.000Z");

// ── The money ──────────────────────────────────────────────────────────────
// Buyer-paid per item (ticket + platform fee): 2750, 2750, 4400 = 9900.
// Order-level tax 275 → everything the buyer paid = 10175.
// Stripe's actual fee on the PaymentIntent: 325.
//
// `allocateFullRefundShares` (largest remainder, ties by item id):
//   paid shares  2827 / 2826 / 4522  (Σ 10175)
//   fee shares     90 /   90 /  145  (Σ   325)
//   net          2737 / 2736 / 4377  (Σ  9850)
const ORDER_TOTAL_PAID_CENTS = 10_175;
const STRIPE_FEE_CENTS = 325;
const EXPECTED_NET_REFUND_CENTS = ORDER_TOTAL_PAID_CENTS - STRIPE_FEE_CENTS; // 9850
const EXPECTED_NET_ITEM_C_CENTS = 4_377;
// Tax 275 by the same weights: 76.39 / 76.39 / 122.22 → 77 / 76 / 122.
// Platform fee 900 (no per-item `platformFeePerTicketCents` on the rows, so
// allocated by the same weights): 250 / 250 / 400.
const EXPECTED_STAMPS: ReadonlyArray<[string, number, number]> = [
  [ITEM_A, 77, 250],
  [ITEM_B, 76, 250],
  [ITEM_C, 122, 400],
];
const SORTED_ITEM_IDS = [ITEM_A, ITEM_B, ITEM_C].sort().join(",");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Processing Fee Test Event",
    slug: "processing-fee-test-event",
    startsAt: new Date("2026-10-01T20:00:00.000Z"),
    endsAt: new Date("2026-10-01T23:00:00.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

function makeItem(
  id: string,
  amountCents: number,
  buyerTotalCents: number,
  overrides: Partial<OrderItemRecord> = {},
): OrderItemRecord {
  return {
    id,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: "tt-ga",
    qty: 1,
    unitPriceCents: amountCents,
    amountCents,
    meta: { buyerTotalCents },
    paidOutAt: null,
    refundedAt: null,
    refundedTaxCents: null,
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
  } as OrderItemRecord;
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 9_000,
    feesPlatformCents: 900,
    taxAmountCents: 275,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    disputeStatus: null,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    paymentChannel: "WEB",
    parentOrderId: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    paymentMethodType: "card",
    items: [
      makeItem(ITEM_A, 2_500, 2_750),
      makeItem(ITEM_B, 2_500, 2_750),
      makeItem(ITEM_C, 4_000, 4_400),
    ],
    ...overrides,
  } as OrderRecord;
}

const ticketIdByItem: Record<string, string> = {
  [ITEM_A]: TICKET_A,
  [ITEM_B]: TICKET_B,
  [ITEM_C]: TICKET_C,
};

/**
 * The shared fake payments port: the SAME instance is handed to both use
 * cases in the parity test, so both read the same fee and both refunds are
 * observable on one spy.
 */
function makePayments(opts: { feeCents?: number; feeError?: Error } = {}) {
  const feeCents = opts.feeCents ?? STRIPE_FEE_CENTS;
  return {
    getProcessingFeeForPaymentIntent: vi.fn(
      async (_input: { paymentIntentId: string }) => {
        if (opts.feeError) throw opts.feeError;
        return { feeCents, currency: "usd" };
      },
    ),
    refundPaymentIntent: vi.fn(
      async (_input: {
        paymentIntentId: string;
        amountCents?: number;
        idempotencyKey?: string;
        metadata?: Record<string, string>;
      }) => ({
        refundId: "re_test",
        status: "succeeded" as const,
      }),
    ),
    reverseTransfer: vi.fn(
      async (_input: {
        transferId: string;
        amountCents?: number;
        idempotencyKey?: string;
      }) => ({ reversalId: "trr_test" }),
    ),
  };
}

type FakePayments = ReturnType<typeof makePayments>;

/**
 * One repo bag that satisfies BOTH `cancelEvent` and `refundFullOrder` for a
 * PRIMARY order (optionally with a legacy paid-out item behind the junction
 * settlement chain). Nothing is stateful except the payee ledger.
 */
function makeRepos(params: { event: EventRecord; orders: OrderRecord[] }) {
  const { event, orders } = params;
  const ordersById = new Map(orders.map((o) => [o.id, o]));
  const payeeLedger = createFakePayeeLedgerRepo();

  // The in-memory orders ARE the state: `updateStatus` / `markRefunded`
  // mutate them so a second use case run on the same harness (the
  // PART_REFUNDED case) sees what the first one committed.
  const ordersRepo = {
    listTaxLinesByOrderIds: vi.fn(async () => new Map()),
    listTaxLines: vi.fn(async () => []),
    // Honour the filters both scans pass: cancel-event asks for
    // SUCCEEDED/PART_REFUNDED, the stranded-resale phase for PENDING RESALE.
    listAll: vi.fn(
      async (input: { statuses?: string[]; source?: string }) => {
        const items = orders.filter(
          (o) =>
            (!input.statuses || input.statuses.includes(o.status)) &&
            (!input.source || input.source === o.source),
        );
        return {
          items: items.map((o) => ({
            id: o.id,
            stripePaymentIntentId: o.stripePaymentIntentId,
            amountGrossCents: o.amountGrossCents,
            feesPlatformCents: o.feesPlatformCents,
          })),
          total: items.length,
        };
      },
    ),
    getById: vi.fn(async (id: string) => ordersById.get(id) ?? null),
    // The cancellation's door cash phase: no cash sales here.
    listSucceededCashOrderIdsForEvent: vi.fn(async () => []),
    markRefunded: vi.fn(async (id: string, partialCents?: number) => {
      const order = ordersById.get(id);
      if (order) {
        order.status = partialCents === undefined ? "REFUNDED" : "PART_REFUNDED";
      }
    }),
  };
  const orderItemsRepo = {
    updateStatus: vi.fn(async (itemId: string, status: string, at: Date) => {
      const item = orders.flatMap((o) => o.items).find((i) => i.id === itemId);
      if (item && status === "refunded") {
        item.status = "refunded";
        item.refundedAt = at;
      }
    }),
    setResaleListingId: vi.fn(async () => undefined),
    recordReleasedSeats: vi.fn(async () => undefined),
    listByOrderId: vi.fn(
      async (orderId: string) => ordersById.get(orderId)?.items ?? [],
    ),
    getById: vi.fn(
      async (id: string) =>
        orders.flatMap((o) => o.items).find((i) => i.id === id) ?? null,
    ),
  };
  const ticketsRepo = {
    listByOrderId: vi.fn(async (orderId: string) =>
      (ordersById.get(orderId)?.items ?? []).map((item) => ({
        id: ticketIdByItem[item.id] ?? `ticket-${item.id}`,
        orderItemId: item.id,
        status: "VALID",
        scannedAt: null,
      })),
    ),
    getByOrderItemId: vi.fn(async (orderItemId: string) => ({
      id: ticketIdByItem[orderItemId] ?? `ticket-${orderItemId}`,
      ownerHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId,
      status: "VALID",
    })),
    setStatus: vi.fn(async () => undefined),
    clearSeatAssignments: vi.fn(async () => undefined),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => undefined),
  };
  const auditRepo = { log: vi.fn(async () => undefined) };

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
    humans: {
      getById: vi.fn(async (id: string) =>
        id === STAFF_ID || id === ACTOR_ID ? { id } : null,
      ),
      listAuthAccounts: vi.fn(async () => []),
    },
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    seats: { updateStatuses: vi.fn(async () => undefined) },
    // `quoteItemRefund` insists the event's org has a Stripe account.
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-org" })),
      getById: vi.fn(async () => ({
        id: "payee-org",
        stripeAccountId: "acct_test",
      })),
    },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    payeeLedger: payeeLedger.repo,
    splits: { getForOrder: vi.fn(async () => []) },
    promos: { releaseHoldsForOrder: vi.fn(async () => undefined) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    // Legacy (pre-cutover) transfer resolution for a paid-out item: no
    // ledger-era payout covers it, so `reverseTransfersForItems` falls
    // through to the junction chain — the arm that honours `itemAmounts`.
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
    },
    orderItemSettlementLines: {
      listByOrderItemIds: vi.fn(async (orderItemIds: string[]) =>
        orderItemIds.map((orderItemId) => ({
          id: `oisl-${orderItemId}`,
          orderItemId,
          settlementLineId: `sl-${orderItemId}`,
          amountCents: 4_400,
        })),
      ),
    },
    settlementLines: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, settlementId: `settlement-${id}` })),
      ),
    },
    settlements: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          payeeId: "payee-org",
          stripeTransferId: `tr_${id}`,
        })),
      ),
    },
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
    audit: auditRepo,
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  return {
    repos,
    payeeLedger,
    ordersRepo,
    orderItemsRepo,
    auditRepo,
    eventChangeNoticesCreate: (
      txRepos as unknown as { eventChangeNotices: { create: ReturnType<typeof vi.fn> } }
    ).eventChangeNotices.create,
  };
}

function makeCancelDeps(
  repos: Repos,
  payments: FakePayments,
  opts: { reportError?: ReturnType<typeof vi.fn> } = {},
): CancelEventDeps & {
  logger: LoggerPort;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = opts.reportError ?? vi.fn();
  return {
    repos,
    authz: denyStaffAuthz,
    payments: payments as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    reportError: reportError as unknown as CancelEventDeps["reportError"] &
      ReturnType<typeof vi.fn>,
  };
}

function makeRefundOrderItemsDeps(
  repos: Repos,
  payments: FakePayments,
): RefundOrderItemsDeps {
  return {
    repos,
    payments: payments as unknown as RefundOrderItemsDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    _skipBuyerCheck: true,
  };
}

/** `(itemId, taxCents, platformFeeCents)` of every 5-arg refunded stamp. */
function refundedStampsOf(
  updateStatus: ReturnType<typeof vi.fn>,
): Array<[string, number, number | null]> {
  return updateStatus.mock.calls
    .filter(([, status]) => status === "refunded")
    .map(([itemId, , , tax, platformFee]) => [
      itemId as string,
      tax as number,
      (platformFee ?? null) as number | null,
    ]);
}

function makeRefundFullOrderDeps(
  repos: Repos,
  payments: FakePayments,
): RefundFullOrderDeps {
  return {
    repos,
    payments: payments as unknown as RefundFullOrderDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    // The staff path (`staffRefundOrder` → `refundFullOrder`): the same
    // actor class as cancel-event — paid-out items refundable via reversal,
    // no buyer window / stop-at-payout gates.
    _skipBuyerCheck: true,
  };
}

/** The use case's scoped logger (`deps.logger.child(...)` — first child). */
function scopedLoggerOf(logger: LoggerPort): LoggerPort {
  const child = logger.child as unknown as ReturnType<typeof vi.fn>;
  return child.mock.results[0]!.value as LoggerPort;
}

async function runCancel(deps: CancelEventDeps) {
  return cancelEvent(deps, {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    clientKey: CLIENT_KEY,
  });
}

describe("cancelEvent — refunds are net of the Stripe processing fee", () => {
  it("(a) refunds buyerPaid − stripeFee, read off the order's PaymentIntent", async () => {
    const payments = makePayments();
    const { repos, eventChangeNoticesCreate, orderItemsRepo } = makeRepos({
      event: makeEvent(),
      orders: [makeOrder()],
    });
    const deps = makeCancelDeps(repos, payments);

    const result = await runCancel(deps);

    expect(result.status).toBe("CANCELLED");
    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(0);

    // The fee is READ, per order, off the actual PaymentIntent.
    expect(payments.getProcessingFeeForPaymentIntent).toHaveBeenCalledTimes(1);
    expect(payments.getProcessingFeeForPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: PAYMENT_INTENT_ID,
    });

    // The refund asked of Stripe is the NET amount — not the 10,175¢ gross.
    expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: PAYMENT_INTENT_ID,
        amountCents: EXPECTED_NET_REFUND_CENTS,
      }),
    );
    expect(EXPECTED_NET_REFUND_CENTS).toBe(9_850);

    // Every refunded ticket item is stamped with its tax and platform-fee
    // share from the same allocation the money used — never left NULL.
    expect(refundedStampsOf(orderItemsRepo.updateStatus)).toEqual(
      EXPECTED_STAMPS,
    );
    for (const [itemId, tax, platformFee] of EXPECTED_STAMPS) {
      expect(orderItemsRepo.updateStatus).toHaveBeenCalledWith(
        itemId,
        "refunded",
        NOW,
        tax,
        platformFee,
      );
    }

    // The buyer is told the net figure too (change-notice outbox payload).
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: "CANCELLED",
        payload: expect.objectContaining({
          buyers: [
            {
              humanId: BUYER_ID,
              refundedCents: EXPECTED_NET_REFUND_CENTS,
              currency: "usd",
            },
          ],
        }),
      }),
    );
  });

  it("(b) a free / comp order (no PaymentIntent) is untouched and never triggers a fee read", async () => {
    const payments = makePayments();
    const freeOrder = makeOrder({
      stripePaymentIntentId: null,
      amountGrossCents: 0,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      items: [makeItem(ITEM_A, 0, 0)],
    });
    const { repos, ordersRepo } = makeRepos({
      event: makeEvent(),
      orders: [freeOrder],
    });
    const deps = makeCancelDeps(repos, payments);

    const result = await runCancel(deps);

    // Pre-existing posture, kept: an order with no PaymentIntent is neither
    // refunded nor failed — it is not a refundable order at all.
    expect(result.status).toBe("CANCELLED");
    expect(result.refundedOrderCount).toBe(0);
    expect(result.failedRefundCount).toBe(0);
    expect(payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ordersRepo.markRefunded).not.toHaveBeenCalled();
  });

  it("(b) a paid order with nothing left to refund is skipped BEFORE the fee read", async () => {
    const payments = makePayments();
    const drained = makeOrder({
      items: [
        makeItem(ITEM_A, 2_500, 2_750, {
          status: "refunded",
          refundedAt: new Date("2026-09-10T00:00:00.000Z"),
        }),
      ],
    });
    const { repos, ordersRepo } = makeRepos({
      event: makeEvent(),
      orders: [drained],
    });
    const deps = makeCancelDeps(repos, payments);

    const result = await runCancel(deps);

    expect(result.status).toBe("CANCELLED");
    expect(result.refundedOrderCount).toBe(0);
    expect(result.failedRefundCount).toBe(0);
    expect(payments.getProcessingFeeForPaymentIntent).not.toHaveBeenCalled();
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ordersRepo.markRefunded).not.toHaveBeenCalled();
    expect(scopedLoggerOf(deps.logger).warn).toHaveBeenCalledWith(
      "cancel_event_refund_skip_zero",
      { orderId: ORDER_ID },
    );
  });

  it("(c) a failed fee read is a dependency failure for that order: failed list, no Stripe refund", async () => {
    const payments = makePayments({
      feeError: new Error("stripe balance transaction unavailable"),
    });
    const { repos, ordersRepo, auditRepo, eventChangeNoticesCreate } = makeRepos({
      event: makeEvent(),
      orders: [makeOrder()],
    });
    const deps = makeCancelDeps(repos, payments);

    const result = await runCancel(deps);

    // The cancellation itself completes (per-order failure posture)…
    expect(result.status).toBe("CANCELLED");
    expect(result.refundedOrderCount).toBe(0);
    expect(result.failedRefundCount).toBe(1);

    // …but NOTHING was refunded: no Stripe refund, no gross fallback, and
    // the order is not marked refunded. The read was retried (3 attempts)
    // before giving up — nothing retries this order later.
    expect(payments.getProcessingFeeForPaymentIntent).toHaveBeenCalledTimes(3);
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(ordersRepo.markRefunded).not.toHaveBeenCalled();

    // The stranded order is REPORTED (a swallowed failure nothing retries
    // must be visible), tagged so it is findable.
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stripe balance transaction unavailable" }),
      {
        tags: { useCase: "cancelEvent", stage: "get_processing_fee" },
        extra: expect.objectContaining({
          orderId: ORDER_ID,
          eventId: EVENT_ID,
          paymentIntentId: PAYMENT_INTENT_ID,
          attempts: 3,
        }),
      },
    );

    // The failure is the `dependency_failed` from the fee lookup.
    const scoped = scopedLoggerOf(deps.logger);
    expect(scoped.error).toHaveBeenCalledWith(
      "dependency_failed",
      expect.objectContaining({
        action: "get_processing_fee",
        orderId: ORDER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        attempts: 3,
      }),
    );
    expect(scoped.error).toHaveBeenCalledWith(
      "cancel_event_refund_failed",
      expect.objectContaining({
        orderId: ORDER_ID,
        error: expect.stringContaining("get_processing_fee"),
      }),
    );
    expect(auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "cancelled",
        data: expect.objectContaining({
          failedRefundCount: 1,
          failedOrderIds: [ORDER_ID],
        }),
      }),
    );
    // The buyer whose money is still held is captured for the drain.
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          buyers: [],
          pendingRefundBuyerHumanIds: [BUYER_ID],
        }),
      }),
    );
  });

  it("(c) a fee read that recovers on a retry refunds normally, nothing reported", async () => {
    const payments = makePayments();
    let calls = 0;
    payments.getProcessingFeeForPaymentIntent.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("stripe blip");
      return { feeCents: STRIPE_FEE_CENTS, currency: "usd" };
    });
    const { repos } = makeRepos({ event: makeEvent(), orders: [makeOrder()] });
    const deps = makeCancelDeps(repos, payments);

    const result = await runCancel(deps);

    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(0);
    expect(payments.getProcessingFeeForPaymentIntent).toHaveBeenCalledTimes(2);
    expect(payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: EXPECTED_NET_REFUND_CENTS }),
    );
    // No stranded-fee report. (The harness seeds no payee credit, so the
    // ledger writer's own `no_credits_for_order` notice fires — unrelated.)
    const feeReports = deps.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags?: { stage?: string } }).tags?.stage ===
        "get_processing_fee",
    );
    expect(feeReports).toEqual([]);
  });

  it("(c) a throwing reporter never changes the outcome", async () => {
    const payments = makePayments({ feeError: new Error("stripe down") });
    const { repos } = makeRepos({ event: makeEvent(), orders: [makeOrder()] });
    const deps = makeCancelDeps(repos, payments, {
      reportError: vi.fn(() => {
        throw new Error("sentry down too");
      }),
    });

    const result = await runCancel(deps);

    expect(result.status).toBe("CANCELLED");
    expect(result.failedRefundCount).toBe(1);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("(e) the refund names every refunded item as useCase cancelEvent, so the reconciler's partial arm can heal a dead marking tx", async () => {
    const payments = makePayments();
    const { repos } = makeRepos({ event: makeEvent(), orders: [makeOrder()] });

    await runCancel(makeCancelDeps(repos, payments));

    // A fee-withholding refund is PARTIAL to Stripe, and the partial arm
    // flips ONLY the items named here — the same stamp refundFullOrder puts
    // on its refund (`buildRefundMetadata`).
    expect(payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: EXPECTED_NET_REFUND_CENTS,
        metadata: {
          useCase: "cancelEvent",
          orderId: ORDER_ID,
          orderItemCount: "3",
          orderItemIds: SORTED_ITEM_IDS,
        },
      }),
    );
  });

  describe("(d) parity with refundFullOrder — same order, same payments port, same cents", () => {
    it("both paths ask Stripe for the identical net refund", async () => {
      const payments = makePayments();

      // Two harnesses over the SAME order fixture, ONE payments port. Each
      // use case runs its own fee lookup — nothing is handed to the
      // allocator directly.
      const cancelHarness = makeRepos({
        event: makeEvent(),
        orders: [makeOrder()],
      });
      const cancelResult = await runCancel(
        makeCancelDeps(cancelHarness.repos, payments),
      );
      expect(cancelResult.refundedOrderCount).toBe(1);
      expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
      const cancelRefund = payments.refundPaymentIntent.mock.calls[0]![0];

      const refundHarness = makeRepos({
        event: makeEvent(),
        orders: [makeOrder()],
      });
      const staffResult = await refundFullOrder(
        makeRefundFullOrderDeps(refundHarness.repos, payments),
        { actorHumanId: STAFF_ID, orderId: ORDER_ID },
      );
      expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(2);
      const staffRefund = payments.refundPaymentIntent.mock.calls[1]![0];

      // Both read the fee off the same PaymentIntent…
      expect(payments.getProcessingFeeForPaymentIntent).toHaveBeenCalledTimes(2);
      for (const call of payments.getProcessingFeeForPaymentIntent.mock.calls) {
        expect(call[0]).toEqual({ paymentIntentId: PAYMENT_INTENT_ID });
      }

      // …and move the SAME cents.
      expect(cancelRefund.amountCents).toBe(staffRefund.amountCents);
      expect(cancelRefund.amountCents).toBe(EXPECTED_NET_REFUND_CENTS);
      expect(staffResult.refundedCents).toBe(EXPECTED_NET_REFUND_CENTS);
      expect(staffResult.amountPaidCents).toBe(ORDER_TOTAL_PAID_CENTS);
      expect(staffResult.stripeFeeCents).toBe(STRIPE_FEE_CENTS);

      // …and stamp the SAME per-item tax / platform-fee attribution.
      const cancelStamps = refundedStampsOf(
        cancelHarness.orderItemsRepo.updateStatus,
      );
      const staffStamps = refundedStampsOf(
        refundHarness.orderItemsRepo.updateStatus,
      );
      expect(cancelStamps).toEqual(EXPECTED_STAMPS);
      expect(staffStamps).toEqual(cancelStamps);
    });

    it("both paths reverse the identical net cents for a legacy paid-out item", async () => {
      const payments = makePayments();
      const paidOut = new Date("2026-09-05T00:00:00.000Z");
      const orderWithPaidOutItem = () =>
        makeOrder({
          items: [
            makeItem(ITEM_A, 2_500, 2_750),
            makeItem(ITEM_B, 2_500, 2_750),
            makeItem(ITEM_C, 4_000, 4_400, { paidOutAt: paidOut }),
          ],
        });
      const seedCredit = async (h: ReturnType<typeof makeRepos>) =>
        h.payeeLedger.seedCredit({
          orderId: ORDER_ID,
          payeeId: "payee-org",
          amountCents: 9_000,
          items: { [ITEM_A]: 2_500, [ITEM_B]: 2_500, [ITEM_C]: 4_000 },
        });

      const cancelHarness = makeRepos({
        event: makeEvent(),
        orders: [orderWithPaidOutItem()],
      });
      await seedCredit(cancelHarness);
      const cancelResult = await runCancel(
        makeCancelDeps(cancelHarness.repos, payments),
      );
      expect(cancelResult.refundedOrderCount).toBe(1);
      expect(cancelResult.failedRefundCount).toBe(0);
      expect(payments.reverseTransfer).toHaveBeenCalledTimes(1);
      const cancelReversal = payments.reverseTransfer.mock.calls[0]![0];

      const refundHarness = makeRepos({
        event: makeEvent(),
        orders: [orderWithPaidOutItem()],
      });
      await seedCredit(refundHarness);
      const staffResult = await refundFullOrder(
        makeRefundFullOrderDeps(refundHarness.repos, payments),
        { actorHumanId: STAFF_ID, orderId: ORDER_ID },
      );
      expect(payments.reverseTransfer).toHaveBeenCalledTimes(2);
      const staffReversal = payments.reverseTransfer.mock.calls[1]![0];

      // Same transfer, same NET cents pulled back from the payee — item C's
      // buyer-paid share (4,522¢) minus its fee share (145¢), not the
      // 4,400¢ gross the cancellation used to pass.
      expect(cancelReversal.transferId).toBe(`tr_settlement-sl-${ITEM_C}`);
      expect(cancelReversal.amountCents).toBe(staffReversal.amountCents);
      expect(cancelReversal.amountCents).toBe(EXPECTED_NET_ITEM_C_CENTS);
      expect(
        staffResult.refundedItems.find((i) => i.orderItemId === ITEM_C)
          ?.refundedCents,
      ).toBe(EXPECTED_NET_ITEM_C_CENTS);

      // And the buyer-side refunds still agree, to the cent.
      const [cancelRefund, staffRefund] =
        payments.refundPaymentIntent.mock.calls.map(
          ([input]) => input.amountCents,
        );
      expect(cancelRefund).toBe(staffRefund);
      expect(cancelRefund).toBe(EXPECTED_NET_REFUND_CENTS);
    });
  });

  describe("(f) discounted PART_REFUNDED order — item path then cancellation", () => {
    // A 1,000¢ platform credit: `computeExpectedPaymentAmount` = 2,750 +
    // 2,750 − 1,000 = 4,500 (post-discount). Both paths now price an item
    // from that post-discount total via the shared
    // `allocateRefundItemBases` (`lib/orders/refund-item-base.ts`) — 2,250
    // each, not the PRE-discount `buyerTotalCents` of 2,750 the item path
    // used to read straight off the item. Fee 200 → 100 per item.
    const DISCOUNTED_TOTAL_CENTS = 4_500;
    const DISCOUNTED_FEE_CENTS = 200;
    const PLATFORM_CREDIT_ITEM = "30000000-0000-4000-8000-0000000000cc";

    function discountedOrder(): OrderRecord {
      return makeOrder({
        amountGrossCents: 5_000,
        feesPlatformCents: 500,
        taxAmountCents: 0,
        items: [
          makeItem(ITEM_A, 2_500, 2_750),
          makeItem(ITEM_B, 2_500, 2_750),
          makeItem(PLATFORM_CREDIT_ITEM, -1_000, 0, {
            kind: "platform_credit",
            ticketTypeId: null,
            meta: {},
          }),
        ],
      });
    }

    /** Item A refunded by the REAL item path, then the event cancelled. */
    async function runItemRefundThenCancel() {
      const payments = makePayments({ feeCents: DISCOUNTED_FEE_CENTS });
      const harness = makeRepos({
        event: makeEvent(),
        orders: [discountedOrder()],
      });
      const itemRefund = await refundOrderItems(
        makeRefundOrderItemsDeps(harness.repos, payments),
        { actorHumanId: STAFF_ID, orderId: ORDER_ID, orderItemIds: [ITEM_A] },
      );
      expect(itemRefund.newOrderStatus).toBe("PART_REFUNDED");

      const cancel = await runCancel(makeCancelDeps(harness.repos, payments));
      expect(cancel.refundedOrderCount).toBe(1);
      expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(2);
      const cancelNetCents = payments.refundPaymentIntent.mock.calls[1]![0]
        .amountCents as number;
      return { priorCents: itemRefund.totalRefundedCents, cancelNetCents };
    }

    it("pins the concrete amounts each path moves (so the gap below is a real measurement, not a harness error)", async () => {
      const { priorCents, cancelNetCents } = await runItemRefundThenCancel();
      // Item path: A's share of the post-discount 4,500 (2,250) − 100 fee
      // share. It used to move 2,650 (the pre-discount 2,750 − 100), which is
      // the 1,000¢ credit handed back a second time.
      expect(priorCents).toBe(2_150);
      // Cancel: B's share of the post-discount 4,500 (2,250) − 100 fee share.
      expect(cancelNetCents).toBe(2_150);
      // The two paths now price an item identically — that agreement IS the
      // fix, and it is what closes the gap asserted below.
      expect(priorCents).toBe(cancelNetCents);
    });

    // GAP CLOSED (money review 2026-09-15). It used to read: the item path
    // and the full-order allocator disagree on the discount, so the two
    // refunds together exceed what the buyer paid net of the fee (4,800 >
    // 4,300); Stripe's charge-level cap (4,500) bounded the buyer-side total
    // but the platform ate the difference.
    //
    // How it was closed: `quoteItemRefund` no longer reads an item's
    // PRE-discount `computeItemBuyerPaid` as its absolute refundable base. It
    // now takes the item's share of `computeExpectedPaymentAmount(order) −
    // tax` — the post-discount, pre-tax charge — from the shared
    // `allocateRefundItemBases` (`lib/orders/refund-item-base.ts`), the same
    // largest-remainder allocator the tax and fee shares use. The bases
    // therefore sum to exactly what the buyer was charged ex-tax, so
    // Σ(base + tax − fee) over every item is exactly `orderTotal − fee` and
    // any subset is ≤ it. Here the two refunds land on 2,150 + 2,150 = 4,300,
    // the bound exactly.
    //
    // The definition is phrased in terms of the ORDER TOTAL, not an
    // enumeration of negative `kind` values, so a future discount kind is
    // covered the moment it lands in that total.
    it("Σ item refund + cancel net ≤ orderTotal − fee", async () => {
      const { priorCents, cancelNetCents } = await runItemRefundThenCancel();
      expect(cancelNetCents).toBeLessThanOrEqual(
        DISCOUNTED_TOTAL_CENTS - DISCOUNTED_FEE_CENTS - priorCents,
      );
    });
  });
});

// Owner ruling 2026-10-11: "yeah it should refund 0 because that's what it
// cost. Otherwise we will get taken advantage of".
describe("cancelEvent — a ticket a discount brought down to $0", () => {
  it("refunds charge − fee in total, none of it attributed to the freed ticket", async () => {
    // The shape of dev order f425308e: a freed $125 VIP (ITEM_A) beside a
    // paid $50 GA (ITEM_B). Charged 5245 + 444 tax = 5689; processor kept 195.
    const order = makeOrder({
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items: [
        makeItem("dddddddd-dddd-4ddd-8ddd-dddddddddddd", -12_500, 0, {
          kind: "discount",
          ticketTypeId: null,
          meta: {},
        }),
        makeItem(ITEM_A, 12_500, 12_500, {
          meta: {
            buyerTotalCents: 12_500,
            discountedToZero: true,
            platformFeePerTicketCents: 0,
          },
        }),
        makeItem(ITEM_B, 5_000, 5_245, {
          meta: { buyerTotalCents: 5_245, platformFeePerTicketCents: 50 },
        }),
      ],
    });
    const payments = makePayments({ feeCents: 195 });
    const { repos, orderItemsRepo } = makeRepos({
      event: makeEvent(),
      orders: [order],
    });

    const result = await runCancel(makeCancelDeps(repos, payments));

    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(0);
    // The same total a cancellation of this order returned before the ruling.
    expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5_689 - 195 }),
    );
    // Stamps: the freed ticket gave back no tax and no platform fee
    // (by buyer-paid weight it was stamped 313 of the 444 tax).
    const stamps = refundedStampsOf(orderItemsRepo.updateStatus).filter(
      ([itemId]) => itemId === ITEM_A || itemId === ITEM_B,
    );
    expect(stamps).toEqual([
      [ITEM_A, 0, 0],
      [ITEM_B, 444, 50],
    ]);
  });

  /** The freed $125 VIP (ITEM_A) beside a paid $50 GA (ITEM_B); charged 5689. */
  function freedVipOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
    return makeOrder({
      amountGrossCents: 5_000,
      feesPlatformCents: 50,
      taxAmountCents: 444,
      items: [
        makeItem("dddddddd-dddd-4ddd-8ddd-dddddddddddd", -12_500, 0, {
          kind: "discount",
          ticketTypeId: null,
          meta: {},
        }),
        makeItem(ITEM_A, 12_500, 12_500, {
          meta: {
            buyerTotalCents: 12_500,
            discountedToZero: true,
            platformFeePerTicketCents: 0,
          },
        }),
        makeItem(ITEM_B, 5_000, 5_245, {
          meta: { buyerTotalCents: 5_245, platformFeePerTicketCents: 50 },
        }),
      ],
      ...overrides,
    });
  }

  // Review finding, 2026-10-11. With the GA refunded first, the freed VIP is
  // the only item left and the plan totals $0. The cancellation used to SKIP
  // such an order (`cancel_event_refund_skip_zero`): the item was never
  // marked, the order stayed PART_REFUNDED and the ticket stayed a live pass
  // for a cancelled show.
  it("GA refunded first, then the event is cancelled: the freed ticket is returned with no Stripe refund", async () => {
    const order = freedVipOrder();
    const payments = makePayments({ feeCents: 195 });
    const harness = makeRepos({ event: makeEvent(), orders: [order] });

    const itemRefund = await refundOrderItems(
      makeRefundOrderItemsDeps(harness.repos, payments),
      { actorHumanId: STAFF_ID, orderId: ORDER_ID, orderItemIds: [ITEM_B] },
    );
    expect(itemRefund.totalRefundedCents).toBe(5_689 - 195);
    expect(order.status).toBe("PART_REFUNDED");
    expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    harness.orderItemsRepo.updateStatus.mockClear();
    const setStatus = harness.repos.tickets.setStatus as unknown as ReturnType<
      typeof vi.fn
    >;
    setStatus.mockClear();

    const deps = makeCancelDeps(harness.repos, payments);
    const result = await runCancel(deps);

    // Counted as refunded, not skipped and not failed.
    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(0);
    // No processor call for the $0 plan: no second refund, no reversal.
    expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(payments.reverseTransfer).not.toHaveBeenCalled();
    // The marking half ran: item refunded with 0 tax / 0 platform fee, its
    // ticket REFUNDED, the order REFUNDED.
    // (The order's `discount` line is marked too, as on every cancelled
    // order; only ticket items carry stamps.)
    expect(
      refundedStampsOf(harness.orderItemsRepo.updateStatus).filter(
        ([itemId]) => itemId === ITEM_A || itemId === ITEM_B,
      ),
    ).toEqual([[ITEM_A, 0, 0]]);
    expect(order.items.find((item) => item.id === ITEM_A)?.status).toBe(
      "refunded",
    );
    expect(setStatus).toHaveBeenCalledWith(
      TICKET_A,
      "REFUNDED",
      expect.anything(),
    );
    expect(order.status).toBe("REFUNDED");
    // No money moved, so nothing is debited from the organiser.
    expect(harness.payeeLedger.entries).toEqual([]);
    // The buyer is in the cancellation notice's buyer list with 0 cents; the
    // drain sends them the plain cancellation, not "refunded $0.00"
    // (dispatch-event-change-notifications.test.ts).
    expect(harness.eventChangeNoticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: "CANCELLED",
        payload: expect.objectContaining({
          buyers: [{ humanId: BUYER_ID, refundedCents: 0, currency: "usd" }],
          pendingRefundBuyerHumanIds: [],
        }),
      }),
    );
    expect(scopedLoggerOf(deps.logger).warn).not.toHaveBeenCalledWith(
      "cancel_event_refund_skip_zero",
      expect.anything(),
    );
    expect(harness.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancelled",
        data: expect.objectContaining({
          refundedOrderCount: 1,
          noChargeOrderCount: 1,
        }),
      }),
    );
  });

  // Review round 2 (BLOCKING): buyer B has order A (GA refunded earlier, the
  // freed VIP left: a $0 plan) and a paid order C. A $0 entry in the buyer
  // list must not hide C's money.
  describe("a buyer with a $0 order and a paid order on the same event", () => {
    const ORDER_C = "30000000-0000-4000-8000-0000000000c0";
    const ITEM_C2 = "30000000-0000-4000-8000-0000000000c2";

    function twoOrders() {
      const orderA = freedVipOrder({ status: "PART_REFUNDED" });
      const ga = orderA.items.find((item) => item.id === ITEM_B)!;
      ga.status = "refunded";
      ga.refundedAt = NOW;
      const orderC = makeOrder({
        id: ORDER_C,
        stripePaymentIntentId: "pi_order_c",
        amountGrossCents: 4_000,
        feesPlatformCents: 400,
        taxAmountCents: 0,
        items: [makeItem(ITEM_C2, 4_000, 4_400, { orderId: ORDER_C })],
      });
      return { orderA, orderC };
    }

    it("C's refund fails: the buyer is in the pending cohort, so they hear 'refund in progress'", async () => {
      const { orderA, orderC } = twoOrders();
      const payments = makePayments({ feeCents: 195 });
      payments.refundPaymentIntent.mockImplementation(async (input) => {
        if (input.paymentIntentId === "pi_order_c") {
          throw new Error("stripe_down");
        }
        return { refundId: "re_test", status: "succeeded" as const };
      });
      const harness = makeRepos({
        event: makeEvent(),
        orders: [orderA, orderC],
      });

      const result = await runCancel(makeCancelDeps(harness.repos, payments));

      expect(result.refundedOrderCount).toBe(1);
      expect(result.failedRefundCount).toBe(1);
      expect(orderA.status).toBe("REFUNDED");
      expect(orderC.status).toBe("SUCCEEDED");
      expect(harness.eventChangeNoticesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            buyers: [{ humanId: BUYER_ID, refundedCents: 0, currency: "usd" }],
            pendingRefundBuyerHumanIds: [BUYER_ID],
          }),
        }),
      );
      // The audit row counts the order returned with no money moved.
      expect(harness.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "event",
          action: "cancelled",
          data: expect.objectContaining({
            refundedOrderCount: 1,
            noChargeOrderCount: 1,
            failedRefundCount: 1,
          }),
        }),
      );
    });

    it("C's refund succeeds: the buyer gets the money-aware notice for C's amount and is not pending", async () => {
      const { orderA, orderC } = twoOrders();
      const payments = makePayments({ feeCents: 195 });
      const harness = makeRepos({
        event: makeEvent(),
        orders: [orderA, orderC],
      });

      const result = await runCancel(makeCancelDeps(harness.repos, payments));

      expect(result.refundedOrderCount).toBe(2);
      // One Stripe refund, for C only: 4400 − 195.
      expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
      expect(payments.refundPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: "pi_order_c",
          amountCents: 4_400 - 195,
        }),
      );
      expect(harness.eventChangeNoticesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            buyers: [
              { humanId: BUYER_ID, refundedCents: 4_400 - 195, currency: "usd" },
            ],
            pendingRefundBuyerHumanIds: [],
          }),
        }),
      );
      expect(harness.auditRepo.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "cancelled",
          data: expect.objectContaining({
            refundedOrderCount: 2,
            noChargeOrderCount: 1,
          }),
        }),
      );
    });
  });

  it("a RESALE order whose plan totals $0 is still skipped (unchanged)", async () => {
    // One resold $1.00 ticket whose processing fee is larger than what was
    // paid: the net refund clamps to $0. `refundFullOrder` refuses this
    // shape for a RESALE order (REFUND_AMOUNT_ZERO); the cancellation keeps
    // skipping it, exactly as before.
    const order = makeOrder({
      source: "RESALE",
      amountGrossCents: 100,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      items: [
        makeItem(ITEM_A, 100, 100, {
          resaleListingId: "30000000-0000-4000-8000-0000000000e1",
        }),
      ],
    });
    const payments = makePayments({ feeCents: 150 });
    const harness = makeRepos({ event: makeEvent(), orders: [order] });
    (
      harness.repos.resaleListings as unknown as { getById: unknown }
    ).getById = vi.fn(async () => ({
      id: "30000000-0000-4000-8000-0000000000e1",
      sellerHumanId: STAFF_ID,
    }));

    const deps = makeCancelDeps(harness.repos, payments);
    const result = await runCancel(deps);

    expect(result.refundedOrderCount).toBe(0);
    expect(result.failedRefundCount).toBe(0);
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(order.status).toBe("SUCCEEDED");
    expect(order.items[0]!.status).toBe("active");
    expect(scopedLoggerOf(deps.logger).warn).toHaveBeenCalledWith(
      "cancel_event_refund_skip_zero",
      { orderId: ORDER_ID },
    );
  });
});
