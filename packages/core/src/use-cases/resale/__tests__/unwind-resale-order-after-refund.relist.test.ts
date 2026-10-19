import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";

import { setListedNowPointer } from "../../_helpers/order-item-listing-pointer";
import { finalizeResalePurchase } from "../finalize-resale-purchase";
import {
  assertResaleOrderCanBeUnwound,
  unwindResaleOrderAfterRefund,
} from "../unwind-resale-order-after-refund";

// Owner ruling 2026-10-11: "Reselling is infinite". A ticket bought on resale
// can be listed and sold again, so the order being refunded may belong to a
// buyer who has since relisted the ticket, or sold it on.
//
// These tests run the REAL `finalizeResalePurchase` and
// `unwindResaleOrderAfterRefund` against one small in-memory world whose
// repos keep the adapter's rules that matter here: status compare-and-swaps,
// and one live (ACTIVE / HELD) listing per ticket, enforced on `create` AND
// on `unwindSale(..., "ACTIVE")` the way the partial unique index
// "Listing_ticketId_live_key" does.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const clock = { now: () => NOW };
const HELD_UNTIL = new Date("2026-10-11T12:10:00.000Z");

const TICKET = "ticket-1";
const A = "human-a"; // bought from the organizer
const B = "human-b"; // bought from A
const C = "human-c"; // bought from B
const O_A = "order-a";
const I_A = "item-a";
const O_B = "order-b";
const I_B = "item-b";
const O_C = "order-c";
const I_C = "item-c";
const L1 = "listing-1"; // A's
const L2 = "listing-2"; // B's
const L3 = "listing-3";

type TicketRow = {
  id: string;
  status: string;
  ownerHumanId: string;
  orderId: string | null;
  orderItemId: string | null;
  code: string;
  scannedAt: Date | null;
};
type ListingRow = {
  id: string;
  ticketId: string;
  sellerHumanId: string;
  status: string;
  buyerOrderId: string | null;
  expiresAt: Date | null;
  saleCutoffAt: Date | null;
  eventShareCents: number | null;
  holdBuyerHumanId: string | null;
  seq: number;
};
type ItemRow = {
  id: string;
  orderId: string;
  kind: "ticket";
  status: string;
  resaleListingId: string | null;
  meta: Record<string, unknown>;
  refundedAt: Date | null;
  transferredAt: Date | null;
  ticketTypeId: null;
};
type OrderRow = {
  id: string;
  source: string;
  buyerHumanId: string;
  parentOrderId: string | null;
  status: string;
};

const LIVE = new Set(["ACTIVE", "HELD"]);

