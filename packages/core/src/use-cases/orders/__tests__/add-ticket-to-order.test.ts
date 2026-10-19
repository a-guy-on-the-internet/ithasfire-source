import { describe, expect, it, vi } from "vitest";

import { addTicketToOrder } from "../add-ticket-to-order";
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

describe("addTicketToOrder", () => {
  it("adds seats to an existing ticket item", async () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const order: OrderRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      eventId: "22222222-2222-4222-8222-222222222222",
      buyerHumanId: "33333333-3333-4333-8333-333333333333",
      amountGrossCents: 1000,
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
          orderId: "11111111-1111-4111-8111-111111111111",
          kind: "ticket",
          ticketTypeId: "44444444-4444-4444-8444-444444444444",
          qty: 1,
          unitPriceCents: 1000,
          amountCents: 1000,
          meta: { seatIds: ["55555555-5555-4555-8555-555555555555"] },
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

    await addTicketToOrder(deps, {
      actorHumanId: "33333333-3333-4333-8333-333333333333",
      eventId: "22222222-2222-4222-8222-222222222222",
      orderId: "11111111-1111-4111-8111-111111111111",
      ticketTypeId: "44444444-4444-4444-8444-444444444444",
      qty: 1,
      seatIds: ["66666666-6666-4666-8666-666666666666"],
    });

    expect(updateOrderItemsMock).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        orderId: "11111111-1111-4111-8111-111111111111",
        items: [
          {
            ticketTypeId: "44444444-4444-4444-8444-444444444444",
            qty: 2,
            seatIds: [
              "55555555-5555-4555-8555-555555555555",
              "66666666-6666-4666-8666-666666666666",
            ],
          },
        ],
      }),
    );
  });
});
