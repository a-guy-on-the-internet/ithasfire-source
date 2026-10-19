import { describe, it, expect, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { ResaleListingRecord } from "@th/types/repos/resale-listings";

import { getResaleListing } from "../get-resale-listing";

// ── Constants ──────────────────────────────────────────────────────────────

const LISTING_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const TICKET_ID = "bb222222-bb22-4b22-8b22-bb2222222222";
const EVENT_ID = "cc333333-cc33-4c33-8c33-cc3333333333";
const SELLER_ID = "dd444444-dd44-4d44-8d44-dd4444444444";
const TICKET_TYPE_ID = "ee555555-ee55-4e55-8e55-ee5555555555";
const SECTION_ID = "ff666666-ff66-4f66-8f66-ff6666666666";
const SEAT_ID = "aa777777-aa77-4a77-8a77-aa7777777777";
const ORDER_ITEM_ID = "bb888888-bb88-4b88-8b88-bb8888888888";
const BUYER_ID = "cc121212-cc12-4c12-8c12-cc1212121212";
const BUYER_ORDER_ID = "dd131313-dd13-4d13-8d13-dd1313131313";
const STRANGER_ID = "ee141414-ee14-4e14-8e14-ee1414141414";
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
    // Null by default so these tests exercise the OrderItem path; a real
    // internal listing always carries its own frozen snapshot.
    faceValueCents: null,
    processingPassThroughCents: 0,
    processingFeeConfigRef: null,
    saleCutoffAt: null,
    payoutReleaseAt: null,
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
    eventId: EVENT_ID,
    ownerHumanId: SELLER_ID,
    status: "LISTED",
    ticketTypeId: TICKET_TYPE_ID,
    seatId: null,
    orderItemId: ORDER_ITEM_ID,
    code: "abc123",
    ...overrides,
  };
}

/** The seller's purchase snapshot: `OrderItem.unitPriceCents`. */
function makeOrderItem(unitPriceCents: number) {
  return {
    id: ORDER_ITEM_ID,
    orderId: "cc999999-cc99-4c99-8c99-cc9999999999",
    kind: "ticket",
    ticketTypeId: TICKET_TYPE_ID,
    qty: 1,
    unitPriceCents,
    amountCents: unitPriceCents,
    meta: {},
    status: "active",
  };
}

function makeTicketType(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_TYPE_ID,
    name: "VIP",
    priceCents: 10000,
    resaleAllowed: true,
    resaleCapCents: null,
    seatSectionId: null,
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Test Concert",
    slug: "test-concert",
    startsAt: new Date("2026-04-01T19:00:00Z"),
    locationLabel: "Test Venue",
    status: "PUBLISHED",
    publishedAt: new Date("2026-03-01T00:00:00Z"),
    ownerBanned: false,
    ...overrides,
  };
}