function makeWorld() {
  const tickets = new Map<string, TicketRow>();
  const listings = new Map<string, ListingRow>();
  const items = new Map<string, ItemRow>();
  const orders = new Map<string, OrderRow>();
  const calls: string[] = [];
  let seq = 0;

  const liveListingOf = (ticketId: string, exceptId?: string) =>
    [...listings.values()].find(
      (l) => l.ticketId === ticketId && LIVE.has(l.status) && l.id !== exceptId,
    );
  const liveIndexViolation = () =>
    Object.assign(new Error("unique constraint Listing_ticketId_live_key"), {
      code: "P2002",
    });

  const orderRecord = (orderId: string): OrderRecord | null => {
    const order = orders.get(orderId);
    if (!order) return null;
    return {
      ...order,
      items: [...items.values()]
        .filter((item) => item.orderId === orderId)
        .map((item) => ({ ...item, meta: { ...item.meta } })),
    } as unknown as OrderRecord;
  };

  const ticketsRepo = {
    getById: vi.fn(async (id: string) => {
      const row = tickets.get(id);
      return row ? { ...row } : null;
    }),
    getByIdForUpdate: vi.fn(async (id: string) => {
      calls.push("tickets.getByIdForUpdate");
      const row = tickets.get(id);
      return row ? { ...row } : null;
    }),
    getByOrderItemId: vi.fn(async (orderItemId: string) => {
      const row = [...tickets.values()].find(
        (t) => t.orderItemId === orderItemId,
      );
      return row ? { ...row } : null;
    }),
    transfer: vi.fn(
      async (input: {
        ticketId: string;
        fromHumanId: string;
        toHumanId: string;
      }) => {
        const row = tickets.get(input.ticketId)!;
        if (row.ownerHumanId !== input.fromHumanId) return false;
        row.ownerHumanId = input.toHumanId;
        return true;
      },
    ),
    restoreAfterResale: vi.fn(
      async (input: {
        ticketId: string;
        restoredOrderId: string | null;
        restoredOrderItemId: string | null;
        newCode: string;
      }) => {
        const row = tickets.get(input.ticketId)!;
        if (!["VALID", "SCANNED", "LISTED"].includes(row.status)) {
          throw { code: "conflict", message: "resale_restore_ticket_terminal" };
        }
        row.orderId = input.restoredOrderId;
        row.orderItemId = input.restoredOrderItemId;
        row.code = input.newCode;
        row.status = "VALID";
        row.scannedAt = null;
      },
    ),
    reassignForResale: vi.fn(
      async (input: {
        ticketId: string;
        newOrderId: string;
        newOrderItemId: string;
        newCode: string;
      }) => {
        const row = tickets.get(input.ticketId)!;
        if (row.status !== "LISTED") {
          throw {
            code: "conflict",
            message: "resale_reassign_ticket_not_listed",
          };
        }
        row.orderId = input.newOrderId;
        row.orderItemId = input.newOrderItemId;
        row.code = input.newCode;
        row.status = "VALID";
      },
    ),
    setStatus: vi.fn(
      async (
        id: string,
        status: string,
        opts?: { expectedStatus?: string },
      ) => {
        const row = tickets.get(id)!;
        if (opts?.expectedStatus && row.status !== opts.expectedStatus) {
          return false;
        }
        row.status = status;
        return true;
      },
    ),
  };

  const listingsRepo = {
    getById: vi.fn(async (id: string) => {
      const row = listings.get(id);
      return row ? { ...row } : null;
    }),
    getByTicketId: vi.fn(async (ticketId: string) => {
      const live = liveListingOf(ticketId);
      if (live) return { ...live };
      const latest = [...listings.values()]
        .filter((l) => l.ticketId === ticketId)
        .sort((x, y) => y.seq - x.seq)[0];
      return latest ? { ...latest } : null;
    }),
    create: vi.fn(
      async (input: { id: string; ticketId: string; sellerHumanId: string }) => {
        if (liveListingOf(input.ticketId)) {
          throw { code: "conflict", message: "resale_listing_live_exists" };
        }
        const row: ListingRow = {
          id: input.id,
          ticketId: input.ticketId,
          sellerHumanId: input.sellerHumanId,
          status: "ACTIVE",
          buyerOrderId: null,
          expiresAt: null,
          saleCutoffAt: null,
          eventShareCents: 500,
          holdBuyerHumanId: null,
          seq: ++seq,
        };
        listings.set(row.id, row);
        return { ...row };
      },
    ),
    cancel: vi.fn(async (id: string, sellerHumanId: string) => {
      calls.push("resaleListings.cancel");
      const row = listings.get(id);
      if (!row || row.status !== "ACTIVE" || row.sellerHumanId !== sellerHumanId) {
        return false;
      }
      row.status = "CANCELLED";
      return true;
    }),
    hold: vi.fn(async (id: string, buyerHumanId: string) => {
      const row = listings.get(id);
      if (!row || row.status !== "ACTIVE") return { ok: false };
      row.status = "HELD";
      row.holdBuyerHumanId = buyerHumanId;
      return { ok: true };
    }),
    commit: vi.fn(
      async (id: string, buyerHumanId: string, buyerOrderId: string) => {
        const row = listings.get(id);
        if (!row) return { ok: false };
        // As the adapter: a closed listing is never an "already committed".
        if (row.status === "CANCELLED" || row.status === "EXPIRED") {
          throw { code: "conflict", message: "resale_listing_not_sellable" };
        }
        if (row.holdBuyerHumanId !== buyerHumanId) return { ok: false };
        tickets.get(row.ticketId)!.ownerHumanId = buyerHumanId;
        if (row.status !== "HELD") {
          throw { code: "conflict", message: "resale_listing_commit_mismatch" };
        }
        row.status = "SOLD";
        row.buyerOrderId = buyerOrderId;
        row.holdBuyerHumanId = null;
        return { ok: true, ticketId: row.ticketId };
      },
    ),
    closeHeld: vi.fn(async (id: string) => {
      calls.push("resaleListings.closeHeld");
      const row = listings.get(id);
      if (!row || row.status !== "HELD") return { closed: false, hold: null };
      row.status = "CANCELLED";
      const hold = row.holdBuyerHumanId
        ? { buyerHumanId: row.holdBuyerHumanId, heldUntil: HELD_UNTIL }
        : null;
      row.holdBuyerHumanId = null;
      return { closed: true, hold };
    }),
    listOrdersForHold: vi.fn(async (listingId: string, buyerHumanId: string) =>
      [...orders.values()]
        .filter(
          (order) =>
            order.buyerHumanId === buyerHumanId &&
            [...items.values()].some(
              (item) =>
                item.orderId === order.id && item.resaleListingId === listingId,
            ),
        )
        .map((order) => ({
          id: order.id,
          status: order.status,
          holdExpiresAt: HELD_UNTIL.toISOString(),
        })),
    ),
    unwindSale: vi.fn(
      async (id: string, buyerOrderId: string, nextStatus: string) => {
        calls.push(`resaleListings.unwindSale:${id}:${nextStatus}`);
        const row = listings.get(id);
        if (!row || row.status !== "SOLD" || row.buyerOrderId !== buyerOrderId) {
          throw { code: "conflict", message: "resale_sale_unwind_mismatch" };
        }
        if (nextStatus === "ACTIVE" && liveListingOf(row.ticketId, id)) {
          throw liveIndexViolation();
        }
        row.status = nextStatus;
        row.buyerOrderId = null;
      },
    ),
  };

  const orderItemsRepo = {
    getById: vi.fn(async (id: string) => {
      const row = items.get(id);
      return row ? { ...row, meta: { ...row.meta } } : null;
    }),
    updateStatus: vi.fn(async (id: string, status: string, at: Date) => {
      const row = items.get(id)!;
      row.status = status;
      row.refundedAt = status === "refunded" ? at : null;
      row.transferredAt = status === "transferred" ? at : null;
      return true;
    }),
    setResaleListingId: vi.fn(async (id: string, listingId: string | null) => {
      items.get(id)!.resaleListingId = listingId;
    }),
  };

  const ordersRepo = {
    getById: vi.fn(async (id: string) => orderRecord(id)),
  };
  const audit = { log: vi.fn(async (_row: unknown) => undefined) };

  const tx = {
    tickets: ticketsRepo,
    resaleListings: listingsRepo,
    orderItems: orderItemsRepo,
    orders: ordersRepo,
    audit,
  } as unknown as TxRepos;

  // ── Scenario steps ───────────────────────────────────────────────────────

  /** A buys the ticket from the organizer. */
  const seedPrimaryPurchase = () => {
    orders.set(O_A, {
      id: O_A,
      source: "PRIMARY",
      buyerHumanId: A,
      parentOrderId: null,
      status: "SUCCEEDED",
    });
    items.set(I_A, {
      id: I_A,
      orderId: O_A,
      kind: "ticket",
      status: "active",
      resaleListingId: null,
      meta: {},
      refundedAt: null,
      transferredAt: null,
      ticketTypeId: null,
    });
    tickets.set(TICKET, {
      id: TICKET,
      status: "VALID",
      ownerHumanId: A,
      orderId: O_A,
      orderItemId: I_A,
      code: "CODE-A",
      scannedAt: null,
    });
  };

  /**
   * The ticket's holder lists it: the writes `createResaleListing` makes
   * (listing row, the purchase item's pointer through the one rule, ticket
   * VALID → LISTED).
   */
  const list = async (sellerHumanId: string, listingId: string) => {
    const ticket = tickets.get(TICKET)!;
    await listingsRepo.create({ id: listingId, ticketId: TICKET, sellerHumanId });
    await setListedNowPointer(tx, {
      orderItemId: ticket.orderItemId!,
      listingId,
      orderSource: orders.get(items.get(ticket.orderItemId!)!.orderId)!.source,
    });
    const listed = await ticketsRepo.setStatus(TICKET, "LISTED", {
      expectedStatus: "VALID",
    });
    expect(listed).toBe(true);
  };

  /** A buyer's checkout takes the listing: the pending order and the hold. */
  const startCheckout = async (
    listingId: string,
    buyerHumanId: string,
    orderId: string,
    itemId: string,
  ) => {
    const ticket = tickets.get(TICKET)!;
    orders.set(orderId, {
      id: orderId,
      source: "RESALE",
      buyerHumanId,
      parentOrderId: ticket.orderId,
      status: "PENDING",
    });
    items.set(itemId, {
      id: itemId,
      orderId,
      kind: "ticket",
      status: "active",
      // What `createResaleCheckout` writes: the listing bought through, in
      // the column and in meta, and the seller's order + item.
      resaleListingId: listingId,
      meta: {
        resaleListingId: listingId,
        resaleOriginalOrderId: ticket.orderId,
        resaleOriginalOrderItemId: ticket.orderItemId,
      },
      refundedAt: null,
      transferredAt: null,
      ticketTypeId: null,
    });
    expect(await listingsRepo.hold(listingId, buyerHumanId)).toEqual({
      ok: true,
    });
  };

  /** The whole purchase: checkout, then the real finalize. */
  const buy = async (
    listingId: string,
    buyerHumanId: string,
    orderId: string,
    itemId: string,
  ) => {
    await startCheckout(listingId, buyerHumanId, orderId, itemId);
    orders.get(orderId)!.status = "SUCCEEDED";
    await finalizeResalePurchase(tx, { order: orderRecord(orderId)!, clock });
  };

  /**
   * What every refund path does in its marking transaction: flip the order's
   * live ticket items to `refunded`, then run the real unwind.
   */
  const refund = async (
    orderId: string,
    opts: {
      listingDisposition?: "restore_active" | "cancel";
      reportError?: ReturnType<typeof vi.fn>;
      logger?: unknown;
    } = {},
  ) => {
    for (const item of orderRecord(orderId)!.items) {
      if (item.status === "active") {
        await orderItemsRepo.updateStatus(item.id, "refunded", NOW);
      }
    }
    // `orders.markRefunded`, in the same transaction, before the unwind.
    orders.get(orderId)!.status = "REFUNDED";
    await unwindResaleOrderAfterRefund(tx, {
      order: orderRecord(orderId)!,
      clock,
      listingDisposition: opts.listingDisposition,
      reportError: opts.reportError as never,
      logger: opts.logger as never,
    });
  };

  const auditRows = () =>
    (audit.log.mock.calls as unknown as Array<
      [{ entityId: string; action: string; data: Record<string, unknown> }]
    >).map(([row]) => row);

  return {
    tx,
    tickets,
    listings,
    items,
    orders,
    calls,
    repos: { ticketsRepo, listingsRepo, orderItemsRepo, ordersRepo, audit },
    orderRecord,
    seedPrimaryPurchase,
    list,
    startCheckout,
    buy,
    refund,
    auditRows,
  };
}

