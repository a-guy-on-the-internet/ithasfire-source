import { describe, expect, it } from "vitest";

import { buildEventJsonLd } from "../buildEventJsonLd";
import type { SeoEvent } from "../types";

describe("buildEventJsonLd", () => {
  const baseEvent: SeoEvent = {
    id: "event-789",
    slug: "jazz-night",
    url: "https://tickets.example.com/events/jazz-night",
    name: "Jazz Night",
    description: "A night of live jazz music.",
    startsAt: new Date("2025-03-10T19:30:00.000Z"),
    endsAt: new Date("2025-03-10T22:00:00.000Z"),
    status: "PUBLISHED",
    updatedAt: new Date("2025-02-01T10:00:00.000Z"),
    ticketingUrl: "https://tickets.example.com/checkout/jazz-night",
    images: [
      "https://cdn.example.com/jazz-night/hero.jpg",
      "https://cdn.example.com/jazz-night/poster.jpg",
    ],
    location: {
      name: "Kings Theatre",
      addressLine1: "1027 Flatbush Ave",
      city: "Brooklyn",
      region: "NY",
      postalCode: "11226",
      countryCode: "US",
      latitude: 40.6451,
      longitude: -73.9558,
    },
    organizer: {
      name: "Ithas Fire",
      url: "https://ithasfire.com",
    },
    pricing: {
      currency: "USD",
      minPriceCents: 2500,
      maxPriceCents: 9500,
      availability: "limited",
      validFrom: new Date("2025-01-01T00:00:00.000Z"),
    },
    performers: [],
  };

  it("builds a schema.org Event JSON-LD payload", () => {
    const jsonLd = buildEventJsonLd(baseEvent);

    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Jazz Night",
      description: "A night of live jazz music.",
      startDate: "2025-03-10T19:30:00.000Z",
      endDate: "2025-03-10T22:00:00.000Z",
      url: "https://tickets.example.com/events/jazz-night",
      eventStatus: "https://schema.org/EventScheduled",
      image: [
        "https://cdn.example.com/jazz-night/hero.jpg",
        "https://cdn.example.com/jazz-night/poster.jpg",
      ],
      organizer: {
        "@type": "Organization",
        name: "Ithas Fire",
        url: "https://ithasfire.com",
      },
      location: {
        "@type": "Place",
        name: "Kings Theatre",
        address: {
          "@type": "PostalAddress",
          streetAddress: "1027 Flatbush Ave",
          addressLocality: "Brooklyn",
          addressRegion: "NY",
          postalCode: "11226",
          addressCountry: "US",
        },
        geo: {
          "@type": "GeoCoordinates",
          latitude: 40.6451,
          longitude: -73.9558,
        },
      },
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "USD",
        lowPrice: "25.00",
        highPrice: "95.00",
        availability: "https://schema.org/LimitedAvailability",
        validFrom: "2025-01-01T00:00:00.000Z",
        url: "https://tickets.example.com/checkout/jazz-night",
      },
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      dateModified: "2025-02-01T10:00:00.000Z",
    });
  });

  it("always marks events as in-person, even without a location", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      location: undefined,
    });

    expect(jsonLd.eventAttendanceMode).toBe(
      "https://schema.org/OfflineEventAttendanceMode",
    );
    // Never emit a VirtualLocation for missing venue data.
    expect(jsonLd).not.toHaveProperty("location");
  });

  it("emits venue-local dates with the timezone offset when set", () => {
    // 2025-03-10T19:30:00Z is 14:30 in America/Chicago (CDT, -05:00).
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      timezone: "America/Chicago",
    });

    expect(jsonLd.startDate).toBe("2025-03-10T14:30:00-05:00");
    expect(jsonLd.endDate).toBe("2025-03-10T17:00:00-05:00");
  });

  it("falls back to UTC when timezone is absent", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      timezone: null,
    });

    expect(jsonLd.startDate).toBe("2025-03-10T19:30:00.000Z");
    expect(jsonLd.endDate).toBe("2025-03-10T22:00:00.000Z");
  });

  it("falls back to UTC when timezone is invalid", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      timezone: "Not/A_Zone",
    });

    expect(jsonLd.startDate).toBe("2025-03-10T19:30:00.000Z");
    expect(jsonLd.endDate).toBe("2025-03-10T22:00:00.000Z");
  });

  it("omits offers entirely when pricing has no minimum price", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      pricing: {
        currency: "USD",
        availability: "in_stock",
      },
    });

    expect(jsonLd).not.toHaveProperty("offers");
  });

  it("emits a free Offer for a community/RSVP listing with no pricing", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      ticketingUrl: null,
      pricing: undefined,
    });

    expect(jsonLd.offers).toEqual({
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: "https://tickets.example.com/events/jazz-night",
    });
  });

  it("emits a free Offer for a ticketed event priced at $0 (using its currency)", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      ticketingUrl: null,
      pricing: {
        currency: "CAD",
        minPriceCents: 0,
        maxPriceCents: 0,
        availability: "in_stock",
      },
    });

    expect(jsonLd.offers).toEqual({
      "@type": "Offer",
      price: "0",
      priceCurrency: "CAD",
      availability: "https://schema.org/InStock",
      url: "https://tickets.example.com/events/jazz-night",
    });
    // A $0 price must NOT produce an AggregateOffer.
    expect(jsonLd.offers).not.toHaveProperty("lowPrice");
  });

  it("honors availability and validFrom on a $0 sold-out free Offer", () => {
    const validFrom = new Date("2026-06-01T00:00:00.000Z");
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      pricing: {
        currency: "USD",
        minPriceCents: 0,
        maxPriceCents: 0,
        availability: "sold_out",
        validFrom,
      },
    });

    expect(jsonLd.offers).toMatchObject({
      "@type": "Offer",
      price: "0",
      availability: "https://schema.org/SoldOut",
      validFrom: validFrom.toISOString(),
    });
  });

  it("prefers the ticketing URL for a free Offer when present", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      pricing: undefined,
    });

    expect(jsonLd.offers).toMatchObject({
      "@type": "Offer",
      url: "https://tickets.example.com/checkout/jazz-night",
    });
  });

  it("falls back to event URL when ticketing URL is missing", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      ticketingUrl: null,
    });

    expect(jsonLd.offers).toMatchObject({
      url: "https://tickets.example.com/events/jazz-night",
    });
  });

  it("maps cancellation status to schema.org enumerations", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      status: "CANCELLED",
    });

    expect(jsonLd.eventStatus).toBe("https://schema.org/EventCancelled");
  });

  it("treats completed events as scheduled for schema compatibility", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      status: "COMPLETED",
    });

    expect(jsonLd.eventStatus).toBe("https://schema.org/EventScheduled");
  });

  describe("geo emission (obscured-location privacy)", () => {
    it("emits GeoCoordinates for exact coordinates (isExact: true)", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: { ...baseEvent.location, isExact: true },
      });

      const location = jsonLd.location as Record<string, unknown>;
      expect(location.geo).toEqual({
        "@type": "GeoCoordinates",
        latitude: 40.6451,
        longitude: -73.9558,
      });
    });

    it("emits GeoCoordinates when isExact is absent (legacy exact shape)", () => {
      // baseEvent.location has no isExact — the pre-existing exact behavior.
      const jsonLd = buildEventJsonLd(baseEvent);

      const location = jsonLd.location as Record<string, unknown>;
      expect(location.geo).toEqual({
        "@type": "GeoCoordinates",
        latitude: 40.6451,
        longitude: -73.9558,
      });
    });

    it("emits a GeoCircle (not GeoCoordinates) for obscured coordinates", () => {
      // build-event-seo's obscured variant: server-offset point + radius.
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          name: "Midtown Manhattan",
          city: "New York",
          region: "NY",
          latitude: 40.7484,
          longitude: -73.9856,
          isExact: false,
          radiusMeters: 800,
          areaLabel: "Midtown Manhattan",
        },
      });

      const location = jsonLd.location as Record<string, unknown>;
      expect(location.geo).toEqual({
        "@type": "GeoCircle",
        geoMidpoint: {
          "@type": "GeoCoordinates",
          latitude: 40.7484,
          longitude: -73.9856,
        },
        geoRadius: 800,
      });
    });

    it("omits geoRadius when the obscured variant carries no radius", () => {
      // Defensive: publicEventCoordinate never emits coords without a radius,
      // but if it ever did we still must not emit a sharp GeoCoordinates pin.
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          city: "New York",
          latitude: 40.7484,
          longitude: -73.9856,
          isExact: false,
          radiusMeters: null,
        },
      });

      const location = jsonLd.location as Record<string, unknown>;
      expect(location.geo).toEqual({
        "@type": "GeoCircle",
        geoMidpoint: {
          "@type": "GeoCoordinates",
          latitude: 40.7484,
          longitude: -73.9856,
        },
      });
    });

    it("emits no geo at all for the fully-hidden variant (no coordinates)", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          city: "Brooklyn",
          region: "NY",
          isExact: false,
          areaLabel: "Bushwick, Brooklyn",
        },
      });

      const location = jsonLd.location as Record<string, unknown>;
      expect(location).not.toHaveProperty("geo");
      // The Place itself still renders (coarse address only).
      expect(location["@type"]).toBe("Place");
    });
  });

  it("renders performer array with optional url", () => {
    const jsonLd = buildEventJsonLd({
      ...baseEvent,
      performers: [
        {
          eventHumanId: "eh-1",
          name: "Alice Coltrane",
          role: "PERFORMER",
          url: "https://alice.example.com",
        },
        { eventHumanId: "eh-2", name: "Bob the DJ", role: "DJ" },
      ],
    });

    expect(jsonLd.performer).toEqual([
      {
        "@type": "Person",
        name: "Alice Coltrane",
        url: "https://alice.example.com",
      },
      { "@type": "Person", name: "Bob the DJ" },
    ]);
    // Performer without URL should not have the `url` key at all
    const bob = (jsonLd.performer as Record<string, unknown>[])[1];
    expect(bob).not.toHaveProperty("url");
  });

  describe("@type (data-driven per category)", () => {
    it("emits a known schema.org subtype (music category → MusicEvent)", () => {
      const jsonLd = buildEventJsonLd({ ...baseEvent, seoType: "MusicEvent" });
      expect(jsonLd["@type"]).toBe("MusicEvent");
    });

    it("falls back to Event when seoType is absent", () => {
      const jsonLd = buildEventJsonLd({ ...baseEvent, seoType: undefined });
      expect(jsonLd["@type"]).toBe("Event");
    });

    it("falls back to Event when seoType is null", () => {
      const jsonLd = buildEventJsonLd({ ...baseEvent, seoType: null });
      expect(jsonLd["@type"]).toBe("Event");
    });

    it("falls back to Event when seoType is not in the allowlist", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        // Not a curated schema.org Event subtype we emit.
        seoType: "NotARealEvent",
      });
      expect(jsonLd["@type"]).toBe("Event");
    });
  });

  describe("Offer.validFrom", () => {
    it("emits validFrom on a community listing's free Offer from publishedAt", () => {
      // Search Console: "Missing field validFrom (in offers)" on every
      // community listing. They have no pricing block, so the go-live stamp
      // is the date the free Offer became available.
      const publishedAt = new Date("2026-09-01T15:00:00.000Z");
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        ticketingUrl: null,
        pricing: undefined,
        publishedAt,
      });

      expect(jsonLd.offers).toEqual({
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        validFrom: "2026-09-01T15:00:00.000Z",
        url: "https://tickets.example.com/events/jazz-night",
      });
    });

    it("prefers pricing.validFrom (the sales opening) over publishedAt", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        publishedAt: new Date("2024-12-01T00:00:00.000Z"),
      });
      expect(jsonLd.offers).toMatchObject({
        "@type": "AggregateOffer",
        validFrom: "2025-01-01T00:00:00.000Z",
      });
    });

    it("falls back to publishedAt on an AggregateOffer with no sales opening", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        pricing: { ...baseEvent.pricing!, validFrom: null },
        publishedAt: new Date("2024-12-01T00:00:00.000Z"),
      });
      expect(jsonLd.offers).toMatchObject({
        "@type": "AggregateOffer",
        validFrom: "2024-12-01T00:00:00.000Z",
      });
    });

    it("omits validFrom when neither pricing.validFrom nor publishedAt is known", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        pricing: undefined,
        publishedAt: undefined,
      });
      expect(jsonLd.offers).not.toHaveProperty("validFrom");
    });
  });

  describe("location.name fallback (values already public in the location)", () => {
    const placeOf = (jsonLd: Record<string, unknown>) =>
      jsonLd.location as Record<string, unknown>;

    it("keeps the disclosure-gated place name when upstream allowed one", () => {
      expect(placeOf(buildEventJsonLd(baseEvent)).name).toBe("Kings Theatre");
    });

    it("names an exact, unnamed community listing by its street address", () => {
      // The prod shape Search Console flagged: the address text itself
      // carries the place, but build-event-seo's gate nulled `name`.
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
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
      });
      const location = placeOf(jsonLd);
      expect(location.name).toBe(
        "Grandpa Bar, 1501 Herman St #123, Nashville, TN",
      );
      expect(location.address).toMatchObject({
        streetAddress: "Grandpa Bar, 1501 Herman St #123, Nashville, TN",
      });
    });

    it("joins both address lines, as streetAddress does", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          addressLine1: "1501 Herman St",
          addressLine2: "Suite 123",
          city: "Nashville",
        },
      });
      expect(placeOf(jsonLd).name).toBe("1501 Herman St, Suite 123");
    });

    it("falls back to the city when there is no street address", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: { city: "Nashville", region: "TN", isExact: true },
      });
      expect(placeOf(jsonLd).name).toBe("Nashville");
    });

    it("OBSCURED: names the area label only, never anything finer", () => {
      // build-event-seo's obscured variant: name/street/postcode/city null,
      // an offset centre, a radius and a coarse area label.
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          latitude: 36.164,
          longitude: -86.789,
          isExact: false,
          radiusMeters: 800,
          areaLabel: "East Nashville",
        },
      });
      const location = placeOf(jsonLd);
      expect(location.name).toBe("East Nashville");
      expect(location).not.toHaveProperty("address");
      expect(location.geo).toMatchObject({ "@type": "GeoCircle" });
      expect(JSON.stringify(jsonLd)).not.toContain("streetAddress");
    });

    it("an approximate location prefers its area label over a city", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          city: "Brooklyn",
          isExact: false,
          areaLabel: "Bushwick, Brooklyn",
        },
      });
      expect(placeOf(jsonLd).name).toBe("Bushwick, Brooklyn");
    });

    it("an EXACT location ignores a stray area label", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: {
          addressLine1: "1027 Flatbush Ave",
          city: "Brooklyn",
          isExact: true,
          areaLabel: "Flatbush",
        },
      });
      expect(placeOf(jsonLd).name).toBe("1027 Flatbush Ave");
    });

    it("omits name when the location carries nothing to name it by", () => {
      const jsonLd = buildEventJsonLd({
        ...baseEvent,
        location: { latitude: 36.1, longitude: -86.7, isExact: false },
      });
      expect(placeOf(jsonLd)).not.toHaveProperty("name");
    });
  });
});
