import { describe, it, expect, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { createClaim, type CreateClaimDeps } from "../create-claim";

// ── Constants ──────────────────────────────────────────────────────────────

const BUYER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const ORDER_ID = "aa222222-aa22-4a22-8a22-aa2222222222";
const ORDER_ITEM_ID = "aa333333-aa33-4a33-8a33-aa3333333333";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LISTING_ID = "aa444444-aa44-4a44-8a44-aa4444444444";
const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TICKET_ID = "aa555555-aa55-4a55-8a55-aa5555555555";
const GIFTEE_ID = "aa666666-aa66-4a66-8a66-aa6666666666";

// After event start, within claim window
const NOW = new Date("2026-04-02T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5000,
    currency: "usd",
    status: "SUCCEEDED",
    source: "RESALE",
    items: [
      {
        id: ORDER_ITEM_ID,
        kind: "ticket",
        resaleListingId: LISTING_ID,
        meta: { resaleListingId: LISTING_ID },
      },
    ],
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    startsAt: new Date("2026-04-01T19:00:00Z"),
    endsAt: new Date("2026-04-01T23:00:00Z"),
    ...overrides,
  };
}

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    sellerHumanId: SELLER_ID,
    ...overrides,
  };
}

// The order item and ticket as re-read under the claim lock. Default: the
// claimant still holds a VALID ticket on an active item.
function makeOrderItemRow(overrides: Record<string, unknown> = {}) {
  return { id: ORDER_ITEM_ID, orderId: ORDER_ID, status: "active", ...overrides };
}

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    orderItemId: ORDER_ITEM_ID,
    ownerHumanId: BUYER_ID,
    status: "VALID",
    ...overrides,
  };
}

