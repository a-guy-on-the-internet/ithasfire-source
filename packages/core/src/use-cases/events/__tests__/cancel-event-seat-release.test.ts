import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

// Cancelling a show refunds the whole house — and before this fix every one of
// those seats stayed SOLD forever, because mint stamped `Seat.status = SOLD`
// and `Ticket.seatId`, and no refund path ever set either back. The layout was
// bricked: a rescheduled date could not sell a single reserved ticket, and the
// buyer only ever saw `seat_unavailable`.

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const BUYER_ID = "30000000-0000-4000-8000-000000000004";
const ORDER_ID = "30000000-0000-4000-8000-000000000006";
const ITEM_1 = "30000000-0000-4000-8000-000000000007";
const ITEM_2 = "30000000-0000-4000-8000-000000000008";
const TICKET_1 = "30000000-0000-4000-8000-000000000009";
const TICKET_2 = "30000000-0000-4000-8000-00000000000a";
const SEAT_1 = "30000000-0000-4000-8000-0000000000b1";
const SEAT_2 = "30000000-0000-4000-8000-0000000000b2";
const CLIENT_KEY = "cancel-seats-key-12345";
const NOW = new Date("2026-09-10T12:00:00.000Z");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Seated Show",
    slug: "seated-show",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

function makeSeatedOrder(opts: { gifted?: boolean } = {}): OrderRecord {
  const item = (id: string) => ({
    id,
    orderId: ORDER_ID,
    kind: "ticket" as const,
    ticketTypeId: "tt-reserved",
    qty: 1,
    unitPriceCents: 5000,
    amountCents: 5000,
    meta: { buyerTotalCents: 5500 },
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    status: "active" as const,
  });

  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: 10000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_seated_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    parentOrderId: null,
    items: [
      item(ITEM_1),
      // A gifted seat: the recipient's pass still carries THIS order's id.
      opts.gifted
        ? { ...item(ITEM_2), status: "transferred" as const, transferredAt: NOW }
        : item(ITEM_2),
    ],
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
  } as unknown as OrderRecord;
}

function buildHarness(
  options: { refundOutcome?: "succeeded" | "throws"; gifted?: boolean } = {},
) {
  const { refundOutcome = "succeeded" } = options;
  const event = makeEvent();
  const order = makeSeatedOrder({ gifted: options.gifted });

  const ordersRepo = {
    listTaxLinesByOrderIds: vi.fn(async () => new Map()),
    listAll: vi.fn(async () => ({
      items: [
        {
          id: ORDER_ID,
          stripePaymentIntentId: "pi_seated_123",
          amountGrossCents: 10000,
          feesPlatformCents: 0,
        },
      ],
      total: 1,
    })),
    getById: vi.fn(async (orderId: string) =>
      orderId === ORDER_ID ? order : null,
    ),
    markRefunded: vi.fn(async () => undefined),
  };
  const orderItemsRepo = {
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
    // Only read when the caller does NOT pass `voidTransferred` — cancelEvent
    // does, so a gifted ticket dies with the show either way. Present so this
    // harness would still answer honestly if that flag were ever dropped.
    listByOrderId: vi.fn(async () => order.items),
    // Seat history: the former seat is stamped onto the order item just
    // before the ticket's @unique `seatId` link is cleared.
    recordReleasedSeats: vi.fn(async () => undefined),
  };
  const ticketsRepo = {
    listByOrderId: vi.fn(async (orderId: string) =>
      orderId === ORDER_ID
        ? [
            {
              id: TICKET_1,
              status: "VALID",
              scannedAt: null,
              seatId: SEAT_1,
              orderItemId: ITEM_1,
            },
            {
              id: TICKET_2,
              // A gifted pass stays VALID — the transfer moved only its owner.
              status: options.gifted ? "VALID" : "SCANNED",
              scannedAt: options.gifted ? null : NOW,
              seatId: SEAT_2,
              orderItemId: ITEM_2,
            },
          ]
        : [],
    ),
    setStatus: vi.fn(async () => undefined),
    clearSeatAssignments: vi.fn(async () => undefined),
  };
  const seatsRepo = {
    updateStatuses: vi.fn(async () => undefined),
    releaseSeats: vi.fn(async () => undefined),
  };
  const resaleListingsRepo = {
    cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
  };
  const auditRepo = { log: vi.fn(async () => undefined) };
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
    seats: seatsRepo,
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
    audit: auditRepo,
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const refundPaymentIntent = vi.fn(async () => {
    if (refundOutcome === "throws") {
      throw new Error("stripe_down");
    }
    return { refundId: "re_seated", status: "succeeded" as const };
  });

  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: {
      refundPaymentIntent,
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
  };

  return {
    deps,
    ticketsRepo,
    seatsRepo,
    auditRepo,
    refundPaymentIntent,
  };
}

const input = {
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey: CLIENT_KEY,
};

describe("cancelEvent — reserved seats", () => {
  it("frees the whole house: every voided ticket's seat goes back to AVAILABLE", async () => {
    const h = buildHarness();

    const result = await cancelEvent(h.deps, input);

    expect(result.refundedOrderCount).toBe(1);

    // The dead tickets let go of their seats (`Ticket.seatId` is @unique, so a
    // held link fails the next mint after the card is charged) …
    expect(h.ticketsRepo.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
      TICKET_2,
    ]);
    // … and the seats come back. `updateStatuses`, not `releaseSeats`: these
    // are SOLD seats and `releaseSeats` is HELD-gated, so it would no-op.
    expect(h.seatsRepo.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1, SEAT_2],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    expect(h.seatsRepo.releaseSeats).not.toHaveBeenCalled();

    expect(h.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "cancelled",
        data: expect.objectContaining({ releasedSeatCount: 2 }),
      }),
    );
  });

  it("WHOLE HOUSE means gifted tickets too — the show is gone, the seat comes back", async () => {
    // The one place killing a transferred ticket is right, and it is an
    // EXPLICIT flag (`voidTransferred: true`), not an accident of which
    // tickets happen to be VALID. Every other refund path must leave a gifted
    // pass — and its seat — alone: the sender is not refunded for it, so
    // re-selling that seat double-sells it.
    const h = buildHarness({ gifted: true });

    await cancelEvent(h.deps, input);

    expect(h.ticketsRepo.setStatus).toHaveBeenCalledWith(TICKET_2, "REFUNDED", {
      scannedAt: null,
    });
    expect(h.ticketsRepo.clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_1,
      TICKET_2,
    ]);
    expect(h.seatsRepo.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1, SEAT_2],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
  });

  it("leaves the seats alone when the order's refund FAILS", async () => {
    // The buyer's money is still in limbo, so the ticket is not voided — and a
    // seat whose ticket is alive must not be resold underneath them.
    const h = buildHarness({ refundOutcome: "throws" });

    const result = await cancelEvent(h.deps, input);

    expect(result.failedRefundCount).toBe(1);
    expect(h.ticketsRepo.setStatus).not.toHaveBeenCalled();
    expect(h.seatsRepo.updateStatuses).not.toHaveBeenCalled();
    expect(h.ticketsRepo.clearSeatAssignments).not.toHaveBeenCalled();
  });

  it("replays idempotently without freeing anything twice", async () => {
    const h = buildHarness();

    const first = await cancelEvent(h.deps, input);
    const second = await cancelEvent(h.deps, input);

    expect(second).toEqual(first);
    expect(h.seatsRepo.updateStatuses).toHaveBeenCalledTimes(1);
  });
});
