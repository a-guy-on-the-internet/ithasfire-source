import { describe, expect, it } from "vitest";

import {
  countryEventToDto,
  discoverEventToDto,
  discoveredEventToDto,
  localEventToDto,
  nearbyEventToDto,
  nearbyEventsToDto,
  type DiscoveredEventShape,
  type LocalEventShape,
  type NearbyEventShape,
} from "./event-summary-mapper";

const baseNearby: NearbyEventShape = {
  id: "evt_1",
  title: "Backyard Jam",
  addressText: "123 Main St",
  lat: 40.662,
  lng: -73.97,
  distanceMeters: 1500,
  heroImageUrl: null,
  slug: "backyard-jam",
};

describe("nearbyEventToDto", () => {
  it("maps the slug through so cards can build /events/<slug> links", () => {
    const dto = nearbyEventToDto(baseNearby);

    expect(dto.slug).toBe("backyard-jam");
    expect(dto.id).toBe("evt_1");
  });

  it("falls back to null when the geo row has no slug", () => {
    const dto = nearbyEventToDto({ ...baseNearby, slug: null });

    expect(dto.slug).toBeNull();
  });

  it("falls back to null when slug is absent from the shape", () => {
    const { slug: _slug, ...withoutSlug } = baseNearby;

    const dto = nearbyEventToDto(withoutSlug);

    expect(dto.slug).toBeNull();
  });

  it("maps slugs across a batch", () => {
    const dtos = nearbyEventsToDto([
      baseNearby,
      { ...baseNearby, id: "evt_2", slug: "other-show" },
    ]);

    expect(dtos.map((d) => d.slug)).toEqual(["backyard-jam", "other-show"]);
  });
});

describe("localEventToDto priceLabel", () => {
  const baseLocal: LocalEventShape = {
    id: "evt_1",
    title: "Tuesday Open Mic",
    status: "PUBLISHED",
    slug: "us/tn/tuesday-open-mic--abc123",
    startsAt: new Date("2026-03-01T00:00:00Z"),
    addressText: "123 Broadway",
    regionCode: "tn",
    heroImageUrl: null,
  };

  it("renders 'Free' for RSVP community listings (no ticket types)", () => {
    const dto = localEventToDto({
      ...baseLocal,
      attendanceMode: "RSVP",
      pricing: null,
    });

    expect(dto.priceLabel).toBe("Free");
  });

  it("renders 'Free' for a TICKETED event with a free-only rollup", () => {
    const dto = localEventToDto({
      ...baseLocal,
      attendanceMode: "TICKETED",
      pricing: { hasFreeTier: true, paidTierCount: 0, minPaidPriceCents: null },
    });

    expect(dto.priceLabel).toBe("Free");
  });

  it("renders the ALL-IN figure, no '+', for a TICKETED paid event", () => {
    const dto = localEventToDto({
      ...baseLocal,
      attendanceMode: "TICKETED",
      pricing: {
        hasFreeTier: false,
        paidTierCount: 2,
        minPaidPriceCents: 2500,
        lowestBuyerTotalCents: 2862,
      },
    });

    expect(dto.priceLabel).toBe("$28.62");
  });

  it("says 'See details' — never the face price — when the all-in figure is unknown", () => {
    const dto = localEventToDto({
      ...baseLocal,
      attendanceMode: "TICKETED",
      pricing: {
        hasFreeTier: false,
        paidTierCount: 2,
        minPaidPriceCents: 2500,
        lowestBuyerTotalCents: null,
      },
    });

    expect(dto.priceLabel).toBe("See details");
  });

  it("applies no plausibility band to a live DB total (a $1 ticket's real all-in)", () => {
    const dto = localEventToDto({
      ...baseLocal,
      attendanceMode: "TICKETED",
      pricing: {
        hasFreeTier: false,
        paidTierCount: 1,
        minPaidPriceCents: 100,
        lowestBuyerTotalCents: 600,
      },
    });

    expect(dto.priceLabel).toBe("$6");
  });

  it("keeps 'See details' for a TICKETED event with unknown pricing", () => {
    const dto = localEventToDto({
      ...baseLocal,
      attendanceMode: "TICKETED",
      pricing: null,
    });

    expect(dto.priceLabel).toBe("See details");
  });

  it("keeps the pricing-driven label when attendanceMode is omitted", () => {
    const dto = localEventToDto({
      ...baseLocal,
      pricing: null,
    });

    expect(dto.priceLabel).toBe("See details");
  });
});