function makeDeps(opts?: {
  order?: any;
  event?: any;
  listing?: any;
  existingClaim?: any;
  orderItemRow?: any;
  ticket?: any;
  now?: Date;
}) {
  const order = opts?.order !== undefined ? opts.order : makeOrder();
  const event = opts?.event !== undefined ? opts.event : makeEvent();
  const listing = opts?.listing !== undefined ? opts.listing : makeListing();
  const existingClaim =
    opts?.existingClaim !== undefined ? opts.existingClaim : null;
  const orderItemRow =
    opts?.orderItemRow !== undefined ? opts.orderItemRow : makeOrderItemRow();
  const ticket = opts?.ticket !== undefined ? opts.ticket : makeTicket();
  const now = opts?.now ?? NOW;

  const getOrderById = vi.fn(async () => order);
  const getEventById = vi.fn(async () => event);
  const getByOrderItemId = vi.fn(async () => existingClaim);
  const lockOrderItem = vi.fn(async () => {});
  const getListingById = vi.fn(async () => listing);
  const createCl = vi.fn(async (input: any) => ({
    id: CLAIM_ID,
    status: "open",
    ...input,
    createdAt: now,
    updatedAt: now,
  }));
  const auditLog = vi.fn(async () => {});
  const getOrderItemById = vi.fn(async () => orderItemRow);
  const getTicketByOrderItemId = vi.fn(async () => ticket);

  const ordersRepo = { getById: getOrderById } as any;
  const eventsRepo = { getById: getEventById } as any;
  const claimsRepo = {
    getByOrderItemId,
    lockOrderItem,
    create: createCl,
  } as any;
  const listingsRepo = { getById: getListingById } as any;
  const auditRepo = { log: auditLog } as any;
  const orderItemsRepo = { getById: getOrderItemById } as any;
  const ticketsRepo = { getByOrderItemId: getTicketByOrderItemId } as any;

  const repos = {
    orders: ordersRepo,
    events: eventsRepo,
    claims: claimsRepo,
    resaleListings: listingsRepo,
    audit: auditRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    tx: vi.fn(async (fn: any) =>
      fn({
        orders: ordersRepo,
        events: eventsRepo,
        claims: claimsRepo,
        resaleListings: listingsRepo,
        audit: auditRepo,
        orderItems: orderItemsRepo,
        tickets: ticketsRepo,
      }),
    ),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => now };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  return {
    deps: { repos, clock, logger } satisfies CreateClaimDeps,
    mocks: {
      getOrderById,
      getEventById,
      getByOrderItemId,
      lockOrderItem,
      getListingById,
      createCl,
      auditLog,
      getOrderItemById,
      getTicketByOrderItemId,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createClaim", () => {
  it("creates a claim and returns claimId, status, and deadline", async () => {
    const { deps, mocks } = makeDeps();

    const result = await createClaim(deps, {
      actorHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ORDER_ITEM_ID,
      kind: "ticket_invalid",
      evidence: { description: "QR didn't scan" },
    });

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.status).toBe("open");
    expect(result.deadline).toBeTruthy();

    // Should have created the claim with correct respondentId
    expect(mocks.createCl).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        eventId: EVENT_ID,
        claimantId: BUYER_ID,
        respondentId: SELLER_ID,
        kind: "ticket_invalid",
      }),
    );

    // Should have audited the creation
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "claim",
        action: "created",
      }),
    );
  });

  it("stores the sanitized, trimmed description", async () => {
    const { deps, mocks } = makeDeps();

    await createClaim(deps, {
      actorHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ORDER_ITEM_ID,
      kind: "ticket_invalid",
      evidence: { description: "  QR <b>didn't</b> scan\n\n\n\nat gate 3  " },
    });

    expect(mocks.createCl).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: { description: "QR didn't scan\n\nat gate 3" },
      }),
    );
  });

  // v1 evidence is the buyer's written description: anything else is refused
  // before the order is read.
  it.each([
    ["missing", undefined],
    ["an empty object", {}],
    ["an empty description", { description: "" }],
    ["a whitespace-only description", { description: "  \n " }],
    ["a description over 2000 chars", { description: "x".repeat(2001) }],
    ["an extra key", { description: "bad", photos: ["u"] }],
  ])("rejects evidence that is %s", async (_label, evidence) => {
    const { deps, mocks } = makeDeps();

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    expect(mocks.createCl).not.toHaveBeenCalled();
  });

  it("throws not_found when order does not exist", async () => {
    const { deps } = makeDeps({ order: null });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "ORDER_NOT_FOUND" }));
  });

  it("throws forbidden when actor is not the buyer", async () => {
    const { deps } = makeDeps({
      order: makeOrder({ buyerHumanId: "other-buyer" }),
    });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("throws claim_not_resale_order when order source is not RESALE", async () => {
    const { deps } = makeDeps({
      order: makeOrder({ source: "PRIMARY" }),
    });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_NOT_RESALE_ORDER" }),
    );
  });

  it("throws not_found when order item does not belong to order", async () => {
    const { deps } = makeDeps({
      order: makeOrder({
        items: [
          {
            id: "different-item",
            kind: "ticket",
            resaleListingId: null,
            meta: {},
          },
        ],
      }),
    });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "ORDER_ITEM_NOT_FOUND" }));
  });

  it("prefers orderItem.resaleListingId over legacy meta", async () => {
    const { deps, mocks } = makeDeps({
      order: makeOrder({
        items: [
          {
            id: ORDER_ITEM_ID,
            kind: "ticket",
            resaleListingId: LISTING_ID,
            meta: {},
          },
        ],
      }),
    });

    await createClaim(deps, {
      actorHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ORDER_ITEM_ID,
      kind: "ticket_invalid",
      evidence: { description: "QR didn't scan" },
    });

    expect(mocks.getListingById).toHaveBeenCalledWith(LISTING_ID);
  });

  it("falls back to legacy meta when canonical resaleListingId is missing", async () => {
    const { deps, mocks } = makeDeps({
      order: makeOrder({
        items: [
          {
            id: ORDER_ITEM_ID,
            kind: "ticket",
            resaleListingId: null,
            meta: { resaleListingId: LISTING_ID },
          },
        ],
      }),
    });

    await createClaim(deps, {
      actorHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ORDER_ITEM_ID,
      kind: "ticket_invalid",
      evidence: { description: "QR didn't scan" },
    });

    expect(mocks.getListingById).toHaveBeenCalledWith(LISTING_ID);
  });

  it("throws claim_window_not_open when event has not started", async () => {
    const { deps } = makeDeps({
      now: new Date("2026-03-30T12:00:00Z"), // before startsAt
    });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_WINDOW_NOT_OPEN" }),
    );
  });

  it("throws claim_window_expired when past the 3-day window", async () => {
    const { deps } = makeDeps({
      now: new Date("2026-04-10T12:00:00Z"), // well past endsAt + 3 days
    });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_WINDOW_EXPIRED" }),
    );
  });

  it("refuses a claim filed AT the deadline instant (half-open window — the credits mature then)", async () => {
    // endsAt 2026-04-01T23:00Z + 3 days.
    const { deps } = makeDeps({ now: new Date("2026-04-04T23:00:00.000Z") });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_WINDOW_EXPIRED" }),
    );
  });

  it("accepts a claim one millisecond before the deadline", async () => {
    const { deps } = makeDeps({ now: new Date("2026-04-04T22:59:59.999Z") });

    const result = await createClaim(deps, {
      actorHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ORDER_ITEM_ID,
      kind: "ticket_invalid",
      evidence: { description: "QR didn't scan" },
    });

    expect(result.status).toBe("open");
    expect(result.deadline).toBe("2026-04-04T23:00:00.000Z");
  });

  it("throws claim_already_exists when a claim already exists on the order item", async () => {
    const { deps } = makeDeps({
      existingClaim: { id: "existing-claim", status: "open" },
    });

    await expect(
      createClaim(deps, {
        actorHumanId: BUYER_ID,
        orderId: ORDER_ID,
        orderItemId: ORDER_ITEM_ID,
        kind: "ticket_invalid",
        evidence: { description: "QR didn't scan" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "CLAIM_ALREADY_EXISTS" }),
    );
  });

  it("uses startsAt as event end when endsAt is null (single time event)", async () => {
    // With endsAt null, deadline = startsAt + 3 days = 2026-04-04T19:00:00Z
    // NOW is 2026-04-02, which is within the window
    const { deps } = makeDeps({
      event: makeEvent({ endsAt: null }),
    });

    const result = await createClaim(deps, {
      actorHumanId: BUYER_ID,
      orderId: ORDER_ID,
      orderItemId: ORDER_ITEM_ID,
      kind: "wrong_seat",
      evidence: { description: "QR didn't scan" },
    });

    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.status).toBe("open");
  });
});