function makeDeps(opts?: {
  listing?: ResaleListingRecord | null;
  ticket?: any;
  ticketType?: any;
  event?: any;
  section?: any;
  seats?: any[];
  /** `OrderItem.unitPriceCents` — what the seller actually paid. */
  purchasedUnitPriceCents?: number;
  /** Force `orderItems.getById` to miss (legacy / fixture ticket). */
  orderItemMissing?: boolean;
  /** The buyer's order a SOLD listing points at. */
  buyerOrder?: { id: string; buyerHumanId: string } | null;
  reportError?: ReporterPort;
}) {
  const listing = opts?.listing !== undefined ? opts.listing : makeListing();
  const ticket = opts?.ticket !== undefined ? opts.ticket : makeTicket();
  const ticketType =
    opts?.ticketType !== undefined ? opts.ticketType : makeTicketType();
  const event = opts?.event !== undefined ? opts.event : makeEvent();
  const section = opts?.section !== undefined ? opts.section : null;
  const seats = opts?.seats ?? [];
  const getOrderItemById = vi.fn(async () =>
    opts?.orderItemMissing
      ? null
      : makeOrderItem(opts?.purchasedUnitPriceCents ?? 8000),
  );

  return {
    clock: { now: () => NOW },
    repos: {
      resaleListings: {
        getById: vi.fn(async () => listing),
      },
      tickets: {
        getById: vi.fn(async () => ticket),
        getTicketTypeById: vi.fn(async () => ticketType),
      },
      orderItems: {
        getById: getOrderItemById,
      },
      events: {
        getById: vi.fn(async () => event),
      },
      orders: {
        getById: vi.fn(async () => opts?.buyerOrder ?? null),
      },
      seats: {
        getSectionById: vi.fn(async () => section),
        findLabelsByIds: vi.fn(async () => seats),
        // A public read must never take the seat lock.
        findByIdsForUpdate: vi.fn(async () => {
          throw new Error("getResaleListing must not lock seats");
        }),
      },
    } as unknown as Repos,
    ...(opts?.reportError ? { reportError: opts.reportError } : {}),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getResaleListing", () => {
  it("returns enriched listing with ticket type and event context", async () => {
    const deps = makeDeps({
      ticketType: makeTicketType({ name: "VIP", priceCents: 10000 }),
      event: makeEvent({ title: "Big Show", slug: "big-show" }),
      purchasedUnitPriceCents: 8000,
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.id).toBe(LISTING_ID);
    expect(result.ticketTypeName).toBe("VIP");
    // FR-001: what the seller PAID (8000), not the live type price (10000).
    expect(result.facePriceCents).toBe(8000);
    expect(result.eventName).toBe("Big Show");
    expect(result.eventSlug).toBe("big-show");
    expect(result.eventStartsAt).toBe("2026-04-01T19:00:00.000Z");
    expect(result.eventLocationLabel).toBe("Test Venue");
  });

  it("throws listing_not_found when listing does not exist", async () => {
    const deps = makeDeps({ listing: null });

    await expect(
      getResaleListing(deps, { listingId: LISTING_ID }),
    ).rejects.toEqual(expect.objectContaining({ code: "LISTING_NOT_FOUND" }));
  });

  it("returns null enrichment when ticket has no ticket type", async () => {
    const deps = makeDeps({
      ticket: makeTicket({ ticketTypeId: null }),
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.ticketTypeName).toBeNull();
    expect(result.sectionName).toBeNull();
    // Face value is independent of the type — it comes from the OrderItem.
    expect(result.facePriceCents).toBe(8000);
  });

  // ── FR-001: historical face value ────────────────────────────────────
  it("prefers the listing's own frozen face-value snapshot over the OrderItem", async () => {
    const deps = makeDeps({
      listing: makeListing({ faceValueCents: 1200 }),
      ticketType: makeTicketType({ priceCents: 2000 }),
      purchasedUnitPriceCents: 1500,
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.facePriceCents).toBe(1200);
  });

  it("never reports the live ticket-type price as face value", async () => {
    // Bought at $12 early-bird; organizer later raised the type to $20.
    const deps = makeDeps({
      ticketType: makeTicketType({ priceCents: 2000 }),
      purchasedUnitPriceCents: 1200,
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.facePriceCents).toBe(1200);
    expect(result.facePriceCents).not.toBe(2000);
  });

  it("returns null face value and reports when no purchase snapshot is reachable", async () => {
    const reportError = vi.fn();
    const deps = makeDeps({
      ticketType: makeTicketType({ priceCents: 2000 }),
      orderItemMissing: true,
      reportError,
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    // Degraded to null — never the live 2000.
    expect(result.facePriceCents).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "getResaleListing" },
        extra: expect.objectContaining({
          listingId: LISTING_ID,
          ticketId: TICKET_ID,
        }),
      }),
    );
  });

  it("survives a throwing reporter on the degraded branch", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry exploded");
    });
    const deps = makeDeps({ orderItemMissing: true, reportError });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.facePriceCents).toBeNull();
    expect(reportError).toHaveBeenCalled();
  });

  it("resolves section from ticket type", async () => {
    const deps = makeDeps({
      ticketType: makeTicketType({ seatSectionId: SECTION_ID }),
      section: { id: SECTION_ID, name: "Section A" },
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.sectionName).toBe("Section A");
    expect(result.sectionId).toBe(SECTION_ID);
  });

  it("resolves seat details when ticket has a seatId", async () => {
    const deps = makeDeps({
      ticket: makeTicket({ seatId: SEAT_ID }),
      seats: [
        {
          id: SEAT_ID,
          label: "A12",
          row: "A",
          number: 12,
          seatSectionId: SECTION_ID,
          sectionName: "Floor",
        },
      ],
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.seatLabel).toBe("A12");
    expect(result.seatRow).toBe("A");
    expect(result.seatNumber).toBe(12);
    // The type named no section, so the seat's own section is shown.
    expect(result.sectionName).toBe("Floor");
    expect(result.sectionId).toBe(SECTION_ID);
    expect(deps.repos.seats.findLabelsByIds).toHaveBeenCalledWith({
      seatIds: [SEAT_ID],
      eventId: EVENT_ID,
    });
    expect(deps.repos.seats.findByIdsForUpdate).not.toHaveBeenCalled();
  });

  it("serializes dates to ISO strings", async () => {
    const deps = makeDeps({
      listing: makeListing({
        expiresAt: new Date("2026-04-01T00:00:00Z"),
      }),
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.expiresAt).toBe("2026-04-01T00:00:00.000Z");
    expect(result.createdAt).toBe("2026-03-10T12:00:00.000Z");
    expect(result.updatedAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("returns null expiresAt when listing has no expiry", async () => {
    const deps = makeDeps({
      listing: makeListing({ expiresAt: null }),
    });

    const result = await getResaleListing(deps, { listingId: LISTING_ID });

    expect(result.expiresAt).toBeNull();
  });

  it("returns null event context to the seller when the event is not found", async () => {
    const deps = makeDeps({ event: null });

    const result = await getResaleListing(deps, {
      listingId: LISTING_ID,
      viewerHumanId: SELLER_ID,
    });

    expect(result.eventName).toBeNull();
    expect(result.eventSlug).toBeNull();
    expect(result.eventStartsAt).toBeNull();
  });

  // ── Who may read it (owner ruling 2026-10-13: the link works for anyone,
  // let in or not, while the listing is on sale) ─────────────────────────
  describe("access", () => {
    it.each(["ACTIVE", "HELD"] as const)(
      "an anonymous viewer reads a %s listing, without the seller's or ticket's id",
      async (status) => {
        const deps = makeDeps({ listing: makeListing({ status }) });

        const result = await getResaleListing(deps, { listingId: LISTING_ID });

        expect(result.status).toBe(status);
        expect(result.isOwnListing).toBe(false);
        expect(result).not.toHaveProperty("sellerHumanId");
        expect(result).not.toHaveProperty("ticketId");
        expect(JSON.stringify(result)).not.toContain(SELLER_ID);
        expect(JSON.stringify(result)).not.toContain(TICKET_ID);
      },
    );

    it.each(["SOLD", "CANCELLED", "EXPIRED"] as const)(
      "a %s listing is LISTING_NOT_FOUND to anyone but the seller, and nothing is enriched",
      async (status) => {
        const deps = makeDeps({
          listing: makeListing({ status, buyerOrderId: BUYER_ORDER_ID }),
          buyerOrder: { id: BUYER_ORDER_ID, buyerHumanId: BUYER_ID },
        });

        for (const viewerHumanId of [null, STRANGER_ID]) {
          await expect(
            getResaleListing(deps, { listingId: LISTING_ID, viewerHumanId }),
          ).rejects.toEqual(
            expect.objectContaining({ code: "LISTING_NOT_FOUND" }),
          );
        }
        expect(deps.repos.tickets.getById).not.toHaveBeenCalled();
      },
    );

    it.each(["SOLD", "CANCELLED", "EXPIRED", "HELD"] as const)(
      "the seller reads their own %s listing, flagged as theirs",
      async (status) => {
        const deps = makeDeps({ listing: makeListing({ status }) });

        const result = await getResaleListing(deps, {
          listingId: LISTING_ID,
          viewerHumanId: SELLER_ID,
        });

        expect(result.status).toBe(status);
        expect(result.isOwnListing).toBe(true);
      },
    );

    it("the buyer reads the SOLD listing they bought", async () => {
      const deps = makeDeps({
        listing: makeListing({ status: "SOLD", buyerOrderId: BUYER_ORDER_ID }),
        buyerOrder: { id: BUYER_ORDER_ID, buyerHumanId: BUYER_ID },
      });

      const result = await getResaleListing(deps, {
        listingId: LISTING_ID,
        viewerHumanId: BUYER_ID,
      });

      expect(result.status).toBe("SOLD");
      expect(result.isOwnListing).toBe(false);
      expect(deps.repos.orders.getById).toHaveBeenCalledWith(BUYER_ORDER_ID);
    });

    it.each([
      ["the event is a draft", { status: "DRAFT", publishedAt: null }],
      ["the event is cancelled", { status: "CANCELLED" }],
      ["the event is RSVP-only", { attendanceMode: "RSVP" }],
      ["the event is gone", null],
    ])(
      "an ACTIVE listing is LISTING_NOT_FOUND to a non-seller when %s, and readable by the seller",
      async (_label, eventOverride) => {
        const event = eventOverride === null ? null : makeEvent(eventOverride);
        const deps = makeDeps({ event });

        await expect(
          getResaleListing(deps, {
            listingId: LISTING_ID,
            viewerHumanId: STRANGER_ID,
          }),
        ).rejects.toEqual(expect.objectContaining({ code: "LISTING_NOT_FOUND" }));

        const own = await getResaleListing(deps, {
          listingId: LISTING_ID,
          viewerHumanId: SELLER_ID,
        });
        expect(own.isOwnListing).toBe(true);
      },
    );

    // Ban-that-sticks (2026-09-29): holders keep their tickets and resale
    // stays open; createResaleCheckout sells it, so the link must show it.
    it("an ACTIVE listing of a BANNED owner's event is readable by anyone", async () => {
      const deps = makeDeps({ event: makeEvent({ ownerBanned: true }) });

      for (const viewerHumanId of [null, STRANGER_ID]) {
        const result = await getResaleListing(deps, {
          listingId: LISTING_ID,
          viewerHumanId,
        });
        expect(result.status).toBe("ACTIVE");
        expect(result.eventName).toBe("Test Concert");
      }
    });
  });
});
