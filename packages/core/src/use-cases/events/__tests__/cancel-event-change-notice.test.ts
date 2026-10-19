import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000003";
const BUYER_ID = "20000000-0000-4000-8000-000000000004";
const ORDER_ONE_ID = "20000000-0000-4000-8000-000000000005";
const ORDER_TWO_ID = "20000000-0000-4000-8000-000000000006";
const BUYER_TWO_ID = "20000000-0000-4000-8000-000000000007";
const CLIENT_KEY = "cancel-notice-key-12345";
const NOW = new Date("2026-05-10T18:00:00.000Z");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Riverside Jazz Night",
    slug: "riverside-jazz-night",
    startsAt: new Date("2026-06-01T20:00:00.000Z"),
    endsAt: new Date("2026-06-01T23:00:00.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as EventRecord;
}

function makePrimaryOrder(
  orderId: string,
  buyerTotalCents: number,
  overrides: Partial<OrderRecord> = {},
): OrderRecord {
  return {
    id: orderId,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: buyerTotalCents,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: `pi_${orderId}`,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: [
      {
        id: `${orderId}-item`,
        orderId,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: buyerTotalCents,
        amountCents: buyerTotalCents,
        meta: { buyerTotalCents },
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
      },
    ],
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

function buildHarness(params: {
  event: EventRecord;
  orders: OrderRecord[];
}) {
  const { event, orders } = params;
  const eventChangeNoticesCreate = vi.fn(async () => ({
    id: "notice-1",
    createdAt: NOW,
  }));

  const ordersById = new Map(orders.map((order) => [order.id, order]));

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
    orders: {
      listTaxLinesByOrderIds: vi.fn(async () => new Map()),
      listAll: vi.fn(async () => ({
        items: orders.map((order) => ({
          id: order.id,
          stripePaymentIntentId: order.stripePaymentIntentId,
          amountGrossCents: order.amountGrossCents,
          feesPlatformCents: order.feesPlatformCents,
        })),
        total: orders.length,
      })),
      getById: vi.fn(async (orderId: string) => ordersById.get(orderId) ?? null),
      markRefunded: vi.fn(async () => undefined),
    },
    orderItems: {
      updateStatus: vi.fn(async () => undefined),
    },
    tickets: {
      listByOrderId: vi.fn(async () => []),
    },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    // Settlement cancellation is DELETED — refunds write REFUND_DEBIT ledger
    // entries instead (no credits seeded here: the ledger write is a
    // reported no-op for these fixtures, and never blocks the cancel).
    payeeLedger: createFakePayeeLedgerRepo().repo,
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: {
      enqueueMany: vi.fn(async () => undefined),
    },
    eventChangeNotices: {
      create: eventChangeNoticesCreate,
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
    resourceQuotas: {
      incrementUsage: vi.fn(async () => undefined),
    },
    // Booking-timeline reverse lookup: this event never came from a booking.
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: {
      refundPaymentIntent: vi.fn(async () => ({
        refundId: "re_test",
        status: "succeeded",
      })),
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
  };

  return { deps, eventChangeNoticesCreate };
}

describe("cancelEvent — CANCELLED change-notice outbox (Unit 4)", () => {
  it("writes a CANCELLED notice capturing refunded buyers, deduped + summed per humanId", async () => {
    const event = makeEvent();
    const { deps, eventChangeNoticesCreate } = buildHarness({
      event,
      // Same buyer, two refunded orders → one deduped entry with summed cents.
      orders: [
        makePrimaryOrder(ORDER_ONE_ID, 5000),
        makePrimaryOrder(ORDER_TWO_ID, 3000),
      ],
    });

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.refundedOrderCount).toBe(2);
    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Riverside Jazz Night",
        startsAt: "2026-06-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER_ID, refundedCents: 8000, currency: "usd" }],
        pendingRefundBuyerHumanIds: [],
      },
    });
  });

  it("writes a CANCELLED notice with an empty buyers array for a free/RSVP event", async () => {
    const event = makeEvent({ attendanceMode: "RSVP" } as Partial<EventRecord>);
    const { deps, eventChangeNoticesCreate } = buildHarness({
      event,
      orders: [],
    });

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.refundedOrderCount).toBe(0);
    expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Riverside Jazz Night",
        startsAt: "2026-06-01T20:00:00.000Z",
        buyers: [],
        pendingRefundBuyerHumanIds: [],
      },
    });
  });

  it("captures a failed-refund buyer in pendingRefundBuyerHumanIds (money still stuck)", async () => {
    const event = makeEvent();
    // ORDER_ONE (BUYER_ID) refunds cleanly; ORDER_TWO (BUYER_TWO_ID) fails.
    const { deps, eventChangeNoticesCreate } = buildHarness({
      event,
      orders: [
        makePrimaryOrder(ORDER_ONE_ID, 5000),
        makePrimaryOrder(ORDER_TWO_ID, 3000, {
          buyerHumanId: BUYER_TWO_ID,
        }),
      ],
    });

    // Make ORDER_TWO's refund fail (its payment intent rejects); ORDER_ONE ok.
    deps.payments.refundPaymentIntent = vi.fn(
      async ({ paymentIntentId }: { paymentIntentId: string }) => {
        if (paymentIntentId === `pi_${ORDER_TWO_ID}`) {
          throw new Error("stripe refund declined");
        }
        return { refundId: "re_test", status: "succeeded" as const };
      },
    ) as unknown as CancelEventDeps["payments"]["refundPaymentIntent"];

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.refundedOrderCount).toBe(1);
    expect(result.failedRefundCount).toBe(1);
    expect(eventChangeNoticesCreate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Riverside Jazz Night",
        startsAt: "2026-06-01T20:00:00.000Z",
        // Only the succeeded-refund buyer is money-aware…
        buyers: [{ humanId: BUYER_ID, refundedCents: 5000, currency: "usd" }],
        // …the failed-refund buyer is captured so the drain still tells them.
        pendingRefundBuyerHumanIds: [BUYER_TWO_ID],
      },
    });
  });
});
