import { describe, expect, it, vi } from "vitest";

import { listPlatformOrders } from "../list-platform-orders";

const STAFF_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_HUMAN_ID = "33333333-3333-4333-8333-333333333333";

function makeOrder(id: string, buyerHumanId: string) {
  return {
    id,
    eventId: "44444444-4444-4444-8444-444444444444",
    // (id values supplied by callers below are valid v4-shaped UUIDs)
    eventTitle: "A Show",
    orgId: null,
    orgName: null,
    buyerHumanId,
    buyerName: "Buyer",
    buyerEmail: "buyer@example.com",
    kind: "TICKETING",
    amountGrossCents: 1000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: null,
    paymentMethodType: null,
    occurredAt: new Date("2026-06-23T11:00:00.000Z"),
    createdAt: new Date("2026-06-23T10:00:00.000Z"),
    updatedAt: new Date("2026-06-23T11:00:00.000Z"),
    itemCount: 1,
    feePolicySnapshot: null,
    billingCountry: null,
    billingAddress: null,
    stripeTaxCalculationId: null,
    parentOrderId: null,
    promo: null,
    items: [],
  };
}

function makeDeps(opts: { isStaff?: boolean; items?: unknown[] } = {}) {
  const allOrders = [
    makeOrder("55555555-5555-4555-8555-555555555551", HUMAN_ID),
    makeOrder("55555555-5555-4555-8555-555555555552", OTHER_HUMAN_ID),
  ];

  return {
    repos: {
      orders: {
        // Emulate the repo honoring the buyerHumanId filter so the test proves
        // the use case wires `humanId` → `buyerHumanId` end to end.
        listAll: vi.fn(async (input: { buyerHumanId?: string | null }) => {
          if (opts.items) return { items: opts.items, total: opts.items.length };
          const items = input.buyerHumanId
            ? allOrders.filter((o) => o.buyerHumanId === input.buyerHumanId)
            : allOrders;
          return { items, total: items.length };
        }),
      },
    },
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: opts.isStaff ?? true })),
    },
  } as any;
}

describe("listPlatformOrders", () => {
  it("forbids non-staff", async () => {
    const deps = makeDeps({ isStaff: false });

    await expect(
      listPlatformOrders(deps, { actorHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(deps.repos.orders.listAll).not.toHaveBeenCalled();
  });

  it("works without a humanId filter (optional/additive)", async () => {
    const deps = makeDeps();

    const result = await listPlatformOrders(deps, { actorHumanId: STAFF_ID });

    expect(result.items).toHaveLength(2);
    expect(deps.repos.orders.listAll).toHaveBeenCalledWith(
      expect.objectContaining({ buyerHumanId: undefined }),
    );
  });

  it("maps humanId → repo buyerHumanId and scopes to that buyer's orders", async () => {
    const deps = makeDeps();

    const result = await listPlatformOrders(deps, {
      actorHumanId: STAFF_ID,
      humanId: HUMAN_ID,
    });

    expect(deps.repos.orders.listAll).toHaveBeenCalledWith(
      expect.objectContaining({ buyerHumanId: HUMAN_ID }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ buyerHumanId: HUMAN_ID });
  });
});

describe("listPlatformOrders — DISPUTED filter", () => {
  it("translates status = DISPUTED into the dispute-mirror filter", async () => {
    const deps = makeDeps();

    await listPlatformOrders(deps, { actorHumanId: STAFF_ID, status: "DISPUTED" });

    const call = deps.repos.orders.listAll.mock.calls[0]![0] as any;
    expect(call.status).toBeUndefined();
    expect(call.statuses).toBeUndefined();
    expect(call.disputeStatuses).toEqual(["OPEN", "UNDER_REVIEW", "LOST"]);
  });

  it("splits a multi-select containing DISPUTED and keeps the rest on Order.status", async () => {
    const deps = makeDeps();

    await listPlatformOrders(deps, {
      actorHumanId: STAFF_ID,
      statuses: ["SUCCEEDED", "DISPUTED"],
    });

    const call = deps.repos.orders.listAll.mock.calls[0]![0] as any;
    expect(call.statuses).toEqual(["SUCCEEDED"]);
    expect(call.disputeStatuses).toEqual(["OPEN", "UNDER_REVIEW", "LOST"]);
  });
});

describe("listPlatformOrders — buyer charge lines", () => {
  const ticketItem = (meta: Record<string, unknown>) => ({
    id: "66666666-6666-4666-8666-666666666661",
    kind: "ticket",
    ticketTypeName: "GA",
    qty: 1,
    unitPriceCents: 1000,
    amountCents: 1000,
    status: "active",
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    ticketCode: null,
    ticketScannedAt: null,
    seatId: null,
    ticketOwnerName: null,
    meta,
  });

  it("ABSORB: Net charged is face + tax, and item meta never leaves the server", async () => {
    const order = {
      ...makeOrder("55555555-5555-4555-8555-555555555553", HUMAN_ID),
      feesPlatformCents: 33,
      taxAmountCents: 89,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items: [ticketItem({ buyerTotalCents: 1000, effectiveFeeMode: "ABSORB" })],
    };
    const deps = makeDeps({ items: [order] });

    const result = await listPlatformOrders(deps, { actorHumanId: STAFF_ID });

    const row = result.items[0]!;
    expect(row.feesPlatformCents).toBe(33); // recorded, organiser-paid
    expect(row.charges).toMatchObject({
      buyerFeeMode: "ABSORB",
      platformFeeCents: 0,
      processingFeeCents: 0,
      totalCents: 1089,
    });
    expect(row.items[0]).not.toHaveProperty("meta");
  });

  it("PASS_THROUGH: Net charged includes the processing fee the buyer paid", async () => {
    const order = {
      ...makeOrder("55555555-5555-4555-8555-555555555554", HUMAN_ID),
      feesPlatformCents: 33,
      taxAmountCents: 89,
      feePolicySnapshot: { feeMode: "PASS_THROUGH" },
      items: [ticketItem({ buyerTotalCents: 1097 })],
    };
    const deps = makeDeps({ items: [order] });

    const result = await listPlatformOrders(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]!.charges).toMatchObject({
      platformFeeCents: 33,
      processingFeeCents: 64,
      totalCents: 1186,
    });
  });
});
