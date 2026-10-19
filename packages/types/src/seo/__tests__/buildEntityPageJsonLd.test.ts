import { describe, expect, it } from "vitest";

import { buildEntityPageJsonLd } from "../buildEntityPageJsonLd";
import type { SeoEntityPage } from "../entity-page-types";

const BASE_PAGE: SeoEntityPage = {
  url: "https://ithasfire.com/p/alice",
  ownerType: "HUMAN",
  displayName: "Alice",
  bio: "Singer-songwriter from Austin",
  avatarUrl: "https://cdn.example.com/alice.jpg",
  bannerUrl: "https://cdn.example.com/alice-banner.jpg",
  entity: { type: "HUMAN", id: "h1", name: "Alice" },
};

describe("buildEntityPageJsonLd", () => {
  it("builds Person JSON-LD for HUMAN pages", () => {
    const ld = buildEntityPageJsonLd(BASE_PAGE);

    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Person");
    expect(ld.name).toBe("Alice");
    expect(ld.url).toBe("https://ithasfire.com/p/alice");
    expect(ld.description).toBe("Singer-songwriter from Austin");
    expect(ld.image).toBe("https://cdn.example.com/alice.jpg");
  });

  it("builds Organization JSON-LD for ORGANIZATION pages", () => {
    const page: SeoEntityPage = {
      url: "https://ithasfire.com/p/acme",
      ownerType: "ORGANIZATION",
      displayName: "Acme Events",
      bio: "Event promoters",
      avatarUrl: "https://cdn.example.com/acme-logo.png",
      entity: {
        type: "ORGANIZATION",
        id: "o1",
        name: "Acme Events",
        slug: "acme",
        trustTier: "VERIFIED",
        trustBadgeLabel: "Verified",
      },
    };

    const ld = buildEntityPageJsonLd(page);

    expect(ld["@type"]).toBe("Organization");
    expect(ld.name).toBe("Acme Events");
    expect(ld.logo).toBe("https://cdn.example.com/acme-logo.png");
    expect(ld.description).toBe("Event promoters");
  });

  it("builds Place JSON-LD for PLACE pages with geo + address", () => {
    const page: SeoEntityPage = {
      url: "https://ithasfire.com/p/the-roxy",
      ownerType: "PLACE",
      displayName: "The Roxy",
      bio: "Legendary music venue",
      avatarUrl: null,
      entity: {
        type: "PLACE",
        id: "p1",
        name: "The Roxy",
        slug: "the-roxy",
        city: "Los Angeles",
        region: "CA",
        formattedAddress: null,
        lat: 34.09,
        lng: -118.39,
        // Required for sharp coordinates now (place-address-withholding): the
        // flag is optional on EntitySummary, so its ABSENCE reads as withheld.
        locationIsExact: true,
      },
    };

    const ld = buildEntityPageJsonLd(page);

    expect(ld["@type"]).toBe("Place");
    expect(ld.name).toBe("The Roxy");
    expect(ld.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Los Angeles",
      addressRegion: "CA",
    });
    expect(ld.geo).toEqual({
      "@type": "GeoCoordinates",
      latitude: 34.09,
      longitude: -118.39,
    });
  });

  /**
   * ADDRESS PRIVACY (place-address-withholding). A withheld venue's `lat`/`lng`
   * is the deliberately-offset circle CENTRE, not the venue. Sharp
   * `GeoCoordinates` would be a machine-readable assertion that the venue is at
   * a precise point it never published — so this branch emits a GeoCircle.
   */
  it("emits a GeoCircle, not a pin, for a venue that withholds its address", () => {
    const page: SeoEntityPage = {
      url: "https://ithasfire.com/places/the-bat-cave",
      ownerType: "PLACE",
      displayName: "The Bat Cave",
      bio: null,
      avatarUrl: null,
      entity: {
        type: "PLACE",
        id: "p2",
        name: "The Bat Cave",
        city: "Nashville",
        region: "TN",
        formattedAddress: null,
        lat: 36.1801,
        lng: -86.7355,
        locationIsExact: false,
        locationRadiusMeters: 1200,
      },
    };

    expect(buildEntityPageJsonLd(page).geo).toEqual({
      "@type": "GeoCircle",
      geoMidpoint: {
        "@type": "GeoCoordinates",
        latitude: 36.1801,
        longitude: -86.7355,
      },
      geoRadius: 1200,
    });
  });

  it("treats an ABSENT locationIsExact as withheld (fail closed)", () => {
    // Client-side fallback summaries omit the flag. An omission must not be
    // read as permission to publish a pin.
    const page: SeoEntityPage = {
      url: "https://ithasfire.com/places/unknown",
      ownerType: "PLACE",
      displayName: "Unknown",
      bio: null,
      avatarUrl: null,
      entity: {
        type: "PLACE",
        id: "p3",
        name: "Unknown",
        city: null,
        region: null,
        formattedAddress: null,
        lat: 36.1,
        lng: -86.7,
      },
    };

    expect(buildEntityPageJsonLd(page).geo).toMatchObject({
      "@type": "GeoCircle",
    });
  });

  it("omits optional fields when they are null/undefined", () => {
    const page: SeoEntityPage = {
      url: "https://ithasfire.com/p/bob",
      ownerType: "HUMAN",
      displayName: "Bob",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      entity: { type: "HUMAN", id: "h2", name: "Bob" },
    };

    const ld = buildEntityPageJsonLd(page);

    expect(ld.description).toBeUndefined();
    expect(ld.image).toBeUndefined();
  });

  it("omits geo/address for PLACE when not available", () => {
    const page: SeoEntityPage = {
      url: "https://ithasfire.com/p/nowhere",
      ownerType: "PLACE",
      displayName: "Nowhere",
      bio: null,
      entity: {
        type: "PLACE",
        id: "p2",
        name: "Nowhere",
        slug: null,
        city: null,
        region: null,
        formattedAddress: null,
        lat: null,
        lng: null,
      },
    };

    const ld = buildEntityPageJsonLd(page);

    expect(ld.address).toBeUndefined();
    expect(ld.geo).toBeUndefined();
  });
});
