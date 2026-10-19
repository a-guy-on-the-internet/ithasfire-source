import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  cancelEvent,
  cancelEventOutputSchema,
  type CancelEventDeps,
} from "../cancel-event";

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000003";
const BUYER_ID = "20000000-0000-4000-8000-000000000004";
const SELLER_ID = "20000000-0000-4000-8000-000000000005";
/** The PENDING resale order whose finalize this cancellation killed. */
const STRANDED_ORDER_ID = "20000000-0000-4000-8000-000000000006";
const STRANDED_ITEM_ID = "20000000-0000-4000-8000-000000000007";
const STRANDED_PI = "pi_stranded_resale";
/** An ordinary, already-SUCCEEDED resale order. */
const SOLD_ORDER_ID = "20000000-0000-4000-8000-000000000008";
const SOLD_ITEM_ID = "20000000-0000-4000-8000-000000000009";
const SOLD_PARENT_ORDER_ID = "20000000-0000-4000-8000-00000000000a";
const SOLD_PARENT_ITEM_ID = "20000000-0000-4000-8000-00000000000b";
const SOLD_LISTING_ID = "20000000-0000-4000-8000-00000000000c";
const SOLD_TICKET_ID = "20000000-0000-4000-8000-00000000000d";
const SOLD_PI = "pi_sold_resale";
const CLIENT_KEY = "cancel-stranded-key-12345";
const NOW = new Date("2026-05-01T12:00:00.000Z");

const STRANDED_REFUND_KEY = `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${STRANDED_ORDER_ID}:refund-stranded-resale`;
const SOLD_REFUND_KEY = `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${SOLD_ORDER_ID}:refund-payment-intent`;

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Stranded Resale Event",
    slug: "stranded-resale-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

function makeOrderItem(overrides: Record<string, unknown>) {
  return {
    kind: "ticket",
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: 5000,
    amountCents: 5000,
    meta: {},
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
  };
}