/** A lists, B buys: the one-hop state every case below starts from. */
async function worldWhereBBought() {
  const world = makeWorld();
  world.seedPrimaryPurchase();
  await world.list(A, L1);
  await world.buy(L1, B, O_B, I_B);
  world.repos.audit.log.mockClear();
  return world;
}

const snapshot = (world: ReturnType<typeof makeWorld>) => ({
  ticket: { ...world.tickets.get(TICKET)! },
  listings: Object.fromEntries(
    [...world.listings.values()].map((l) => [
      l.id,
      { status: l.status, buyerOrderId: l.buyerOrderId },
    ]),
  ),
});

// ── The pointer through the chain ──────────────────────────────────────────

describe("resale chain: each item keeps the listing it was bought through", () => {
  it("B's item still names A's listing after B lists, after C buys, and after C is refunded", async () => {
    const world = await worldWhereBBought();
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);
    // A's PRIMARY item was unlinked when its listing sold.
    expect(world.items.get(I_A)!.resaleListingId).toBeNull();

    await world.list(B, L2);
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);
    expect(world.tickets.get(TICKET)!.status).toBe("LISTED");

    await world.buy(L2, C, O_C, I_C);
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);
    expect(world.items.get(I_B)!.status).toBe("transferred");
    expect(world.items.get(I_C)!.resaleListingId).toBe(L2);
    // Each hop's sale is its own row.
    expect(world.listings.get(L1)!.buyerOrderId).toBe(O_B);
    expect(world.listings.get(L2)!.buyerOrderId).toBe(O_C);

    await world.refund(O_C);
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);
    expect(world.items.get(I_C)!.resaleListingId).toBe(L2);
  });
});

