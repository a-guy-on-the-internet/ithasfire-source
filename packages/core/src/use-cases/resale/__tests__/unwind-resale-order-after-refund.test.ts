import { describe, expect, it, vi } from "vitest";

import type { OrderRecord } from "@th/ports/repos/orders";
import type { TxRepos } from "@th/ports/repos";

import { unwindResaleOrderAfterRefund } from "../unwind-resale-order-after-refund";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const BUYER_ID = "55555555-5555-4555-8555-555555555555";
const SELLER_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-10-10T12:00:00.000Z");

const order = {
  id: ORDER_ID,
  source: "RESALE",
  buyerHumanId: BUYER_ID,
  parentOrderId: null,
  items: [
    { id: ITEM_ID, kind: "ticket", resaleListingId: LISTING_ID, meta: {} },
  ],
} as unknown as OrderRecord;

function makeTx(opts: {
  ticketStatus: string;
  listingStatus?: string;
  listingBuyerOrderId?: string | null;
  /** Default 500 (priced under the share); null = the removed markup split. */
  eventShareCents?: number | null;
}) {
  const tickets: Record<string, ReturnType<typeof vi.fn>> & {
    getByOrderItemId: ReturnType<typeof vi.fn>;
    restoreAfterResale: ReturnType<typeof vi.fn>;
  } = {
    getByOrderItemId: vi.fn(async () => ({
      id: TICKET_ID,
      status: opts.ticketStatus,
      ownerHumanId: BUYER_ID,
      orderItemId: ITEM_ID,
    })),
    // The row lock the unwind takes before deciding: the same ticket.
    getByIdForUpdate: vi.fn(
      async (): Promise<unknown> => tickets.getByOrderItemId(),
    ),
    transfer: vi.fn(async () => true),
    restoreAfterResale: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => true),
  };
  const resaleListings = {
    // No live listing of the refunded buyer's own.
    getByTicketId: vi.fn(async (): Promise<unknown> => null),
    getById: vi.fn(async () => ({
      id: LISTING_ID,
      sellerHumanId: SELLER_ID,
      status: opts.listingStatus ?? "SOLD",
      buyerOrderId:
        opts.listingBuyerOrderId === undefined
          ? ORDER_ID
          : opts.listingBuyerOrderId,
      expiresAt: null,
      saleCutoffAt: null,
      eventShareCents: opts.eventShareCents === undefined ? 500 : opts.eventShareCents,
    })),
    unwindSale: vi.fn(async () => undefined),
  };
  const orderItems = {
    listByOrderId: vi.fn(async () => []),
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const tx = { tickets, resaleListings, orderItems, audit } as unknown as TxRepos;
  return { tx, tickets, resaleListings, orderItems, audit };
}

const clock = { now: () => NOW };

// Refunds restock (spec 2026-10-09), fix round 2. The callers run this unwind
// in the transaction that marks the order refunded and writes REFUND_DEBIT,
// AFTER Stripe has refunded the buyer. A terminal ticket used to make
// `restoreAfterResale` throw there and roll all of that back.
describe("unwindResaleOrderAfterRefund — the ticket is already REFUNDED / INVALID", () => {
  it.each(["INVALID", "REFUNDED"])(
    "%s: closes the sale as CANCELLED, hands nothing back, and reports",
    async (ticketStatus) => {
      const { tx, tickets, resaleListings, orderItems, audit } = makeTx({
        ticketStatus,
      });
      const reportError = vi.fn();

      await expect(
        unwindResaleOrderAfterRefund(tx, { order, clock, reportError }),
      ).resolves.toEqual({ relistNotices: [] });

      expect(resaleListings.unwindSale).toHaveBeenCalledWith(
        LISTING_ID,
        ORDER_ID,
        "CANCELLED",
      );
      // The dead ticket is not moved, restored or relisted.
      expect(tickets.transfer).not.toHaveBeenCalled();
      expect(tickets.restoreAfterResale).not.toHaveBeenCalled();
      expect(tickets.setStatus).not.toHaveBeenCalled();
      expect(orderItems.updateStatus).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "purchase_unwound_after_refund",
          data: expect.objectContaining({
            ticketAlreadyTerminal: ticketStatus,
            ticketRestoredToSeller: false,
            listingStatusAfterRefund: "CANCELLED",
          }),
        }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "resale_unwind_ticket_already_terminal",
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ ticketStatus }),
        }),
      );
    },
  );

  it("restore_active disposition still CANCELS: a dead ticket is never relisted", async () => {
    const { tx, resaleListings } = makeTx({ ticketStatus: "INVALID" });

    await unwindResaleOrderAfterRefund(tx, {
      order,
      clock,
      listingDisposition: "restore_active",
    });

    expect(resaleListings.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
  });

  it("does not touch a listing that is no longer this order's SOLD sale", async () => {
    const { tx, resaleListings } = makeTx({
      ticketStatus: "INVALID",
      listingStatus: "CANCELLED",
      listingBuyerOrderId: null,
    });

    await unwindResaleOrderAfterRefund(tx, { order, clock });

    expect(resaleListings.unwindSale).not.toHaveBeenCalled();
  });

  it("never lets a throwing reporter fail the refund's transaction", async () => {
    const { tx } = makeTx({ ticketStatus: "INVALID" });

    await expect(
      unwindResaleOrderAfterRefund(tx, {
        order,
        clock,
        reportError: () => {
          throw new Error("reporter down");
        },
      }),
    ).resolves.toEqual({ relistNotices: [] });
  });

  it("a live ticket still goes home to its seller", async () => {
    const { tx, tickets, resaleListings } = makeTx({ ticketStatus: "VALID" });

    await unwindResaleOrderAfterRefund(tx, { order, clock });

    expect(tickets.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: TICKET_ID, toHumanId: SELLER_ID }),
    );
    expect(tickets.restoreAfterResale).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: TICKET_ID }),
    );
    expect(resaleListings.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "ACTIVE",
    );
  });
});