describe("discoveredEventToDto priceLabel (fee-inclusive badge)", () => {
  const baseDiscovered: DiscoveredEventShape = {
    id: "row_1",
    eventId: "evt_1",
    title: "Indexed Show",
    subtitle: "The Basement",
    helper: null,
    slug: "us/tn/indexed-show--abc123",
    startsAt: new Date("2026-03-01T00:00:00Z"),
    imageUrl: null,
  };

  it("shows the fee-inclusive buyer total with NO '+' for a multi-tier paid event", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 3,
      hasFreeTier: false,
      minPaidPriceCents: 4500,
      lowestBuyerTotalCents: 4850,
    });

    expect(dto.priceLabel).toBe("$48.50");
  });

  it("shows the fee-inclusive buyer total with NO '+' for a single-tier paid event", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 1,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: 2700,
    });

    expect(dto.priceLabel).toBe("$27");
  });

  it("says 'See details', never the face, when the buyer total is absent (multi-tier)", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 2,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: null,
    });

    expect(dto.priceLabel).toBe("See details");
  });

  it("says 'See details', never the face, when absent and single-tier", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 1,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: null,
    });

    expect(dto.priceLabel).toBe("See details");
  });

  it("ALLOWS a buyer total exactly equal to face value (ABSORB, zero tax — lower boundary)", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 1,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: 2500,
    });

    expect(dto.priceLabel).toBe("$25");
  });

  it("ALLOWS a buyer total at exactly 2x face + $3 (upper boundary)", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 2,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: 5300,
    });

    expect(dto.priceLabel).toBe("$53");
  });

  it("ALLOWS a small ticket's legitimate total above 2x face (fixed $0.30 + platform fee)", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 1,
      hasFreeTier: false,
      minPaidPriceCents: 100,
      lowestBuyerTotalCents: 250,
    });

    expect(dto.priceLabel).toBe("$2.50");
  });

  it("REJECTS a stale buyer total just over 2x face + $3, to 'See details'", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 2,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: 5301,
    });

    expect(dto.priceLabel).toBe("See details");
  });

  it("degrades to 'See details' when the indexed buyer total is below face value", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 1,
      hasFreeTier: false,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: 2000,
    });

    expect(dto.priceLabel).toBe("See details");
  });

  it("renders 'Free' for a free-only rollup regardless of any buyer total", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 0,
      hasFreeTier: true,
      minPaidPriceCents: null,
      lowestBuyerTotalCents: null,
    });

    expect(dto.priceLabel).toBe("Free");
  });

  it("keeps 'Free+' (free AND paid) and never applies the buyer total to it", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 2,
      hasFreeTier: true,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: 2700,
    });

    expect(dto.priceLabel).toBe("Free+");
  });

  it("renders 'Free+' on the REAL search path, where a free+paid event maps to minPaidPriceCents: null", () => {
    // build-search-index stores lowestPriceCents=0 for free+paid events;
    // mapEventSuggestions maps 0 → minPaidPriceCents: null. The "Free+" branch
    // must win over the null-face guard, or free+paid cards read "See details".
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 2,
      hasFreeTier: true,
      minPaidPriceCents: null,
      lowestBuyerTotalCents: null,
    });

    expect(dto.priceLabel).toBe("Free+");
  });

  it("keeps 'See details' when the face value is unknown even if a buyer total is present", () => {
    const dto = discoveredEventToDto({
      ...baseDiscovered,
      paidTierCount: 1,
      hasFreeTier: false,
      minPaidPriceCents: null,
      lowestBuyerTotalCents: 2700,
    });

    expect(dto.priceLabel).toBe("See details");
  });
});

describe("localEventToDto isRecurring", () => {
  const baseLocal: LocalEventShape = {
    id: "evt_1",
    title: "Tuesday Open Mic",
    status: "PUBLISHED",
    slug: "us/tn/tuesday-open-mic--abc123",
    startsAt: new Date("2026-03-01T00:00:00Z"),
    addressText: "123 Broadway",
    regionCode: "tn",
    heroImageUrl: null,
  };

  it("passes isRecurring through when the event repeats", () => {
    const dto = localEventToDto({ ...baseLocal, isRecurring: true });

    expect(dto.isRecurring).toBe(true);
  });

  it("omits isRecurring for a single-date event", () => {
    const dto = localEventToDto({ ...baseLocal, isRecurring: false });

    expect(dto.isRecurring).toBeUndefined();
  });

  it("omits isRecurring when the flag is absent", () => {
    const dto = localEventToDto(baseLocal);

    expect(dto.isRecurring).toBeUndefined();
  });
});