// ── Chain (i): refund of the last hop ──────────────────────────────────────

describe("resale chain: refund of C's order (A → B → C)", () => {
  async function chain() {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    world.repos.audit.log.mockClear();
    return world;
  }

  it("returns the ticket to B on B's item and puts B's listing back on sale", async () => {
    const world = await chain();
    const reportError = vi.fn();

    await world.refund(O_C, { reportError });

    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: B,
      orderId: O_B,
      orderItemId: I_B,
      status: "LISTED",
    });
    expect(world.items.get(I_B)!.status).toBe("active");
    expect(world.listings.get(L2)).toMatchObject({
      status: "ACTIVE",
      buyerOrderId: null,
    });
    // A's sale to B is untouched.
    expect(world.listings.get(L1)).toMatchObject({
      status: "SOLD",
      buyerOrderId: O_B,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("with the listing cancelled instead, B holds a VALID ticket and can list it again", async () => {
    const world = await chain();

    await world.refund(O_C, { listingDisposition: "cancel" });

    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: B,
      orderItemId: I_B,
      status: "VALID",
    });
    expect(world.listings.get(L2)!.status).toBe("CANCELLED");

    await world.list(B, L3);

    expect(world.listings.get(L3)).toMatchObject({
      status: "ACTIVE",
      sellerHumanId: B,
    });
    expect(world.tickets.get(TICKET)!.status).toBe("LISTED");
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);
  });

  it("then a refund of B's order closes B's listing and returns the ticket to A", async () => {
    const world = await chain();
    await world.refund(O_C); // ticket back with B, L2 ACTIVE again
    world.repos.audit.log.mockClear();
    const reportError = vi.fn();

    await world.refund(O_B, { reportError });

    expect(world.listings.get(L2)!.status).toBe("CANCELLED");
    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: A,
      orderId: O_A,
      orderItemId: I_A,
      status: "LISTED",
    });
    expect(world.listings.get(L1)).toMatchObject({
      status: "ACTIVE",
      buyerOrderId: null,
    });
    // A's PRIMARY item is active and listed-now through L1 again.
    expect(world.items.get(I_A)).toMatchObject({
      status: "active",
      resaleListingId: L1,
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});

// ── Case a: the refunded buyer's own listing is ACTIVE ─────────────────────

describe("unwind — the refunded buyer has an ACTIVE listing of their own (case a)", () => {
  it("closes it first, then unwinds as usual: ticket to the seller, sale back on", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    world.repos.audit.log.mockClear();
    world.calls.length = 0;
    const reportError = vi.fn();

    await world.refund(O_B, { reportError });

    expect(world.listings.get(L2)!.status).toBe("CANCELLED");
    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: A,
      orderItemId: I_A,
      status: "LISTED",
    });
    expect(world.listings.get(L1)).toMatchObject({
      status: "ACTIVE",
      buyerOrderId: null,
    });
    // Ticket row locked first, then B's listing, then the sale's listing.
    expect(world.calls).toEqual([
      "tickets.getByIdForUpdate",
      "resaleListings.cancel",
      `resaleListings.unwindSale:${L1}:ACTIVE`,
    ]);
    expect(world.repos.listingsRepo.cancel).toHaveBeenCalledWith(L2, B);
    // Both closures are on the audit trail.
    expect(world.auditRows()).toEqual([
      expect.objectContaining({
        entityId: L2,
        action: "cancelled",
        data: expect.objectContaining({
          reason: "seller_purchase_refunded",
          refundedOrderId: O_B,
          purchasedListingId: L1,
          ticketId: TICKET,
        }),
      }),
      expect.objectContaining({
        entityId: L1,
        action: "purchase_unwound_after_refund",
        data: expect.objectContaining({
          refundedOrderId: O_B,
          closedBuyerListingId: L2,
          listingStatusAfterRefund: "ACTIVE",
        }),
      }),
    ]);
    // Not a degraded result.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("with the sale cancelled instead (a claim, a cancelled event), the seller gets a VALID ticket", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);

    await world.refund(O_B, { listingDisposition: "cancel" });

    expect(world.listings.get(L2)!.status).toBe("CANCELLED");
    expect(world.listings.get(L1)!.status).toBe("CANCELLED");
    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: A,
      orderItemId: I_A,
      status: "VALID",
    });
  });

  it("carries on when the listing was closed by someone else since the read", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    // The expiry sweep got there between the read and the cancel.
    world.repos.listingsRepo.cancel.mockImplementationOnce(async () => {
      world.listings.get(L2)!.status = "EXPIRED";
      return false;
    });
    const reportError = vi.fn();

    await world.refund(O_B, { reportError });

    expect(world.tickets.get(TICKET)!.ownerHumanId).toBe(A);
    expect(world.listings.get(L1)!.status).toBe("ACTIVE");
    expect(reportError).not.toHaveBeenCalled();
  });
});