// organiser-resale-share FR-014/FR-015: checkout refuses a listing with no
// event share (priced under the removed markup split), so a refund never puts
// one back on sale. It is closed, the ticket goes home VALID, and the seller is
// told to list it again.
describe("unwindResaleOrderAfterRefund — a listing priced under the removed markup split", () => {
  const SELLER_ORDER_ID = "77777777-7777-4777-8777-777777777777";
  const legacyOrder = { ...order, parentOrderId: SELLER_ORDER_ID } as OrderRecord;

  function legacyTx() {
    const h = makeTx({ ticketStatus: "VALID", eventShareCents: null });
    const notifications = { create: vi.fn(async () => ({ id: "n-1" })) };
    const events = { getById: vi.fn(async () => ({ id: "event-1", title: "x" })) };
    // The seller's own order, for the item the ticket goes home to.
    const orders = {
      getById: vi.fn(async () => ({
        id: SELLER_ORDER_ID,
        source: "PRIMARY",
        status: "SUCCEEDED",
        items: [
          { id: "seller-item", kind: "ticket", status: "transferred", ticketTypeId: null },
        ],
      })),
    };
    Object.assign(h.tx, { notifications, events, orders });
    h.resaleListings.getById.mockImplementation(async () => ({
      id: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: "event-1",
      status: "SOLD",
      buyerOrderId: ORDER_ID,
      expiresAt: null,
      saleCutoffAt: null,
      eventShareCents: null,
      askPriceCents: 5000,
      currency: "usd",
    }) as never);
    return { ...h, notifications, events };
  }

  it("closes it instead of relisting: the ticket goes home VALID, never LISTED, and the close is audited", async () => {
    const h = legacyTx();

    await unwindResaleOrderAfterRefund(h.tx, { order: legacyOrder, clock });

    expect(h.tickets.restoreAfterResale).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: TICKET_ID }),
    );
    expect(h.tickets.setStatus).not.toHaveBeenCalledWith(
      TICKET_ID,
      "LISTED",
      expect.anything(),
    );
    expect(h.resaleListings.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "purchase_unwound_after_refund",
        data: expect.objectContaining({
          listingStatusAfterRefund: "CANCELLED",
          legacyListingClosed: true,
        }),
      }),
    );
  });

  it("returns the seller's notice as DATA and writes nothing in the refund's transaction", async () => {
    const h = legacyTx();

    const out = await unwindResaleOrderAfterRefund(h.tx, {
      order: legacyOrder,
      clock,
    });

    expect(out.relistNotices).toEqual([
      {
        sellerHumanId: SELLER_ID,
        listingId: LISTING_ID,
        eventId: "event-1",
        askPriceCents: 5000,
        currency: "usd",
        // The seller's own order: the relist link opens on it.
        sellerOrderId: SELLER_ORDER_ID,
        refundedOrderId: ORDER_ID,
      },
    ]);
    // Nothing that could fail and roll the refund back.
    expect(h.notifications.create).not.toHaveBeenCalled();
    expect(h.events.getById).not.toHaveBeenCalled();
  });

  it("a cancel disposition (event cancelled, approved claim) is not a legacy close: no flag, no notice", async () => {
    const h = legacyTx();

    const out = await unwindResaleOrderAfterRefund(h.tx, {
      order: legacyOrder,
      clock,
      listingDisposition: "cancel",
    });

    expect(h.resaleListings.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "CANCELLED",
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ legacyListingClosed: true }),
      }),
    );
    expect(out.relistNotices).toEqual([]);
  });

  it("a listing priced under the share still goes back on sale, with no notice", async () => {
    const h = makeTx({ ticketStatus: "VALID", eventShareCents: 0 });

    const out = await unwindResaleOrderAfterRefund(h.tx, { order, clock });

    expect(h.resaleListings.unwindSale).toHaveBeenCalledWith(
      LISTING_ID,
      ORDER_ID,
      "ACTIVE",
    );
    expect(out.relistNotices).toEqual([]);
  });

  it("a replay that finds the order already unwound returns no notice", async () => {
    // What a first unwind left: the listing closed and no longer naming this
    // order, the ticket back with the seller on the seller's own item.
    const h = makeTx({
      ticketStatus: "VALID",
      eventShareCents: null,
      listingStatus: "CANCELLED",
      listingBuyerOrderId: null,
    });
    h.tickets.getByOrderItemId.mockResolvedValue(null);
    Object.assign(h.tickets, {
      getById: vi.fn(async () => ({
        id: TICKET_ID,
        status: "VALID",
        ownerHumanId: SELLER_ID,
        orderItemId: "seller-item",
      })),
    });
    const listingRead = h.resaleListings.getById.getMockImplementation()!;
    h.resaleListings.getById.mockImplementation(async () => ({
      ...(await listingRead()),
      ticketId: TICKET_ID,
    }));

    const out = await unwindResaleOrderAfterRefund(h.tx, { order, clock });

    expect(out.relistNotices).toEqual([]);
    expect(h.resaleListings.unwindSale).not.toHaveBeenCalled();
  });
});

