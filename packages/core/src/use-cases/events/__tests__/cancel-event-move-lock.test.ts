import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";
import {
  ensureTicketRefundLockHeld,
  withTicketRefundLock,
  type TicketRefundLock,
} from "../../_helpers/with-ticket-refund-lock";

// Owner ruling 2026-10-05: "when the refund is in process nothing can happen
// to the ticket". cancelEvent holds `cancel-op:<eventId>` from before its
// first order's refund until its marking tx commits, and the ticket-move
// wrapper refuses while it is held. Each order is also re-read inside its
// own refund mutex before selection.

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const BUYER_A_ID = "30000000-0000-4000-8000-000000000004";
const BUYER_B_ID = "30000000-0000-4000-8000-000000000005";
const ORDER_A_ID = "30000000-0000-4000-8000-000000000006";
const ORDER_B_ID = "30000000-0000-4000-8000-000000000007";
const ITEM_A_ID = "30000000-0000-4000-8000-000000000008";
const ITEM_B_ID = "30000000-0000-4000-8000-000000000009";
const TICKET_A_ID = "30000000-0000-4000-8000-000000000010";
const TICKET_B_ID = "30000000-0000-4000-8000-000000000011";
const CLIENT_KEY = "cancel-move-lock-12345";
const NOW = new Date("2026-05-01T12:00:00.000Z");
const EVENT_KEY = `cancel-op:${EVENT_ID}`;

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Move Lock Event",
    slug: "move-lock-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

type ItemStatus = "active" | "transferred" | "refunded";

function makeOrder(
  orderId: string,
  buyerId: string,
  itemId: string,
  pi: string,
  itemStatus: ItemStatus = "active",
): OrderRecord {
  return {
    id: orderId,
    eventId: EVENT_ID,
    buyerHumanId: buyerId,
    amountGrossCents: 5000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: pi,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: [
      {
        id: itemId,
        orderId,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        meta: { buyerTotalCents: 5500 },
        paidOutAt: null,
        refundedAt: itemStatus === "refunded" ? NOW : null,
        transferredAt: itemStatus === "transferred" ? NOW : null,
        resaleListingId: null,
        status: itemStatus,
      },
    ],
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
  } as OrderRecord;
}

const TICKETS = {
  [TICKET_A_ID]: { id: TICKET_A_ID, eventId: EVENT_ID, orderItemId: ITEM_A_ID },
  [TICKET_B_ID]: { id: TICKET_B_ID, eventId: EVENT_ID, orderItemId: ITEM_B_ID },
} as const;

const ORDER_UNLOADABLE_ID = "30000000-0000-4000-8000-000000000012";