// ── Drift: a live listing on a ticket that is not LISTED ───────────────────

// The live-listing index is on the LISTING rows, not on the ticket's status.
// A ticket that reads VALID or SCANNED while a live row of the refunded
// buyer's is still open (drift) used to skip the close, reach
// `unwindSale(…, "ACTIVE")` and fail on the index, after Stripe had paid.
describe("unwind — the refunded buyer's listing is live but the ticket is not LISTED (drift)", () => {
  for (const drifted of ["VALID", "SCANNED"] as const) {
    it(`a ${drifted} ticket with an ACTIVE listing: the listing is closed and the refund commits`, async () => {
      const world = await worldWhereBBought();
      await world.list(B, L2);
      world.tickets.get(TICKET)!.status = drifted;
      world.calls.length = 0;
      const reportError = vi.fn();

      await expect(
        world.refund(O_B, { reportError }),
      ).resolves.toBeUndefined();

      expect(world.listings.get(L2)!.status).toBe("CANCELLED");
      expect(world.listings.get(L1)).toMatchObject({
        status: "ACTIVE",
        buyerOrderId: null,
      });
      expect(world.tickets.get(TICKET)).toMatchObject({
        ownerHumanId: A,
        orderItemId: I_A,
      });
      // Under the ticket lock, like the LISTED case.
      expect(world.calls.slice(0, 2)).toEqual([
        "tickets.getByIdForUpdate",
        "resaleListings.cancel",
      ]);
      expect(
        [...world.listings.values()].filter((l) => LIVE.has(l.status)),
      ).toHaveLength(1);
    });
  }

  it("a VALID ticket with a HELD listing: closed, the sale goes to CANCELLED, reported", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.startCheckout(L2, C, O_C, I_C);
    world.tickets.get(TICKET)!.status = "VALID";
    const reportError = vi.fn();

    await expect(world.refund(O_B, { reportError })).resolves.toBeUndefined();

    expect(world.listings.get(L2)!.status).toBe("CANCELLED");
    expect(world.listings.get(L1)!.status).toBe("CANCELLED");
    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: A,
      orderItemId: I_A,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_unwind_ticket_relisted_checkout_in_flight",
      }),
      expect.anything(),
    );
  });
});

// ── Case b: the refunded buyer's own listing is HELD ───────────────────────

