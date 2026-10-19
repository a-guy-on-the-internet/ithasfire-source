import { describe, it, expect, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ResaleListingRecord } from "@th/types/repos/resale-listings";

import {
  cancelResaleListing,
  type CancelResaleListingDeps,
} from "../cancel-resale-listing";

// ── Constants ──────────────────────────────────────────────────────────────

const SELLER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LISTING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EVENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORIGINAL_ORDER_ITEM_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ORIGINAL_ORDER_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeListing(
  overrides: Partial<ResaleListingRecord> = {},
): ResaleListingRecord {
  return {
    id: LISTING_ID,
    ticketId: TICKET_ID,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
    currency: "usd",
    status: "ACTIVE",
    expiresAt: null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    buyerOrderId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    orderItemId: ORIGINAL_ORDER_ITEM_ID,
    ...overrides,
  };
}

function makeDeps(opts?: {
  listing?: ResaleListingRecord | null;
  ticket?: ReturnType<typeof makeTicket> | null;
  /** How the ticket's purchase order was sold. Default: PRIMARY. */
  purchaseOrderSource?: "PRIMARY" | "RESALE" | "COMP";
}) {
  const listing = opts?.listing !== undefined ? opts.listing : makeListing();
  const ticket = opts?.ticket !== undefined ? opts.ticket : makeTicket();

  const getById = vi.fn(async () => listing);
  // The adapter's ACTIVE → CANCELLED compare-and-swap: true = it flipped.
  const cancel = vi.fn(async (..._args: unknown[]) => true);
  const getTicketById = vi.fn(async () => ticket);
  const getTicketByIdForUpdate = vi.fn(async () => ticket);
  const setStatus = vi.fn(async (..._args: unknown[]) => true);
  const setResaleListingId = vi.fn(async () => {});
  const auditLog = vi.fn(async () => {});

  const listingsRepo = { getById, cancel } as any;
  // The use case reads the ticket under the row lock.
  const ticketsRepo = {
    getById: getTicketById,
    getByIdForUpdate: getTicketByIdForUpdate,
    setStatus,
  } as any;
  // The pointer rule reads the purchase item and its order's `source`.
  const getOrderItemById = vi.fn(async (id: string) => ({
    id,
    orderId: ORIGINAL_ORDER_ID,
  }));
  const getOrderById = vi.fn(async (id: string) => ({
    id,
    source: opts?.purchaseOrderSource ?? "PRIMARY",
  }));
  const orderItemsRepo = {
    setResaleListingId,
    getById: getOrderItemById,
  } as any;
  const ordersRepo = { getById: getOrderById } as any;
  const auditRepo = { log: auditLog } as any;

  const repos = {
    resaleListings: listingsRepo,
    tickets: ticketsRepo,
    orderItems: orderItemsRepo,
    audit: auditRepo,
    tx: vi.fn(async (fn: any) =>
      fn({
        resaleListings: listingsRepo,
        tickets: ticketsRepo,
        orderItems: orderItemsRepo,
        orders: ordersRepo,
        audit: auditRepo,
      }),
    ),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };

  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;

  return {
    deps: { repos, clock, logger } satisfies CancelResaleListingDeps,
    mocks: {
      getById,
      getTicketById,
      getTicketByIdForUpdate,
      cancel,
      setStatus,
      setResaleListingId,
      auditLog,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("cancelResaleListing", () => {
  // A ticket bought on resale can be listed again (owner ruling 2026-10-11).
  // Its purchase item's `resaleListingId` is the listing it was BOUGHT
  // through, which a refund of that purchase reads to find the sale to undo.
  // Cancelling the buyer's own listing must not wipe it.
  it("leaves the bought-through pointer alone when the ticket was bought on resale", async () => {
    const { deps, mocks } = makeDeps({ purchaseOrderSource: "RESALE" });

    const result = await cancelResaleListing(deps, {
      actorHumanId: SELLER_ID,
      listingId: LISTING_ID,
    });

    expect(result).toEqual({ listingId: LISTING_ID, ticketId: TICKET_ID });
    expect(mocks.setResaleListingId).not.toHaveBeenCalled();
    // Everything else about the cancel is unchanged.
    expect(mocks.cancel).toHaveBeenCalledWith(LISTING_ID, SELLER_ID);
    expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "VALID", {
      expectedStatus: "LISTED",
    });
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cancelled", entityId: LISTING_ID }),
    );
  });

  it.each(["PRIMARY", "COMP"] as const)(
    "clears the listed-now pointer of a %s purchase item",
    async (purchaseOrderSource) => {
      const { deps, mocks } = makeDeps({ purchaseOrderSource });

      await cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      });

      expect(mocks.setResaleListingId).toHaveBeenCalledWith(
        ORIGINAL_ORDER_ITEM_ID,
        null,
      );
    },
  );

  // The listing is read unlocked, so a buyer's `hold` can flip it to HELD
  // before the cancel lands. The cancel is a compare-and-swap: if it flips
  // nothing, the buyer's checkout owns the listing, and putting the ticket
  // back to VALID would make their paid finalize fail.
  it("refuses with LISTING_NOT_ACTIVE, ticket untouched, when a hold wins the cancel", async () => {
    const { deps, mocks } = makeDeps();
    mocks.cancel.mockResolvedValueOnce(false);

    await expect(
      cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      }),
    ).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });

    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.setResaleListingId).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("locks the ticket before it cancels the listing (ticket, then listing)", async () => {
    const { deps, mocks } = makeDeps();

    await cancelResaleListing(deps, {
      actorHumanId: SELLER_ID,
      listingId: LISTING_ID,
    });

    expect(mocks.getTicketByIdForUpdate).toHaveBeenCalledWith(TICKET_ID);
    expect(
      mocks.getTicketByIdForUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0]!);
    // The use case never reads the ticket without the lock.
    expect(mocks.getTicketById).not.toHaveBeenCalled();
  });

  // Refunds restock (spec 2026-10-09): REFUNDED and INVALID are terminal. A
  // ticket voided while its listing stayed open (a revoked comp) must stay
  // voided when the seller cancels: the write is LISTED → VALID only, and a
  // ticket in any other status is left alone while the listing still closes.
  it("cancels the listing but leaves a voided ticket voided", async () => {
    const { deps, mocks } = makeDeps({
      ticket: makeTicket({ status: "INVALID" }),
    });
    // The adapter's compare-and-swap: an INVALID ticket is not LISTED.
    mocks.setStatus.mockResolvedValueOnce(false);

    const result = await cancelResaleListing(deps, {
      actorHumanId: SELLER_ID,
      listingId: LISTING_ID,
    });

    expect(result.listingId).toBe(LISTING_ID);
    expect(mocks.cancel).toHaveBeenCalledWith(LISTING_ID, SELLER_ID);
    expect(mocks.setStatus).toHaveBeenCalledTimes(1);
    expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "VALID", {
      expectedStatus: "LISTED",
    });
  });

  it("cancels an active listing and restores ticket to VALID", async () => {
    const { deps, mocks } = makeDeps();

    const result = await cancelResaleListing(deps, {
      actorHumanId: SELLER_ID,
      listingId: LISTING_ID,
    });

    expect(result.listingId).toBe(LISTING_ID);
    expect(result.ticketId).toBe(TICKET_ID);
    expect(mocks.cancel).toHaveBeenCalledWith(LISTING_ID, SELLER_ID);
    expect(mocks.setStatus).toHaveBeenCalledWith(TICKET_ID, "VALID", {
      expectedStatus: "LISTED",
    });
    expect(mocks.setResaleListingId).toHaveBeenCalledWith(
      ORIGINAL_ORDER_ITEM_ID,
      null,
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "resale_listing",
        entityId: LISTING_ID,
        action: "cancelled",
      }),
    );
  });

  it("throws listing_not_found when listing does not exist", async () => {
    const { deps } = makeDeps({ listing: null });

    await expect(
      cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "LISTING_NOT_FOUND" }));
  });

  it("throws forbidden when actor is not the seller", async () => {
    const { deps } = makeDeps({
      listing: makeListing({ sellerHumanId: "other-seller-uuid" }),
    });

    await expect(
      cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("throws listing_not_active when listing is already SOLD", async () => {
    const { deps } = makeDeps({
      listing: makeListing({ status: "SOLD" }),
    });

    await expect(
      cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "LISTING_NOT_ACTIVE" }));
  });

  it("throws listing_not_active when listing is CANCELLED", async () => {
    const { deps } = makeDeps({
      listing: makeListing({ status: "CANCELLED" }),
    });

    await expect(
      cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "LISTING_NOT_ACTIVE" }));
  });

  it("throws listing_not_active when listing is EXPIRED", async () => {
    const { deps } = makeDeps({
      listing: makeListing({ status: "EXPIRED" }),
    });

    await expect(
      cancelResaleListing(deps, {
        actorHumanId: SELLER_ID,
        listingId: LISTING_ID,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "LISTING_NOT_ACTIVE" }));
  });
});
