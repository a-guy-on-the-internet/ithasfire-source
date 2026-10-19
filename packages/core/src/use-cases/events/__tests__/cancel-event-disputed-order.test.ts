import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

// Dispute guard: an order whose charge is under an OPEN / UNDER_REVIEW / LOST
// dispute cannot be refunded (Stripe refuses `charge_disputed`). cancelEvent
// must record it as a failed refund with reason "disputed" and NEVER attempt
// it — no mutex, no transfer reversal, no Stripe call — while the other
// orders are still refunded and the cancellation completes.

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000003";
const BUYER_A_ID = "20000000-0000-4000-8000-000000000004";
const BUYER_B_ID = "20000000-0000-4000-8000-000000000005";
const ORDER_A_ID = "20000000-0000-4000-8000-000000000006";
const ORDER_B_ID = "20000000-0000-4000-8000-000000000007";
const ITEM_A_ID = "20000000-0000-4000-8000-000000000008";
const ITEM_B_ID = "20000000-0000-4000-8000-000000000009";
const TICKET_A_ID = "20000000-0000-4000-8000-000000000010";
const TICKET_B_ID = "20000000-0000-4000-8000-000000000011";
const CLIENT_KEY = "cancel-dispute-key-12345";
const NOW = new Date("2026-05-01T12:00:00.000Z");

// Owned events never hit the FR-014 platform-staff override; deny-all stub.
const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Dispute Test Event",
    slug: "dispute-test-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

