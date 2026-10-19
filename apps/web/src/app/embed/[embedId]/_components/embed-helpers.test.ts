import { describe, expect, it } from "vitest";

import {
  buildVenueLabel,
  buyerTaxRateBps,
  mapEventItemToSummary,
} from "./embed-helpers";
import type { EventItem } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// mapEventItemToSummary price-label rules
//
// The pricing fields carry SEARCH-INDEX semantics (see `getEmbedForWidget`):
// `lowestPriceCents` is 0 whenever a free tier exists and null ONLY when there
// are no ACTIVE tiers — it is NOT the minimum paid price. These tests pin the
// derivation: the shared ALL-IN `formatListingPriceLabel` rule (never face).
// ─────────────────────────────────────────────────────────────────────────────

const baseEvent: EventItem = {
  id: "evt-1",
  title: "Warehouse Show",
  slug: "warehouse-show",
  startsAt: new Date("2026-09-01T20:00:00Z"),
  endsAt: null,
  currency: "usd",
  heroImageUrl: null,
  addressText: "123 Main St",
  locality: "Nashville",
  region: "TN",
  lowestPriceCents: null,
  paidTierCount: 0,
  hasFreeTier: false,
  lowestBuyerTotalCents: null,
};

const withPricing = (
  pricing: Pick<
    EventItem,
    "lowestPriceCents" | "paidTierCount" | "hasFreeTier" | "lowestBuyerTotalCents"
  >,
): EventItem => ({ ...baseEvent, ...pricing });

describe("mapEventItemToSummary price label", () => {
  it("labels a multi-tier paid event with the all-in minimum, no plus", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 2500,
        lowestBuyerTotalCents: 2862,
        paidTierCount: 3,
        hasFreeTier: false,
      }),
    );
    expect(summary.priceLabel).toBe("$28.62");
    expect(summary.isFree).toBe(false);
  });

  it("labels a single paid tier with the exact all-in price", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 2500,
        lowestBuyerTotalCents: 2862,
        paidTierCount: 1,
        hasFreeTier: false,
      }),
    );
    expect(summary.priceLabel).toBe("$28.62");
    expect(summary.isFree).toBe(false);
  });

  it("trims whole-dollar all-in amounts", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 2550,
        lowestBuyerTotalCents: 2900,
        paidTierCount: 2,
        hasFreeTier: false,
      }),
    );
    expect(summary.priceLabel).toBe("$29");
  });

  it("labels a free-only event Free and flags isFree", () => {
    // Index semantics: a free tier pins lowestPriceCents to 0.
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 0,
        lowestBuyerTotalCents: null,
        paidTierCount: 0,
        hasFreeTier: true,
      }),
    );
    expect(summary.priceLabel).toBe("Free");
    expect(summary.isFree).toBe(true);
  });

  it("labels free + paid tiers Free+ with no amount (paid min unavailable)", () => {
    // lowestPriceCents is the FREE tier's 0 here — the paid minimum is not in
    // the payload, and Free+ carries no amount on the site either.
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 0,
        lowestBuyerTotalCents: 0,
        paidTierCount: 2,
        hasFreeTier: true,
      }),
    );
    expect(summary.priceLabel).toBe("Free+");
    expect(summary.isFree).toBe(false);
  });

  it("falls back to See details when there are no active tiers", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: null,
        lowestBuyerTotalCents: null,
        paidTierCount: 0,
        hasFreeTier: false,
      }),
    );
    expect(summary.priceLabel).toBe("See details");
    expect(summary.isFree).toBe(false);
  });

  it("degrades to See details when a stale payload lacks the pricing fields", () => {
    // A cached pre-rollout payload has no pricing keys at all — the mapper
    // must not crash and must not mislabel.
    const stale = { ...baseEvent } as Partial<EventItem>;
    delete stale.lowestPriceCents;
    delete stale.paidTierCount;
    delete stale.hasFreeTier;
    const summary = mapEventItemToSummary(stale as EventItem);
    expect(summary.priceLabel).toBe("See details");
    expect(summary.isFree).toBe(false);
  });

  it("never falls back to face: paid tiers with an unknown all-in read See details", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 2500,
        lowestBuyerTotalCents: null,
        paidTierCount: 1,
        hasFreeTier: false,
      }),
    );
    expect(summary.priceLabel).toBe("See details");
  });

  it("degrades to See details when a stale payload lacks lowestBuyerTotalCents", () => {
    const stale = {
      ...baseEvent,
      lowestPriceCents: 2500,
      paidTierCount: 1,
    } as Partial<EventItem>;
    delete stale.lowestBuyerTotalCents;
    expect(mapEventItemToSummary(stale as EventItem).priceLabel).toBe(
      "See details",
    );
  });

  it("formats the all-in figure in the event currency", () => {
    const summary = mapEventItemToSummary({
      ...withPricing({
        lowestPriceCents: 2500,
        lowestBuyerTotalCents: 2750,
        paidTierCount: 1,
        hasFreeTier: false,
      }),
      currency: "jpy",
    });
    expect(summary.priceLabel).toBe("\u00a52,750");
  });

  it("falls back when paid tiers exist but the price is missing (malformed)", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: null,
        lowestBuyerTotalCents: null,
        paidTierCount: 2,
        hasFreeTier: false,
      }),
    );
    expect(summary.priceLabel).toBe("See details");
  });
});

