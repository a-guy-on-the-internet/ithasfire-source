import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

// Money audit 2026-09-08 finding #22: cancelling an event refunded the buyer
// of a LISTED ticket but left the resale listing ACTIVE (and the ticket
// LISTED). The listing could still be bought — the resale buyer was charged
// and the finalize landed in the DLQ over a refunded original item. These
// tests pin the fix: every open listing of the event is cancelled inside the
// cancel tx and the LISTED ticket is flipped to REFUNDED with its order.

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000003";
const BUYER_ID = "20000000-0000-4000-8000-000000000004";
const ORDER_ID = "20000000-0000-4000-8000-000000000006";
const ORDER_ITEM_ID = "20000000-0000-4000-8000-000000000008";
const LISTING_ID = "20000000-0000-4000-8000-000000000010";
const HELD_LISTING_ID = "20000000-0000-4000-8000-000000000012";
const TICKET_ID = "20000000-0000-4000-8000-000000000011";
const CLIENT_KEY = "cancel-listed-key-12345";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Listed Ticket Event",
    slug: "listed-ticket-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

/** Primary order whose single ticket the buyer has LISTED for resale. */
function makeListedPrimaryOrder(): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_listed_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: [
      {
        id: ORDER_ITEM_ID,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        meta: { buyerTotalCents: 5500 },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        // The item still points at its open listing — exactly the state
        // finding #22 found "refunded" items left in.
        resaleListingId: LISTING_ID,
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
      },
    ],
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
  };
}