describe("discoveredEventToDto startsAt", () => {
  const baseIndexed: DiscoveredEventShape = {
    id: "row_1",
    eventId: "evt_1",
    title: "Indexed Show",
    subtitle: "The Basement",
    helper: "Sep 2",
    slug: "us/tn/indexed-show--abc123",
    startsAt: new Date("2026-09-02T21:00:00Z"),
    imageUrl: null,
  };

  // Renderers that need date PARTS rather than a sentence — the LineupRow
  // when-column splits the rail into a date line over a time line — cannot
  // recover them from `helper`, so dropping this silently costs them the time.
  it("forwards the structured start as an ISO string alongside `date`", () => {
    const dto = discoveredEventToDto(baseIndexed);

    expect(dto.startsAt).toBe("2026-09-02T21:00:00.000Z");
    expect(dto.date).toBe("Sep 2");
  });

  it("omits startsAt when the indexed row carries no start", () => {
    const dto = discoveredEventToDto({ ...baseIndexed, startsAt: null });

    expect(dto.startsAt).toBeUndefined();
  });
});

describe("floor-0 pay-what-you-want (owner ruling 2026-10-06, F2) and the structured listingPrice (F3)", () => {
  const baseLocal: LocalEventShape = {
    id: "evt_pwyw",
    title: "Pass the Hat Night",
    status: "PUBLISHED",
    slug: "us/tn/pass-the-hat--abc123",
    startsAt: new Date("2026-03-01T00:00:00Z"),
    addressText: "123 Broadway",
    regionCode: "tn",
    heroImageUrl: null,
  };

  it("never says 'Free' for a floor-0 PWYW tier, and isFree stays false", () => {
    const dto = localEventToDto({
      ...baseLocal,
      pricing: {
        hasFreeTier: false,
        hasPayWhatYouWantTier: true,
        paidTierCount: 0,
        minPaidPriceCents: null,
        lowestBuyerTotalCents: null,
      },
    });
    expect(dto.priceLabel).toBe("Pay what you want");
    expect(dto.listingPrice).toEqual({ kind: "payWhatYouWant" });
    expect(dto.isFree).toBe(false);

    // Beside a genuinely free tier the label is still PWYW, so no free badge.
    const withFree = localEventToDto({
      ...baseLocal,
      pricing: {
        hasFreeTier: true,
        hasPayWhatYouWantTier: true,
        paidTierCount: 0,
        minPaidPriceCents: null,
        lowestBuyerTotalCents: null,
      },
    });
    expect(withFree.priceLabel).toBe("Pay what you want");
    expect(withFree.isFree).toBe(false);
  });

  it("floor-0 PWYW beside paid tiers reads 'Pay what you want', not Free+ or the paid figure", () => {
    const dto = discoveredEventToDto({
      id: "event_evt_pwyw",
      eventId: "evt_pwyw",
      title: "Pass the Hat Night",
      subtitle: null,
      helper: null,
      slug: null,
      startsAt: null,
      imageUrl: null,
      paidTierCount: 2,
      hasFreeTier: false,
      hasPayWhatYouWantTier: true,
      // The index pins lowestPriceCents to 0 → mapEventSuggestions → null.
      minPaidPriceCents: null,
      lowestBuyerTotalCents: 2862,
    });
    expect(dto.priceLabel).toBe("Pay what you want");
    expect(dto.listingPrice).toEqual({ kind: "payWhatYouWant" });
  });

  it("carries the same price as data beside every English label", () => {
    expect(
      localEventToDto({
        ...baseLocal,
        pricing: {
          hasFreeTier: false,
          paidTierCount: 1,
          minPaidPriceCents: 2500,
          lowestBuyerTotalCents: 2862,
        },
      }),
    ).toMatchObject({
      priceLabel: "$28.62",
      listingPrice: { kind: "amount", cents: 2862, currency: "USD", from: false },
    });
    expect(
      localEventToDto({ ...baseLocal, attendanceMode: "RSVP", pricing: null }),
    ).toMatchObject({ priceLabel: "Free", listingPrice: { kind: "free" } });
    expect(localEventToDto({ ...baseLocal, pricing: null })).toMatchObject({
      priceLabel: "See details",
      listingPrice: null,
    });
    expect(nearbyEventToDto(baseNearby)).toMatchObject({
      priceLabel: "See details",
      listingPrice: null,
    });
  });
});

