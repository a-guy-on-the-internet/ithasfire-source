import { describe, expect, it, vi } from "vitest";

import { listMyEventOrders } from "../list-my-event-orders";

describe("listMyEventOrders", () => {
  it("returns human-owned event order rows and scopes to actorHumanId", async () => {
    const occurredAt = new Date("2026-05-01T12:00:00.000Z");
    const deps = {
      repos: {
        orders: {
          listForHumanOwnedEvents: vi.fn(async () => ({
            items: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                eventId: "33333333-3333-4333-8333-333333333333",
                eventTitle: "Human-Owned Event",
                orgId: null,
                buyerHumanId: "44444444-4444-4444-8444-444444444444",
                buyerName: "Buyer One",
                buyerEmail: "buyer@example.com",
                amountGrossCents: 2500,
                feesPlatformCents: 250,
                taxAmountCents: 125,
                currency: "USD",
                status: "SUCCEEDED",
                source: "PRIMARY",
                disputeStatus: null,
                stripePaymentIntentId: null,
                occurredAt,
              },
            ],
            total: 1,
          })),
        },
      },
      authz: {
        // not used
      },
    } as any;

    const result = await listMyEventOrders(deps, {
      actorHumanId: "11111111-1111-4111-8111-111111111111",
      limit: 5,
      offset: 0,
    });

    expect(deps.repos.orders.listForHumanOwnedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerHumanId: "11111111-1111-4111-8111-111111111111",
        limit: 5,
        offset: 0,
      }),
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "22222222-2222-4222-8222-222222222222",
        eventTitle: "Human-Owned Event",
        orgId: null,
        source: "PRIMARY",
        disputeStatus: null,
        occurredAt,
      }),
    ]);
    expect(result.pageInfo).toMatchObject({
      total: 1,
      count: 1,
      limit: 5,
      offset: 0,
    });
  });
});

describe("listMyEventOrders — DISPUTED filter", () => {
  it("sends the dispute-mirror filter to the repo instead of status = DISPUTED", async () => {
    const listForHumanOwnedEvents = vi.fn(async () => ({ items: [], total: 0 }));
    const deps = {
      repos: { orders: { listForHumanOwnedEvents } },
    } as any;

    await listMyEventOrders(deps, {
      actorHumanId: "11111111-1111-4111-8111-111111111111",
      status: "DISPUTED",
    });

    const call = listForHumanOwnedEvents.mock.calls[0]![0] as any;
    expect(call.status).toBeUndefined();
    expect(call.disputeStatuses).toEqual(["OPEN", "UNDER_REVIEW", "LOST"]);
  });
});