describe("unwind — a checkout holds the refunded buyer's listing (case b)", () => {
  // C's checkout cannot complete either way: every refund path marks B's
  // item refunded before the unwind, and finalize refuses a refunded seller
  // item. So the ticket goes back to A (who is debited for this refund), and
  // the held listing is closed rather than left on sale.
  const expectReturnedToA = (
    world: ReturnType<typeof makeWorld>,
    reportError: ReturnType<typeof vi.fn>,
  ) => {
    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: A,
      orderId: O_A,
      orderItemId: I_A,
      status: "VALID",
    });
    // The sale is undone but NEVER put back on sale, whatever the caller's
    // disposition; the held listing is closed and its hold dropped.
    expect(world.listings.get(L1)).toMatchObject({
      status: "CANCELLED",
      buyerOrderId: null,
    });
    expect(world.listings.get(L2)).toMatchObject({
      status: "CANCELLED",
      buyerOrderId: null,
      holdBuyerHumanId: null,
    });
    // No ticket has two live listings, and none is left live at all.
    expect(
      [...world.listings.values()].filter((l) => LIVE.has(l.status)),
    ).toEqual([]);
    expect(world.items.get(I_A)).toMatchObject({
      status: "active",
      resaleListingId: null,
    });
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);

    const inFlight = {
      listingId: L2,
      listingClosed: true,
      listingStatusAfter: "CANCELLED",
      holdBuyerHumanId: C,
      heldUntil: HELD_UNTIL.toISOString(),
      orders: [{ id: O_C, status: "PENDING" }],
    };
    expect(world.auditRows()).toEqual([
      expect.objectContaining({
        entityId: L2,
        action: "cancelled",
        data: expect.objectContaining({
          reason: "seller_purchase_refunded_checkout_in_flight",
          refundedOrderId: O_B,
          purchasedListingId: L1,
          holdBuyerHumanId: C,
          inFlightOrders: [{ id: O_C, status: "PENDING" }],
        }),
      }),
      expect.objectContaining({
        entityId: L1,
        action: "purchase_unwound_after_refund",
        data: expect.objectContaining({
          refundedOrderId: O_B,
          refundedOrderItemId: I_B,
          ticketId: TICKET,
          sellerHumanId: A,
          restoredOrderItemId: I_A,
          listingStatusAfterRefund: "CANCELLED",
          ticketRestoredToSeller: true,
          checkoutInFlight: inFlight,
        }),
      }),
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_unwind_ticket_relisted_checkout_in_flight",
      }),
      expect.objectContaining({
        tags: {
          useCase: "unwindResaleOrderAfterRefund",
          reason: "relisted_checkout_in_flight",
        },
        extra: expect.objectContaining({
          orderId: O_B,
          ticketId: TICKET,
          sellerHumanId: A,
          ticketRestoredToSeller: true,
          purchasedListingId: L1,
          purchasedListingStatusAfter: "CANCELLED",
          checkoutInFlight: inFlight,
        }),
      }),
    );
  };

  it("returns the ticket to the seller, closes the held listing, cancels the sale, audits and reports", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.startCheckout(L2, C, O_C, I_C);
    world.repos.audit.log.mockClear();
    world.calls.length = 0;
    const reportError = vi.fn();

    // The default disposition would put L1 back on sale.
    await expect(world.refund(O_B, { reportError })).resolves.toBeUndefined();

    // A HELD listing is closed by its own compare-and-swap, never by the
    // seller's ACTIVE-only cancel. Ticket lock first, then the buyer's
    // listing, then the sale's listing.
    expect(world.repos.listingsRepo.cancel).not.toHaveBeenCalled();
    expect(world.calls).toEqual([
      "tickets.getByIdForUpdate",
      "resaleListings.closeHeld",
      `resaleListings.unwindSale:${L1}:CANCELLED`,
    ]);
    expectReturnedToA(world, reportError);
  });

  it("does the same when the close loses to a hold that lands after the read", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    world.repos.audit.log.mockClear();
    // C's hold flips the listing between the unwind's read and its cancel.
    world.repos.listingsRepo.cancel.mockImplementationOnce(async () => {
      await world.startCheckout(L2, C, O_C, I_C);
      return false;
    });
    const reportError = vi.fn();

    await expect(world.refund(O_B, { reportError })).resolves.toBeUndefined();

    expect(world.repos.listingsRepo.closeHeld).toHaveBeenCalledWith(L2);
    expectReturnedToA(world, reportError);
  });

  it("still hands the ticket back, with the sale CANCELLED, if the held listing could not be closed", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.startCheckout(L2, C, O_C, I_C);
    world.repos.audit.log.mockClear();
    // Cannot happen under the ticket lock; the unwind must not throw if it does.
    world.repos.listingsRepo.closeHeld.mockImplementationOnce(async () => ({
      closed: false,
      hold: null,
    }));
    const reportError = vi.fn();

    await expect(world.refund(O_B, { reportError })).resolves.toBeUndefined();

    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: A,
      orderItemId: I_A,
      status: "VALID",
    });
    // CANCELLED needs no live slot, so the still-HELD listing is no conflict.
    expect(world.listings.get(L1)!.status).toBe("CANCELLED");
    expect(world.listings.get(L2)!.status).toBe("HELD");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_unwind_ticket_relisted_checkout_in_flight",
      }),
      expect.objectContaining({
        extra: expect.objectContaining({
          checkoutInFlight: expect.objectContaining({
            listingId: L2,
            listingClosed: false,
            listingStatusAfter: "HELD",
          }),
        }),
      }),
    );
    // Even then the checkout cannot take the ticket: it is no longer LISTED.
    world.orders.get(O_C)!.status = "SUCCEEDED";
    await expect(
      finalizeResalePurchase(world.tx, {
        order: world.orderRecord(O_C)!,
        clock,
      }),
    ).rejects.toMatchObject({ message: "resale_reassign_ticket_not_listed" });
  });

  it("never lets a throwing reporter fail the refund's transaction", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.startCheckout(L2, C, O_C, I_C);

    await expect(
      world.refund(O_B, {
        reportError: vi.fn(() => {
          throw new Error("reporter down");
        }),
      }),
    ).resolves.toBeUndefined();
    expect(world.tickets.get(TICKET)!.ownerHumanId).toBe(A);
  });

  it("the third person's finalize is then refused and takes nothing", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.startCheckout(L2, C, O_C, I_C);
    await world.refund(O_B, { reportError: vi.fn() });
    const before = snapshot(world);
    // C's payment lands.
    world.orders.get(O_C)!.status = "SUCCEEDED";

    await expect(
      finalizeResalePurchase(world.tx, {
        order: world.orderRecord(O_C)!,
        clock,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_not_sellable",
    });

    // The ticket is still A's and no listing changed.
    expect(snapshot(world)).toEqual(before);
    expect(world.tickets.get(TICKET)!.ownerHumanId).toBe(A);
    expect(world.repos.ticketsRepo.reassignForResale).toHaveBeenCalledTimes(1); // B's own purchase only
  });
});

// ── Case c: the ticket has been sold on ────────────────────────────────────
//
// DEFENCE ONLY. These drive the unwind directly. No refund path reaches this
// branch in the product today: the Stripe webhook reads the order under the
// ticket lock and sends a ticket sold on to manual review (nobody debited,
// nothing written; `reconcile-stripe-full-refund.test.ts`, "sold on while
// the refund waited for the ticket lock"), and the paths that refund before
// money moves refuse it in the pre-check. The branch is kept so that a caller
// that does get here, with money already moved, does not throw.