// Owner ruling 2026-10-10: a refund of a scanned-in ticket means the person
// left. A resale refund does not void the ticket, it hands it back to the
// seller VALID with `scannedAt` cleared, so the unwind's audit row is the only
// record that the refunded buyer had been admitted on it.
describe("unwindResaleOrderAfterRefund — leftOnRefund on the audit row", () => {
  /**
   * One ticket row, and a `restoreAfterResale` that writes what the real one
   * writes ON THAT ROW: a list taken after it finds no SCANNED ticket.
   */
  function withTicketRow(
    harness: ReturnType<typeof makeTx>,
    row: { status: string; scannedAt: Date | null },
  ) {
    const ticket = {
      id: TICKET_ID,
      ownerHumanId: BUYER_ID,
      orderItemId: ITEM_ID,
      ...row,
    };
    harness.tickets.getByOrderItemId.mockImplementation((async () => ticket) as never);
    harness.tickets.restoreAfterResale.mockImplementation((async () => {
      ticket.status = "VALID";
      ticket.scannedAt = null;
    }) as never);
    return ticket;
  }
  const unwoundAuditData = (harness: ReturnType<typeof makeTx>) => {
    const calls = harness.audit.log.mock.calls as unknown as Array<
      [{ action: string; data: Record<string, unknown> }]
    >;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].action).toBe("purchase_unwound_after_refund");
    return calls[0]![0].data;
  };

  it("records the buyer's scanned ticket with its admit time, and still hands it back to the seller", async () => {
    const harness = makeTx({ ticketStatus: "SCANNED" });
    const ticket = withTicketRow(harness, {
      status: "SCANNED",
      scannedAt: new Date("2026-10-10T02:15:40.000Z"),
    });

    await unwindResaleOrderAfterRefund(harness.tx, { order, clock });

    // What the unwind does to the ticket is unchanged.
    expect(harness.tickets.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: TICKET_ID, toHumanId: SELLER_ID }),
    );
    expect(harness.tickets.restoreAfterResale).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: TICKET_ID }),
    );
    expect(ticket.status).toBe("VALID");
    expect(unwoundAuditData(harness).leftOnRefund).toEqual([
      { ticketId: TICKET_ID, admittedAt: "2026-10-10T02:15:40.000Z" },
    ]);
  });

  it("writes no leftOnRefund key when the buyer's ticket had not been scanned", async () => {
    const harness = makeTx({ ticketStatus: "VALID" });
    withTicketRow(harness, { status: "VALID", scannedAt: null });

    await unwindResaleOrderAfterRefund(harness.tx, { order, clock });

    expect(unwoundAuditData(harness)).not.toHaveProperty("leftOnRefund");
  });
});