function makeHarness(opts?: {
  /**
   * Order A as each successive `orders.getById(A)` returns it; the last one
   * repeats once the list runs out.
   */
  orderAReads?: OrderRecord[];
  /**
   * A third listed order whose load fails, which turns gift detection off
   * for the whole cancellation (degraded mode).
   */
  withUnloadableOrder?: boolean;
}) {
  const event = makeEvent();
  const orderB = makeOrder(ORDER_B_ID, BUYER_B_ID, ITEM_B_ID, "pi_order_b");
  const aReads = [...(opts?.orderAReads ?? [])];
  let lastA = makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a");
  const readA = () => {
    lastA = aReads.shift() ?? lastA;
    return lastA;
  };

  const eventsRepo = {
    getById: vi.fn(async () => event),
    lockRows: vi.fn(async () => undefined),
    cancel: vi.fn(async () => event),
  };
  const ordersRepo = {
    listTaxLinesByOrderIds: vi.fn(async () => new Map()),
    listAll: vi.fn(async () => ({
      items: [
        { id: ORDER_A_ID, stripePaymentIntentId: "pi_order_a" },
        { id: ORDER_B_ID, stripePaymentIntentId: "pi_order_b" },
        ...(opts?.withUnloadableOrder
          ? [{ id: ORDER_UNLOADABLE_ID, stripePaymentIntentId: "pi_gone" }]
          : []),
      ],
      total: opts?.withUnloadableOrder ? 3 : 2,
    })),
    getById: vi.fn(async (orderId: string) => {
      if (orderId === ORDER_A_ID) return readA();
      if (orderId === ORDER_B_ID) return orderB;
      return null;
    }),
    markRefunded: vi.fn(async () => undefined),
  };
  const orderItemsRepo = {
    listByOrderId: vi.fn(async () => []),
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
    getById: vi.fn(async (id: string) => ({
      id,
      orderId: id === ITEM_A_ID ? ORDER_A_ID : ORDER_B_ID,
    })),
  };
  const ticketsRepo = {
    listByOrderId: vi.fn(async (orderId: string) =>
      orderId === ORDER_B_ID
        ? [{ id: TICKET_B_ID, status: "VALID", scannedAt: null }]
        : [{ id: TICKET_A_ID, status: "VALID", scannedAt: null }],
    ),
    getById: vi.fn(
      async (id: string) => TICKETS[id as keyof typeof TICKETS] ?? null,
    ),
    getByOrderItemId: vi.fn(async () => null),
    setStatus: vi.fn(async () => undefined),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => undefined),
  };
  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    events: eventsRepo,
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
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
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
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  // `withStatus`: the move wrapper's read-only "is cancel-op held?" check.
  const idempotency = createFakeIdempotencyPort({ withStatus: true });
  const refundPaymentIntent = vi.fn(
    async (_args: { paymentIntentId: string }) => ({
      refundId: "re_test",
      status: "succeeded",
    }),
  );
  const reportError = vi.fn();
  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: {
      refundPaymentIntent,
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    } as unknown as CancelEventDeps["payments"],
    idempotency,
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    reportError,
  };

  /** What a gift / invite / listing would see for this ticket right now. */
  const attemptMove = (ticketId: string): Promise<TicketRefundLock> =>
    withTicketRefundLock(
      { repos, idempotency, reportError },
      ticketId,
      async (lock) => lock,
    );

  const run = () =>
    cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

  return {
    deps,
    run,
    attemptMove,
    idempotency,
    eventsRepo,
    ordersRepo,
    orderItemsRepo,
    refundPaymentIntent,
    reportError,
  };
}

function beginsOf(
  h: ReturnType<typeof makeHarness>,
  key: string,
): { index: number; order: number; token: unknown }[] {
  const begin = h.idempotency.__mocks.begin;
  return begin.mock.calls.flatMap(([k, , token], index) =>
    k === key
      ? [{ index, order: begin.mock.invocationCallOrder[index]!, token }]
      : [],
  );
}

