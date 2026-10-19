import { describe, it, expect } from "vitest";
import { getMyOrder } from "../get-my-order";

const now = new Date();

// Valid UUIDs for testing (v4 format)
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_TYPE_ID = "55555555-5555-4555-8555-555555555555";

describe("getMyOrder", () => {
  it("returns items using the canonical orderItem schema subtype", async () => {
    const mockOrder = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      buyerHumanId: HUMAN_ID,
      amountGrossCents: 12345,
      feesPlatformCents: 345,
      currency: "usd",
      feePolicySnapshot: {},
      status: "SUCCEEDED",
      stripePaymentIntentId: null,
      source: "PRIMARY",
      nonRefundable: false,
      occurredAt: now,
      paidOutAt: null,
      parentOrderId: null,
      items: [
        {
          id: ITEM_ID,
          orderId: ORDER_ID,
          kind: "ticket",
          ticketTypeId: TICKET_TYPE_ID,
          qty: 1,
          unitPriceCents: 12000,
          amountCents: 12000,
          meta: {},
          paidOutAt: now,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        },
      ],
    } as any;

    const deps = {
      repos: {
        orders: {
          getById: async () => mockOrder,
        },
        events: {
          getById: async () => ({
            id: EVENT_ID,
            title: "Event",
            startsAt: now,
            addressText: "123 Main",
            locality: "City",
          }),
          listTicketTypes: async () => [
            { id: TICKET_TYPE_ID, name: "General Admission" },
          ],
        },
        organizations: {
          getById: async () => null,
        },
        tickets: {
          viewerHoldsActiveTicketForEvent: async () => true,
        },
      },
    } as any;

    const result = await getMyOrder(deps, {
      actorHumanId: HUMAN_ID,
      orderId: ORDER_ID,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.id).toBe(ITEM_ID);
    expect(item.qty).toBe(1);
    expect(item.amountCents).toBe(12000);
    expect(item.kind).toBe("ticket");
    expect(item.ticketTypeId).toBe(TICKET_TYPE_ID);
    expect(item.paidOutAt).toEqual(now);
    expect(item.refundedAt).toBeNull();
    expect(item.transferredAt).toBeNull();
    expect(item.status).toBe("active");

    // Verify ticket type names are resolved
    expect(result.ticketTypeNames).toEqual({
      [TICKET_TYPE_ID]: "General Admission",
    });
  });
});