describe("unwind — the refunded buyer already sold the ticket on (case c)", () => {
  async function soldOn() {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    world.repos.audit.log.mockClear();
    return world;
  }

  const expectLeftWithC = (
    world: ReturnType<typeof makeWorld>,
    before: ReturnType<typeof snapshot>,
    reportError: ReturnType<typeof vi.fn>,
  ) => {
    // Nothing is taken from C, and neither sale is touched.
    expect(snapshot(world)).toEqual(before);
    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: C,
      orderId: O_C,
      orderItemId: I_C,
      status: "VALID",
    });
    expect(world.listings.get(L1)).toMatchObject({
      status: "SOLD",
      buyerOrderId: O_B,
    });
    expect(world.listings.get(L2)).toMatchObject({
      status: "SOLD",
      buyerOrderId: O_C,
    });
    expect(world.repos.ticketsRepo.transfer).not.toHaveBeenCalled();
    expect(world.repos.ticketsRepo.restoreAfterResale).not.toHaveBeenCalled();
    expect(world.repos.listingsRepo.unwindSale).not.toHaveBeenCalled();
    expect(world.repos.listingsRepo.cancel).not.toHaveBeenCalled();

    expect(world.auditRows()).toEqual([
      expect.objectContaining({
        entityId: L1,
        action: "purchase_unwound_after_refund",
        data: expect.objectContaining({
          refundedOrderId: O_B,
          refundedOrderItemId: I_B,
          ticketId: TICKET,
          ticketRestoredToSeller: false,
          ticketNotRestoredReason: "sold_on",
          purchasedListingId: L1,
          laterListingId: L2,
          laterListingStatus: "SOLD",
          currentHolderHumanId: C,
          currentHolderOrderItemId: I_C,
          currentHolderOrderId: O_C,
          buyerHumanId: B,
          sellerHumanId: A,
          listingStatusAfterRefund: "SOLD",
        }),
      }),
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "resale_unwind_ticket_sold_on" }),
      expect.objectContaining({
        tags: { useCase: "unwindResaleOrderAfterRefund", reason: "sold_on" },
        extra: expect.objectContaining({
          orderId: O_B,
          purchasedListingId: L1,
          laterListingId: L2,
          currentHolderOrderItemId: I_C,
        }),
      }),
    );
  };

  it("lets the refund commit and takes nothing from the later holder (was TICKET_NOT_FOUND)", async () => {
    const world = await soldOn();
    const before = snapshot(world);
    const reportError = vi.fn();

    await expect(world.refund(O_B, { reportError })).resolves.toBeUndefined();

    expectLeftWithC(world, before, reportError);
  });

  it("is caught under the ticket lock when C's finalize lands after the unwind's first read", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.startCheckout(L2, C, O_C, I_C);
    world.repos.audit.log.mockClear();
    // The unlocked read still sees the ticket LISTED on B's item; C's
    // finalize commits before the row lock is granted.
    world.repos.ticketsRepo.getByIdForUpdate.mockImplementationOnce(
      async (id: string) => {
        await finalizeResalePurchase(world.tx, {
          order: world.orderRecord(O_C)!,
          clock,
        });
        world.repos.audit.log.mockClear();
        return { ...world.tickets.get(id)! };
      },
    );
    const reportError = vi.fn();

    // The refund path marks B's item itself; C's finalize has already
    // flipped it to `transferred` here, so run the unwind directly.
    await expect(
      unwindResaleOrderAfterRefund(world.tx, {
        order: world.orderRecord(O_B)!,
        clock,
        reportError,
      }),
    ).resolves.toEqual({ relistNotices: [] });

    expectLeftWithC(world, snapshot(world), reportError);
  });
});

// ── After case c: the later holder is refunded too ─────────────────────────

describe("unwind — the ticket comes back to a seller whose own purchase was already refunded", () => {
  // B was refunded while C held the ticket (case c), so B's order is
  // REFUNDED and A's sale to B still stands. Now C is refunded. The ticket
  // has to leave C and this refund has to commit, so it goes back to B, the
  // seller of the sale being undone; but B has their money back already.
  it("hands it back, does NOT put the refunded seller's listing back on sale, and reports", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    await world.refund(O_B, { reportError: vi.fn() }); // case c
    world.repos.audit.log.mockClear();
    const reportError = vi.fn();

    // The default disposition would put L2 back on sale.
    await expect(world.refund(O_C, { reportError })).resolves.toBeUndefined();

    expect(world.tickets.get(TICKET)).toMatchObject({
      ownerHumanId: B,
      orderItemId: I_B,
      status: "VALID",
    });
    expect(world.listings.get(L2)).toMatchObject({
      status: "CANCELLED",
      buyerOrderId: null,
    });
    // A's sale to B is still there for a person to unwind.
    expect(world.listings.get(L1)).toMatchObject({
      status: "SOLD",
      buyerOrderId: O_B,
    });
    expect(world.auditRows()).toEqual([
      expect.objectContaining({
        entityId: L2,
        action: "purchase_unwound_after_refund",
        data: expect.objectContaining({
          refundedOrderId: O_C,
          listingStatusAfterRefund: "CANCELLED",
          sellerPurchaseAlreadyRefunded: true,
          sellerRefundedOrderId: O_B,
        }),
      }),
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_unwind_ticket_returned_to_refunded_buyer",
      }),
      expect.objectContaining({
        extra: expect.objectContaining({
          orderId: O_C,
          ticketId: TICKET,
          sellerHumanId: B,
          sellerRefundedOrderId: O_B,
          sellerRefundedOrderItemId: I_B,
        }),
      }),
    );
  });

  it("a seller whose purchase stands is not reported, and their listing goes back on sale", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    world.repos.audit.log.mockClear();
    const reportError = vi.fn();

    await world.refund(O_C, { reportError });

    expect(world.listings.get(L2)!.status).toBe("ACTIVE");
    expect(reportError).not.toHaveBeenCalled();
    expect(world.auditRows()[0]!.data).not.toHaveProperty(
      "sellerPurchaseAlreadyRefunded",
    );
  });

  it("never lets a throwing reporter fail the refund's transaction", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    await world.refund(O_B, { reportError: vi.fn() });

    await expect(
      world.refund(O_C, {
        reportError: vi.fn(() => {
          throw new Error("reporter down");
        }),
      }),
    ).resolves.toBeUndefined();
  });
});

