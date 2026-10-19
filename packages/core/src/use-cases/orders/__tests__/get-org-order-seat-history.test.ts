import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { getOrgOrder } from "../get-org-order";

/**
 * REGRESSION — "a refunded line forgets which seat it sold".
 *
 * A voided ticket has to give up `Ticket.seatId`: the column is `@unique`, so
 * a dead row still holding it fails the NEXT buyer's mint with P2002 after
 * their card is charged. The cost is that `ticket.seatId` — the only thing
 * this view read — is null for every refunded item, and the org's order
 * detail lost the seat the moment it refunded it.
 *
 * `releaseSeatsForVoidedTickets` stamps the former seat onto the order item's
 * `meta.releasedSeatId` before clearing the link; this is the read side.
 */

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const REFUNDED_ITEM = "55555555-5555-4555-8555-555555555555";
const LIVE_ITEM = "66666666-6666-4666-8666-666666666666";
const REFUNDED_TICKET = "77777777-7777-4777-8777-777777777777";
const LIVE_TICKET = "88888888-8888-4888-8888-888888888888";
const TICKET_TYPE_ID = "99999999-9999-4999-8999-999999999999";
const FORMER_SEAT = "5ea70001-0000-4000-8000-00000000000c";
const LIVE_SEAT = "5ea70002-0000-4000-8000-00000000000d";

function makeDeps() {
  const items = [
    {
      id: REFUNDED_ITEM,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: TICKET_TYPE_ID,
      qty: 1,
      unitPriceCents: 5_000,
      amountCents: 5_000,
      // Stamped as the refund cleared the ticket's link.
      meta: { buyerTotalCents: 5_500, releasedSeatId: FORMER_SEAT },
      paidOutAt: null,
      refundedAt: new Date("2026-05-02T15:00:00.000Z"),
      transferredAt: null,
      status: "refunded",
    },
    {
      id: LIVE_ITEM,
      orderId: ORDER_ID,
      kind: "ticket",
      ticketTypeId: TICKET_TYPE_ID,
      qty: 1,
      unitPriceCents: 5_000,
      amountCents: 5_000,
      meta: { buyerTotalCents: 5_500 },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active",
    },
  ];

  const order = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 10_000,
    feesPlatformCents: 300,
    taxAmountCents: 0,
    currency: "usd",
    status: "PART_REFUNDED",
    source: "PRIMARY",
    stripePaymentIntentId: "pi_123",
    stripeTaxCalculationId: null,
    paymentMethodType: "card",
    parentOrderId: null,
    feePolicySnapshot: {},
    billingAddressLine1: null,
    occurredAt: new Date("2026-05-01T15:00:00.000Z"),
    paidOutAt: null,
    disputeStatus: null,
    items,
  };

  const repos = {
    orders: { getById: vi.fn(async () => order) },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        title: "Rock Show",
      })),
      listTicketTypes: vi.fn(async () => []),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
    },
    promos: { listRedemptionsByOrderId: vi.fn(async () => []) },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Drkmttr" })),
    },
    tickets: {
      listByOrderItemIds: vi.fn(async () => [
        {
          id: REFUNDED_TICKET,
          orderItemId: REFUNDED_ITEM,
          code: "tk_dead",
          scannedAt: null,
          // Cleared by the refund — this is the whole problem.
          seatId: null,
          ownerHumanId: BUYER_ID,
          status: "REFUNDED",
        },
        {
          id: LIVE_TICKET,
          orderItemId: LIVE_ITEM,
          code: "tk_live",
          scannedAt: null,
          seatId: LIVE_SEAT,
          ownerHumanId: BUYER_ID,
          status: "VALID",
        },
      ]),
    },
    earlyFraudWarnings: { findActiveForOrder: vi.fn(async () => null) },
    // The event credit's ledger read (OrderSplit rows); none written here.
    splits: { getForOrder: vi.fn(async () => []) },
  } as unknown as Repos;

  const authz = {
    canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  } as unknown as AuthZPort;

  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  return { repos, authz, reportError: vi.fn(), logger: logger as never };
}

describe("getOrgOrder — seat history", () => {
  it("still names the seat a refunded item sold, from the item's stamp", async () => {
    const out = await getOrgOrder(makeDeps(), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    const refunded = out.items.find((i) => i.id === REFUNDED_ITEM);
    expect(refunded?.seatId).toBe(FORMER_SEAT);
  });

  it("prefers the LIVE ticket's seat — the stamp is a fallback, not an override", async () => {
    const out = await getOrgOrder(makeDeps(), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    const live = out.items.find((i) => i.id === LIVE_ITEM);
    expect(live?.seatId).toBe(LIVE_SEAT);
  });
});