describe("cancelEvent — no ticket moves while the cancellation refunds", () => {
  it("holds cancel-op:<eventId> from before the first order's mutex until after the marking tx", async () => {
    const h = makeHarness();

    const result = await h.run();

    expect(result.status).toBe("CANCELLED");
    expect(result.refundedOrderCount).toBe(2);
    expect(h.idempotency.__mocks.begin).toHaveBeenCalledWith(
      EVENT_KEY,
      3600,
      expect.any(String),
    );
    const [eventBegin] = beginsOf(h, EVENT_KEY);
    const [firstOrderBegin] = beginsOf(h, `refund-op:${ORDER_A_ID}`);
    expect(eventBegin!.order).toBeLessThan(firstOrderBegin!.order);
    // Taken before the order snapshots are loaded.
    expect(eventBegin!.order).toBeLessThan(
      h.ordersRepo.listAll.mock.invocationCallOrder[0]!,
    );

    const release = h.idempotency.__mocks.release;
    const releaseIdx = release.mock.calls.findIndex(([k]) => k === EVENT_KEY);
    expect(release.mock.calls[releaseIdx]![1]).toBe(eventBegin!.token);
    // Released only after the marking tx's event cancel.
    expect(release.mock.invocationCallOrder[releaseIdx]!).toBeGreaterThan(
      h.eventsRepo.cancel.mock.invocationCallOrder[0]!,
    );
    expect(await h.idempotency.status!(EVENT_KEY)).toBeNull();
  });

  it("refuses a gift on a ticket whose order was already refunded, in the gap before the marking tx", async () => {
    const h = makeHarness();
    let duringMarking: TicketRefundLock | undefined;
    h.eventsRepo.cancel.mockImplementation(async () => {
      // Both orders are refunded and their order mutexes released; only the
      // event lock stands between a gift and the not-yet-committed marking.
      expect(h.idempotency.__locks.has(`refund-op:${ORDER_A_ID}`)).toBe(false);
      duringMarking = await h.attemptMove(TICKET_A_ID);
      return makeEvent();
    });

    await h.run();

    expect(duringMarking?.refundInProgress).toBe(true);
    expect(() =>
      ensureTicketRefundLockHeld(duringMarking!, {
        orderItemId: ITEM_A_ID,
      }),
    ).toThrow(expect.objectContaining({ code: "TICKET_REFUND_IN_PROGRESS" }));
  });

  it("refuses a gift on an order the cancel has not reached yet, without taking that order's mutex", async () => {
    const h = makeHarness();
    let duringRefundA: TicketRefundLock | undefined;
    let orderBBeginsDuringA = -1;
    h.refundPaymentIntent.mockImplementation(async (args) => {
      if (args.paymentIntentId === "pi_order_a") {
        duringRefundA = await h.attemptMove(TICKET_B_ID);
        orderBBeginsDuringA = beginsOf(h, `refund-op:${ORDER_B_ID}`).length;
      }
      return { refundId: "re_test", status: "succeeded" };
    });

    const result = await h.run();

    expect(duringRefundA?.refundInProgress).toBe(true);
    // The move refused on the event lock before touching order B's mutex,
    // so order B's refund was never made to wait or fail.
    expect(orderBBeginsDuringA).toBe(0);
    expect(result.refundedOrderCount).toBe(2);
    expect(result.failedRefundCount).toBe(0);
  });

  it("lets the same move through once the cancel has committed", async () => {
    const h = makeHarness();
    await h.run();

    const after = await h.attemptMove(TICKET_A_ID);
    expect(after.refundInProgress).toBe(false);
  });

  it("releases the event lock when the marking tx fails", async () => {
    const h = makeHarness();
    h.eventsRepo.cancel.mockRejectedValueOnce(new Error("tx died"));

    await expect(h.run()).rejects.toThrow("tx died");

    const [eventBegin] = beginsOf(h, EVENT_KEY);
    expect(h.idempotency.__mocks.release).toHaveBeenCalledWith(
      EVENT_KEY,
      eventBegin!.token,
    );
    expect(await h.idempotency.status!(EVENT_KEY)).toBeNull();
    // Exactly once: the catch released it, the finally backstop did nothing.
    expect(
      h.idempotency.__mocks.release.mock.calls.filter(([k]) => k === EVENT_KEY),
    ).toHaveLength(1);
    expect((await h.attemptMove(TICKET_A_ID)).refundInProgress).toBe(false);
  });

  it("reports a lost event lock and still completes the cancel", async () => {
    const h = makeHarness();
    h.eventsRepo.cancel.mockImplementation(async () => {
      // The TTL lapsed and something else re-acquired the key mid-cancel.
      h.idempotency.__tokens.set(EVENT_KEY, "someone-else");
      return makeEvent();
    });

    const result = await h.run();

    expect(result.status).toBe("CANCELLED");
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "event_cancel_mutex_lock_lost" }),
      expect.objectContaining({
        tags: { useCase: "cancelEvent.eventMutex" },
        extra: expect.objectContaining({ eventId: EVENT_ID, key: EVENT_KEY }),
      }),
    );
    // The other holder's key is untouched.
    expect(h.idempotency.__tokens.get(EVENT_KEY)).toBe("someone-else");
  });

  it("runs as today when another cancel of the event holds the lock, and never frees it", async () => {
    const h = makeHarness();
    expect(await h.idempotency.begin(EVENT_KEY, 3600, "other-cancel")).toBe(
      true,
    );

    const result = await h.run();

    expect(result.status).toBe("CANCELLED");
    expect(result.refundedOrderCount).toBe(2);
    expect(h.idempotency.__tokens.get(EVENT_KEY)).toBe("other-cancel");
    expect(
      h.idempotency.__mocks.release.mock.calls.filter(([k]) => k === EVENT_KEY),
    ).toHaveLength(0);
  });
});

describe("cancelEvent — a move's brief order-mutex hold does not fail the order", () => {
  it("waits out a move that holds the order's mutex for one short tx, then refunds it", async () => {
    const h = makeHarness();
    // A gift took order A's mutex just before the cancel reached it (its
    // check ran before cancel-op existed) and commits within milliseconds.
    expect(
      await h.idempotency.begin(`refund-op:${ORDER_A_ID}`, 60, "move"),
    ).toBe(true);
    setTimeout(() => {
      void h.idempotency.release(`refund-op:${ORDER_A_ID}`, "move");
    }, 50);

    const result = await h.run();

    // A cancellation never re-runs for its event, so failing order A here
    // would have stranded its payer.
    expect(result.failedRefundCount).toBe(0);
    expect(result.refundedOrderCount).toBe(2);
    expect(beginsOf(h, `refund-op:${ORDER_A_ID}`).length).toBeGreaterThan(2);
  });
});

