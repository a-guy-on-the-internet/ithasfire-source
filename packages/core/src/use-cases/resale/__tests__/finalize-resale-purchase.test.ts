import { describe, it, expect, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";

import { finalizeResalePurchase } from "../finalize-resale-purchase";

// ── Constants ──────────────────────────────────────────────────────────────

const BUYER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELLER_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const ORDER_ID = "aa222222-aa22-4a22-8a22-aa2222222222";
const ORDER_ITEM_ID = "aa333333-aa33-4a33-8a33-aa3333333333";
const LISTING_ID = "aa444444-aa44-4a44-8a44-aa4444444444";
const TICKET_ID = "aa555555-aa55-4a55-8a55-aa5555555555";
const SELLER_ORDER_ID = "aa666666-aa66-4a66-8a66-aa6666666666";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: "event-uuid",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5000,
    feesPlatformCents: 250,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_test",
    source: "RESALE",
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: [
      {
        id: ORDER_ITEM_ID,
        kind: "ticket" as const,
        ticketTypeId: null,
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        status: "fulfilled",
        resaleListingId: LISTING_ID,
        meta: { resaleListingId: LISTING_ID },
      } as any,
    ],
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    ...overrides,
  } as OrderRecord;
}

function makeTx(opts?: {
  commitResult?: { ok: boolean; ticketId?: string };
  ticket?: any;
  listing?: any;
  /**
   * The seller's ORIGINAL order item (the one the ticket was bought with),
   * served by `orderItems.getById`. Default: a live, unrefunded item.
   */
  originalItem?: any;
  /** How the SELLER's own order was sold. Default: PRIMARY. */
  sellerOrderSource?: "PRIMARY" | "RESALE" | "COMP";
}) {
  const commitResult = opts?.commitResult ?? { ok: true, ticketId: TICKET_ID };
  const originalItem =
    opts && "originalItem" in opts
      ? opts.originalItem
      : {
          id: "original-item-id",
          orderId: SELLER_ORDER_ID,
          status: "active",
          refundedAt: null,
          resaleListingId: LISTING_ID,
        };
  const listing =
    opts && "listing" in opts
      ? opts.listing
      : {
          id: LISTING_ID,
          sellerHumanId: SELLER_ID,
          ticketId: TICKET_ID,
        };
  const ticket =
    opts && "ticket" in opts
      ? opts.ticket
      : {
          id: TICKET_ID,
          ownerHumanId: BUYER_ID,
          orderItemId: "original-item-id",
          seatId: null,
        };

  const commit = vi.fn(async () => commitResult);
  const getListingById = vi.fn(async () => listing);
  const getTicketById = vi.fn(async () => ticket);
  const transfer = vi.fn(async () => {});
  const reassignForResale = vi.fn(async () => {});
  const updateOrderItemStatus = vi.fn(async () => {});
  const setOrderItemResaleListingId = vi.fn(async () => {});
  const getOrderItemById = vi.fn(async () => originalItem);
  const auditLog = vi.fn(async () => {});
  // The pointer rule reads the seller item's order `source`.
  const getOrderById = vi.fn(async (id: string) => ({
    id,
    source: opts?.sellerOrderSource ?? "PRIMARY",
  }));

  const tx = {
    orders: { getById: getOrderById } as any,
    resaleListings: { getById: getListingById, commit } as any,
    tickets: { getById: getTicketById, transfer, reassignForResale } as any,
    orderItems: {
      getById: getOrderItemById,
      updateStatus: updateOrderItemStatus,
      setResaleListingId: setOrderItemResaleListingId,
    } as any,
    audit: { log: auditLog } as any,
  } as unknown as TxRepos;

  return {
    tx,
    mocks: {
      commit,
      getListingById,
      getTicketById,
      transfer,
      reassignForResale,
      updateOrderItemStatus,
      setOrderItemResaleListingId,
      getOrderItemById,
      auditLog,
    },
  };
}

function makeClock(): ClockPort {
  return { now: () => NOW };
}

