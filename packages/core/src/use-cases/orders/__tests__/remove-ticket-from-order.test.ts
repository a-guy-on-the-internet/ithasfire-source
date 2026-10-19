import { describe, expect, it, vi } from "vitest";

import { removeTicketFromOrder } from "../remove-ticket-from-order";
import { updateOrderItems } from "../update-order-items";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos } from "@th/ports/repos";

vi.mock("../update-order-items", async () => {
  const actual = await vi.importActual<typeof import("../update-order-items")>(
    "../update-order-items",
  );
  return { ...actual, updateOrderItems: vi.fn() };
});

const updateOrderItemsMock = vi.mocked(updateOrderItems);

describe("removeTicketFromOrder", () => {
  it("removes seats from an existing ticket item", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const order: OrderRecord = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      buyerHumanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      amountGrossCents: 2000,
      feesPlatformCents: 0,
      currency: "usd",
      feePolicySnapshot: {},
      status: "PENDING",
      stripePaymentIntentId: null,
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
      items: [
        {
          id: "item-1",
          orderId: "order-1",
          kind: "ticket",
          ticketTypeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          qty: 2,
          unitPriceCents: 1000,
          amountCents: 2000,
          meta: {
            seatIds: [
              "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              "ffffffff-ffff-4fff-8fff-ffffffffffff",
            ],
          },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    };

    const repos = {
      orders: {
        getById: vi.fn(async () => order),
      },
    } as unknown as Repos;

    updateOrderItemsMock.mockResolvedValue({
      order: {
        id: order.id,
        eventId: order.eventId,
        buyerHumanId: order.buyerHumanId,
        amountGrossCents: order.amountGrossCents,
        feesPlatformCents: order.feesPlatformCents,
        buyerFeesCents: 0,
        processorFeeCents: 0,
        currency: order.currency,
        status: order.status,
        items: [],
      },
      holdExpiresAt: now.toISOString(),
    });

    const deps = {
      repos,
      clock: { now: () => now },
    };

    await removeTicketFromOrder(deps, {
      actorHumanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ticketTypeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      qty: 1,
      seatIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
    });

    expect(updateOrderItemsMock).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        items: [
          {
            ticketTypeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            qty: 1,
            seatIds: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
          },
        ],
      }),
    );
  });
});