// ── Owner ruling 2026-10-04: a ticket under an unresolved claim is frozen.
// Every move takes the order item's claim lock before its "no unresolved
// claim" check; createClaim takes the SAME lock before its existing-claim
// check, so a move never passes while this claim is uncommitted.
describe("createClaim — order item claim lock", () => {
  const input = {
    actorHumanId: BUYER_ID,
    orderId: ORDER_ID,
    orderItemId: ORDER_ITEM_ID,
    kind: "ticket_invalid" as const,
    evidence: { description: "QR didn't scan" },
  };

  it("takes the lock on the claimed order item before the existing-claim check and the insert", async () => {
    const { deps, mocks } = makeDeps();

    await createClaim(deps, input);

    expect(mocks.lockOrderItem).toHaveBeenCalledTimes(1);
    expect(mocks.lockOrderItem).toHaveBeenCalledWith(ORDER_ITEM_ID);
    const lockAt = mocks.lockOrderItem.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(
      mocks.getByOrderItemId.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(mocks.createCl.mock.invocationCallOrder[0]!);
  });

  it("still holds the lock when it refuses a duplicate claim", async () => {
    const { deps, mocks } = makeDeps({
      existingClaim: { id: CLAIM_ID, status: "open" },
    });

    await expect(createClaim(deps, input)).rejects.toMatchObject({
      code: "CLAIM_ALREADY_EXISTS",
    });
    expect(mocks.lockOrderItem).toHaveBeenCalledWith(ORDER_ITEM_ID);
    expect(mocks.createCl).not.toHaveBeenCalled();
  });
});

// ── Owner ruling 2026-10-04: "THey shouldn't be able to file that claim."
// Approving a full_refund moves the ticket back to the seller from whoever
// holds it, so a buyer who no longer holds the ticket can't file a claim.
describe("createClaim — the claimant must still hold the ticket", () => {
  const input = {
    actorHumanId: BUYER_ID,
    orderId: ORDER_ID,
    orderItemId: ORDER_ITEM_ID,
    kind: "ticket_invalid" as const,
    evidence: { description: "QR didn't scan" },
  };

  const refusals: Array<[string, Parameters<typeof makeDeps>[0]]> = [
    [
      "the item was transferred (gift, email transfer or resale)",
      { orderItemRow: makeOrderItemRow({ status: "transferred" }) },
    ],
    [
      "the item was refunded",
      { orderItemRow: makeOrderItemRow({ status: "refunded" }) },
    ],
    [
      "the item row is gone",
      { orderItemRow: null },
    ],
    [
      "someone else owns the ticket",
      { ticket: makeTicket({ ownerHumanId: GIFTEE_ID }) },
    ],
    [
      "the ticket is LISTED for resale",
      { ticket: makeTicket({ status: "LISTED" }) },
    ],
    [
      "the ticket is REFUNDED",
      { ticket: makeTicket({ status: "REFUNDED" }) },
    ],
    ["there is no ticket on the item", { ticket: null }],
  ];

  it.each(refusals)(
    "refuses with CLAIM_TICKET_NOT_HELD when %s",
    async (_label, opts) => {
      const { deps, mocks } = makeDeps(opts);

      await expect(createClaim(deps, input)).rejects.toMatchObject({
        code: "CLAIM_TICKET_NOT_HELD",
      });
      expect(mocks.createCl).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
    },
  );

  it("refuses even though the order read (taken before the lock) still shows the item", async () => {
    // The pre-lock order read says `active`; the re-read under the lock says
    // the item has moved on. The re-read decides.
    const { deps, mocks } = makeDeps({
      order: makeOrder({
        items: [
          {
            id: ORDER_ITEM_ID,
            kind: "ticket",
            status: "active",
            resaleListingId: LISTING_ID,
            meta: {},
          },
        ],
      }),
      orderItemRow: makeOrderItemRow({ status: "transferred" }),
      ticket: makeTicket({ ownerHumanId: GIFTEE_ID }),
    });

    await expect(createClaim(deps, input)).rejects.toMatchObject({
      code: "CLAIM_TICKET_NOT_HELD",
    });
    expect(mocks.getOrderItemById).toHaveBeenCalledWith(ORDER_ITEM_ID);
    expect(mocks.createCl).not.toHaveBeenCalled();
  });

  it.each(["VALID", "SCANNED", "INVALID"] as const)(
    "allows a %s ticket the claimant holds on an active item",
    async (status) => {
      const { deps, mocks } = makeDeps({ ticket: makeTicket({ status }) });

      const result = await createClaim(deps, { ...input, kind: "wrong_seat" });

      expect(result.claimId).toBe(CLAIM_ID);
      expect(mocks.getTicketByOrderItemId).toHaveBeenCalledWith(ORDER_ITEM_ID);
      expect(mocks.createCl).toHaveBeenCalledTimes(1);
      expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    },
  );

  it("reads the item and the ticket AFTER taking the order item lock", async () => {
    const { deps, mocks } = makeDeps();

    await createClaim(deps, input);

    const lockAt = mocks.lockOrderItem.mock.invocationCallOrder[0]!;
    const itemAt = mocks.getOrderItemById.mock.invocationCallOrder[0]!;
    const ticketAt = mocks.getTicketByOrderItemId.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(itemAt);
    expect(lockAt).toBeLessThan(ticketAt);
    expect(itemAt).toBeLessThan(mocks.createCl.mock.invocationCallOrder[0]!);
    expect(ticketAt).toBeLessThan(mocks.createCl.mock.invocationCallOrder[0]!);
  });

  it("reports CLAIM_ALREADY_EXISTS before the holder check when a claim is already open", async () => {
    const { deps, mocks } = makeDeps({
      existingClaim: { id: CLAIM_ID, status: "open" },
      orderItemRow: makeOrderItemRow({ status: "transferred" }),
    });

    await expect(createClaim(deps, input)).rejects.toMatchObject({
      code: "CLAIM_ALREADY_EXISTS",
    });
    expect(mocks.getOrderItemById).not.toHaveBeenCalled();
  });
});