describe("cancelEvent — each order is re-read inside its refund mutex", () => {
  it("does not refund an order a concurrent refund finished before the cancel reached it", async () => {
    const h = makeHarness({
      orderAReads: [
        // processRefunds' snapshot: still active.
        makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a"),
        // Inside order A's mutex: a buyer refund committed in between.
        makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a", "refunded"),
      ],
    });

    const result = await h.run();

    const refundedPis = h.refundPaymentIntent.mock.calls.map(
      ([args]) => args.paymentIntentId,
    );
    expect(refundedPis).toEqual(["pi_order_b"]);
    expect(result.refundedOrderCount).toBe(1);
  });

  it("selects a gift that committed before the cancel reached the order as a gift, so the marking records its refund", async () => {
    const h = makeHarness({
      orderAReads: [
        makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a"),
        // From the in-mutex reload on, the item reads as gifted away.
        makeOrder(
          ORDER_A_ID,
          BUYER_A_ID,
          ITEM_A_ID,
          "pi_order_a",
          "transferred",
        ),
      ],
    });

    await h.run();

    // The payer was refunded for the gifted item (decision record:
    // cancellation-refunds-gifted-tickets-to-the-payer) and the marking tx,
    // which reads it as transferred, marks it refunded. Off the stale
    // snapshot it would have been refunded as "active" and then skipped by
    // the marking, leaving money out with the item unmarked.
    expect(h.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_order_a" }),
    );
    expect(h.orderItemsRepo.updateStatus).toHaveBeenCalledWith(
      ITEM_A_ID,
      "refunded",
      NOW,
      expect.anything(),
      expect.anything(),
    );
  });
});

// Review round 1 [BLOCKING]: the degraded-mode gift guard must judge the
// order as re-read inside its mutex, not the processRefunds snapshot.
describe("cancelEvent — in-lock guards judge the re-read order", () => {
  it("degraded mode: a gift that lands between the snapshot and the lock sends the order to the failed list", async () => {
    const h = makeHarness({
      withUnloadableOrder: true,
      orderAReads: [
        // Snapshot: active, so a snapshot-only guard would let it through.
        makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a"),
        // In-lock re-read: gifted away (origin unknown in degraded mode).
        makeOrder(
          ORDER_A_ID,
          BUYER_A_ID,
          ITEM_A_ID,
          "pi_order_a",
          "transferred",
        ),
      ],
    });

    const result = await h.run();

    // Order A is on the failed list (not silently skipped) and was never
    // refunded; the unloadable order fails too; B is refunded.
    expect(
      h.refundPaymentIntent.mock.calls.map(([a]) => a.paymentIntentId),
    ).toEqual(["pi_order_b"]);
    expect(result.failedRefundCount).toBe(2);
    expect(result.refundedOrderCount).toBe(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "cancel_event_gift_detection_disabled",
      }),
      expect.objectContaining({
        tags: { useCase: "cancelEvent", stage: "gift_detection" },
        extra: expect.objectContaining({ orderId: ORDER_A_ID }),
      }),
    );
  });

  it("a dispute opened between the snapshot and the lock blocks the refund like the snapshot guard does", async () => {
    const h = makeHarness({
      orderAReads: [
        makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a"),
        {
          ...makeOrder(ORDER_A_ID, BUYER_A_ID, ITEM_A_ID, "pi_order_a"),
          disputeStatus: "OPEN",
        } as OrderRecord,
      ],
    });

    const result = await h.run();

    expect(
      h.refundPaymentIntent.mock.calls.map(([a]) => a.paymentIntentId),
    ).toEqual(["pi_order_b"]);
    expect(result.failedRefundCount).toBe(1);
    expect(result.refundedOrderCount).toBe(1);
    // No transfer reversal or fee read either: nothing touched order A's money.
    expect(
      vi.mocked(h.deps.payments!.getProcessingFeeForPaymentIntent).mock.calls,
    ).toHaveLength(1);
  });
});