function buildHarness(options: {
  refundOutcome?: "succeeded" | "throws";
  cancelledListingIds?: string[];
} = {}) {
  const { refundOutcome = "succeeded", cancelledListingIds = [LISTING_ID] } =
    options;
  const event = makeEvent();
  const order = makeListedPrimaryOrder();

  const ordersRepo = {
    listTaxLinesByOrderIds: vi.fn(async () => new Map()),
    listAll: vi.fn(async () => ({
      items: [
        {
          id: ORDER_ID,
          stripePaymentIntentId: "pi_listed_123",
          amountGrossCents: 5000,
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
  };
  const ticketsRepo = {
    // The fake does NOT reset LISTED → VALID the way the Prisma adapter
    // does, so this pins that cancelEvent's own ticket flip covers LISTED
    // independently of adapter-side bookkeeping.
    listByOrderId: vi.fn(async (orderId: string) =>
      orderId === ORDER_ID
        ? [{ id: TICKET_ID, status: "LISTED", scannedAt: null }]
        : [],
    ),
    setStatus: vi.fn(async () => undefined),
  };
  const resaleListingsRepo = {
    cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds })),
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

  // Spread the tx bag so post-commit `deps.repos.<x>` reads resolve — a
  // `{ tx } as unknown as Repos` fake makes them undefined and tests go
  // green over dead code.
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const refundPaymentIntent = vi.fn(async () => {
    if (refundOutcome === "throws") {
      throw new Error("stripe_down");
    }
    return { refundId: "re_listed", status: "succeeded" as const };
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
    txRepos,
    ordersRepo,
    orderItemsRepo,
    ticketsRepo,
    resaleListingsRepo,
    auditRepo,
    refundPaymentIntent,
  };
}

const input = { actorHumanId: ACTOR_ID, eventId: EVENT_ID, clientKey: CLIENT_KEY };

describe("cancelEvent — open resale listings of the cancelled event", () => {
  it("cancels the ACTIVE listing, flips the LISTED ticket to REFUNDED and refunds the buyer", async () => {
    const h = buildHarness();

    const result = await cancelEvent(h.deps, input);

    expect(result.refundedOrderCount).toBe(1);
    expect(h.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(h.refundPaymentIntent.mock.calls[0]![0]).toMatchObject({
      paymentIntentId: "pi_listed_123",
      amountCents: 5500,
    });

    // Every open listing of THIS event, once, scoped by event id — never by
    // a broader key that could reach another event's inventory.
    expect(h.resaleListingsRepo.cancelOpenForEvent).toHaveBeenCalledTimes(1);
    expect(h.resaleListingsRepo.cancelOpenForEvent).toHaveBeenCalledWith(
      EVENT_ID,
    );

    // The listing is cancelled BEFORE any ticket is flipped, so a resale
    // checkout racing this tx sees CANCELLED, never a REFUNDED ticket under
    // a still-open listing.
    const cancelOrder =
      h.resaleListingsRepo.cancelOpenForEvent.mock.invocationCallOrder[0]!;
    const flipOrder = h.ticketsRepo.setStatus.mock.invocationCallOrder[0]!;
    expect(cancelOrder).toBeLessThan(flipOrder);

    expect(h.ticketsRepo.setStatus).toHaveBeenCalledWith(
      TICKET_ID,
      "REFUNDED",
      { scannedAt: null },
    );
    // A ticket item also carries its refunded tax / platform-fee share
    // (docs/decisions/absorb-refund-returns-platform-fee.md). This fixture
    // has neither, so both are a MEASURED zero — not the `null` that means
    // "not attributed".
    expect(h.orderItemsRepo.updateStatus).toHaveBeenCalledWith(
      ORDER_ITEM_ID,
      "refunded",
      NOW,
      0,
      0,
    );
    expect(h.ordersRepo.markRefunded).toHaveBeenCalledWith(ORDER_ID);

    // The cancelled-listing count is on the event's audit row.
    expect(h.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "cancelled",
        data: expect.objectContaining({ cancelledResaleListingCount: 1 }),
      }),
    );
  });

  it("cancels a HELD listing (resale checkout in flight) the same way", async () => {
    const h = buildHarness({
      cancelledListingIds: [LISTING_ID, HELD_LISTING_ID],
    });

    await cancelEvent(h.deps, input);

    // HELD rows are the adapter's concern (ACTIVE | HELD both cancel); the
    // use case audits whatever the bulk cancel actually flipped.
    expect(h.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "cancelled",
        data: expect.objectContaining({ cancelledResaleListingCount: 2 }),
      }),
    );
  });

  it("still cancels the event's listings when the order's refund FAILS, without touching that order's ticket", async () => {
    const h = buildHarness({ refundOutcome: "throws" });

    const result = await cancelEvent(h.deps, input);

    expect(result.failedRefundCount).toBe(1);
    expect(result.refundedOrderCount).toBe(0);
    // The listing must not stay purchasable just because Stripe was down.
    expect(h.resaleListingsRepo.cancelOpenForEvent).toHaveBeenCalledWith(
      EVENT_ID,
    );
    // But the buyer still has their money in limbo, so the ticket is NOT
    // marked REFUNDED (the adapter resets it LISTED → VALID; a later manual
    // refund then takes the normal path).
    expect(h.ticketsRepo.setStatus).not.toHaveBeenCalled();
    expect(h.ordersRepo.markRefunded).not.toHaveBeenCalled();
  });

  it("replays idempotently: a second call with the same clientKey returns the cached result and cancels nothing twice", async () => {
    const h = buildHarness();

    const first = await cancelEvent(h.deps, input);
    const second = await cancelEvent(h.deps, input);

    expect(second).toEqual(first);
    expect(h.resaleListingsRepo.cancelOpenForEvent).toHaveBeenCalledTimes(1);
    expect(h.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(h.ticketsRepo.setStatus).toHaveBeenCalledTimes(1);
  });

  it("goes red when the tx bag has no resaleListings.cancelOpenForEvent (missing-fake trap)", async () => {
    const h = buildHarness();
    // Simulate a fixture that forgot the new repo method on the TX bag (the
    // one the cancel tx actually closes over): the cancel must FAIL loudly
    // rather than silently skip listing cleanup.
    (h.txRepos as unknown as { resaleListings: unknown }).resaleListings = {};

    await expect(cancelEvent(h.deps, input)).rejects.toThrow();
  });
});