// Regression (prod, 2026-10-13): the card date was formatted with no
// `timeZone`, so on the UTC server a 7pm Chicago show (00:00Z the next day)
// read "Tue, Oct 13, 12:00 AM". It renders in `Event.timezone` now. These
// pass under TZ=UTC and TZ=America/Chicago alike.
describe("event card date renders in the event's timezone", () => {
  // ICU puts a narrow no-break space before AM/PM; compare on plain spaces.
  const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

  // 2026-10-12 19:00 CDT (UTC-5) = 2026-10-13T00:00Z.
  const EVENING_CDT = new Date("2026-10-13T00:00:00.000Z");
  // 2026-01-15 19:30 CST (UTC-6) = 2026-01-16T01:30Z.
  const EVENING_CST = new Date("2026-01-16T01:30:00.000Z");

  const local = (startsAt: Date | string, timezone?: string | null) =>
    localEventToDto({
      id: "evt_1",
      title: "Cobra Comedy Open Mic",
      status: "PUBLISHED",
      slug: "us/tn/cobra-comedy-open-mic--abc123",
      startsAt,
      ...(timezone === undefined ? {} : { timezone }),
      addressText: null,
      regionCode: "tn",
      heroImageUrl: null,
    });

  it("localEventToDto: 7pm CDT stays on Oct 12", () => {
    expect(plain(local(EVENING_CDT, "America/Chicago").date)).toBe(
      "Mon, Oct 12, 7:00 PM",
    );
  });

  it("localEventToDto: 7:30pm CST in winter stays on Jan 15", () => {
    expect(plain(local(EVENING_CST, "America/Chicago").date)).toBe(
      "Thu, Jan 15, 7:30 PM",
    );
  });

  it("localEventToDto: an ISO string instant formats the same way", () => {
    expect(
      plain(local(EVENING_CDT.toISOString(), "America/Chicago").date),
    ).toBe("Mon, Oct 12, 7:00 PM");
  });

  // 2026-10-12 22:30 PDT (UTC-7) = 05:30Z the next day: Oct 13 in UTC AND in
  // Chicago (00:30 CDT), so this fails on zone-less code under either TZ.
  const LATE_PDT = new Date("2026-10-13T05:30:00.000Z");

  it("uses the event's own zone, not a fixed one", () => {
    expect(plain(local(EVENING_CDT, "America/Los_Angeles").date)).toBe(
      "Mon, Oct 12, 5:00 PM",
    );
    expect(plain(local(LATE_PDT, "America/Los_Angeles").date)).toBe(
      "Mon, Oct 12, 10:30 PM",
    );
  });

  it("falls back to the platform default (America/Chicago), never UTC", () => {
    expect(plain(local(EVENING_CDT).date)).toBe("Mon, Oct 12, 7:00 PM");
    expect(plain(local(EVENING_CDT, null).date)).toBe("Mon, Oct 12, 7:00 PM");
    expect(plain(local(EVENING_CDT, "Mars/Olympus_Mons").date)).toBe(
      "Mon, Oct 12, 7:00 PM",
    );
  });

  it("countryEventToDto: 7pm CDT and winter CST stay on the local day", () => {
    const country = (startsAt: Date, timezone = "America/Chicago") =>
      countryEventToDto({
        eventId: "evt_1",
        title: "Cobra Comedy Open Mic",
        status: "PUBLISHED",
        slug: null,
        startsAt,
        timezone,
        addressText: null,
        regionCode: "tn",
        heroImageUrl: null,
      });
    expect(plain(country(EVENING_CDT).date)).toBe("Mon, Oct 12, 7:00 PM");
    expect(plain(country(EVENING_CST).date)).toBe("Thu, Jan 15, 7:30 PM");
    expect(plain(country(LATE_PDT, "America/Los_Angeles").date)).toBe(
      "Mon, Oct 12, 10:30 PM",
    );
  });

  it("discoverEventToDto: 7pm CDT and winter CST stay on the local day", () => {
    const discover = (startsAt: Date, timezone = "America/Chicago") =>
      discoverEventToDto({
        id: "evt_1",
        title: "Cobra Comedy Open Mic",
        status: "PUBLISHED",
        slug: null,
        startsAt,
        timezone,
        addressText: null,
        regionCode: "tn",
        heroImageUrl: null,
      });
    expect(plain(discover(EVENING_CDT).date)).toBe("Mon, Oct 12, 7:00 PM");
    expect(plain(discover(EVENING_CST).date)).toBe("Thu, Jan 15, 7:30 PM");
    expect(plain(discover(LATE_PDT, "America/Los_Angeles").date)).toBe(
      "Mon, Oct 12, 10:30 PM",
    );
  });

  it("discoveredEventToDto: with no helper, the fallback is the platform default zone", () => {
    const dto = discoveredEventToDto({
      id: "evt_1",
      eventId: "evt_1",
      title: "Cobra Comedy Open Mic",
      subtitle: null,
      helper: null,
      slug: null,
      startsAt: EVENING_CDT,
      imageUrl: null,
    });
    expect(plain(dto.date)).toBe("Mon, Oct 12, 7:00 PM");
  });
});
