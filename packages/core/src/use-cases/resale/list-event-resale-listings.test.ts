import { describe, it, expect, vi } from "vitest";
import { listEventResaleListings } from "./list-event-resale-listings";

// ── Helpers ──────────────────────────────────────────────────────────────────

const EVENT_ID = "a0a0a0a0-1111-4222-a333-444444444444";
const SECTION_A_ID = "b0b0b0b0-1111-4222-a333-444444444444";
const SECTION_B_ID = "c0c0c0c0-1111-4222-a333-444444444444";
const BAD_LISTING_A = "d0d0d0d0-1111-4222-a333-444444444444";
const BAD_LISTING_B = "e0e0e0e0-1111-4222-a333-444444444444";

const now = new Date("2026-03-10T12:00:00Z");

function makeListing(
  overrides: Partial<{
    id: string;
    ticketId: string;
    eventId: string;
    askPriceCents: number;
    currency: string;
    ticketTypeName: string | null;
    facePriceCents: number | null;
    sectionName: string | null;
    sectionId: string | null;
    seatLabel: string | null;
    seatRow: string | null;
    seatNumber: number | null;
    expiresAt: Date | null;
  }>,
) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    ticketId: overrides.ticketId ?? crypto.randomUUID(),
    eventId: overrides.eventId ?? EVENT_ID,
    sellerHumanId: crypto.randomUUID(),
    askPriceCents: overrides.askPriceCents ?? 5000,
    currency: overrides.currency ?? "usd",
    status: "ACTIVE" as const,
    expiresAt: overrides.expiresAt ?? null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    buyerOrderId: null,
    createdAt: now,
    updatedAt: now,
    // enriched fields
    ticketTypeName: overrides.ticketTypeName ?? null,
    facePriceCents: overrides.facePriceCents ?? null,
    sectionName: overrides.sectionName ?? null,
    sectionId: overrides.sectionId ?? null,
    seatLabel: overrides.seatLabel ?? null,
    seatRow: overrides.seatRow ?? null,
    seatNumber: overrides.seatNumber ?? null,
  };
}

