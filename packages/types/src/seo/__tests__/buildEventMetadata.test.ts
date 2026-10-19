import { describe, expect, it } from "vitest";

import { buildEventMetadata } from "../buildEventMetadata";
import type { SeoEvent } from "../types";

describe("buildEventMetadata", () => {
  const event: SeoEvent = {
    id: "event-456",
    slug: "sunrise-yoga",
    url: "https://tickets.example.com/events/sunrise-yoga",
    name: "Sunrise Rooftop Yoga",
    description: "Start your day with an energizing rooftop yoga session.",
    startsAt: new Date("2025-08-01T10:00:00.000Z"),
    endsAt: new Date("2025-08-01T11:30:00.000Z"),
    status: "PUBLISHED",
    updatedAt: new Date("2025-07-01T09:00:00.000Z"),
    ticketingUrl: "https://tickets.example.com/checkout/sunrise-yoga",
    images: ["https://cdn.example.com/sunrise-yoga/hero.jpg"],
    location: {
      name: "Skyline Terrace",
      addressLine1: "200 Market St",
      city: "San Francisco",
      region: "CA",
      postalCode: "94105",
      countryCode: "US",
    },
    organizer: {
      name: "Ithas Fire",
      url: "https://ithasfire.com",
    },
    pricing: {
      currency: "USD",
      minPriceCents: 1500,
      maxPriceCents: 3500,
      availability: "in_stock",
    },
    performers: [],
  };

  it("produces a Next.js Metadata object for the event", () => {
    const metadata = buildEventMetadata({ event, siteName: "Ithas Fire" });

    expect(metadata).toMatchObject({
      title: "Sunrise Rooftop Yoga · San Francisco, CA",
      description: "Start your day with an energizing rooftop yoga session.",
      alternates: {
        canonical: "https://tickets.example.com/events/sunrise-yoga",
      },
      openGraph: {
        type: "website",
        title: "Sunrise Rooftop Yoga · San Francisco, CA",
        description: "Start your day with an energizing rooftop yoga session.",
        url: "https://tickets.example.com/events/sunrise-yoga",
        siteName: "Ithas Fire",
        images: [
          {
            url: "https://cdn.example.com/sunrise-yoga/hero.jpg",
            alt: "Sunrise Rooftop Yoga",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: "Sunrise Rooftop Yoga · San Francisco, CA",
        description: "Start your day with an energizing rooftop yoga session.",
        images: [
          {
            url: "https://cdn.example.com/sunrise-yoga/hero.jpg",
            alt: "Sunrise Rooftop Yoga",
          },
        ],
      },
      lastModified: event.updatedAt,
      other: {
        "event:id": "event-456",
        "event:slug": "sunrise-yoga",
        "event:url": "https://tickets.example.com/events/sunrise-yoga",
        "event:description":
          "Start your day with an energizing rooftop yoga session.",
        "event:start": "2025-08-01T10:00:00.000Z",
        "event:end": "2025-08-01T11:30:00.000Z",
        "event:status": "PUBLISHED",
        "event:status:url": "https://schema.org/EventScheduled",
        "event:attendance-mode":
          "https://schema.org/OfflineEventAttendanceMode",
        "event:updated": "2025-07-01T09:00:00.000Z",
        "event:ticketing:url":
          "https://tickets.example.com/checkout/sunrise-yoga",
        "event:image": "https://cdn.example.com/sunrise-yoga/hero.jpg",
        "event:images": ["https://cdn.example.com/sunrise-yoga/hero.jpg"],
        "event:location:name": "Skyline Terrace",
        "event:location:street": "200 Market St",
        "event:location:city": "San Francisco",
        "event:location:region": "CA",
        "event:location:postal-code": "94105",
        "event:location:country": "US",
        "event:organizer:name": "Ithas Fire",
        "event:organizer:url": "https://ithasfire.com",
        "event:offers:currency": "USD",
        "event:offers:low-price": "15.00",
        "event:offers:high-price": "35.00",
        "event:offers:availability": "https://schema.org/InStock",
        "event:offers:url": "https://tickets.example.com/checkout/sunrise-yoga",
      },
    });
  });

  it("omits empty collections and fields", () => {
    const metadata = buildEventMetadata({
      event: {
        ...event,
        images: [],
        organizer: undefined,
        pricing: undefined,
        location: undefined,
      },
      siteName: "Ithas Fire",
    });

    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter?.images).toBeUndefined();
    expect(metadata.other?.["event:image"]).toBeUndefined();
    expect(metadata.other?.["event:images"]).toBeUndefined();
    expect(metadata.other?.["event:location:name"]).toBeUndefined();
    expect(metadata.other?.["event:offers:currency"]).toBeUndefined();
  });

  it("personalises OG description when refPerformerName is provided", () => {
    const metadata = buildEventMetadata({
      event,
      siteName: "Ithas Fire",
      refPerformerName: "DJ Pulse",
    });

    const expectedDesc = "See DJ Pulse at Sunrise Rooftop Yoga";
    expect(metadata.description).toBe(expectedDesc);
    expect(metadata.openGraph?.description).toBe(expectedDesc);
    expect(metadata.twitter?.description).toBe(expectedDesc);
    // Title and canonical must remain unchanged
    expect(metadata.title).toBe("Sunrise Rooftop Yoga · San Francisco, CA");
    expect(metadata.alternates?.canonical).toBe(event.url);
    // Meta tag set
    expect(metadata.other?.["event:ref-performer"]).toBe("DJ Pulse");
  });

  it("falls back to default description when refPerformerName is undefined", () => {
    const metadata = buildEventMetadata({
      event,
      siteName: "Ithas Fire",
      refPerformerName: undefined,
    });

    expect(metadata.description).toBe(event.description);
    expect(metadata.other?.["event:ref-performer"]).toBeUndefined();
  });

  describe("title", () => {
    it("appends city and region, in title, og and twitter", () => {
      const m = buildEventMetadata({
        event: {
          ...event,
          name: "Roast the Host",
          location: { city: "Nashville", region: "TN" },
        },
      });
      expect(m.title).toBe("Roast the Host · Nashville, TN");
      expect(m.openGraph?.title).toBe("Roast the Host · Nashville, TN");
      expect(m.twitter?.title).toBe("Roast the Host · Nashville, TN");
    });

    it("appends the city alone when there is no region", () => {
      const m = buildEventMetadata({
        event: { ...event, location: { city: "Nashville" } },
      });
      expect(m.title).toBe("Sunrise Rooftop Yoga · Nashville");
    });

    it("skips the suffix when the name already contains the city", () => {
      const m = buildEventMetadata({
        event: {
          ...event,
          name: "NASHVILLE Open Mic",
          location: { city: "Nashville", region: "TN" },
        },
      });
      expect(m.title).toBe("NASHVILLE Open Mic");
    });

    it("matches the city as a whole word only", () => {
      const at = (name: string, city: string) =>
        buildEventMetadata({
          event: { ...event, name, location: { city, region: "TN" } },
        }).title;
      expect(at("Nashville Songwriters", "Nashville")).toBe(
        "Nashville Songwriters",
      );
      expect(at("Jerusalem Nights", "Salem")).toBe(
        "Jerusalem Nights · Salem, TN",
      );
      expect(at("Adam's Open Mic", "Ada")).toBe("Adam's Open Mic · Ada, TN");
    });

    it("is the name only without a locality", () => {
      expect(
        buildEventMetadata({ event: { ...event, location: undefined } }).title,
      ).toBe("Sunrise Rooftop Yoga");
      expect(
        buildEventMetadata({
          event: { ...event, location: { name: "Skyline Terrace" } },
        }).title,
      ).toBe("Sunrise Rooftop Yoga");
    });
  });

  describe("description fallback", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const bare: SeoEvent = {
      ...event,
      description: null,
      startsAt: new Date("2026-10-16T02:00:00.000Z"),
      location: { city: "Nashville", region: "TN" },
    };

    it("is a readable sentence in the event timezone with the category", () => {
      const m = buildEventMetadata({
        now,
        event: {
          ...bare,
          timezone: "America/Chicago",
          categoryName: "Open Mics",
        },
      });
      expect(m.description).toBe(
        "Open Mics in Nashville, TN on Thu, Oct 15, 9:00 PM.",
      );
      expect(m.openGraph?.description).toBe(m.description);
      expect(m.other?.["event:description"]).toBe(m.description);
    });

    it("says Event without a category", () => {
      const m = buildEventMetadata({
        now,
        event: { ...bare, timezone: "America/Chicago" },
      });
      expect(m.description).toBe(
        "Event in Nashville, TN on Thu, Oct 15, 9:00 PM.",
      );
    });

    it("omits the time and uses the UTC date without a timezone", () => {
      const m = buildEventMetadata({
        now,
        event: { ...bare, startsAt: new Date("2026-10-16T02:00:00.000Z") },
      });
      expect(m.description).toBe("Event in Nashville, TN on Fri, Oct 16.");
    });

    it("omits the place when there is no locality", () => {
      const m = buildEventMetadata({
        now,
        event: { ...bare, location: undefined, timezone: "UTC" },
      });
      expect(m.description).toBe("Event on Fri, Oct 16, 2:00 AM.");
    });

    it("treats an invalid timezone like a missing one", () => {
      const m = buildEventMetadata({
        now,
        event: { ...bare, timezone: "Not/AZone" },
      });
      expect(m.description).toBe("Event in Nashville, TN on Fri, Oct 16.");
    });

    it("adds the year when the start is not in the current year", () => {
      const m = buildEventMetadata({
        now,
        event: {
          ...bare,
          timezone: "America/Chicago",
          startsAt: new Date("2027-01-02T03:00:00.000Z"),
        },
      });
      expect(m.description).toBe(
        "Event in Nashville, TN on Fri, Jan 1, 2027, 9:00 PM.",
      );
      const n = buildEventMetadata({
        now: new Date("2026-12-31T23:00:00.000Z"),
        event: { ...bare, startsAt: new Date("2027-01-01T03:00:00.000Z") },
      });
      expect(n.description).toBe("Event in Nashville, TN on Fri, Jan 1, 2027.");
    });

    it("keeps a real description unchanged", () => {
      expect(buildEventMetadata({ event }).description).toBe(event.description);
    });
  });
});