function makeOrder(overrides: Partial<OrderRecord>): OrderRecord {
  return {
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
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

/** The PENDING resale order: charged (or not), never finalized, no ticket. */
function makeStrandedResaleOrder(status = "PENDING"): OrderRecord {
  return makeOrder({
    id: STRANDED_ORDER_ID,
    status: status as OrderRecord["status"],
    stripePaymentIntentId: STRANDED_PI,
    source: "RESALE",
    items: [
      makeOrderItem({
        id: STRANDED_ITEM_ID,
        orderId: STRANDED_ORDER_ID,
        meta: { buyerTotalCents: 5500 },
      }),
    ] as OrderRecord["items"],
  });
}

/** A resale order that DID finalize — the existing refund path owns it. */
function makeSoldResaleOrder(): OrderRecord {
  return makeOrder({
    id: SOLD_ORDER_ID,
    status: "SUCCEEDED",
    stripePaymentIntentId: SOLD_PI,
    source: "RESALE",
    parentOrderId: SOLD_PARENT_ORDER_ID,
    items: [
      makeOrderItem({
        id: SOLD_ITEM_ID,
        orderId: SOLD_ORDER_ID,
        resaleListingId: SOLD_LISTING_ID,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: SOLD_LISTING_ID,
          resaleOriginalOrderId: SOLD_PARENT_ORDER_ID,
          resaleOriginalOrderItemId: SOLD_PARENT_ITEM_ID,
        },
      }),
    ] as OrderRecord["items"],
  });
}

function makeSoldParentOrder(): OrderRecord {
  return makeOrder({
    id: SOLD_PARENT_ORDER_ID,
    buyerHumanId: SELLER_ID,
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_sold_parent",
    source: "PRIMARY",
    items: [
      makeOrderItem({
        id: SOLD_PARENT_ITEM_ID,
        orderId: SOLD_PARENT_ORDER_ID,
        resaleListingId: SOLD_LISTING_ID,
        transferredAt: NOW,
        status: "transferred",
        meta: { buyerTotalCents: 5500 },
      }),
    ] as OrderRecord["items"],
  });
}

interface HarnessOptions {
  /** PENDING RESALE rows the scan returns. */
  pendingResaleOrders?: OrderRecord[];
  /** SUCCEEDED rows the existing refund path collects. */
  refundableOrders?: OrderRecord[];
  /** `cancelPaymentIntent` verdict for the stranded PI. */
  piCanceled?: boolean;
  /** `retrievePaymentIntent` status for the stranded PI. */
  piStatus?: string;
  /** Make the stranded refund resolve with this status. */
  strandedRefundStatus?: string;
  /**
   * A resale checkout's link lands right after the scan: the order gains this
   * PaymentIntent before the settle-and-cancel runs.
   */
  linkAfterScan?: string;
}

function makeHarness(opts: HarnessOptions = {}) {
  const event = makeEvent();
  const pendingResaleOrders = opts.pendingResaleOrders ?? [];
  const refundableOrders = opts.refundableOrders ?? [];

  const orderStatus = new Map<string, string>();
  /** The order's CURRENT PaymentIntent, like the row the cancel CAS reads. */
  const orderPi = new Map<string, string | null>();
  for (const o of [...pendingResaleOrders, ...refundableOrders]) {
    orderStatus.set(o.id, o.status);
    orderPi.set(o.id, o.stripePaymentIntentId ?? null);
  }

  const byId = new Map<string, OrderRecord>();
  for (const o of [
    ...pendingResaleOrders,
    ...refundableOrders,
    makeSoldParentOrder(),
  ]) {
    byId.set(o.id, o);
  }

  let txDepth = 0;
  /** Depth at which each externally-observable call happened. */
  const txDepths: Record<string, number[]> = {
    cancelPaymentIntent: [],
    retrievePaymentIntent: [],
    refundPaymentIntent: [],
    listAllPendingResale: [],
  };
  /** Coarse ordering log: listing cancel vs. stranded settlement. */
  const callLog: string[] = [];

  const repoMocks = {
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
    orders: {
      listTaxLinesByOrderIds: vi.fn(async () => new Map()),
      listAll: vi.fn(async (input: Record<string, unknown>) => {
        const statuses = (input.statuses ?? []) as string[];
        if (statuses.includes("PENDING") && input.source === "PRIMARY") {
          // The door's PENDING card-sale scan (Phase 4): none on this event.
          callLog.push("scan:pendingPos");
          return { items: [], total: 0 };
        }
        if (statuses.includes("PENDING")) {
          txDepths.listAllPendingResale.push(txDepth);
          callLog.push("scan:pendingResale");
          expect(input.source).toBe("RESALE");
          const items = pendingResaleOrders
            .filter((o) => orderStatus.get(o.id) === "PENDING")
            .map((o) => ({ ...o, stripePaymentIntentId: orderPi.get(o.id) ?? null }));
          if (opts.linkAfterScan) {
            for (const o of items) orderPi.set(o.id, opts.linkAfterScan);
          }
          return { items, total: items.length };
        }
        return { items: refundableOrders, total: refundableOrders.length };
      }),
      // The door cash phase (Phase 3): no cash sales on this event.
      listSucceededCashOrderIdsForEvent: vi.fn(async () => []),
      getById: vi.fn(async (orderId: string) => {
        const order = byId.get(orderId);
        if (!order) return null;
        return { ...order, status: orderStatus.get(orderId) ?? order.status };
      }),
      markRefunded: vi.fn(async (orderId: string) => {
        callLog.push(`markRefunded:${orderId}`);
        orderStatus.set(orderId, "REFUNDED");
      }),
      cancelPendingOrder: vi.fn(
        async (
          orderId: string,
          casOpts?: { expectedPaymentIntentId: string | null },
        ) => {
        callLog.push(`cancelPendingOrder:${orderId}`);
        if (orderStatus.get(orderId) !== "PENDING") return false;
        // Same CAS as the adapter: PENDING ∧ PI = expected, when given.
        if (
          casOpts &&
          (orderPi.get(orderId) ?? null) !== casOpts.expectedPaymentIntentId
        ) {
          return false;
        }
        orderStatus.set(orderId, "CANCELLED");
        return true;
        },
      ),
    },
    orderItems: {
      listByOrderId: vi.fn(async (orderId: string) => byId.get(orderId)?.items ?? []),
      updateStatus: vi.fn(async () => undefined),
      setResaleListingId: vi.fn(async () => undefined),
      getById: vi.fn(async () => null),
    },
    tickets: {
      listByOrderId: vi.fn(async (orderId: string) =>
        orderId === SOLD_PARENT_ORDER_ID
          ? [{ id: SOLD_TICKET_ID, status: "VALID", scannedAt: null }]
          : [],
      ),
      getByOrderItemId: vi.fn(async (orderItemId: string) =>
        orderItemId === SOLD_ITEM_ID
          ? {
              id: SOLD_TICKET_ID,
              ownerHumanId: BUYER_ID,
              orderId: SOLD_ORDER_ID,
              orderItemId: SOLD_ITEM_ID,
            }
          : null,
      ),
      // The resale unwind locks the ticket row before it moves anything.
      getByIdForUpdate: vi.fn(async (ticketId: string) =>
        ticketId === SOLD_TICKET_ID
          ? {
              id: SOLD_TICKET_ID,
              ownerHumanId: BUYER_ID,
              orderId: SOLD_ORDER_ID,
              orderItemId: SOLD_ITEM_ID,
            }
          : null,
      ),
      setStatus: vi.fn(async () => undefined),
      transfer: vi.fn(async () => true),
      restoreAfterResale: vi.fn(async () => undefined),
    },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => {
        callLog.push("cancelOpenForEvent");
        return { cancelledListingIds: [SOLD_LISTING_ID] };
      }),
      getById: vi.fn(async () => ({
        id: SOLD_LISTING_ID,
        sellerHumanId: SELLER_ID,
        expiresAt: null,
        saleCutoffAt: null,
        status: "SOLD",
        ticketId: SOLD_TICKET_ID,
        buyerOrderId: SOLD_ORDER_ID,
      })),
      // No live listing of the refunded buyer's own.
      getByTicketId: vi.fn(async () => null),
      unwindSale: vi.fn(async () => undefined),
    },
    promos: {
      releaseHoldsForOrder: vi.fn(async (orderId: string) => {
        callLog.push(`promos:${orderId}`);
      }),
    },
    feeWaivers: {
      release: vi.fn(async (orderId: string) => {
        callLog.push(`feeWaivers:${orderId}`);
      }),
    },
    credits: {
      releaseForOrder: vi.fn(async (orderId: string) => {
        callLog.push(`credits:${orderId}`);
      }),
    },
    seats: {
      releaseSeats: vi.fn(async () => undefined),
      updateStatuses: vi.fn(async () => undefined),
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
    audit: { log: vi.fn(async () => undefined) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
    settlements: { getByIds: vi.fn(async () => []) },
    splits: { listByOrderId: vi.fn(async () => []) },
  };

  const payeeLedger = createFakePayeeLedgerRepo();
  const txRepos = {
    ...repoMocks,
    payeeLedger: payeeLedger.repo,
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
      txDepth += 1;
      try {
        return await fn(txRepos);
      } finally {
        txDepth -= 1;
      }
    }),
  } as unknown as Repos;

  const payments = {
    refundPaymentIntent: vi.fn(async (input: { paymentIntentId: string }) => {
      txDepths.refundPaymentIntent.push(txDepth);
      callLog.push(`refund:${input.paymentIntentId}`);
      return {
        refundId: `re_${input.paymentIntentId}`,
        status:
          input.paymentIntentId === STRANDED_PI
            ? (opts.strandedRefundStatus ?? "succeeded")
            : "succeeded",
      };
    }),
    cancelPaymentIntent: vi.fn(async () => {
      txDepths.cancelPaymentIntent.push(txDepth);
      callLog.push("cancelPaymentIntent");
      return { canceled: opts.piCanceled ?? true };
    }),
    retrievePaymentIntent: vi.fn(async () => {
      txDepths.retrievePaymentIntent.push(txDepth);
      return {
        id: STRANDED_PI,
        status: opts.piStatus ?? "canceled",
        amountReceived: 0,
        currency: "usd",
        metadata: {},
      };
    }),
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
  };

  const reportError = vi.fn();

  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: payments as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    reportError,
  };

  const run = () =>
    cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

  return {
    run,
    deps,
    repos,
    repoMocks,
    payments,
    payeeLedger,
    reportError,
    txDepths,
    callLog,
    orderStatus,
  };
}

