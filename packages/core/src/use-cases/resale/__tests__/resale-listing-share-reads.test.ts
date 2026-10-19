import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { computeResaleShare } from "../../../lib/pricing/resale-pricing";
import {
  buyerTotalBeforeFeesCents,
  buyerTotalBeforeTaxCents,
  sellerReceivesCents,
} from "../_shared/resale-listing-display";
import { getResaleListing } from "../get-resale-listing";
import { listEventResaleListings } from "../list-event-resale-listings";
import { listMyResaleListings } from "../list-my-resale-listings";

// Organiser-resale-share B6: the three listing reads carry the share, who pays
// it, the buyer's total before fees and the ORIGINAL price (first sale).

const LISTING_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const TICKET_ID = "bb222222-bb22-4b22-8b22-bb2222222222";
const EVENT_ID = "cc333333-cc33-4c33-8c33-cc3333333333";
const SELLER_ID = "dd444444-dd44-4d44-8d44-dd4444444444";
const TYPE_ID = "ee555555-ee55-4e55-8e55-ee5555555555";
const ITEM_ID = "bb888888-bb88-4b88-8b88-bb8888888888";
const NOW = new Date("2026-03-10T12:00:00Z");
const clock = { now: () => NOW };

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    ticketId: TICKET_ID,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
    faceValueCents: 4000,
    processingPassThroughCents: 0,
    // A share listing always freezes the fee policy it priced processing with.
    processingFeeConfigRef: "fee-policy-1",
    saleCutoffAt: null,
    payoutReleaseAt: null,
    currency: "usd",
    status: "ACTIVE",
    expiresAt: null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    eventShareCents: 500,
    sharePayer: "SELLER",
    buyerOrderId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}


const FIXED_TYPE = {
  priceCents: 4000,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  pricingMode: "FIXED",
  minimumCents: null,
};

describe("share arithmetic helpers", () => {
  it("SELLER pays: buyer pays the ask, seller nets ask - share", () => {
    const l = { askPriceCents: 5000, eventShareCents: 500, sharePayer: "SELLER" as const };
    expect(buyerTotalBeforeFeesCents(l)).toBe(5000);
    expect(sellerReceivesCents(l)).toBe(4500);
  });

  it("BUYER pays: buyer pays ask + share, seller nets the ask", () => {
    const l = { askPriceCents: 5000, eventShareCents: 500, sharePayer: "BUYER" as const };
    expect(buyerTotalBeforeFeesCents(l)).toBe(5500);
    expect(sellerReceivesCents(l)).toBe(5000);
  });

  it("BUYER, ask 5000, share 500, processing 210 -> 5710 before tax", () => {
    expect(
      buyerTotalBeforeTaxCents({
        askPriceCents: 5000,
        eventShareCents: 500,
        sharePayer: "BUYER",
        processingPassThroughCents: 210,
      }),
    ).toBe(5710);
  });

  it("a share of 0 changes nothing for either payer", () => {
    for (const sharePayer of ["SELLER", "BUYER"] as const) {
      const l = { askPriceCents: 5000, eventShareCents: 0, sharePayer };
      expect(buyerTotalBeforeFeesCents(l)).toBe(5000);
      expect(sellerReceivesCents(l)).toBe(5000);
    }
  });

  it("a legacy listing (no share) answers null, not the ask", () => {
    const l = { askPriceCents: 5000, eventShareCents: null, sharePayer: null, processingPassThroughCents: 210 };
    expect(buyerTotalBeforeFeesCents(l)).toBeNull();
    expect(sellerReceivesCents(l)).toBeNull();
    expect(buyerTotalBeforeTaxCents(l)).toBeNull();
  });

  it("agrees with computeResaleShare across asks, clauses and payers", () => {
    const clauses = [
      { type: "PERCENT", bps: 1000 },
      { type: "FLAT", cents: 800 },
      { type: "FLAT", cents: 50 },
    ] as const;
    for (const askCents of [100, 999, 5000, 12345]) {
      for (const c of clauses) {
        for (const payer of ["SELLER", "BUYER"] as const) {
          const share = computeResaleShare({
            askCents,
            clause: { ...c, payer } as never,
          });
          const l = { askPriceCents: askCents, eventShareCents: share.shareCents, sharePayer: payer };
          expect(buyerTotalBeforeFeesCents(l)).toBe(share.basisCents);
          expect(sellerReceivesCents(l)).toBe(share.sellerReceivesCents);
        }
      }
    }
  });
});

/** The fee policy the listings freeze: 2.9% + 30 cents, whatever the ref. */
const feePolicyMap = vi.fn(
  async (ids: readonly string[]) =>
    new Map(
      ids.map((id) => [
        id,
        { id, processsorFeePct: 0.029, processorFixedCents: 30 },
      ]),
    ),
);

