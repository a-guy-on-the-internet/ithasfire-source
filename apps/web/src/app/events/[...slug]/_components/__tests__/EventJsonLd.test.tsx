import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventJsonLd } from "../EventJsonLd";
import type { SeoEvent } from "@th/types/seo/types";

describe("EventJsonLd", () => {
  const event: SeoEvent = {
    id: "evt-1",
    slug: "evening-show",
    url: "https://tickets.local/events/evening-show",
    name: "Evening Show",
    description: "A relaxing concert at sunset.",
    startsAt: new Date("2025-03-10T19:00:00.000Z"),
    endsAt: new Date("2025-03-10T21:00:00.000Z"),
    status: "PUBLISHED",
    updatedAt: new Date("2025-02-01T10:00:00.000Z"),
    ticketingUrl: "https://tickets.local/checkout/evening-show",
    images: ["https://cdn.local/evening-show.jpg"],
    location: {
      name: "Main Hall",
      city: "Austin",
      region: "TX",
      countryCode: "US",
    },
    organizer: {
      name: "Ithas Fire",
      url: "https://ithasfire.com",
    },
    pricing: {
      currency: "USD",
      minPriceCents: 2500,
      availability: "in_stock",
    },
    // Required on SeoEvent — `mapEventToSeo` always supplies an array (its
    // `sanitizePerformers` returns `[]` for null/undefined), so a fixture
    // without it is a shape the builder never sees in production.
    performers: [],
  };

  it("renders JSON-LD script with schema.org payload", () => {
    const html = renderToStaticMarkup(<EventJsonLd event={event} />);

    expect(html).toContain("<script");
    expect(html).toContain("application/ld+json");
    expect(html).toContain('id="event-jsonld"');
    expect(html).toContain('"@type": "Event"');
    expect(html).toContain('"name": "Evening Show"');
    expect(html).toContain(
      '"url": "https://tickets.local/events/evening-show"',
    );
    expect(html).toContain('"offers"');
    expect(html).toContain('"organizer"');
  });

  it("applies the enrichment: a posterless org event gets the stub image and an Organization", () => {
    // A posterless, org-owned event straight from the payload: no organizer
    // (core leaves it null), no images.
    const posterless: SeoEvent = {
      ...event,
      images: [],
      organizer: undefined,
    };
    const before = structuredClone(posterless);
    const stub = "https://tickets.local/og/event/evening-show?v=abc123";

    const html = renderToStaticMarkup(
      <EventJsonLd
        event={posterless}
        enrichment={{
          organizer: { name: "Drkmttr", url: "https://tickets.local/orgs/drkmttr" },
          fallbackImageUrl: stub,
        }}
      />,
    );
    const body = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1] ?? "{}";
    const jsonLd = JSON.parse(body) as Record<string, unknown>;

    expect(jsonLd.image).toEqual([stub]);
    expect(jsonLd.organizer).toEqual({
      "@type": "Organization",
      name: "Drkmttr",
      url: "https://tickets.local/orgs/drkmttr",
    });
    // The page renders `event.images[0]` as the poster: the stub must stay
    // out of the object the page holds.
    expect(posterless).toEqual(before);
    expect(posterless.images).toEqual([]);
  });

  it("does not emit JSON-LD for non-indexable events", () => {
    const html = renderToStaticMarkup(
      <EventJsonLd
        event={{
          ...event,
          status: "DRAFT",
        }}
      />,
    );

    expect(html).toBe("");
  });
});