function makeLogger(): LoggerPort {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("finalizeResalePurchase", () => {
  it("commits listing, reassigns the ticket, and clears the seller item listing link", async () => {
    const { tx, mocks } = makeTx();
    const order = makeOrder();

    await finalizeResalePurchase(tx, {
      order,
      clock: makeClock(),
      logger: makeLogger(),
    });

    // 1. Commit listing
    expect(mocks.getListingById).toHaveBeenCalledWith(LISTING_ID);
    expect(mocks.commit).toHaveBeenCalledWith(LISTING_ID, BUYER_ID, ORDER_ID);

    // 2. Load ticket
    expect(mocks.getTicketById).toHaveBeenCalledWith(TICKET_ID);

    // 3. Commit already transferred ownership; finalize only reassigns order linkage.
    expect(mocks.transfer).not.toHaveBeenCalled();

    // 4. Reassign with new code
    expect(mocks.reassignForResale).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        newOrderId: ORDER_ID,
        newOrderItemId: ORDER_ITEM_ID,
      }),
    );

    // 5. Mark seller's original order item as transferred
    expect(mocks.updateOrderItemStatus).toHaveBeenCalledWith(
      "original-item-id",
      "transferred",
      NOW,
    );
    expect(mocks.setOrderItemResaleListingId).toHaveBeenCalledWith(
      "original-item-id",
      null,
    );

    // 6. Audit
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "resale_listing",
        entityId: LISTING_ID,
        action: "purchase_finalized",
      }),
    );
  });

  // A chain (owner ruling 2026-10-11: a ticket bought on resale can be sold
  // again). The seller here bought the ticket on resale: their item's
  // `resaleListingId` is the listing THEY bought it through, which a refund
  // of their purchase reads. Selling the ticket on must not clear it.
  it("keeps the seller item's bought-through pointer when the seller bought on resale", async () => {
    const { tx, mocks } = makeTx({ sellerOrderSource: "RESALE" });

    await finalizeResalePurchase(tx, {
      order: makeOrder(),
      clock: makeClock(),
      logger: makeLogger(),
    });

    expect(mocks.setOrderItemResaleListingId).not.toHaveBeenCalled();
    // The rest of the sale is unchanged: the seller's item is transferred
    // and the ticket moves to the buyer's item.
    expect(mocks.updateOrderItemStatus).toHaveBeenCalledWith(
      "original-item-id",
      "transferred",
      NOW,
    );
    expect(mocks.reassignForResale).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        newOrderId: ORDER_ID,
        newOrderItemId: ORDER_ITEM_ID,
      }),
    );
  });

  it("throws (rolls finalize back) when order has no ticket item", async () => {
    const { tx, mocks } = makeTx();
    const order = makeOrder({ items: [] });

    await expect(
      finalizeResalePurchase(tx, {
        order,
        clock: makeClock(),
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({
      code: "TICKET_NOT_FOUND",
      meta: expect.objectContaining({ reason: "resale_order_no_ticket_item" }),
    });

    expect(mocks.getListingById).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("throws when ticket item has no resaleListingId in meta", async () => {
    const { tx, mocks } = makeTx();
    const order = makeOrder({
      items: [
        {
          id: ORDER_ITEM_ID,
          kind: "ticket" as const,
          resaleListingId: null,
          meta: {},
        } as any,
      ],
    });

    await expect(
      finalizeResalePurchase(tx, {
        order,
        clock: makeClock(),
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
      meta: expect.objectContaining({ reason: "resale_order_missing_listing_id" }),
    });

    expect(mocks.getListingById).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("prefers orderItem.resaleListingId over legacy meta", async () => {
    const { tx, mocks } = makeTx();
    const order = makeOrder({
      items: [
        {
          id: ORDER_ITEM_ID,
          kind: "ticket" as const,
          resaleListingId: LISTING_ID,
          meta: {},
        } as any,
      ],
    });

    await finalizeResalePurchase(tx, {
      order,
      clock: makeClock(),
      logger: makeLogger(),
    });

    expect(mocks.getListingById).toHaveBeenCalledWith(LISTING_ID);
    expect(mocks.commit).toHaveBeenCalledWith(LISTING_ID, BUYER_ID, ORDER_ID);
  });

  it("falls back to legacy meta when canonical resaleListingId is missing", async () => {
    const { tx, mocks } = makeTx();
    const order = makeOrder({
      items: [
        {
          id: ORDER_ITEM_ID,
          kind: "ticket" as const,
          resaleListingId: null,
          meta: { resaleListingId: LISTING_ID },
        } as any,
      ],
    });

    await finalizeResalePurchase(tx, {
      order,
      clock: makeClock(),
      logger: makeLogger(),
    });

    expect(mocks.getListingById).toHaveBeenCalledWith(LISTING_ID);
    expect(mocks.commit).toHaveBeenCalledWith(LISTING_ID, BUYER_ID, ORDER_ID);
  });

  it("throws when the listing cannot be loaded", async () => {
    const { tx, mocks } = makeTx({ listing: null });
    const order = makeOrder();

    await expect(
      finalizeResalePurchase(tx, {
        order,
        clock: makeClock(),
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
      meta: expect.objectContaining({ reason: "resale_listing_not_found_at_finalize" }),
    });

    expect(mocks.getListingById).toHaveBeenCalledWith(LISTING_ID);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.reassignForResale).not.toHaveBeenCalled();
  });

  it("is idempotent - returns early when the listing is already sold to THIS order", async () => {
    const { tx, mocks } = makeTx({
      commitResult: { ok: false },
      listing: {
        id: LISTING_ID,
        sellerHumanId: SELLER_ID,
        ticketId: TICKET_ID,
        status: "SOLD",
        buyerOrderId: ORDER_ID,
      },
    });
    const order = makeOrder();

    await finalizeResalePurchase(tx, {
      order,
      clock: makeClock(),
      logger: makeLogger(),
    });

    expect(mocks.commit).toHaveBeenCalled();
    // Should NOT have proceeded with transfer
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.reassignForResale).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "sold to a DIFFERENT buyer order",
      listing: { status: "SOLD", buyerOrderId: "other-order-id" },
    },
    {
      label: "no hold and no buyer order (hold expired, never sold)",
      listing: { status: "ACTIVE", buyerOrderId: null },
    },
  ])(
    "throws (rolls finalize back) when commit is refused and the listing is $label",
    async ({ listing }) => {
      const { tx, mocks } = makeTx({
        commitResult: { ok: false },
        listing: {
          id: LISTING_ID,
          sellerHumanId: SELLER_ID,
          ticketId: TICKET_ID,
          ...listing,
        },
      });

      await expect(
        finalizeResalePurchase(tx, {
          order: makeOrder(),
          clock: makeClock(),
          logger: makeLogger(),
        }),
      ).rejects.toMatchObject({
        code: "LISTING_NOT_ACTIVE",
        meta: expect.objectContaining({
          reason: "resale_listing_commit_refused",
          listingBuyerOrderId: listing.buyerOrderId,
        }),
      });
      expect(mocks.reassignForResale).not.toHaveBeenCalled();
      expect(mocks.updateOrderItemStatus).not.toHaveBeenCalled();
    },
  );

  it("throws when commit returns ok but no ticketId", async () => {
    const { tx, mocks } = makeTx({
      commitResult: { ok: true, ticketId: undefined },
    });

    await expect(
      finalizeResalePurchase(tx, {
        order: makeOrder(),
        clock: makeClock(),
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({
      code: "TICKET_NOT_FOUND",
      meta: expect.objectContaining({ reason: "resale_commit_missing_ticket_id" }),
    });

    expect(mocks.commit).toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("throws when the committed ticket row is missing", async () => {
    const { tx, mocks } = makeTx({ ticket: null });

    await expect(
      finalizeResalePurchase(tx, {
        order: makeOrder(),
        clock: makeClock(),
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({
      code: "TICKET_NOT_FOUND",
      meta: expect.objectContaining({ reason: "resale_committed_ticket_row_missing" }),
    });

    expect(mocks.commit).toHaveBeenCalled();
    expect(mocks.getTicketById).toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("skips marking original item if ticket has no orderItemId", async () => {
    const { tx, mocks } = makeTx({
      ticket: {
        id: TICKET_ID,
        ownerHumanId: SELLER_ID,
        orderItemId: null, // no original order item
        seatId: null,
      },
    });
    const order = makeOrder();

    await finalizeResalePurchase(tx, {
      order,
      clock: makeClock(),
      logger: makeLogger(),
    });

    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.updateOrderItemStatus).not.toHaveBeenCalled();
    expect(mocks.setOrderItemResaleListingId).not.toHaveBeenCalled();
    // Audit should still fire
    expect(mocks.auditLog).toHaveBeenCalled();
  });

  // ── Defence in depth (audit #2) ───────────────────────────────────────────
  // If the seller's original item was somehow refunded while the listing
  // stayed live, committing the sale would turn `refunded` into
  // `transferred` and pay the seller twice. Refuse instead.

  describe("refunded original item", () => {
    it("refuses to commit when the original order item is already refunded (status)", async () => {
      const { tx, mocks } = makeTx({
        originalItem: {
          id: "original-item-id",
          status: "refunded",
          refundedAt: new Date("2026-03-01T00:00:00Z"),
        },
      });

      await expect(
        finalizeResalePurchase(tx, {
          order: makeOrder(),
          clock: makeClock(),
          logger: makeLogger(),
        }),
      ).rejects.toMatchObject({ code: "RESALE_ORIGINAL_ITEM_REFUNDED" });

      expect(mocks.reassignForResale).not.toHaveBeenCalled();
      expect(mocks.updateOrderItemStatus).not.toHaveBeenCalled();
      expect(mocks.setOrderItemResaleListingId).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
    });

    it("refuses when refundedAt is stamped even if status still reads active", async () => {
      const { tx, mocks } = makeTx({
        originalItem: {
          id: "original-item-id",
          status: "active",
          refundedAt: new Date("2026-03-01T00:00:00Z"),
        },
      });

      await expect(
        finalizeResalePurchase(tx, {
          order: makeOrder(),
          clock: makeClock(),
          logger: makeLogger(),
        }),
      ).rejects.toMatchObject({ code: "RESALE_ORIGINAL_ITEM_REFUNDED" });

      expect(mocks.reassignForResale).not.toHaveBeenCalled();
    });

    it("still completes when the original item is live", async () => {
      const { tx, mocks } = makeTx();

      await finalizeResalePurchase(tx, {
        order: makeOrder(),
        clock: makeClock(),
        logger: makeLogger(),
      });

      expect(mocks.getOrderItemById).toHaveBeenCalledWith("original-item-id");
      expect(mocks.reassignForResale).toHaveBeenCalledTimes(1);
      expect(mocks.updateOrderItemStatus).toHaveBeenCalledWith(
        "original-item-id",
        "transferred",
        NOW,
      );
    });
  });
});
