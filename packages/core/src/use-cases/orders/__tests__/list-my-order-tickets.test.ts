import { describe, expect, it, vi } from "vitest";

import { listMyOrderTickets } from "../list-my-order-tickets";
import type { Repos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { TicketRecord } from "@th/ports/repos/tickets";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ITEM_ID = "55555555-5555-4555-8555-555555555555";
const TICKET_TYPE_ID = "66666666-6666-4666-8666-666666666666";

const baseOrder: OrderRecord = {
  id: ORDER_ID,
  eventId: "event-1",
  buyerHumanId: ACTOR_ID,
  amountGrossCents: 2500,
  feesPlatformCents: 0,
  currency: "usd",
  feePolicySnapshot: {},
  status: "SUCCEEDED",
  stripePaymentIntentId: "pi_123",
  source: "PRIMARY",
  nonRefundable: false,
  occurredAt: new Date(),
  parentOrderId: null,
  taxAmountCents: 0,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  stripeTaxCalculationId: null,
  items: [],
};

const baseTicket: TicketRecord = {
  id: TICKET_ID,
  eventId: "event-1",
  ticketTypeId: TICKET_TYPE_ID,
  ownerHumanId: ACTOR_ID,
  orderId: ORDER_ID,
  orderItemId: ORDER_ITEM_ID,
  seatId: null,
  code: "TICKET-CODE",
  status: "VALID",
  issuedAt: new Date(),
  scannedAt: null,
};

describe("listMyOrderTickets", () => {
  it("returns ticket details for the buyer", async () => {
    const repos = {
      orders: {
        getById: vi.fn().mockResolvedValue(baseOrder),
      },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([baseTicket]),
      },
    } as unknown as Repos;

    const result = await listMyOrderTickets(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toMatchObject({
      id: TICKET_ID,
      code: "TICKET-CODE",
      status: "VALID",
      orderItemId: ORDER_ITEM_ID,
      ticketTypeId: TICKET_TYPE_ID,
    });
  });

  it("rejects access for non-buyers who own no tickets in the order", async () => {
    const repos = {
      orders: {
        getById: vi
          .fn()
          .mockResolvedValue({ ...baseOrder, buyerHumanId: OTHER_ID }),
      },
      tickets: {
        // Order belongs to OTHER_ID; ACTOR is not in the ownership set.
        listByOrderId: vi
          .fn()
          .mockResolvedValue([{ ...baseTicket, ownerHumanId: OTHER_ID }]),
        getById: vi.fn(),
      },
    } as unknown as Repos;

    await expect(
      listMyOrderTickets(
        { repos },
        { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("returns only the recipient's owned tickets when actor is a transfer recipient", async () => {
    const otherTicketId = "77777777-7777-4777-8777-777777777777";
    const repos = {
      orders: {
        // Original buyer is OTHER_ID; ACTOR received one ticket via transfer.
        getById: vi
          .fn()
          .mockResolvedValue({ ...baseOrder, buyerHumanId: OTHER_ID }),
      },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([
          {
            ...baseTicket,
            id: otherTicketId,
            ownerHumanId: OTHER_ID,
            code: "OTHER",
          },
          { ...baseTicket, ownerHumanId: ACTOR_ID, code: "MINE" },
        ]),
      },
    } as unknown as Repos;

    const result = await listMyOrderTickets(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toMatchObject({ id: TICKET_ID, code: "MINE" });
  });

  it("buyer still sees every ticket on the order even after transferring some out", async () => {
    const otherTicketId = "77777777-7777-4777-8777-777777777777";
    const repos = {
      orders: {
        getById: vi.fn().mockResolvedValue(baseOrder),
      },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([
          { ...baseTicket, code: "KEPT" },
          {
            ...baseTicket,
            id: otherTicketId,
            ownerHumanId: OTHER_ID,
            code: "GIFTED",
          },
        ]),
      },
    } as unknown as Repos;

    const result = await listMyOrderTickets(
      { repos },
      { actorHumanId: ACTOR_ID, orderId: ORDER_ID },
    );

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets.map((t) => t.code).sort()).toEqual([
      "GIFTED",
      "KEPT",
    ]);
  });
});
