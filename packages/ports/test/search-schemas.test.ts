import { describe, expect, it, expectTypeOf } from "vitest";

import {
  searchSuggestionSchema,
  searchQueryInputSchema,
  searchDocumentSchema,
} from "../src/search/schemas";
import type {
  SearchDocument,
  SearchQueryInput,
  SearchSuggestion,
} from "../src/search";

const buildDocument = (
  overrides: Partial<SearchDocument> = {},
): SearchDocument => ({
  eventId: "evt_123",
  slug: "test-event",
  orgId: "org_123",
  ownerType: "ORG",
  ownerHumanId: null,
  title: "Test Event",
  artists: [],
  tags: [],
  venueId: null,
  venueName: null,
  addressText: null,
  city: null,
  regionCode: null,
  countryCode: null,
  lat: null,
  lng: null,
  startsAt: new Date(),
  endsAt: new Date(),
  status: "PUBLISHED",
  popularityScore: 10,
  recencyScore: Date.now(),
  summary: null,
  embeddingVersion: "emb-v1",
  embeddingVector: null,
  ticketAvailability: { status: "AVAILABLE" },
  ...overrides,
});

describe("search schemas", () => {
  it("allows suggestions without optional metadata", () => {
    const minimalSuggestion = {
      eventId: "evt_123",
      title: "Pizza Party",
      confidence: 0.7,
    } satisfies Partial<SearchSuggestion>;

    expect(() => searchSuggestionSchema.parse(minimalSuggestion)).not.toThrow();
  });

  it("requires non-empty query strings for search", () => {
    expect(() => searchQueryInputSchema.parse({ limit: 5 })).toThrow();
    expect(() =>
      searchQueryInputSchema.parse({ query: "live music" }),
    ).not.toThrow();
  });

  it("enforces maximum embedding vector length", () => {
    const valid = buildDocument({
      embeddingVector: Array.from({ length: 4 }, () => 0.1),
    });
    expect(() => searchDocumentSchema.parse(valid)).not.toThrow();

    const tooLarge = buildDocument({
      embeddingVector: Array.from({ length: 1537 }, () => 0.1),
    });
    expect(() => searchDocumentSchema.parse(tooLarge)).toThrow();
  });
});

describe("search types", () => {
  it("marks slug as optional on suggestions", () => {
    expectTypeOf<SearchSuggestion>().toMatchTypeOf<{ slug?: string | null }>();
  });

  it("requires query on search input", () => {
    expectTypeOf<SearchQueryInput>().toMatchTypeOf<{ query: string }>();
  });
});