function makePrimaryOrder(input: {
  orderId: string;
  buyerId: string;
  itemId: string;
  paymentIntentId: string;
  disputeStatus?: OrderRecord["disputeStatus"];
  paidOutAt?: Date | null;
}): OrderRecord {
  return {
    id: input.orderId,
    eventId: EVENT_ID,
    buyerHumanId: input.buyerId,
    amountGrossCents: 5000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: input.paymentIntentId,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    disputeStatus: input.disputeStatus ?? null,
    items: [
      {
        id: input.itemId,
        orderId: input.orderId,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        meta: { buyerTotalCents: 5500 },
        paidOutAt: input.paidOutAt ?? null,
        refundedAt: null,
        transferredAt: null,
        resaleListingId: null,
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
  } as OrderRecord;
}

describe("cancelEvent dispute guard", () => {
  it.each(["OPEN", "UNDER_REVIEW", "LOST"] as const)("skips a %s-disputed (paid-out) order with no reversal and no processor call, refunds the others", async (disputeStatus) => {
    const event = makeEvent();
    // Order A is PAID OUT and disputed: without the guard the cancellation
    // would reverse its transfer first and only then have Stripe refuse the
    // refund — money moved for nothing.
    const orderA = makePrimaryOrder({
      orderId: ORDER_A_ID,
      buyerId: BUYER_A_ID,
      itemId: ITEM_A_ID,
      paymentIntentId: "pi_order_a",
      disputeStatus,
      paidOutAt: NOW,
    });
    const orderB = makePrimaryOrder({
      orderId: ORDER_B_ID,
      buyerId: BUYER_B_ID,
      itemId: ITEM_B_ID,
      paymentIntentId: "pi_order_b",
    });

    const eventsRepo = {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => event),
    };
    const authzRepo = {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER" as const,
      })),
    };
    const ordersRepo = {
      listTaxLinesByOrderIds: vi.fn(async () => new Map()),
      listAll: vi.fn(async () => ({
        items: [
          {
            id: ORDER_A_ID,
            stripePaymentIntentId: "pi_order_a",
            amountGrossCents: 5000,
            feesPlatformCents: 0,
          },
          {
            id: ORDER_B_ID,
            stripePaymentIntentId: "pi_order_b",
            amountGrossCents: 5000,
            feesPlatformCents: 0,
          },
        ],
        total: 2,
      })),
      getById: vi.fn(async (orderId: string) => {
        if (orderId === ORDER_A_ID) return orderA;
        if (orderId === ORDER_B_ID) return orderB;
        return null;
      }),
      markRefunded: vi.fn(async () => undefined),
    };
    const orderItemsRepo = {
      listByOrderId: vi.fn(async (orderId: string) => {
        if (orderId === ORDER_A_ID) return orderA.items;
        if (orderId === ORDER_B_ID) return orderB.items;
        return [];
      }),
      updateStatus: vi.fn(async () => undefined),
      setResaleListingId: vi.fn(async () => undefined),
    };
    const ticketsRepo = {
      listByOrderId: vi.fn(async (orderId: string) =>
        orderId === ORDER_B_ID
          ? [{ id: TICKET_B_ID, status: "VALID", scannedAt: null }]
          : [{ id: TICKET_A_ID, status: "VALID", scannedAt: null }],
      ),
      getByOrderItemId: vi.fn(async () => null),
      setStatus: vi.fn(async () => undefined),
      transfer: vi.fn(async () => true),
      restoreAfterResale: vi.fn(async () => undefined),
    };
    const payeeLedger = createFakePayeeLedgerRepo();
    await payeeLedger.seedCredit({
      orderId: ORDER_B_ID,
      payeeId: "payee-org",
      amountCents: 5_000,
      items: { [ITEM_B_ID]: 5_000 },
    });

    const txRepos = {
      events: eventsRepo,
      authz: authzRepo,
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
      pendingObjectDeletions: {
        enqueueMany: vi.fn(async () => undefined),
      },
      eventChangeNotices: {
        create: vi.fn(async () => undefined),
      },
      audit: { log: vi.fn(async () => undefined) },
      // Booking-timeline reverse lookup: this event never came from a booking.
      agreements: { findByLinkedEventId: vi.fn(async () => null) },
      resourceQuotas: {
        incrementUsage: vi.fn(async () => undefined),
      },
    } as unknown as TxRepos;

    const repos = {
      ...txRepos,
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
    } as unknown as Repos;

    const idempotency = createFakeIdempotencyPort();

    const refundPaymentIntent = vi.fn(async () => ({
      refundId: "re_test",
      status: "succeeded",
    }));
    const reverseTransfer = vi.fn(async () => ({ reversalId: "trr_never" }));
    const deps: CancelEventDeps = {
      repos,
      authz: denyStaffAuthz,
      payments: {
        refundPaymentIntent,
        reverseTransfer,
        getTransfer: vi.fn(async () => ({
          amountCents: 5_000,
          amountReversedCents: 0,
        })),
        listTransferReversals: vi.fn(async () => []),
        getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
      } as unknown as CancelEventDeps["payments"],
      idempotency,
      clock: { now: vi.fn(() => NOW) },
      logger: createTestLogger(),
    };

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // Order A is recorded as a failed (never attempted) refund; order B is
    // refunded; the cancellation itself completed.
    expect(result.status).toBe("CANCELLED");
    expect(result.failedRefundCount).toBe(1);
    expect(result.refundedOrderCount).toBe(1);

    // Exactly ONE Stripe refund — order B's. No transfer reversal at all:
    // order A's paid-out item was never reversed.
    expect(refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_order_b" }),
    );
    expect(reverseTransfer).not.toHaveBeenCalled();

    // Order A's refund mutex was never even acquired — the guard runs
    // before the per-order refund section.
    expect(idempotency.__mocks.begin).not.toHaveBeenCalledWith(
      `refund-op:${ORDER_A_ID}`,
      expect.anything(),
      expect.anything(),
    );
    expect(idempotency.__mocks.begin).toHaveBeenCalledWith(
      `refund-op:${ORDER_B_ID}`,
      600,
      expect.any(String),
    );

    // Only order B was marked refunded in the tx.
    const updatedItemIds = (
      orderItemsRepo.updateStatus as ReturnType<typeof vi.fn>
    ).mock.calls.map(([itemId]) => itemId);
    expect(updatedItemIds).toContain(ITEM_B_ID);
    expect(updatedItemIds).not.toContain(ITEM_A_ID);

    // The failure is recorded with the typed code and reason "disputed".
    const auditData = (txRepos.audit.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry?.action === "cancelled" || entry?.action === "event_cancelled");
    expect(JSON.stringify(auditData ?? {})).toContain(ORDER_A_ID);
  });
});