// ── A replay of an already-unwound refund is NOT "sold on" ─────────────────

describe("unwind — replay of a refund that was already unwound", () => {
  it("does nothing, and is not mistaken for a ticket sold on", async () => {
    const world = await worldWhereBBought();
    await world.refund(O_B); // the real unwind: ticket back with A, L1 ACTIVE
    world.repos.audit.log.mockClear();
    const before = snapshot(world);
    const reportError = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      unwindResaleOrderAfterRefund(world.tx, {
        order: world.orderRecord(O_B)!,
        clock,
        reportError,
        logger: logger as never,
      }),
    ).resolves.toEqual({ relistNotices: [] });

    expect(snapshot(world)).toEqual(before);
    expect(world.repos.audit.log).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "unwindResaleOrderAfterRefund.already_unwound",
      expect.objectContaining({ orderId: O_B, listingId: L1 }),
    );
  });

  it("a ticket sold on is not mistaken for an already-unwound refund", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reportError = vi.fn();

    await world.refund(O_B, { reportError, logger });

    expect(logger.info).not.toHaveBeenCalledWith(
      "unwindResaleOrderAfterRefund.already_unwound",
      expect.anything(),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("still refuses a ticket that is on no order item at all (corrupt data)", async () => {
    const world = await worldWhereBBought();
    world.tickets.get(TICKET)!.orderItemId = null;

    await expect(
      unwindResaleOrderAfterRefund(world.tx, {
        order: world.orderRecord(O_B)!,
        clock,
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
    await expect(
      assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!, {
        allowAlreadyUnwound: true,
        allowSoldOn: true,
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
  });
});

// ── The pre-check and the unwind agree ─────────────────────────────────────

describe("assertResaleOrderCanBeUnwound agrees with the unwind", () => {
  const states: Array<
    [string, (world: ReturnType<typeof makeWorld>) => Promise<void>]
  > = [
    ["the buyer still holds the ticket", async () => {}],
    ["the buyer relisted it (ACTIVE)", async (world) => world.list(B, L2)],
    [
      "the buyer relisted it and a checkout holds the listing (HELD)",
      async (world) => {
        await world.list(B, L2);
        await world.startCheckout(L2, C, O_C, I_C);
      },
    ],
    [
      "the buyer sold it on",
      async (world) => {
        await world.list(B, L2);
        await world.buy(L2, C, O_C, I_C);
      },
    ],
    ["the refund was already unwound", async (world) => world.refund(O_B)],
  ];

  // The webhook's options: its money has already moved, so whatever the
  // pre-check passes, the unwind must then get through without throwing.
  it.each(states)(
    "money already moved, %s: the pre-check passes and the unwind does not throw",
    async (_label, arrange) => {
      const world = await worldWhereBBought();
      await arrange(world);

      await expect(
        assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!, {
          allowAlreadyUnwound: true,
          allowSoldOn: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        unwindResaleOrderAfterRefund(world.tx, {
          order: world.orderRecord(O_B)!,
          clock,
          reportError: vi.fn(),
        }),
      ).resolves.toEqual({ relistNotices: [] });
    },
  );

  // A caller that has not paid anyone yet still refuses these two up front.
  it("before money moves, a ticket sold on is refused with reason sold_on", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);

    await expect(
      assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!),
    ).rejects.toMatchObject({
      code: "TICKET_NOT_FOUND",
      meta: { via: "unwind", reason: "sold_on" },
    });
    // `allowAlreadyUnwound` alone does not let it through.
    await expect(
      assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!, {
        allowAlreadyUnwound: true,
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
  });

  it("before money moves, an already-unwound refund is refused unless allowed", async () => {
    const world = await worldWhereBBought();
    await world.refund(O_B);

    await expect(
      assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
    // `allowSoldOn` alone does not let it through.
    await expect(
      assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!, {
        allowSoldOn: true,
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
  });

  it("a relisted ticket passes with no options: the unwind closes or leaves the listing", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);

    await expect(
      assertResaleOrderCanBeUnwound(world.tx, world.orderRecord(O_B)!),
    ).resolves.toBeUndefined();
  });
});

// ── The restored item's pointer ────────────────────────────────────────────

describe("unwind — the seller's restored item and its listing pointer", () => {
  it("a PRIMARY seller's item gets its listed-now pointer back", async () => {
    const world = await worldWhereBBought();

    await world.refund(O_B);

    expect(world.items.get(I_A)).toMatchObject({
      status: "active",
      resaleListingId: L1,
    });
  });

  it("a RESALE seller's item is never rewritten: not to the relisted listing, not to null", async () => {
    const world = await worldWhereBBought();
    await world.list(B, L2);
    await world.buy(L2, C, O_C, I_C);
    world.repos.orderItemsRepo.setResaleListingId.mockClear();

    await world.refund(O_C); // restore_active: would have written L2
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);

    await world.buy(L2, C, "order-c2", "item-c2");
    await world.refund("order-c2", { listingDisposition: "cancel" }); // would have written null
    expect(world.items.get(I_B)!.resaleListingId).toBe(L1);

    expect(world.repos.orderItemsRepo.setResaleListingId).not.toHaveBeenCalled();
  });
});
