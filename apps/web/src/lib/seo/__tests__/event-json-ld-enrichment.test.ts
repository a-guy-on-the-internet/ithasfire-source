import { describe, expect, it } from "vitest";

import type { SeoEvent } from "@th/types/seo/types";

import {
  applyEventJsonLdEnrichment,
  type EventJsonLdEnrichment,
} from "../event-json-ld-enrichment";

const event = (overrides: Partial<SeoEvent> = {}): SeoEvent => ({
  id: "e1",
  slug: "a/us/tn/show--x",
  url: "https://ithasfire.com/events/a/us/tn/show--x",
  name: "Show",
  startsAt: new Date("2026-11-01T00:00:00.000Z"),
  status: "PUBLISHED",
  images: [],
  performers: [],
  ...overrides,
});

const ENRICHMENT: EventJsonLdEnrichment = {
  organizer: { name: "Drkmttr", url: "https://ithasfire.com/orgs/drkmttr" },
  fallbackImageUrl: "https://ithasfire.com/og/event/a/us/tn/show--x?v=abc",
};

describe("applyEventJsonLdEnrichment", () => {
  it("adds the organizer and the stub image to a COPY, leaving the page's event alone", () => {
    const original = event();
    const enriched = applyEventJsonLdEnrichment(original, ENRICHMENT);

    expect(enriched.organizer).toEqual(ENRICHMENT.organizer);
    expect(enriched.images).toEqual([ENRICHMENT.fallbackImageUrl]);
    // The page renders `images[0]` as the poster: the stub must never join it.
    expect(original.images).toEqual([]);
    expect(original.organizer).toBeUndefined();
  });

  it("keeps a real poster over the stub", () => {
    const enriched = applyEventJsonLdEnrichment(
      event({ images: ["https://cdn.test/p.jpg"] }),
      ENRICHMENT,
    );
    expect(enriched.images).toEqual(["https://cdn.test/p.jpg"]);
  });

  it("keeps an organizer the payload already carries", () => {
    const own = { name: "Payload Org", url: "https://example.test" };
    expect(
      applyEventJsonLdEnrichment(event({ organizer: own }), ENRICHMENT)
        .organizer,
    ).toBe(own);
  });

  it("adds nothing for an ownerless listing with a poster", () => {
    const original = event({ images: ["https://cdn.test/p.jpg"] });
    const enriched = applyEventJsonLdEnrichment(original, {
      organizer: null,
      fallbackImageUrl: null,
    });
    expect(enriched).toBe(original);
    expect(enriched).not.toHaveProperty("organizer");
  });

  it("is a no-op without an enrichment", () => {
    const original = event();
    expect(applyEventJsonLdEnrichment(original, undefined)).toBe(original);
  });
});
