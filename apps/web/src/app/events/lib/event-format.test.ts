import { describe, expect, it } from "vitest";

import type { EventStatus } from "@th/types";
import type { SeoEvent, SeoPricing } from "@th/types/seo/types";

import {
  buildAddressLines,
  buildPriceLabel,
  buildScheduleLabel,
  formatAvailabilityLabel,
  formatEventDateTime,
} from "./event-format";

const sampleEvent = (overrides: Partial<SeoEvent> = {}): SeoEvent => ({
  id: "evt-123",
  slug: "sample-event",
  url: "https://example.com/events/sample-event",
  name: "Sample Event",
  description: "Description",
  startsAt: new Date("2024-06-01T18:00:00Z"),
  endsAt: new Date("2024-06-01T21:00:00Z"),
  status: "PUBLISHED" satisfies EventStatus,
  updatedAt: null,
  ticketingUrl: "https://tickets.example.com/sample",
  images: [],
  location: {
    name: "Venue",
    addressLine1: "123 Main St",
    addressLine2: undefined,
    city: "Brooklyn",
    region: "NY",
    postalCode: "11211",
    countryCode: "US",
  },
  organizer: {
    name: "Org",
    url: "https://org.example.com",
  },
  pricing: {
    currency: "USD",
    minPriceCents: 1000,
    maxPriceCents: 2500,
    availability: "in_stock",
    validFrom: null,
  },
  performers: [],
  ...overrides,
});

const pricing = (overrides: Partial<SeoPricing> = {}): SeoPricing => ({
  currency: "USD",
  availability: "in_stock",
  validFrom: null,
  ...overrides,
});

describe("event-format helpers", () => {
  it("formats schedule ranges when an end time exists", () => {
    const event = sampleEvent();
    expect(buildScheduleLabel(event)).toEqual(
      `${formatEventDateTime(event.startsAt)} – ${formatEventDateTime(event.endsAt!)}`,
    );
  });

  it("falls back to a single start time when there is no end", () => {
    const event = sampleEvent({ endsAt: null });
    expect(buildScheduleLabel(event)).toEqual(
      formatEventDateTime(event.startsAt),
    );
  });

  it("builds price labels for equal min/max", () => {
    expect(
      buildPriceLabel(
        pricing({
          minPriceCents: 5000,
          maxPriceCents: 5000,
        }),
      ),
    ).toBe("$50");
  });

  it("builds price ranges when both ends differ", () => {
    expect(
      buildPriceLabel(
        pricing({
          minPriceCents: 2500,
          maxPriceCents: 7500,
        }),
      ),
    ).toBe("$25 – $75");
  });

  it("prefers buyer-total pricing when present", () => {
    expect(
      buildPriceLabel(
        pricing({
          minPriceCents: 2500,
          maxPriceCents: 7500,
          minBuyerTotalCents: 3375,
          maxBuyerTotalCents: 8625,
        }),
      ),
    ).toBe("$33.75 – $86.25");
  });

  it("handles address formatting with blank values", () => {
    const lines = buildAddressLines(
      sampleEvent({
        location: {
          name: "",
          addressLine1: "456 Side St",
          city: "Austin",
          region: "TX",
          postalCode: undefined,
          countryCode: "US",
        },
      }).location,
    );
    expect(lines).toEqual(["456 Side St", "Austin, TX", "US"]);
  });

  it("humanizes availability labels", () => {
    expect(formatAvailabilityLabel(pricing({ availability: "sold_out" }))).toBe(
      "sold out",
    );
  });
});