describe("mapEventItemToSummary passthrough fields", () => {
  it("maps identity, date, venue and media", () => {
    const summary = mapEventItemToSummary(
      withPricing({
        lowestPriceCents: 2500,
        lowestBuyerTotalCents: 2862,
        paidTierCount: 1,
        hasFreeTier: false,
      }),
    );
    expect(summary.id).toBe("evt-1");
    expect(summary.title).toBe("Warehouse Show");
    expect(summary.slug).toBe("warehouse-show");
    // No place name on this payload: the address comes before "city, region".
    expect(summary.venue).toBe("123 Main St");
    expect(summary.media).toBeUndefined();

    const withImage = mapEventItemToSummary({
      ...baseEvent,
      heroImageUrl: "https://img.test/hero.jpg",
    });
    expect(withImage.media).toEqual({
      url: "https://img.test/hero.jpg",
      alt: "Warehouse Show",
    });
  });

  it("carries startsAt as an ISO string, so the card draws its date stamp", () => {
    const summary = mapEventItemToSummary(baseEvent);
    expect(summary.startsAt).toBe("2026-09-01T20:00:00.000Z");
    // `date` stays: the card falls back to it when it cannot stamp.
    expect(summary.date).toBeTruthy();

    // A cached payload can hold the date as a string; an unreadable one sends
    // no startsAt instead of throwing.
    const cached = { ...baseEvent, startsAt: "2026-09-01T20:00:00Z" };
    expect(
      mapEventItemToSummary(cached as unknown as EventItem).startsAt,
    ).toBe("2026-09-01T20:00:00.000Z");
    const unreadable = { ...baseEvent, startsAt: new Date("nope") };
    expect(mapEventItemToSummary(unreadable).startsAt).toBeUndefined();
  });
});

