import { describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos } from "@th/ports/repos";
import { SearchPortError, err, ok } from "@th/ports/search";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";
import { createTestLogger } from "@th/test-utils";

import {
  searchPublishedEvents,
  type SearchPublishedEventsDeps,
} from "../search-published-events";

const baseEvent: EventRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "11111111-1111-4111-8111-111111111111",
  humanId: null,
  title: "Summer Nights",
  status: "PUBLISHED",
  attendanceMode: "TICKETED",
  stewardship: "OWNED",
  timezone: "America/Chicago",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-06-01T20:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: "Pier 27 — San Francisco, CA",
  lat: 37.804,
  lng: -122.401,
  slug: "summer-nights",
  shortId: "summernights",
  regionCode: "ca",
  publishedAt: new Date("2025-04-01T12:00:00.000Z"),
  agreementPrimaryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

const makeDeps = (
  events: EventRecord[] = [baseEvent],
  overrides: Partial<SearchPublishedEventsDeps> = {},
) => {
  const repos = {
    events: {
      searchPublished: vi.fn(async () => events),
    },
  } as unknown as Repos;

  return {
    repos,
    logger: overrides.logger ?? createTestLogger(),
  } satisfies SearchPublishedEventsDeps;
};

describe("searchPublishedEvents", () => {
  it("returns formatted suggestions from the repo", async () => {
    const deps = makeDeps();

    const result = await searchPublishedEvents(deps, {
      query: "Summer",
      limit: 5,
    });

    expect(deps.repos.events.searchPublished).toHaveBeenCalledWith({
      query: "Summer",
      limit: 5,
      startsAfter: expect.any(Date),
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      eventId: baseEvent.id,
      title: baseEvent.title,
      subtitle: expect.stringContaining("San Francisco"),
      helper: "Jun 1",
      slug: baseEvent.slug,
    });
  });

  // Regression (prod, 2026-10-13): the helper had no `timeZone`, so on a UTC
  // server a 7pm Chicago show printed the next day.
  it.each([
    {
      name: "7pm CDT Monday",
      startsAt: "2026-10-13T00:00:00.000Z",
      timezone: "America/Chicago",
      helper: "Oct 12",
    },
    {
      name: "10pm CDT Tuesday",
      startsAt: "2026-10-14T03:00:00.000Z",
      timezone: "America/Chicago",
      helper: "Oct 13",
    },
    {
      name: "2pm CDT",
      startsAt: "2026-10-13T19:00:00.000Z",
      timezone: "America/Chicago",
      helper: "Oct 13",
    },
    {
      name: "7pm CST in winter",
      startsAt: "2026-12-08T01:00:00.000Z",
      timezone: "America/Chicago",
      helper: "Dec 7",
    },
    {
      name: "9pm PDT in Los Angeles",
      startsAt: "2026-10-13T04:00:00.000Z",
      timezone: "America/Los_Angeles",
      helper: "Oct 12",
    },
  ])(
    "formats the helper date in the event's zone: $name",
    async ({ startsAt, timezone, helper }) => {
      const deps = makeDeps([
        { ...baseEvent, startsAt: new Date(startsAt), timezone },
      ]);

      const result = await searchPublishedEvents(deps, {
        query: "Summer",
        limit: 5,
      });

      expect(result.suggestions[0]?.helper).toBe(helper);
    },
  );

  it("logs the query metadata", async () => {
    const logger = createTestLogger();
    const deps = makeDeps([], { logger });

    await searchPublishedEvents(deps, { query: "Gathering" });

    // Falls back to Postgres when Meilisearch is not configured
    expect(logger.info).toHaveBeenCalledWith(
      "events.search_published_postgres",
      expect.objectContaining({
        queryLength: expect.any(Number),
        limit: expect.any(Number),
        resultCount: 0,
      }),
    );
  });

  it("validates the incoming query", async () => {
    const deps = makeDeps();

    await expect(
      searchPublishedEvents(deps, { query: " " }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  describe("meilisearch failure reporting", () => {
    const makeSearch = (
      result: Awaited<ReturnType<MultiSearchQueryPort["autocomplete"]>>,
    ) =>
      ({
        autocomplete: vi.fn(async () => result),
      }) satisfies MultiSearchQueryPort;

    const meiliSuggestion: EventSuggestion = {
      type: "event",
      id: `event_${baseEvent.id}`,
      eventId: baseEvent.id,
      title: baseEvent.title,
      subtitle: "Nashville, TN",
      helper: "Jun 1",
      confidence: 0.9,
      slug: baseEvent.slug,
      startsAt: baseEvent.startsAt,
      imageUrl: null,
      lowestPriceCents: null,
      lowestBuyerTotalCents: null,
      currency: null,
      paidTierCount: 0,
      hasFreeTier: false,
    };

    it("reports the swallowed Meilisearch failure and falls back to Postgres", async () => {
      // The Postgres fallback keeps the request working, so without the
      // reporter this backend failure would be invisible to operators.
      const searchError = new SearchPortError(
        "dependency_failed",
        "Meilisearch down",
      );
      const search = makeSearch(err(searchError));
      const reportError = vi.fn();
      const deps = { ...makeDeps([baseEvent]), search, reportError };

      const result = await searchPublishedEvents(deps, { query: "Summer" });

      // Fallback result still comes back from Postgres
      expect(deps.repos.events.searchPublished).toHaveBeenCalledTimes(1);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({ eventId: baseEvent.id });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "searchPublishedEvents" },
        extra: { fallback: "postgres", queryLength: "Summer".length },
      });
    });

    it("still falls back to Postgres when reportError is not wired", async () => {
      const search = makeSearch(
        err(new SearchPortError("transient", "connect ETIMEDOUT")),
      );
      const deps = { ...makeDeps([baseEvent]), search };

      const result = await searchPublishedEvents(deps, { query: "Summer" });

      expect(deps.repos.events.searchPublished).toHaveBeenCalledTimes(1);
      expect(result.suggestions).toHaveLength(1);
    });

    it("a throwing reporter never breaks the Postgres fallback", async () => {
      const search = makeSearch(
        err(new SearchPortError("dependency_failed", "Meilisearch down")),
      );
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const deps = { ...makeDeps([baseEvent]), search, reportError };

      const result = await searchPublishedEvents(deps, { query: "Summer" });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(deps.repos.events.searchPublished).toHaveBeenCalledTimes(1);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({ eventId: baseEvent.id });
    });

    it("does not call reportError (or Postgres) when Meilisearch succeeds", async () => {
      const search = makeSearch(
        ok({ suggestions: [meiliSuggestion], latencyMs: 8 }),
      );
      const reportError = vi.fn();
      const deps = { ...makeDeps([baseEvent]), search, reportError };

      const result = await searchPublishedEvents(deps, { query: "Summer" });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        eventId: baseEvent.id,
        title: baseEvent.title,
      });
      expect(reportError).not.toHaveBeenCalled();
      expect(deps.repos.events.searchPublished).not.toHaveBeenCalled();
    });
  });
});
