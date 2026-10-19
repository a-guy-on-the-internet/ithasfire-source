import { describe, expect, it, vi } from "vitest";

import { estimateResaleListing } from "../estimate-resale-listing";

const SELLER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ITEM_ID = "aa333333-aa33-4a33-8a33-aa3333333333";
const ORDER_ID = "aa444444-aa44-4a44-8a44-aa4444444444";

type Opts = {
  item?: Record<string, unknown>;
  resaleCapCents?: number | null;
  eventClause?: Record<string, unknown>;
  ownerHumanId?: string;
  resaleAllowed?: boolean;
};

function makeDeps(opts: Opts = {}) {
  const fillResaleClauseIfUnset = vi.fn(async () => true);
  const repos = {
    tickets: {
      getById: vi.fn(async () => ({
        id: TICKET_ID,
        eventId: EVENT_ID,
        ownerHumanId: opts.ownerHumanId ?? SELLER_ID,
        ticketTypeId: "type-1",
        orderItemId: ITEM_ID,
      })),
      getTicketTypeById: vi.fn(async () => ({
        id: "type-1",
        resaleAllowed: opts.resaleAllowed ?? true,
        resaleCapCents:
          opts.resaleCapCents === undefined ? null : opts.resaleCapCents,
      })),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        currency: "usd",
        resalePayoutTermsId: "terms-1",
      })),
    },
    orderItems: {
      getById: vi.fn(async () => ({
        id: ITEM_ID,
        orderId: ORDER_ID,
        kind: "ticket",
        unitPriceCents: 4000,
        amountCents: 4000,
        meta: {},
        status: "active",
        ...opts.item,
      })),
      fillResaleClauseIfUnset,
    },
    orders: {
      getById: vi.fn(async () => ({ id: ORDER_ID, source: "PRIMARY" })),
    },
    payoutTerms: {
      getById: vi.fn(async () => ({
        id: "terms-1",
        version: 3,
        resaleShareType: "PERCENT",
        resaleShareBps: 1000,
        resaleShareCents: null,
        resaleSharePayer: "SELLER",
        ...opts.eventClause,
      })),
    },
  };
  return { deps: { repos } as never, fillResaleClauseIfUnset };
}

const estimate = (deps: never, askPriceCents: number, actor = SELLER_ID) =>
  estimateResaleListing(deps, {
    actorHumanId: actor,
    ticketId: TICKET_ID,
    askPriceCents,
  });

const recorded = (clause: Record<string, unknown>) => ({
  resaleClauseTermsId: "first-sale-terms",
  resaleClauseTermsVersion: 1,
  resaleClauseBps: null,
  resaleClauseCents: null,
  originalUnitPriceCents: 4000,
  ...clause,
});

describe("estimateResaleListing (the seller form's numbers, NFR-002)", () => {
  it("a $40 ticket under a 10% SELLER clause at $50: $5 to the night, $45 to the seller, original $40", async () => {
    const { deps } = makeDeps({
      item: recorded({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClausePayer: "SELLER",
      }),
    });

    await expect(estimate(deps, 5000)).resolves.toEqual({
      ticketId: TICKET_ID,
      currency: "usd",
      askPriceCents: 5000,
      shareCents: 500,
      shareHeld: false,
      heldFromCents: null,
      sellerReceivesCents: 4500,
      basisCents: 5000,
      payer: "SELLER",
      originalPriceCents: 4000,
      capCents: null,
      withinCap: true,
      highestFittingAskCents: null,
    });
  });

  it("a FLAT $8 clause on $50 shows the held $5 and the clause's $8", async () => {
    const { deps } = makeDeps({
      item: recorded({
        resaleClauseType: "FLAT",
        resaleClauseCents: 800,
        resaleClausePayer: "SELLER",
      }),
    });

    await expect(estimate(deps, 5000)).resolves.toMatchObject({
      shareCents: 500,
      shareHeld: true,
      heldFromCents: 800,
      sellerReceivesCents: 4500,
    });
  });

  it("a BUYER clause at a $40 cap: a $40 ask is over (not refused here) and $36.37 is offered", async () => {
    const { deps } = makeDeps({
      resaleCapCents: 4000,
      item: recorded({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClausePayer: "BUYER",
      }),
    });

    await expect(estimate(deps, 4000)).resolves.toMatchObject({
      shareCents: 400,
      sellerReceivesCents: 4000,
      basisCents: 4400,
      payer: "BUYER",
      capCents: 4000,
      withinCap: false,
      highestFittingAskCents: 3637,
    });
    await expect(estimate(deps, 3637)).resolves.toMatchObject({
      basisCents: 4000,
      withinCap: true,
    });
  });

  it("the ticket's recorded clause wins over the event's changed one (R10)", async () => {
    const { deps } = makeDeps({
      eventClause: { resaleShareBps: 500 },
      item: recorded({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClausePayer: "SELLER",
      }),
    });

    await expect(estimate(deps, 7000)).resolves.toMatchObject({
      shareCents: 700,
    });
  });

  it("a ticket with no record is priced under the event's clause as it stands, and nothing is written", async () => {
    const { deps, fillResaleClauseIfUnset } = makeDeps({
      eventClause: { resaleShareBps: 500 },
    });

    await expect(estimate(deps, 5000)).resolves.toMatchObject({
      shareCents: 250,
      originalPriceCents: 4000,
    });
    expect(fillResaleClauseIfUnset).not.toHaveBeenCalled();
  });

  it("refuses someone else's ticket", async () => {
    const { deps } = makeDeps();

    await expect(estimate(deps, 5000, OTHER_ID)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("refuses when neither the ticket nor the event carries a clause", async () => {
    const { deps } = makeDeps({
      eventClause: { resaleShareType: null, resaleShareBps: null },
    });

    await expect(estimate(deps, 5000)).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
    });
  });

  it("refuses a type that does not allow resale", async () => {
    const { deps } = makeDeps({ resaleAllowed: false });

    await expect(estimate(deps, 5000)).rejects.toMatchObject({
      code: "RESALE_NOT_ALLOWED_FOR_TYPE",
    });
  });
});