function refundCalls(payments: { refundPaymentIntent: ReturnType<typeof vi.fn> }) {
  return payments.refundPaymentIntent.mock.calls.map(
    ([input]: [{ paymentIntentId: string; amountCents?: number; idempotencyKey?: string }]) => ({
      paymentIntentId: input.paymentIntentId,
      amountCents: input.amountCents,
      idempotencyKey: input.idempotencyKey,
    }),
  );
}

describe("cancelEvent — PENDING resale orders killed by the listing cancellation", () => {
  it("cancels an unpaid PENDING resale order and releases its holds, refunding nothing", async () => {
    const h = makeHarness({
      pendingResaleOrders: [makeStrandedResaleOrder()],
      piCanceled: true,
    });

    const result = await h.run();

    // The PaymentIntent was killed before anything was handed back.
    expect(h.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: STRANDED_PI,
    });
    // The cancel CAS carries the PaymentIntent the settle saw (G2).
    expect(h.repoMocks.orders.cancelPendingOrder).toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
      { expectedPaymentIntentId: STRANDED_PI },
    );
    expect(h.orderStatus.get(STRANDED_ORDER_ID)).toBe("CANCELLED");

    // Everything the cart was holding came back.
    expect(h.repoMocks.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
    );
    expect(h.repoMocks.feeWaivers.release).toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
    );
    expect(h.repoMocks.credits.releaseForOrder).toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
      { now: NOW },
    );

    // Nobody was charged, so nothing was refunded.
    expect(h.payments.refundPaymentIntent).not.toHaveBeenCalled();

    expect(result.cancelledPendingResaleOrderCount).toBe(1);
    expect(result.refundedPendingResaleOrderCount).toBe(0);
    expect(result.strandedPendingResaleOrderCount).toBe(0);
    expect(result.strandedPendingResaleScanFailed).toBe(false);

    // Auditable, not just counted.
    expect(h.repoMocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: STRANDED_ORDER_ID,
        action: "cancelled_on_event_cancellation",
      }),
    );
  });

  it("tries the fenced listing release on cancel; the listing the event cancel closed stays closed (G1)", async () => {
    const order = makeStrandedResaleOrder();
    order.items = [
      makeOrderItem({
        id: STRANDED_ITEM_ID,
        orderId: STRANDED_ORDER_ID,
        // The column is nulled by `cancelOpenForEvent`; meta keeps the copy.
        resaleListingId: null,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: "listing-stranded",
          holdExpiresAt: "2026-10-04T12:15:00.000Z",
        },
      }),
    ] as OrderRecord["items"];
    const h = makeHarness({ pendingResaleOrders: [order], piCanceled: true });
    // The adapter's answer for a CANCELLED listing: not HELD, nothing freed.
    const releaseHold = vi.fn(async () => ({ released: false }));
    (h.repoMocks.resaleListings as Record<string, unknown>).releaseHold =
      releaseHold;

    const result = await h.run();

    expect(releaseHold).toHaveBeenCalledWith(
      "listing-stranded",
      {
        buyerHumanId: order.buyerHumanId,
        heldUntil: new Date("2026-10-04T12:15:00.000Z"),
      },
      { now: NOW },
    );
    expect(h.orderStatus.get(STRANDED_ORDER_ID)).toBe("CANCELLED");
    expect(result.cancelledPendingResaleOrderCount).toBe(1);
  });

  it("REFUNDS a PENDING resale order whose PaymentIntent already succeeded", async () => {
    // The exact bug: the buyer paid, `resaleListings.commit` lost the race to
    // `cancelOpenForEvent`, finalize rolled back, the order stayed PENDING.
    const h = makeHarness({
      pendingResaleOrders: [makeStrandedResaleOrder()],
      piCanceled: false,
      piStatus: "succeeded",
    });

    const result = await h.run();

    // Refunded in full — no amountCents, because the buyer got nothing.
    expect(refundCalls(h.payments)).toEqual([
      {
        paymentIntentId: STRANDED_PI,
        amountCents: undefined,
        idempotencyKey: STRANDED_REFUND_KEY,
      },
    ]);

    // And recorded as refunded, not cancelled into oblivion.
    expect(h.repoMocks.orders.markRefunded).toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
    );
    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(h.orderStatus.get(STRANDED_ORDER_ID)).toBe("REFUNDED");

    expect(result.refundedPendingResaleOrderCount).toBe(1);
    expect(result.cancelledPendingResaleOrderCount).toBe(0);
    expect(result.strandedPendingResaleOrderCount).toBe(0);

    expect(h.repoMocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: STRANDED_ORDER_ID,
        action: "refunded_on_event_cancellation",
        data: expect.objectContaining({ refundId: `re_${STRANDED_PI}` }),
      }),
    );

    // No ledger debit: finalize never wrote a SETTLEMENT_CREDIT for this
    // order, so there is nothing to debit and a debit would be a phantom.
    expect(h.payeeLedger.entriesOfType("REFUND_DEBIT")).toHaveLength(0);
  });

  it("counts and reports a PENDING resale order it cannot settle instead of dropping it", async () => {
    const h = makeHarness({
      pendingResaleOrders: [makeStrandedResaleOrder()],
      piCanceled: false,
      // Still `processing`: the charge may yet land, so keep everything.
      piStatus: "processing",
    });

    const result = await h.run();

    expect(result.strandedPendingResaleOrderCount).toBe(1);
    expect(result.refundedPendingResaleOrderCount).toBe(0);
    expect(result.cancelledPendingResaleOrderCount).toBe(0);
    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(h.repoMocks.orders.markRefunded).not.toHaveBeenCalled();
    expect(h.payments.refundPaymentIntent).not.toHaveBeenCalled();
    // Loud, not silent (CLAUDE.md: a swallow without reportError is invisible).
    expect(h.reportError).toHaveBeenCalled();
  });

  it("counts and reports a stranded order whose refund fails, and never marks it refunded", async () => {
    const h = makeHarness({
      pendingResaleOrders: [makeStrandedResaleOrder()],
      piCanceled: false,
      piStatus: "succeeded",
      strandedRefundStatus: "failed",
    });

    const result = await h.run();

    expect(h.payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(h.repoMocks.orders.markRefunded).not.toHaveBeenCalled();
    expect(result.strandedPendingResaleOrderCount).toBe(1);
    expect(result.refundedPendingResaleOrderCount).toBe(0);
    expect(h.reportError).toHaveBeenCalled();
  });

  it("leaves an already-SUCCEEDED resale order to the existing refund path and never double-refunds it", async () => {
    const h = makeHarness({
      pendingResaleOrders: [],
      refundableOrders: [makeSoldResaleOrder()],
    });
    await h.payeeLedger.seedCredit({
      orderId: SOLD_ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { [SOLD_ITEM_ID]: 5_000 },
    });

    const result = await h.run();

    // Exactly one refund, issued by the pre-existing path with its own key.
    expect(refundCalls(h.payments)).toEqual([
      {
        paymentIntentId: SOLD_PI,
        amountCents: 5500,
        idempotencyKey: SOLD_REFUND_KEY,
      },
    ]);
    expect(
      refundCalls(h.payments).some(
        (c) => c.idempotencyKey === STRANDED_REFUND_KEY,
      ),
    ).toBe(false);

    expect(result.refundedOrderCount).toBe(1);
    expect(result.refundedPendingResaleOrderCount).toBe(0);
    expect(result.cancelledPendingResaleOrderCount).toBe(0);
    expect(result.strandedPendingResaleOrderCount).toBe(0);

    // The existing unwind still ran — this order is not touched by phase 2.
    expect(h.repoMocks.resaleListings.unwindSale).toHaveBeenCalledWith(
      SOLD_LISTING_ID,
      SOLD_ORDER_ID,
      "CANCELLED",
    );
    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
  });

  it("is a no-op when the event has no PENDING resale orders", async () => {
    const h = makeHarness({ pendingResaleOrders: [] });

    const result = await h.run();

    expect(h.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(h.payments.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(h.payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(h.repoMocks.orders.markRefunded).not.toHaveBeenCalled();
    // The scan is the ONLY extra work, and it opens no transaction.
    expect(h.repos.tx).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      eventId: EVENT_ID,
      status: "CANCELLED",
      refundedOrderCount: 0,
      failedRefundCount: 0,
      cancelledPendingResaleOrderCount: 0,
      refundedPendingResaleOrderCount: 0,
      strandedPendingResaleOrderCount: 0,
      strandedPendingResaleScanFailed: false,
      // No door cash sales on this event (owner ruling 2026-10-07 phase).
      refundedCashOrderCount: 0,
      failedCashRefundCount: 0,
      cashRefundScanFailed: false,
      // Nor door card sales left PENDING (Phase 4).
      voidedPendingPosOrderCount: 0,
      failedPendingPosVoidCount: 0,
      pendingPosScanFailed: false,
    });
  });

  it("replays a pre-change idempotency record without tripping the output schema", async () => {
    // A cancellation that ran on the PREVIOUS build stored a response with
    // none of the resale-settlement fields. A replay inside the 300s TTL must
    // still parse at the tRPC `.output()` boundary rather than 500.
    const h = makeHarness({ pendingResaleOrders: [makeStrandedResaleOrder()] });
    const legacyResponse = {
      eventId: EVENT_ID,
      status: "CANCELLED" as const,
      refundedOrderCount: 3,
      failedRefundCount: 0,
    };
    await h.deps.idempotency.commit(
      `event:cancel:${ACTOR_ID}:${CLIENT_KEY}`,
      { payloadHash: JSON.stringify({ eventId: EVENT_ID }), response: legacyResponse },
    );

    const result = await h.run();

    expect(result).toEqual(legacyResponse);
    expect(() => cancelEventOutputSchema.parse(result)).not.toThrow();
    // A replay does no work — the phase never runs a second time.
    expect(h.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(h.repoMocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
  });

  it("says so when the scan itself fails, instead of reporting zero stranded orders", async () => {
    const h = makeHarness({ pendingResaleOrders: [makeStrandedResaleOrder()] });
    h.repoMocks.orders.listAll.mockImplementation(
      async (input: Record<string, unknown>) => {
        const statuses = (input.statuses ?? []) as string[];
        if (statuses.includes("PENDING")) throw new Error("scan boom");
        return { items: [], total: 0 };
      },
    );

    const result = await h.run();

    // The cancellation still SUCCEEDS — the event is cancelled either way, and
    // a throw here would report a committed cancel as a failure.
    expect(result.status).toBe("CANCELLED");
    // But it does not claim zero stranded orders.
    expect(result.strandedPendingResaleScanFailed).toBe(true);
    expect(h.reportError).toHaveBeenCalled();
  });

  it("settles the PaymentIntent OUTSIDE the transaction, and only after the listings are cancelled", async () => {
    const h = makeHarness({
      pendingResaleOrders: [makeStrandedResaleOrder()],
      piCanceled: false,
      piStatus: "succeeded",
    });

    await h.run();

    // Stripe never runs inside `repos.tx` — a 30s budget and a pool of 10.
    expect(h.txDepths.cancelPaymentIntent).toEqual([0]);
    expect(h.txDepths.retrievePaymentIntent).toEqual([0]);
    expect(h.txDepths.refundPaymentIntent).toEqual([0]);
    expect(h.txDepths.listAllPendingResale).toEqual([0]);

    // And the whole phase runs AFTER `cancelOpenForEvent` has committed: that
    // commit is what makes "this order can never mint a ticket" true.
    const cancelListingsAt = h.callLog.indexOf("cancelOpenForEvent");
    const scanAt = h.callLog.indexOf("scan:pendingResale");
    const refundAt = h.callLog.indexOf(`refund:${STRANDED_PI}`);
    const markAt = h.callLog.indexOf(`markRefunded:${STRANDED_ORDER_ID}`);
    expect(cancelListingsAt).toBeGreaterThanOrEqual(0);
    expect(scanAt).toBeGreaterThan(cancelListingsAt);
    expect(refundAt).toBeGreaterThan(scanAt);
    expect(markAt).toBeGreaterThan(refundAt);
  });
});

describe("cancelEvent — a resale checkout's link landing after the stranded scan", () => {
  it("regression (G2): an order scanned with no PI that gains one before the cancel is NOT cancelled", async () => {
    // The resale checkout commits its order with no PI and links it after.
    // The scan read `null`; the link wins before the cancel. A status-only
    // cancel would leave a payable PI on a CANCELLED order.
    const unlinked = makeOrder({
      ...makeStrandedResaleOrder(),
      stripePaymentIntentId: null,
    });
    const h = makeHarness({
      pendingResaleOrders: [unlinked],
      linkAfterScan: "pi_linked_late",
    });

    const result = await h.run();

    // No PI at scan time → settled without Stripe, then the CAS on `null`.
    expect(h.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(h.repoMocks.orders.cancelPendingOrder).toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
      { expectedPaymentIntentId: null },
    );
    expect(h.orderStatus.get(STRANDED_ORDER_ID)).toBe("PENDING");
    expect(h.repoMocks.promos.releaseHoldsForOrder).not.toHaveBeenCalledWith(
      STRANDED_ORDER_ID,
    );
    expect(result.cancelledPendingResaleOrderCount).toBe(0);
  });
});
