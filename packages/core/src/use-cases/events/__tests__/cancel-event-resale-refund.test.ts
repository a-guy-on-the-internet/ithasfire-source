import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "10000000-0000-4000-8000-000000000002";
const ACTOR_ID = "10000000-0000-4000-8000-000000000003";
const BUYER_ID = "10000000-0000-4000-8000-000000000004";
const SELLER_ID = "10000000-0000-4000-8000-000000000005";
const ORDER_ID = "10000000-0000-4000-8000-000000000006";
const PARENT_ORDER_ID = "10000000-0000-4000-8000-000000000007";
const ORDER_ITEM_ID = "10000000-0000-4000-8000-000000000008";
const ORIGINAL_ORDER_ITEM_ID = "10000000-0000-4000-8000-000000000009";
const LISTING_ID = "10000000-0000-4000-8000-000000000010";
const TICKET_ID = "10000000-0000-4000-8000-000000000011";
const CLIENT_KEY = "cancel-resale-key-12345";
const NOW = new Date("2026-04-20T12:00:00.000Z");

// Owned events never hit the FR-014 platform-staff override; deny-all stub.
const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Resale Test Event",
    slug: "resale-test-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as EventRecord;
}

function makeResaleOrder(): OrderRecord {
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
    stripePaymentIntentId: "pi_resale_123",
    source: "RESALE",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: PARENT_ORDER_ID,
    items: [
      {
        id: ORDER_ITEM_ID,
        orderId: ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: LISTING_ID,
          resaleOriginalOrderId: PARENT_ORDER_ID,
          resaleOriginalOrderItemId: ORIGINAL_ORDER_ITEM_ID,
        },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
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

function makeOriginalPrimaryOrder(): OrderRecord {
  return {
    id: PARENT_ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: SELLER_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_primary_123",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: [
      {
        id: ORIGINAL_ORDER_ITEM_ID,
        orderId: PARENT_ORDER_ID,
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        meta: { buyerTotalCents: 5500 },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: NOW,
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
        status: "transferred",
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

describe("cancelEvent resale refund unwind", () => {
  it("refunds the resale buyer and the linked transferred primary leg during cancellation", async () => {
    const event = makeEvent();
    const resaleOrder = makeResaleOrder();
    const originalOrder = makeOriginalPrimaryOrder();

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
            id: PARENT_ORDER_ID,
            stripePaymentIntentId: "pi_primary_123",
            amountGrossCents: 5000,
            feesPlatformCents: 0,
          },
          {
            id: ORDER_ID,
            stripePaymentIntentId: "pi_resale_123",
            amountGrossCents: 5000,
            feesPlatformCents: 0,
          },
        ],
        total: 2,
      })),
      getById: vi.fn(async (orderId: string) => {
        if (orderId === ORDER_ID) {
          return resaleOrder;
        }
        if (orderId === PARENT_ORDER_ID) {
          return originalOrder;
        }
        return null;
      }),
      markRefunded: vi.fn(async () => undefined),
    };
    const orderItemsRepo = {
      listByOrderId: vi.fn(async (orderId: string) => {
        if (orderId === ORDER_ID) {
          return resaleOrder.items;
        }
        if (orderId === PARENT_ORDER_ID) {
          return originalOrder.items;
        }
        return [];
      }),
      updateStatus: vi.fn(async () => undefined),
      setResaleListingId: vi.fn(async () => undefined),
    };
    const ticketsRepo = {
      listByOrderId: vi.fn(async (orderId: string) =>
        orderId === PARENT_ORDER_ID
          ? [{ id: TICKET_ID, status: "VALID", scannedAt: null }]
          : [],
      ),
      getByOrderItemId: vi.fn(async (orderItemId: string) =>
        orderItemId === ORDER_ITEM_ID
          ? {
              id: TICKET_ID,
              ownerHumanId: BUYER_ID,
              orderId: ORDER_ID,
              orderItemId: ORDER_ITEM_ID,
            }
          : null,
      ),
      // The resale unwind locks the ticket row before it moves anything.
      getByIdForUpdate: vi.fn(async (ticketId: string) =>
        ticketId === TICKET_ID
          ? {
              id: TICKET_ID,
              ownerHumanId: BUYER_ID,
              orderId: ORDER_ID,
              orderItemId: ORDER_ITEM_ID,
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
        sellerHumanId: SELLER_ID,
      })),
      // No live listing of the refunded buyer's own.
      getByTicketId: vi.fn(async () => null),
      unwindSale: vi.fn(async () => undefined),
    };
    const payeeLedger = createFakePayeeLedgerRepo();
    // Resale seller credit + primary org credit — each order's refund must
    // write its own exact-cents debit (event cancellation is just its
    // orders' refunds; cancelForEvent no longer exists).
    await payeeLedger.seedCredit({
      orderId: ORDER_ID,
      payeeId: "payee-seller",
      amountCents: 5_000,
      items: { [ORDER_ITEM_ID]: 5_000 },
    });
    await payeeLedger.seedCredit({
      orderId: PARENT_ORDER_ID,
      payeeId: "payee-org",
      amountCents: 5_000,
      items: { [ORIGINAL_ORDER_ITEM_ID]: 5_000 },
    });
    const imagesRepo = {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    };
    const auditRepo = {
      log: vi.fn(async () => undefined),
    };
    const resourceQuotasRepo = {
      incrementUsage: vi.fn(async () => undefined),
    };

    const txRepos = {
      events: eventsRepo,
      authz: authzRepo,
      orders: ordersRepo,
      orderItems: orderItemsRepo,
      tickets: ticketsRepo,
      resaleListings: resaleListingsRepo,
      payeeLedger: payeeLedger.repo,
      images: imagesRepo,
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
      audit: auditRepo,
      resourceQuotas: resourceQuotasRepo,
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

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(deps.payments.refundPaymentIntent).toHaveBeenCalledTimes(2);
    expect(
      deps.payments.refundPaymentIntent.mock.calls
        .map(([input]) => ({
          paymentIntentId: input.paymentIntentId,
          amountCents: input.amountCents,
          idempotencyKey: input.idempotencyKey,
        }))
        .sort((left, right) =>
          left.paymentIntentId.localeCompare(right.paymentIntentId),
        ),
    ).toEqual(
      [
        {
          paymentIntentId: "pi_primary_123",
          amountCents: 5500,
          idempotencyKey: `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${PARENT_ORDER_ID}:refund-payment-intent`,
        },
        {
          paymentIntentId: "pi_resale_123",
          amountCents: 5500,
          idempotencyKey: `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${ORDER_ID}:refund-payment-intent`,
        },
      ].sort((left, right) =>
        left.paymentIntentId.localeCompare(right.paymentIntentId),
      ),
    );

    expect(ticketsRepo.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        fromHumanId: BUYER_ID,
        toHumanId: SELLER_ID,
        reason: "admin",
        orderId: ORDER_ID,
      }),
    );
    expect(ticketsRepo.restoreAfterResale).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        restoredOrderId: PARENT_ORDER_ID,
        restoredOrderItemId: ORIGINAL_ORDER_ITEM_ID,
      }),
    );
    // Ticket items carry their refunded tax / platform-fee attribution
    // (docs/decisions/absorb-refund-returns-platform-fee.md). Both orders
    // here have `feesPlatformCents: 0` and no order tax, so each share is a
    // MEASURED zero — not the `null` that means "not attributed".
    expect(orderItemsRepo.updateStatus).toHaveBeenCalledWith(
      ORDER_ITEM_ID,
      "refunded",
      NOW,
      0,
      0,
    );
    expect(orderItemsRepo.updateStatus).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      "refunded",
      NOW,
      0,
      0,
    );
    expect(orderItemsRepo.setResaleListingId).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      null,
    );
    expect(ticketsRepo.setStatus).toHaveBeenCalledWith(TICKET_ID, "REFUNDED", {
      scannedAt: null,
    });
    expect(ticketsRepo.setStatus).not.toHaveBeenCalledWith(TICKET_ID, "LISTED");
    expect(ordersRepo.markRefunded).toHaveBeenCalledWith(PARENT_ORDER_ID);
    expect(ordersRepo.markRefunded).toHaveBeenCalledWith(ORDER_ID);
    expect(
      deps.payments.getProcessingFeeForPaymentIntent,
    ).toHaveBeenCalledTimes(2);
    expect(
      deps.payments.getProcessingFeeForPaymentIntent,
    ).toHaveBeenCalledWith({ paymentIntentId: "pi_primary_123" });
    expect(
      deps.payments.getProcessingFeeForPaymentIntent,
    ).toHaveBeenCalledWith({ paymentIntentId: "pi_resale_123" });
    expect(resaleListingsRepo.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
    // Each refunded order wrote its own exact-cents REFUND_DEBIT — the
    // ledger replacement for the deleted event-level cancelForEvent.
    const debits = payeeLedger.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(2);
    expect(
      new Map(debits.map((d) => [d.idempotencyKey, d.amountCents])),
    ).toEqual(
      new Map([
        [`refund-debit:${ORDER_ID}:payee-seller:re_test`, 5_000],
        [`refund-debit:${PARENT_ORDER_ID}:payee-org:re_test`, 5_000],
      ]),
    );
  });

  it("fails before issuing the refund when a resale order cannot be unwound", async () => {
    const event = makeEvent();
    const refundedOrder = makeResaleOrder();
    const payments = {
      refundPaymentIntent: vi.fn(async () => ({
        refundId: "re_test",
        status: "succeeded",
      })),
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    };

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
          items: [
            {
              id: ORDER_ID,
              stripePaymentIntentId: "pi_resale_123",
              amountGrossCents: 5000,
              feesPlatformCents: 0,
            },
          ],
          total: 1,
        })),
        getById: vi.fn(async (orderId: string) =>
          orderId === ORDER_ID ? refundedOrder : null,
        ),
        markRefunded: vi.fn(async () => undefined),
      },
      orderItems: {
        listByOrderId: vi.fn(async () => refundedOrder.items),
      },
      tickets: {
        listByOrderId: vi.fn(async () => []),
        getByOrderItemId: vi.fn(async () => null),
        setStatus: vi.fn(async () => undefined),
      },
      resaleListings: {
        cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
        getById: vi.fn(async () => ({
          id: LISTING_ID,
          sellerHumanId: SELLER_ID,
        })),
      },
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
        create: vi.fn(async () => undefined),
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
      payments: payments as unknown as CancelEventDeps["payments"],
      idempotency: createFakeIdempotencyPort(),
      clock: { now: vi.fn(() => NOW) },
      logger: createTestLogger(),
    };

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.failedRefundCount).toBe(1);
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it("refunds only the remaining refundable slice for a PART_REFUNDED order during cancellation", async () => {
    const partialOrderId = "10000000-0000-4000-8000-000000000012";
    const refundedItemId = "10000000-0000-4000-8000-000000000013";
    const paidOutActiveItemId = "10000000-0000-4000-8000-000000000014";
    const transferredItemId = "10000000-0000-4000-8000-000000000015";
    const settlementLineId = "10000000-0000-4000-8000-000000000016";
    const settlementId = "10000000-0000-4000-8000-000000000017";
    const stripeTransferId = "tr_partial_123";
    // The transferred item is the parent of a RESALE order whose charge is
    // under an open dispute: never refunded, so the parent leg stays
    // `transferred` and OUT of this order's refund. (A `transferred` item
    // with NO resale order behind it is a gift and IS refunded to the payer —
    // docs/decisions/cancellation-refunds-gifted-tickets-to-the-payer.md —
    // which would move the 5600 pins below.)
    const disputedResaleOrderId = "10000000-0000-4000-8000-000000000023";
    const disputedResaleItemId = "10000000-0000-4000-8000-000000000024";
    const disputedResaleListingId = "10000000-0000-4000-8000-000000000025";

    const event = makeEvent();
    const disputedResaleOrder = {
      ...makeResaleOrder(),
      id: disputedResaleOrderId,
      stripePaymentIntentId: "pi_partial_resale_disputed",
      parentOrderId: partialOrderId,
      disputeStatus: "OPEN",
      items: [
        {
          ...makeResaleOrder().items[0]!,
          id: disputedResaleItemId,
          orderId: disputedResaleOrderId,
          resaleListingId: disputedResaleListingId,
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: disputedResaleListingId,
            resaleOriginalOrderId: partialOrderId,
            resaleOriginalOrderItemId: transferredItemId,
          },
        },
      ],
    } as OrderRecord;
    const partiallyRefundedOrder: OrderRecord = {
      id: partialOrderId,
      eventId: EVENT_ID,
      buyerHumanId: BUYER_ID,
      amountGrossCents: 15000,
      feesPlatformCents: 0,
      taxAmountCents: 300,
      currency: "usd",
      feePolicySnapshot: {},
      status: "PART_REFUNDED",
      stripePaymentIntentId: "pi_partial_123",
      source: "PRIMARY",
      nonRefundable: false,
      occurredAt: NOW,
      paymentMethodType: "card",
      paidOutAt: null,
      parentOrderId: null,
      items: [
        {
          id: refundedItemId,
          orderId: partialOrderId,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { buyerTotalCents: 5500 },
          paidOutAt: null,
          refundedAt: NOW,
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
          status: "refunded",
        },
        {
          id: paidOutActiveItemId,
          orderId: partialOrderId,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { buyerTotalCents: 5500 },
          paidOutAt: NOW,
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
        {
          id: transferredItemId,
          orderId: partialOrderId,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { buyerTotalCents: 5500 },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: NOW,
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
          status: "transferred",
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
            id: partialOrderId,
            stripePaymentIntentId: "pi_partial_123",
            amountGrossCents: 15000,
            feesPlatformCents: 0,
          },
          {
            id: disputedResaleOrderId,
            stripePaymentIntentId: "pi_partial_resale_disputed",
            amountGrossCents: 5000,
            feesPlatformCents: 0,
          },
        ],
        total: 2,
      })),
      getById: vi.fn(async (orderId: string) => {
        if (orderId === partialOrderId) return partiallyRefundedOrder;
        if (orderId === disputedResaleOrderId) return disputedResaleOrder;
        return null;
      }),
      markRefunded: vi.fn(async () => undefined),
    };
    const orderItemsRepo = {
      updateStatus: vi.fn(async () => undefined),
    };
    const ticketsRepo = {
      listByOrderId: vi.fn(async () => []),
    };
    const orderItemSettlementLinesRepo = {
      listByOrderItemIds: vi.fn(async () => [
        {
          orderItemId: paidOutActiveItemId,
          settlementLineId,
          amountCents: 4000,
        },
      ]),
    };
    const settlementLinesRepo = {
      getByIds: vi.fn(async () => [
        {
          id: settlementLineId,
          settlementId,
        },
      ]),
    };
    // getByIds stays: it is a READ (transfer-reversal lookup chain + the
    // reversal→payee attribution map); only the cancelFor* writes are gone.
    const settlementsRepo = {
      getByIds: vi.fn(async () => [
        {
          id: settlementId,
          payeeId: "payee-org",
          stripeTransferId,
        },
      ]),
    };
    const payeeLedger = createFakePayeeLedgerRepo();
    const imagesRepo = {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    };
    const auditRepo = {
      log: vi.fn(async () => undefined),
    };
    const resourceQuotasRepo = {
      incrementUsage: vi.fn(async () => undefined),
    };

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
      images: imagesRepo,
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
      audit: auditRepo,
      resourceQuotas: resourceQuotasRepo,
      // Booking-timeline reverse lookup: this event never came from a booking.
      agreements: { findByLinkedEventId: vi.fn(async () => null) },
    } as unknown as TxRepos;

    const payments = {
      refundPaymentIntent: vi.fn(async () => ({
        refundId: "re_partial_test",
        status: "succeeded",
      })),
      reverseTransfer: vi.fn(async () => ({ reversalId: "trr_partial_123" })),
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    };

    const repos = {
      ...txRepos,
      // Ledger-era resolution (tried first): nothing post-cutover covers
      // these items, so the frozen junction chain below resolves them.
      payoutItems: {
        listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
      },
      orderItemSettlementLines: orderItemSettlementLinesRepo,
      settlementLines: settlementLinesRepo,
      settlements: settlementsRepo,
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
    } as unknown as Repos;

    const deps: CancelEventDeps = {
      repos,
      authz: denyStaffAuthz,
      payments: payments as unknown as CancelEventDeps["payments"],
      idempotency: createFakeIdempotencyPort(),
      clock: { now: vi.fn(() => NOW) },
      logger: createTestLogger(),
    };

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.refundedOrderCount).toBe(1);
    // The dispute-blocked RESALE order is the one failure (never attempted).
    expect(result.failedRefundCount).toBe(1);
    expect(payments.refundPaymentIntent).toHaveBeenCalledTimes(1);
    expect(payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: stripeTransferId,
        amountCents: 5600,
        idempotencyKey: `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${partialOrderId}:reverse-transfer:${stripeTransferId}`,
      }),
    );
    expect(payments.refundPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_partial_123",
        amountCents: 5600,
        idempotencyKey: `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${partialOrderId}:refund-payment-intent`,
      }),
    );
    expect(orderItemsRepo.updateStatus).toHaveBeenCalledTimes(1);
    // The refunded tax share is allocated over EVERY ticket item on the
    // order, not just the refundable one, so stamps written by separate
    // refunds of one order add up to its tax exactly once. `feesPlatformCents`
    // is 0 on this fixture, so the platform-fee share is a measured zero.
    expect(orderItemsRepo.updateStatus).toHaveBeenCalledWith(
      paidOutActiveItemId,
      "refunded",
      NOW,
      100,
      0,
    );
    expect(ordersRepo.markRefunded).toHaveBeenCalledWith(partialOrderId);
  });

  it("marks the order refund as failed when transfer reversal fails and skips the buyer refund", async () => {
    const partialOrderId = "10000000-0000-4000-8000-000000000018";
    const refundedItemId = "10000000-0000-4000-8000-000000000019";
    const paidOutActiveItemId = "10000000-0000-4000-8000-000000000020";
    const settlementLineId = "10000000-0000-4000-8000-000000000021";
    const settlementId = "10000000-0000-4000-8000-000000000022";
    const stripeTransferId = "tr_partial_failure_123";

    const event = makeEvent();
    const partiallyRefundedOrder: OrderRecord = {
      id: partialOrderId,
      eventId: EVENT_ID,
      buyerHumanId: BUYER_ID,
      amountGrossCents: 15000,
      feesPlatformCents: 0,
      taxAmountCents: 300,
      currency: "usd",
      feePolicySnapshot: {},
      status: "PART_REFUNDED",
      stripePaymentIntentId: "pi_partial_failure_123",
      source: "PRIMARY",
      nonRefundable: false,
      occurredAt: NOW,
      paymentMethodType: "card",
      paidOutAt: null,
      parentOrderId: null,
      items: [
        {
          id: refundedItemId,
          orderId: partialOrderId,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { buyerTotalCents: 5500 },
          paidOutAt: null,
          refundedAt: NOW,
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
          status: "refunded",
        },
        {
          id: paidOutActiveItemId,
          orderId: partialOrderId,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { buyerTotalCents: 5500 },
          paidOutAt: NOW,
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
    };

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
            id: partialOrderId,
            stripePaymentIntentId: "pi_partial_failure_123",
            amountGrossCents: 15000,
            feesPlatformCents: 0,
          },
        ],
        total: 1,
      })),
      getById: vi.fn(async (orderId: string) =>
        orderId === partialOrderId ? partiallyRefundedOrder : null,
      ),
      markRefunded: vi.fn(async () => undefined),
    };
    const orderItemsRepo = {
      updateStatus: vi.fn(async () => undefined),
    };
    const ticketsRepo = {
      listByOrderId: vi.fn(async () => []),
    };
    const orderItemSettlementLinesRepo = {
      listByOrderItemIds: vi.fn(async () => [
        {
          orderItemId: paidOutActiveItemId,
          settlementLineId,
          amountCents: 4000,
        },
      ]),
    };
    const settlementLinesRepo = {
      getByIds: vi.fn(async () => [
        {
          id: settlementLineId,
          settlementId,
        },
      ]),
    };
    const settlementsRepo = {
      getByIds: vi.fn(async () => [
        {
          id: settlementId,
          payeeId: "payee-org",
          stripeTransferId,
        },
      ]),
    };
    const payeeLedger = createFakePayeeLedgerRepo();
    const imagesRepo = {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    };
    const auditRepo = {
      log: vi.fn(async () => undefined),
    };
    const resourceQuotasRepo = {
      incrementUsage: vi.fn(async () => undefined),
    };

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
      images: imagesRepo,
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
      audit: auditRepo,
      resourceQuotas: resourceQuotasRepo,
      // Booking-timeline reverse lookup: this event never came from a booking.
      agreements: { findByLinkedEventId: vi.fn(async () => null) },
    } as unknown as TxRepos;

    const payments = {
      refundPaymentIntent: vi.fn(async () => ({
        refundId: "re_partial_failure_test",
        status: "succeeded",
      })),
      reverseTransfer: vi.fn(async () => {
        throw new Error("reverse failed");
      }),
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    };

    const repos = {
      ...txRepos,
      payoutItems: {
        listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
      },
      orderItemSettlementLines: orderItemSettlementLinesRepo,
      settlementLines: settlementLinesRepo,
      settlements: settlementsRepo,
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
    } as unknown as Repos;

    const deps: CancelEventDeps = {
      repos,
      authz: denyStaffAuthz,
      payments: payments as unknown as CancelEventDeps["payments"],
      idempotency: createFakeIdempotencyPort(),
      clock: { now: vi.fn(() => NOW) },
      logger: createTestLogger(),
    };

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.refundedOrderCount).toBe(0);
    expect(result.failedRefundCount).toBe(1);
    expect(payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: stripeTransferId,
        amountCents: 5650,
      }),
    );
    expect(payments.refundPaymentIntent).not.toHaveBeenCalled();
    expect(orderItemsRepo.updateStatus).not.toHaveBeenCalled();
    expect(ordersRepo.markRefunded).not.toHaveBeenCalled();
  });

  it("reuses stable provider idempotency keys across a retry after crashing before commit", async () => {
    const partialOrderId = "10000000-0000-4000-8000-000000000023";
    const paidOutActiveItemId = "10000000-0000-4000-8000-000000000024";
    const settlementLineId = "10000000-0000-4000-8000-000000000025";
    const settlementId = "10000000-0000-4000-8000-000000000026";
    const stripeTransferId = "tr_retry_123";

    const event = makeEvent();
    const order: OrderRecord = {
      id: partialOrderId,
      eventId: EVENT_ID,
      buyerHumanId: BUYER_ID,
      amountGrossCents: 10000,
      feesPlatformCents: 0,
      taxAmountCents: 100,
      currency: "usd",
      feePolicySnapshot: {},
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_retry_123",
      source: "PRIMARY",
      nonRefundable: false,
      occurredAt: NOW,
      paymentMethodType: "card",
      paidOutAt: null,
      parentOrderId: null,
      items: [
        {
          id: paidOutActiveItemId,
          orderId: partialOrderId,
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { buyerTotalCents: 5500 },
          paidOutAt: NOW,
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
    };

    const txRepos = {
      resaleListings: {
        cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
      },
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
          items: [
            {
              id: partialOrderId,
              stripePaymentIntentId: "pi_retry_123",
              amountGrossCents: 10000,
              feesPlatformCents: 0,
            },
          ],
          total: 1,
        })),
        getById: vi.fn(async (orderId: string) =>
          orderId === partialOrderId ? order : null,
        ),
        markRefunded: vi.fn(async () => undefined),
      },
      orderItems: {
        updateStatus: vi.fn(async () => undefined),
      },
      tickets: {
        listByOrderId: vi.fn(async () => []),
      },
      settlements: {
        // READ-only surface: the cancelFor* writes are deleted.
        getByIds: vi.fn(async () => [
          {
            id: settlementId,
            payeeId: "payee-org",
            stripeTransferId,
          },
        ]),
      },
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
        create: vi.fn(async () => undefined),
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

    const providerRefundRequestsSent: string[] = [];
    const providerReversalRequestsSent: string[] = [];
    const refundResponses = new Map<
      string,
      { refundId: string; status: "succeeded" }
    >();
    const reversalResponses = new Map<string, { reversalId: string }>();

    const payments = {
      refundPaymentIntent: vi.fn(async (input: { idempotencyKey?: string }) => {
        if (!input.idempotencyKey) {
          throw new Error("missing_refund_idempotency_key");
        }

        const cached = refundResponses.get(input.idempotencyKey);
        if (cached) {
          return cached;
        }

        providerRefundRequestsSent.push(input.idempotencyKey);
        const created = {
          refundId: "re_retry_123",
          status: "succeeded" as const,
        };
        refundResponses.set(input.idempotencyKey, created);
        return created;
      }),
      reverseTransfer: vi.fn(async (input: { idempotencyKey?: string }) => {
        if (!input.idempotencyKey) {
          throw new Error("missing_reversal_idempotency_key");
        }

        const cached = reversalResponses.get(input.idempotencyKey);
        if (cached) {
          return cached;
        }

        providerReversalRequestsSent.push(input.idempotencyKey);
        const created = { reversalId: "trr_retry_123" };
        reversalResponses.set(input.idempotencyKey, created);
        return created;
      }),
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
    };

    const repos = {
      ...txRepos,
      payoutItems: {
        listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
      },
      orderItemSettlementLines: {
        listByOrderItemIds: vi.fn(async () => [
          {
            orderItemId: paidOutActiveItemId,
            settlementLineId,
            amountCents: 4000,
          },
        ]),
      },
      settlementLines: {
        getByIds: vi.fn(async () => [
          {
            id: settlementLineId,
            settlementId,
          },
        ]),
      },
      settlements: txRepos.settlements,
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
        const result = await fn(txRepos);
        if ((repos.tx as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
          throw new Error("crash_after_stripe_before_commit");
        }
        return result;
      }),
    } as unknown as Repos;

    const deps: CancelEventDeps = {
      repos,
      authz: denyStaffAuthz,
      payments: payments as unknown as CancelEventDeps["payments"],
      idempotency: createFakeIdempotencyPort(),
      clock: { now: vi.fn(() => NOW) },
      logger: createTestLogger(),
    };

    await expect(
      cancelEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toThrow("crash_after_stripe_before_commit");

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.refundedOrderCount).toBe(1);
    expect(providerRefundRequestsSent).toEqual([
      `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${partialOrderId}:refund-payment-intent`,
    ]);
    expect(providerReversalRequestsSent).toEqual([
      `event:cancel:${ACTOR_ID}:${CLIENT_KEY}:order:${partialOrderId}:reverse-transfer:${stripeTransferId}`,
    ]);
  });
});