describe("listEventResaleListings", () => {
  function run(rows: Record<string, unknown>[], reportError?: ReturnType<typeof vi.fn>) {
    const listByEventEnriched = vi.fn(async () => ({
      items: rows,
      pageInfo: { total: rows.length },
    }));
    const repos = {
      resaleListings: { listByEventEnriched },
      feePolicies: { getByIds: feePolicyMap },
    } as unknown as Repos;
    return {
      listByEventEnriched,
      result: listEventResaleListings({ repos, clock, reportError }, { eventId: EVENT_ID }),
    };
  }
  const enriched = (o: Record<string, unknown> = {}) => ({
    ...listing(),
    ticketTypeName: "GA",
    facePriceCents: 4000,
    sectionName: null,
    sectionId: null,
    seatLabel: null,
    seatRow: null,
    seatNumber: null,
    originalPriceCents: 4000,
    ticketTypePricing: FIXED_TYPE,
    ...o,
  });

  it("returns share, payer, original price, processing and totals (SELLER and BUYER)", async () => {
    const { result, listByEventEnriched } = run([
      enriched({ processingPassThroughCents: 210 }),
      enriched({ id: "aa111111-aa11-4a11-8a11-aa1111111112", sharePayer: "BUYER", processingPassThroughCents: 210 }),
      enriched({ id: "aa111111-aa11-4a11-8a11-aa1111111113", eventShareCents: 0, sharePayer: "BUYER" }),
    ]);
    const out = await result;
    expect(out.items.map((i) => i.buyerTotalBeforeFeesCents)).toEqual([5000, 5500, 5000]);
    expect(out.items.map((i) => i.buyerTotalBeforeTaxCents)).toEqual([5181, 5696, 5181]);
    expect(out.items[1]).toMatchObject({ processingPassThroughCents: 196 });
    expect(out.items[0]).toMatchObject({
      originalPriceCents: 4000,
      eventShareCents: 500,
      sharePayer: "SELLER",
      ticketTypePricing: { listPriceCents: 4000, pricingMode: "FIXED", minimumCents: null },
    });
    expect(out.items[0]).not.toHaveProperty("sellerReceivesCents");
    // Legacy rows are filtered at the repo, never returned by public browse.
    expect(listByEventEnriched).toHaveBeenCalledWith(
      expect.objectContaining({ onlyWithShare: true }),
    );
  });

  it("a comp records $0 and the type keeps its list price", async () => {
    const out = await run([
      enriched({ originalPriceCents: 0, ticketTypePricing: { ...FIXED_TYPE, priceCents: 4000 } }),
    ]).result;
    expect(out.items[0]).toMatchObject({
      originalPriceCents: 0,
      ticketTypePricing: { listPriceCents: 4000, pricingMode: "FIXED" },
    });
  });

  it("a pay-what-you-want ticket never sends what the first buyer chose, only the mode and minimum", async () => {
    const out = await run([
      enriched({
        originalPriceCents: 6000,
        ticketTypePricing: { ...FIXED_TYPE, priceCents: 500, pricingMode: "ADJUSTABLE", minimumCents: 500 },
      }),
    ]).result;
    expect(out.items[0]).toMatchObject({
      originalPriceCents: null,
      ticketTypePricing: { listPriceCents: 500, pricingMode: "ADJUSTABLE", minimumCents: 500 },
    });
  });

  it("resolves a scheduled price flip through the browse path", async () => {
    const out = await run([
      enriched({
        ticketTypePricing: {
          ...FIXED_TYPE,
          scheduledPriceCents: 6000,
          scheduledPriceAt: new Date("2026-03-01T00:00:00Z"),
        },
      }),
    ]).result;
    expect(out.items[0]?.ticketTypePricing?.listPriceCents).toBe(6000);
  });

  it("reports a share-priced listing with no original price, once, and survives a throwing reporter", async () => {
    const reportError = vi.fn();
    const out = await run([enriched({ originalPriceCents: null })], reportError).result;
    expect(out.items).toHaveLength(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { useCase: "listEventResaleListings" },
    });
    const throwing = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(run([enriched({ originalPriceCents: null })], throwing).result).resolves.toBeTruthy();
  });
});

