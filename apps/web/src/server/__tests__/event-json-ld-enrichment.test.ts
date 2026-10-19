/**
 * The JSON-LD additions that need the site URL: the organizer (Search
 * Console: "Missing field organizer") and, for a posterless event, the
 * generated Date Stub as `image` ("Missing field image").
 */
import { describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

import { buildEventJsonLd } from "@th/types/seo/buildEventJsonLd";

import { applyEventJsonLdEnrichment } from "@/lib/seo/event-json-ld-enrichment";
import type { PublicEventSeo } from "@/server/events";

vi.mock("@/config/site", () => ({
  getSiteUrl: () => "https://ithasfire.com",
  getSiteName: () => "Ithas Fire",
  buildCanonicalUrl: (p: string) => new URL(p, "https://ithasfire.com/").toString(),
}));

import { buildEventJsonLdEnrichment } from "../event-json-ld-enrichment";
import {
  eventOgImageInputFor,
  withGeneratedEventOgImage,
} from "../og/event-og-image";

const SLUG = "drkmttr/us/tn/sunset-session--ab12cd";

const communityListing = (
  overrides: Partial<PublicEventSeo> = {},
): PublicEventSeo => ({
  id: "8f0b2e30-1c2a-4c1f-9f9c-0b0d0a0e0f01",
  slug: SLUG,
  url: `https://ithasfire.com/events/${SLUG}`,
  name: "Open Mic at Grandpa Bar",
  startsAt: new Date("2026-11-04T01:00:00.000Z"),
  timezone: "America/Chicago",
  updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  publishedAt: new Date("2026-09-01T12:00:00.000Z"),
  status: "PUBLISHED",
  images: [],
  location: {
    addressLine1: "Grandpa Bar, 1501 Herman St #123, Nashville, TN",
    city: "Nashville",
    region: "TN",
    postalCode: "37208",
    countryCode: "US",
    latitude: 36.16,
    longitude: -86.8,
    isExact: true,
  },
  performers: [],
  attendanceMode: "RSVP",
  stewardship: "COMMUNITY",
  visibility: "PUBLIC",
  organizerName: null,
  organizerHref: null,
  refundCutoffAt: null,
  venueConfirmed: false,
  ...overrides,
});

const orgEvent = (overrides: Partial<PublicEventSeo> = {}) =>
  communityListing({
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    organizerName: "Drkmttr",
    organizerHref: "/orgs/drkmttr",
    ...overrides,
  });

const PUBLIC = { generatedImage: true };

describe("buildEventJsonLdEnrichment — organizer", () => {
  it("is the org behind the 'Presented by' badge, with an absolute /orgs url", () => {
    expect(buildEventJsonLdEnrichment(orgEvent(), SLUG, PUBLIC).organizer).toEqual(
      { name: "Drkmttr", url: "https://ithasfire.com/orgs/drkmttr" },
    );
  });

  it("is null for an ownerless community listing (never the place, never the site)", () => {
    expect(
      buildEventJsonLdEnrichment(communityListing(), SLUG, PUBLIC).organizer,
    ).toBeNull();
  });

  it("is null when the org has no page link to give", () => {
    expect(
      buildEventJsonLdEnrichment(
        orgEvent({ organizerHref: null }),
        SLUG,
        PUBLIC,
      ).organizer,
    ).toBeNull();
  });
});

describe("buildEventJsonLdEnrichment — image", () => {
  it("is the SAME stub url the page's og:image names", () => {
    const event = communityListing();
    const metadata = withGeneratedEventOgImage(
      {} as Metadata,
      eventOgImageInputFor(event, SLUG),
    );
    const ogImages = metadata.openGraph?.images as { url: string }[];

    const { fallbackImageUrl } = buildEventJsonLdEnrichment(event, SLUG, PUBLIC);

    expect(fallbackImageUrl).toMatch(
      /^https:\/\/ithasfire\.com\/og\/event\/drkmttr\/us\/tn\/sunset-session--ab12cd\?v=/,
    );
    expect(fallbackImageUrl).toBe(ogImages[0]?.url);
  });

  it("is null when the event has a poster of its own", () => {
    expect(
      buildEventJsonLdEnrichment(
        communityListing({ images: ["https://cdn.test/poster.jpg"] }),
        SLUG,
        PUBLIC,
      ).fallbackImageUrl,
    ).toBeNull();
  });

  it("is null on the gated unlocked view, whose head never names the stub", () => {
    expect(
      buildEventJsonLdEnrichment(communityListing(), SLUG, {
        generatedImage: false,
      }).fallbackImageUrl,
    ).toBeNull();
  });
});

describe("the enriched JSON-LD of a prod-shaped community listing", () => {
  const jsonLdFor = (event: PublicEventSeo) =>
    buildEventJsonLd(
      applyEventJsonLdEnrichment(
        event,
        buildEventJsonLdEnrichment(event, SLUG, PUBLIC),
      ),
    );

  it("fills location.name, image and offers.validFrom, and adds NO organizer or performer", () => {
    const jsonLd = jsonLdFor(communityListing());

    expect(jsonLd.location).toMatchObject({
      name: "Grandpa Bar, 1501 Herman St #123, Nashville, TN",
    });
    expect(jsonLd.image).toEqual([
      expect.stringMatching(/^https:\/\/ithasfire\.com\/og\/event\//),
    ]);
    expect(jsonLd.offers).toMatchObject({
      "@type": "Offer",
      price: "0",
      validFrom: "2026-09-01T12:00:00.000Z",
    });
    expect(jsonLd).not.toHaveProperty("organizer");
    expect(jsonLd).not.toHaveProperty("performer");
  });

  it("emits the org as a schema.org Organization", () => {
    expect(jsonLdFor(orgEvent()).organizer).toEqual({
      "@type": "Organization",
      name: "Drkmttr",
      url: "https://ithasfire.com/orgs/drkmttr",
    });
  });

  it("an OBSCURED listing still names nothing finer than its area label", () => {
    const jsonLd = jsonLdFor(
      communityListing({
        location: {
          latitude: 36.164,
          longitude: -86.789,
          isExact: false,
          radiusMeters: 800,
          areaLabel: "East Nashville",
        },
      }),
    );
    const location = jsonLd.location as Record<string, unknown>;
    expect(location.name).toBe("East Nashville");
    expect(location).not.toHaveProperty("address");
    expect(location.geo).toMatchObject({ "@type": "GeoCircle" });
  });
});