function makeDeps(
  items: ReturnType<typeof makeListing>[],
  total?: number,
  reportError?: (error: unknown, ctx?: unknown) => void,
) {
  return {
    clock: { now: () => new Date("2026-03-10T12:00:00Z") },
    repos: {
      resaleListings: {
        listByEventEnriched: vi.fn(async () => ({
          items,
          pageInfo: {
            total: total ?? items.length,
            limit: 20,
            offset: 0,
            hasMore: false,
          },
        })),
      },
    },
    ...(reportError ? { reportError } : {}),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listEventResaleListings", () => {
  it("returns enriched listings with seat/section/ticket-type context", async () => {
    const listing = makeListing({
      askPriceCents: 7500,
      ticketTypeName: "VIP",
      facePriceCents: 10000,
      sectionName: "Section A",
      sectionId: SECTION_A_ID,
      seatLabel: "A12",
      seatRow: "A",
      seatNumber: 12,
    });

    const deps = makeDeps([listing]);
    const result = await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.ticketTypeName).toBe("VIP");
    expect(item.facePriceCents).toBe(10000);
    expect(item.sectionName).toBe("Section A");
    expect(item.sectionId).toBe(SECTION_A_ID);
    expect(item.seatLabel).toBe("A12");
    expect(item.seatRow).toBe("A");
    expect(item.seatNumber).toBe(12);
    expect(item.askPriceCents).toBe(7500);
  });

  it("returns nulls for GA/unseated listings", async () => {
    const listing = makeListing({
      ticketTypeName: "General Admission",
      facePriceCents: 3000,
      // no seat info
    });

    const deps = makeDeps([listing]);
    const result = await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.ticketTypeName).toBe("General Admission");
    expect(item.sectionName).toBeNull();
    expect(item.sectionId).toBeNull();
    expect(item.seatLabel).toBeNull();
    expect(item.seatRow).toBeNull();
    expect(item.seatNumber).toBeNull();
  });

  it("collects distinct sections for the filter dropdown", async () => {
    const listings = [
      makeListing({ sectionName: "Section A", sectionId: SECTION_A_ID }),
      makeListing({ sectionName: "Section A", sectionId: SECTION_A_ID }),
      makeListing({ sectionName: "Section B", sectionId: SECTION_B_ID }),
      makeListing({ sectionName: null, sectionId: null }),
    ];

    const deps = makeDeps(listings);
    const result = await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(result.sections).toHaveLength(2);
    const sectionIds = result.sections.map((s) => s.id);
    expect(sectionIds).toContain(SECTION_A_ID);
    expect(sectionIds).toContain(SECTION_B_ID);
  });

  it("returns empty sections array when no listings have sections", async () => {
    const listings = [
      makeListing({ sectionName: null, sectionId: null }),
      makeListing({ sectionName: null, sectionId: null }),
    ];

    const deps = makeDeps(listings);
    const result = await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(result.sections).toHaveLength(0);
  });

  it("passes sectionId to the repo when filtering", async () => {
    const deps = makeDeps([]);

    await listEventResaleListings(deps, {
      eventId: EVENT_ID,
      sectionId: SECTION_A_ID,
    });

    expect(deps.repos.resaleListings.listByEventEnriched).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        sectionId: SECTION_A_ID,
        status: ["ACTIVE"],
      }),
    );
  });

  it("asks only for listings priced under the share (a markup-split listing cannot be bought)", async () => {
    const deps = makeDeps([]);

    await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(deps.repos.resaleListings.listByEventEnriched).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["ACTIVE"], onlyWithShare: true }),
    );
  });

  it("serializes dates to ISO strings", async () => {
    const expiresAt = new Date("2026-04-01T00:00:00Z");
    const listing = makeListing({ expiresAt });

    const deps = makeDeps([listing]);
    const result = await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(result.items[0]!.expiresAt).toBe("2026-04-01T00:00:00.000Z");
    expect(result.items[0]!.createdAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("returns empty results for an event with no listings", async () => {
    const deps = makeDeps([], 0);
    const result = await listEventResaleListings(deps, { eventId: EVENT_ID });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.sections).toHaveLength(0);
  });

  it("respects limit and offset", async () => {
    const deps = makeDeps([]);

    await listEventResaleListings(deps, {
      eventId: EVENT_ID,
      limit: 10,
      offset: 5,
    });

    expect(deps.repos.resaleListings.listByEventEnriched).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        offset: 5,
      }),
    );
  });

  it("rejects invalid eventId", async () => {
    const deps = makeDeps([]);

    await expect(
      listEventResaleListings(deps, { eventId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── FR-001 monitoring parity with getResaleListing ─────────────────────
  //
  // The adapter degrades an unresolvable historical face value to null. The
  // detail page reports that; so must the browse list, or the same defect is
  // visible to one buyer and invisible to a hundred.

  describe("missing historical face value", () => {
    it("reports ONCE per response, listing the offending ids", async () => {
      const reportError = vi.fn();
      const deps = makeDeps(
        [
          makeListing({ id: BAD_LISTING_A, facePriceCents: null }),
          makeListing({ id: BAD_LISTING_B, facePriceCents: null }),
          makeListing({ facePriceCents: 5000 }),
        ],
        3,
        reportError,
      );

      const result = await listEventResaleListings(deps, {
        eventId: EVENT_ID,
      });

      // The response is unaffected — this is monitoring, not a gate.
      expect(result.items).toHaveLength(3);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "listEventResaleListings" },
          extra: expect.objectContaining({
            eventId: EVENT_ID,
            count: 2,
            listingIds: [BAD_LISTING_A, BAD_LISTING_B],
          }),
        }),
      );
    });

    it("stays silent when every row resolved a face value", async () => {
      const reportError = vi.fn();
      const deps = makeDeps(
        [makeListing({ facePriceCents: 5000 }), makeListing({ facePriceCents: 0 })],
        2,
        reportError,
      );

      await listEventResaleListings(deps, { eventId: EVENT_ID });

      // Note the second row is a COMP listing at face 0 — a real price, not a
      // missing one. A falsy check here would have reported it.
      expect(reportError).not.toHaveBeenCalled();
    });

    it("still returns results when the reporter throws", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry exploded");
      });
      const deps = makeDeps(
        [makeListing({ facePriceCents: null })],
        1,
        reportError,
      );

      const result = await listEventResaleListings(deps, {
        eventId: EVENT_ID,
      });

      expect(result.items).toHaveLength(1);
      expect(reportError).toHaveBeenCalled();
    });
  });
});