describe("buildVenueLabel: place name, then address, like the site's cards", () => {
  it("prefers the place label over the address and the city", () => {
    expect(buildVenueLabel({ ...baseEvent, placeLabel: "The Basement" })).toBe(
      "The Basement",
    );
    expect(buildVenueLabel({ ...baseEvent, placeLabel: "  The Basement " })).toBe(
      "The Basement",
    );
  });

  it("falls through a whitespace-only, null or absent place label to the address", () => {
    expect(buildVenueLabel({ ...baseEvent, placeLabel: "   " })).toBe(
      "123 Main St",
    );
    expect(buildVenueLabel({ ...baseEvent, placeLabel: null })).toBe(
      "123 Main St",
    );
    // A cached payload from before the field shipped.
    expect(buildVenueLabel(baseEvent)).toBe("123 Main St");
  });

  it("uses 'locality, region', then the locality, when there is no address", () => {
    expect(buildVenueLabel({ ...baseEvent, addressText: null })).toBe(
      "Nashville, TN",
    );
    expect(
      buildVenueLabel({ ...baseEvent, addressText: null, region: null }),
    ).toBe("Nashville");
  });

  it("reads 'Place TBA' when the event has no public location at all", () => {
    expect(
      buildVenueLabel({
        ...baseEvent,
        addressText: null,
        locality: null,
        region: null,
      }),
    ).toBe("Place TBA");
    // A region alone is not a label.
    expect(
      buildVenueLabel({ ...baseEvent, addressText: null, locality: null }),
    ).toBe("Place TBA");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buyerTaxRateBps — the rate the embed's Taxes row labels
// ─────────────────────────────────────────────────────────────────────────────

describe("mapEventItemToSummary: floor-0 pay-what-you-want (F2) and listingPrice (F3)", () => {
  it("reads 'Pay what you want', never 'Free', and is not the free badge", () => {
    const summary = mapEventItemToSummary({
      ...baseEvent,
      lowestPriceCents: 0,
      paidTierCount: 0,
      hasFreeTier: false,
      hasPayWhatYouWantTier: true,
    });
    expect(summary.priceLabel).toBe("Pay what you want");
    expect(summary.listingPrice).toEqual({ kind: "payWhatYouWant" });
    expect(summary.isFree).toBe(false);
  });

  it("floor-0 PWYW beside paid tiers still reads 'Pay what you want'", () => {
    const summary = mapEventItemToSummary({
      ...baseEvent,
      lowestPriceCents: 0,
      lowestBuyerTotalCents: 2862,
      paidTierCount: 2,
      hasFreeTier: false,
      hasPayWhatYouWantTier: true,
    });
    expect(summary.priceLabel).toBe("Pay what you want");
  });

  it("carries the price as data beside the English label, null for no price", () => {
    expect(
      mapEventItemToSummary(
        withPricing({
          lowestPriceCents: 2500,
          lowestBuyerTotalCents: 2862,
          paidTierCount: 1,
          hasFreeTier: false,
        }),
      ).listingPrice,
    ).toEqual({ kind: "amount", cents: 2862, currency: "USD", from: false });
    const none = mapEventItemToSummary(baseEvent);
    expect(none.priceLabel).toBe("See details");
    expect(none.listingPrice).toBeNull();
  });
});

describe("buyerTaxRateBps — main checkout's label rate (PLATFORM impositions, summed)", () => {
  const line = (collector: "PLATFORM" | "ORGANISER", rateBps: number) => ({
    code: `${collector}-${rateBps}`,
    label: "Tax",
    jurisdiction: "X",
    rateBps,
    base: "TICKET_FACE" as const,
    collector,
  });

  it("sums every PLATFORM line and leaves ORGANISER lines out", () => {
    expect(
      buyerTaxRateBps({
        taxImpositions: [line("PLATFORM", 700), line("PLATFORM", 188), line("ORGANISER", 300)],
      }),
    ).toBe(888);
  });

  it("is null when the buyer is charged no tax (no lines, ORGANISER only, or no data yet)", () => {
    expect(buyerTaxRateBps({ taxImpositions: [] })).toBeNull();
    expect(buyerTaxRateBps({ taxImpositions: [line("ORGANISER", 300)] })).toBeNull();
    expect(buyerTaxRateBps(undefined)).toBeNull();
    expect(buyerTaxRateBps({})).toBeNull();
  });

  it("regression: lines on different bases (Minneapolis) print no rate — the summed 12.03% produced no amount", () => {
    expect(
      buyerTaxRateBps({
        taxImpositions: [
          { ...line("PLATFORM", 903), base: "BUYER_TOTAL" as const },
          line("PLATFORM", 300),
        ],
      }),
    ).toBeNull();
  });
});
