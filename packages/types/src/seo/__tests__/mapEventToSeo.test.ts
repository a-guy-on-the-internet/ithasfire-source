import { describe, expect, it } from "vitest";

import { mapEventToSeo } from "../mapEventToSeo";
import type { SeoEventInput } from "../types";

describe("mapEventToSeo", () => {
  const baseInput: SeoEventInput = {
    event: {
      id: "event-123",
      slug: "my-cool-show",
      title: "  My Cool Show  ",
      description: "  A description with extra spaces.  ",
      startsAt: new Date("2025-01-01T20:00:00.000Z"),
      endsAt: new Date("2025-01-01T22:00:00.000Z"),
      status: "PUBLISHED",
      updatedAt: new Date("2025-01-01T10:00:00.000Z"),
    },
    canonicalUrl: "https://tickets.example.com/events/my-cool-show",
    ticketingUrl: " https://tickets.example.com/checkout/my-cool-show ",
    images: [
      " https://cdn.example.com/hero.jpg ",
      "https://cdn.example.com/hero.jpg",
      null,
    ],
    location: {
      name: "  Kings Theatre  ",
      addressLine1: " 1027 Flatbush Ave ",
      city: " Brooklyn ",
      region: " NY ",
      postalCode: " 11226 ",
      countryCode: " us ",
      latitude: 40.6451,
      longitude: -73.9558,
    },
    organizer: {
      name: " Ithas Fire ",
      url: " https://ithasfire.com ",
    },
    pricing: {
      currency: "usd",
      minPriceCents: 2500,
      maxPriceCents: 7500,
      availability: "limited",
      validFrom: new Date("2024-12-01T00:00:00.000Z"),
    },
  };

  it("normalizes strings, urls, and collections", () => {
    const result = mapEventToSeo(baseInput);

    expect(result).toMatchObject({
      id: "event-123",
      slug: "my-cool-show",
      name: "My Cool Show",
      description: "A description with extra spaces.",
      url: "https://tickets.example.com/events/my-cool-show",
      ticketingUrl: "https://tickets.example.com/checkout/my-cool-show",
      images: ["https://cdn.example.com/hero.jpg"],
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
        maxPriceCents: 7500,
        availability: "limited",
      },
    });
  });

  it("defaults availability and handles missing optional fields", () => {
    const input: SeoEventInput = {
      event: {
        id: "event-456",
        slug: "minimal-event",
        title: "Minimal Event",
        startsAt: new Date("2025-02-01T10:00:00.000Z"),
        status: "PUBLISHED",
      },
      canonicalUrl: "https://tickets.example.com/events/minimal-event",
    };

    const result = mapEventToSeo(input);

    expect(result.pricing).toBeUndefined();
    expect(result.images).toEqual([]);
    expect(result.location).toBeUndefined();
    expect(result.organizer).toBeUndefined();
  });

  it("throws when required fields are missing", () => {
    expect(() =>
      mapEventToSeo({
        // @ts-expect-error intentionally missing slug
        event: {
          id: "bad",
          title: "No Slug",
          startsAt: new Date(),
          status: "PUBLISHED",
        },
        canonicalUrl: "https://tickets.example.com/bad",
      }),
    ).toThrowError(/event\.slug/);

    expect(() =>
      mapEventToSeo({
        // @ts-expect-error missing event
        event: undefined,
        canonicalUrl: "https://tickets.example.com/bad",
      }),
    ).toThrowError(/input\.event/);
  });

  describe("publishedAt (the JSON-LD free Offer's validFrom fallback)", () => {
    const withPublishedAt = (publishedAt: unknown) =>
      mapEventToSeo({
        ...baseInput,
        event: {
          ...baseInput.event,
          publishedAt: publishedAt as Date | null | undefined,
        },
      });

    it("carries a valid Date through", () => {
      const publishedAt = new Date("2026-09-01T12:00:00.000Z");
      expect(withPublishedAt(publishedAt).publishedAt).toEqual(publishedAt);
    });

    it("maps null to null", () => {
      expect(withPublishedAt(null).publishedAt).toBeNull();
    });

    it("maps an absent field (an older API) to null", () => {
      const result = mapEventToSeo(baseInput);
      expect(result).toHaveProperty("publishedAt");
      expect(result.publishedAt).toBeNull();
    });

    it("maps an unparseable date to null, never an Invalid Date", () => {
      expect(withPublishedAt(new Date("not-a-date")).publishedAt).toBeNull();
      expect(withPublishedAt("not-a-date").publishedAt).toBeNull();
    });
  });
});
