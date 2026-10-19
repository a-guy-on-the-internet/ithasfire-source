import { describe, it, expect, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ResaleListingRecord } from "@th/types/repos/resale-listings";

import { listMyResaleListings } from "../list-my-resale-listings";

// ── Constants ──────────────────────────────────────────────────────────────

const SELLER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeListing(
  overrides: Partial<ResaleListingRecord> = {},
): ResaleListingRecord {
  return {
    id: crypto.randomUUID(),
    ticketId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
    faceValueCents: 4000,
    eventShareCents: 500,
    sharePayer: "SELLER",
    processingPassThroughCents: 175,
    processingFeeConfigRef: "resale-default",
    saleCutoffAt: new Date("2026-03-31T23:00:00Z"),
    payoutReleaseAt: new Date("2026-04-05T12:00:00Z"),
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

function makeDeps(
  items: ResaleListingRecord[],
  total?: number,
  events: Array<{ id: string; startsAt: Date; endsAt: Date | null }> = [],
) {
  const reportError = vi.fn();
  const listBySeller = vi.fn(async () => ({
    items,
    pageInfo: {
      total: total ?? items.length,
      limit: 20,
      offset: 0,
      hasMore: false,
    },
  }));

  // Read for the release-date clamp (claim window from the CURRENT end).
  // Default: no events found → the stored release is shown as-is.
  const findManyByIds = vi.fn(async (ids: string[]) =>
    events.filter((event) => ids.includes(event.id)),
  );

  return {
    deps: {
      clock: { now: () => new Date("2026-03-10T12:00:00Z") },
      repos: {
        resaleListings: { listBySeller },
        events: { findManyByIds },
        // The fee policy listings freeze: 2.9% + 30 cents, whatever the ref.
        feePolicies: {
          getByIds: vi.fn(
            async (ids: string[]) =>
              new Map(
                ids.map((id) => [
                  id,
                  { id, processsorFeePct: 0.029, processorFixedCents: 30 },
                ]),
              ),
          ),
        },
      } as unknown as Repos,
      reportError,
    },
    mocks: { listBySeller, findManyByIds, reportError },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("listMyResaleListings", () => {
  it("returns listings for the seller with serialized finance snapshot fields", async () => {
    const buyerOrderId = crypto.randomUUID();
    const listing = makeListing({
      buyerOrderId,
      expiresAt: new Date("2026-04-01T00:00:00Z"),
    });
    const { deps, mocks } = makeDeps([listing]);

    const result = await listMyResaleListings(deps, {
      actorHumanId: SELLER_ID,
    });

    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe(listing.id);
    expect(result.items[0]!.faceValueCents).toBe(4000);
    expect(result.items[0]!.eventShareCents).toBe(500);
    expect(result.items[0]!.sharePayer).toBe("SELLER");
    expect(result.items[0]!.processingPassThroughCents).toBe(181);
    expect(result.items[0]!.saleCutoffAt).toBe("2026-03-31T23:00:00.000Z");
    expect(result.items[0]!.payoutReleaseAt).toBe("2026-04-05T12:00:00.000Z");
    expect(result.items[0]!.buyerOrderId).toBe(buyerOrderId);
    expect(result.items[0]!.expiresAt).toBe("2026-04-01T00:00:00.000Z");
    expect(result.items[0]!.createdAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("returns empty items when seller has no listings", async () => {
    const { deps } = makeDeps([], 0);

    const result = await listMyResaleListings(deps, {
      actorHumanId: SELLER_ID,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("passes status filter to repo", async () => {
    const { deps, mocks } = makeDeps([]);

    await listMyResaleListings(deps, {
      actorHumanId: SELLER_ID,
      status: ["ACTIVE", "HELD"],
    });

    expect(mocks.listBySeller).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerHumanId: SELLER_ID,
        status: ["ACTIVE", "HELD"],
      }),
    );
  });

  it("passes limit and offset to repo", async () => {
    const { deps, mocks } = makeDeps([]);

    await listMyResaleListings(deps, {
      actorHumanId: SELLER_ID,
      limit: 10,
      offset: 5,
    });

    expect(mocks.listBySeller).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        offset: 5,
      }),
    );
  });

  it("returns null values for nullable snapshot fields", async () => {
    const listing = makeListing({
      faceValueCents: null,
      saleCutoffAt: null,
      payoutReleaseAt: null,
      buyerOrderId: null,
      expiresAt: null,
    });
    const { deps } = makeDeps([listing]);

    const result = await listMyResaleListings(deps, {
      actorHumanId: SELLER_ID,
    });

    expect(result.items[0]!.faceValueCents).toBeNull();
    expect(result.items[0]!.saleCutoffAt).toBeNull();
    expect(result.items[0]!.payoutReleaseAt).toBeNull();
    expect(result.items[0]!.buyerOrderId).toBeNull();
    expect(result.items[0]!.expiresAt).toBeNull();
  });

  it("returns total from pageInfo", async () => {
    const listing = makeListing();
    const { deps } = makeDeps([listing], 42);

    const result = await listMyResaleListings(deps, {
      actorHumanId: SELLER_ID,
    });

    expect(result.total).toBe(42);
  });

  it("derives current processing for ACTIVE listings but keeps a SOLD row's stored value", async () => {
    const active = makeListing({ status: "ACTIVE" });
    const sold = makeListing({ status: "SOLD" });
    const { deps, mocks } = makeDeps([active, sold]);

    const result = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });

    expect(result.items[0]!.processingPassThroughCents).toBe(181);
    expect(result.items[1]!.processingPassThroughCents).toBe(175);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  describe("release date clamped to the claim window's close", () => {
    const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    it("shows the claim close when the stored release is earlier (0-day policy)", async () => {
      // Event ends 2026-04-01T23:00Z → claims close 2026-04-04T23:00Z.
      const end = new Date("2026-04-01T23:00:00Z");
      const listing = makeListing({ eventId: EVENT_ID, payoutReleaseAt: end });
      const { deps } = makeDeps([listing], undefined, [
        { id: EVENT_ID, startsAt: end, endsAt: end },
      ]);

      const result = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });

      expect(result.items[0]!.payoutReleaseAt).toBe("2026-04-04T23:00:00.000Z");
    });

    it("follows the event's CURRENT end when the event moved later after listing", async () => {
      const movedEnd = new Date("2026-04-10T23:00:00Z");
      const listing = makeListing({
        eventId: EVENT_ID,
        payoutReleaseAt: new Date("2026-04-05T12:00:00Z"),
      });
      const { deps } = makeDeps([listing], undefined, [
        { id: EVENT_ID, startsAt: movedEnd, endsAt: movedEnd },
      ]);

      const result = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });

      expect(result.items[0]!.payoutReleaseAt).toBe("2026-04-13T23:00:00.000Z");
    });

    it("keeps a stored release that is already after the claim close", async () => {
      const end = new Date("2026-04-01T23:00:00Z");
      const listing = makeListing({
        eventId: EVENT_ID,
        payoutReleaseAt: new Date("2026-04-08T23:00:00Z"),
      });
      const { deps } = makeDeps([listing], undefined, [
        { id: EVENT_ID, startsAt: end, endsAt: end },
      ]);

      const result = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });

      expect(result.items[0]!.payoutReleaseAt).toBe("2026-04-08T23:00:00.000Z");
    });

    it("reads events once, batched, and skips the read when no listing has a release", async () => {
      const a = makeListing({ eventId: EVENT_ID });
      const b = makeListing({ eventId: EVENT_ID });
      const { deps, mocks } = makeDeps([a, b]);
      await listMyResaleListings(deps, { actorHumanId: SELLER_ID });
      expect(mocks.findManyByIds).toHaveBeenCalledTimes(1);
      expect(mocks.findManyByIds).toHaveBeenCalledWith([EVENT_ID]);

      const none = makeDeps([makeListing({ payoutReleaseAt: null })]);
      await listMyResaleListings(none.deps, { actorHumanId: SELLER_ID });
      expect(none.mocks.findManyByIds).not.toHaveBeenCalled();
    });
  });
});