/** A ticket two hops down: the item records the FIRST sale's $40 although it was bought for $90. */
function singleDeps(l: Record<string, unknown>, reportError?: ReturnType<typeof vi.fn>) {
  const row = { ...l, originalPriceCents: 4000, ticketTypePricing: { ...FIXED_TYPE, scheduledPriceCents: 6000, scheduledPriceAt: new Date("2026-03-01T00:00:00Z") } };
  return {
    clock,
    reportError,
    repos: {
      resaleListings: { getById: vi.fn(async () => l), listBySeller: vi.fn(async () => ({ items: [row], pageInfo: { total: 1 } })) },
      tickets: {
        getById: vi.fn(async () => ({
          id: TICKET_ID, eventId: EVENT_ID, ticketTypeId: TYPE_ID, seatId: null, orderItemId: ITEM_ID,
        })),
        getTicketTypeById: vi.fn(async () => ({
          id: TYPE_ID, name: "GA", ...row.ticketTypePricing, seatSectionId: null,
        })),
      },
      orderItems: {
        getById: vi.fn(async () => ({
          id: ITEM_ID, orderId: "cc999999-cc99-4c99-8c99-cc9999999999",
          unitPriceCents: 9000, originalUnitPriceCents: 4000, meta: {},
        })),
      },
      events: {
        getById: vi.fn(async () => ({ id: EVENT_ID, title: "T", slug: "t", startsAt: NOW, locationLabel: null, status: "PUBLISHED" })),
        findManyByIds: vi.fn(async () => []),
      },
      orders: { getById: vi.fn(async () => null) },
      seats: { getSectionById: vi.fn(async () => null), findLabelsByIds: vi.fn(async () => []) },
      feePolicies: {
        getByIds: vi.fn(async () => new Map([["fee-policy-1", { id: "fee-policy-1", processsorFeePct: 0.029, processorFixedCents: 30 }]])),
      },
    } as unknown as Repos,
  };
}

describe("getResaleListing", () => {
  it("BUYER payer: totals include the share and processing; original is the FIRST sale's", async () => {
    const out = await getResaleListing(
      singleDeps(listing({ sharePayer: "BUYER", askPriceCents: 5000, processingPassThroughCents: 210 })),
      { listingId: LISTING_ID },
    );
    expect(out).toMatchObject({
      originalPriceCents: 4000,
      eventShareCents: 500,
      sharePayer: "BUYER",
      buyerTotalBeforeFeesCents: 5500,
      // The stored 210 is the older markup; the read derives what checkout
      // charges at zero tax from the frozen 2.9% + 30c policy.
      processingPassThroughCents: 196,
      buyerTotalBeforeTaxCents: 5696,
      ticketTypePricing: { listPriceCents: 6000, pricingMode: "FIXED", minimumCents: null },
    });
    expect(out).not.toHaveProperty("sellerReceivesCents");
  });

  it("a pay-what-you-want ticket answers a null original price (the chosen amount stays private)", async () => {
    const deps = singleDeps(listing());
    (deps.repos.orderItems.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ITEM_ID, orderId: "x", unitPriceCents: 9000, originalUnitPriceCents: 6000, meta: {},
    });
    (deps.repos.tickets.getTicketTypeById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: TYPE_ID, name: "GA", ...FIXED_TYPE, priceCents: 500, pricingMode: "ADJUSTABLE", minimumCents: 500, seatSectionId: null,
    });
    const out = await getResaleListing(deps, { listingId: LISTING_ID });
    expect(out.originalPriceCents).toBeNull();
    expect(out.ticketTypePricing).toMatchObject({ pricingMode: "ADJUSTABLE", minimumCents: 500 });
  });

  it("SELLER payer with share 0: buyer total is the ask", async () => {
    const out = await getResaleListing(
      singleDeps(listing({ eventShareCents: 0 })),
      { listingId: LISTING_ID },
    );
    expect(out).toMatchObject({ eventShareCents: 0, buyerTotalBeforeFeesCents: 5000 });
  });

  it("a legacy listing answers null share and totals (checkout refuses it)", async () => {
    const out = await getResaleListing(
      singleDeps(listing({ eventShareCents: null, sharePayer: null })),
      { listingId: LISTING_ID },
    );
    expect(out).toMatchObject({
      eventShareCents: null,
      sharePayer: null,
      buyerTotalBeforeFeesCents: null,
      buyerTotalBeforeTaxCents: null,
    });
  });

  it("reports a share-priced listing whose item records no original price", async () => {
    const reportError = vi.fn();
    const deps = singleDeps(listing(), reportError);
    (deps.repos.orderItems.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ITEM_ID, orderId: "x", unitPriceCents: 9000, originalUnitPriceCents: null, meta: {},
    });
    const out = await getResaleListing(deps, { listingId: LISTING_ID });
    expect(out.originalPriceCents).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("listMyResaleListings", () => {
  it("returns the seller's net, totals and the first sale's original price", async () => {
    const seller = await listMyResaleListings(
      singleDeps(listing({ sharePayer: "SELLER", processingPassThroughCents: 210 })),
      { actorHumanId: SELLER_ID },
    );
    expect(seller.items[0]).toMatchObject({
      originalPriceCents: 4000,
      eventShareCents: 500,
      sellerReceivesCents: 4500,
      buyerTotalBeforeFeesCents: 5000,
      // Stored 210 (older markup): shown as the 181 checkout charges now.
      buyerTotalBeforeTaxCents: 5181,
      processingPassThroughCents: 181,
      ticketTypePricing: { listPriceCents: 6000 },
    });
    const buyerPays = await listMyResaleListings(
      singleDeps(listing({ sharePayer: "BUYER", processingPassThroughCents: 210 })),
      { actorHumanId: SELLER_ID },
    );
    expect(buyerPays.items[0]).toMatchObject({
      sellerReceivesCents: 5000,
      buyerTotalBeforeFeesCents: 5500,
      buyerTotalBeforeTaxCents: 5696,
    });
  });

  it("keeps the real original price for the seller, pay-what-you-want or not", async () => {
    const deps = singleDeps(listing());
    const row = {
      ...listing(),
      originalPriceCents: 6000,
      ticketTypePricing: { ...FIXED_TYPE, priceCents: 500, pricingMode: "ADJUSTABLE", minimumCents: 500 },
    };
    (deps.repos.resaleListings.listBySeller as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [row],
      pageInfo: { total: 1 },
    });
    const out = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });
    expect(out.items[0]).toMatchObject({ originalPriceCents: 6000 });
  });

  it("a legacy listing answers null for the derived amounts", async () => {
    const out = await listMyResaleListings(
      singleDeps(listing({ eventShareCents: null, sharePayer: null })),
      { actorHumanId: SELLER_ID },
    );
    expect(out.items[0]).toMatchObject({
      sellerReceivesCents: null,
      buyerTotalBeforeFeesCents: null,
      buyerTotalBeforeTaxCents: null,
    });
  });
});

describe("an old-style listing (stored the markup from before processing covered tax)", () => {
  // $50 basis at 2.9% + 30c: the stored 175 is the old markup, 181 is what
  // checkout charges now at zero tax.
  const OLD = { askPriceCents: 5000, sharePayer: "SELLER", processingPassThroughCents: 175 };

  it("getResaleListing shows 181 and 5181 before tax", async () => {
    const out = await getResaleListing(singleDeps(listing(OLD)), { listingId: LISTING_ID });
    expect(out.processingPassThroughCents).toBe(181);
    expect(out.buyerTotalBeforeTaxCents).toBe(5181);
  });

  it("listMyResaleListings shows 181 and reads the policies in ONE batch", async () => {
    const deps = singleDeps(listing(OLD));
    const out = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });
    expect(out.items[0]).toMatchObject({ processingPassThroughCents: 181, buyerTotalBeforeTaxCents: 5181 });
    expect(deps.repos.feePolicies.getByIds).toHaveBeenCalledTimes(1);
  });

  it("listEventResaleListings shows 181, one batched policy read for many listings", async () => {
    const rows = [1, 2, 3].map((n) => ({
      ...listing({ ...OLD, id: `0000000${n}-0000-4000-8000-000000000000` }),
      ticketTypeName: "GA", facePriceCents: 4000, sectionName: null, sectionId: null,
      seatLabel: null, seatRow: null, seatNumber: null, originalPriceCents: 4000,
      ticketTypePricing: FIXED_TYPE,
    }));
    feePolicyMap.mockClear();
    const repos = {
      resaleListings: { listByEventEnriched: vi.fn(async () => ({ items: rows, pageInfo: { total: 3 } })) },
      feePolicies: { getByIds: feePolicyMap },
    } as unknown as Repos;
    const out = await listEventResaleListings({ repos, clock }, { eventId: EVENT_ID });
    expect(out.items.map((i) => i.buyerTotalBeforeTaxCents)).toEqual([5181, 5181, 5181]);
    expect(feePolicyMap).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stored figure and reports when the policy cannot be read", async () => {
    const reportError = vi.fn();
    const deps = singleDeps(listing(OLD), reportError);
    (deps.repos.feePolicies.getByIds as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const out = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });
    expect(out.items[0]).toMatchObject({ processingPassThroughCents: 175, buyerTotalBeforeTaxCents: 5175 });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({ tags: { useCase: "listMyResaleListings" } });
  });

  it("still returns the stored figure when the read fails and the reporter throws", async () => {
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    const deps = singleDeps(listing(OLD), reportError);
    (deps.repos.feePolicies.getByIds as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const out = await listMyResaleListings(deps, { actorHumanId: SELLER_ID });
    expect(out.items[0]).toMatchObject({ processingPassThroughCents: 175, buyerTotalBeforeTaxCents: 5175 });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a SOLD listing keeps its stored processing on the single read", async () => {
    const sold = singleDeps(listing({ ...OLD, status: "SOLD", buyerOrderId: null }));
    const out = await getResaleListing(sold, { listingId: LISTING_ID, viewerHumanId: SELLER_ID });
    expect(out.processingPassThroughCents).toBe(175);
  });
});
