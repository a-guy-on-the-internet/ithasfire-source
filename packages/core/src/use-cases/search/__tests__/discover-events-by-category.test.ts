import { describe, expect, it, vi } from "vitest";

import { SearchPortError, err, ok } from "@th/ports/search";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import {
  discoverEventsByCategory,
  type DiscoverEventsByCategoryDeps,
} from "../discover-events-by-category";

// ── Helpers ──────────────────────────────────────────────────────────────────

const eventSuggestion: EventSuggestion = {
  type: "event",
  id: "event_00000000-0000-4000-8000-000000000001",
  eventId: "00000000-0000-4000-8000-000000000001",
  title: "Open Mic Night",
  subtitle: "Nashville, TN",
  helper: "Jun 1",
  confidence: 0.9,
  slug: "open-mic-night",
  startsAt: new Date("2026-08-01T20:00:00.000Z"),
  imageUrl: null,
  lowestPriceCents: null,
  lowestBuyerTotalCents: null,
  currency: null,
  paidTierCount: 0,
  hasFreeTier: false,
};

function makeSearch(
  result: Awaited<ReturnType<MultiSearchQueryPort["autocomplete"]>>,
) {
  return {
    autocomplete: vi.fn(async () => result),
  } satisfies MultiSearchQueryPort;
}

const input = { categorySlug: "open-mic" };

const NOW = new Date("2026-10-11T12:00:00.000Z");

/**
 * The category read that gates the search. `category` is what `getBySlug`
 * answers: an active "open-mic" by default, `null` for a slug nobody has.
 */
function makeRepos(category: { active: boolean } | null = { active: true }) {
  const getBySlug = vi.fn(async (slug: string) =>
    category
      ? {
          id: "00000000-0000-4000-8000-0000000000c1",
          slug,
          name: "Open Mic",
          active: category.active,
          sortOrder: 1,
          seoType: "MusicEvent",
          createdAt: NOW,
          updatedAt: NOW,
        }
      : null,
  );
  return {
    categories: { getBySlug },
  } as unknown as DiscoverEventsByCategoryDeps["repos"] & {
    categories: { getBySlug: typeof getBySlug };
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("discoverEventsByCategory", () => {
  it("returns mapped events and latency on success", async () => {
    const search = makeSearch(
      ok({ suggestions: [eventSuggestion], latencyMs: 7 }),
    );
    const reportError = vi.fn();

    const result = await discoverEventsByCategory(
      { search, repos: makeRepos(), reportError },
      input,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: eventSuggestion.eventId,
      title: eventSuggestion.title,
      slug: eventSuggestion.slug,
    });
    expect(result.latencyMs).toBe(7);
  });

  it("requests date ordering (soonest-first) from the search port", async () => {
    const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));

    await discoverEventsByCategory({ search, repos: makeRepos() }, input);

    expect(search.autocomplete.mock.calls[0]![0].sort).toBe("date");
  });

  describe("swallowed search-backend failure reporting", () => {
    it("reports the underlying error and returns the empty fallback", async () => {
      // The empty-list fallback keeps the request working, so without the
      // reporter this backend failure would be invisible to operators.
      const searchError = new SearchPortError(
        "dependency_failed",
        "Meilisearch down",
      );
      const search = makeSearch(err(searchError));
      const reportError = vi.fn();

      const result = await discoverEventsByCategory(
        { search, repos: makeRepos(), reportError },
        input,
      );

      expect(result).toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "discoverEventsByCategory" },
        extra: { categorySlug: "open-mic", hasGeo: false },
      });
    });

    it("still returns the empty fallback when reportError is not wired", async () => {
      const search = makeSearch(
        err(new SearchPortError("transient", "connect ETIMEDOUT")),
      );

      const result = await discoverEventsByCategory({ search, repos: makeRepos() }, input);

      expect(result).toEqual({ events: [], latencyMs: 0 });
    });

    it("a throwing reporter never breaks the empty fallback", async () => {
      const search = makeSearch(
        err(new SearchPortError("dependency_failed", "Meilisearch down")),
      );
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });

      await expect(
        discoverEventsByCategory({ search, repos: makeRepos(), reportError }, input),
      ).resolves.toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 3 }));
      const reportError = vi.fn();

      await discoverEventsByCategory({ search, repos: makeRepos(), reportError }, input);

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  // `Category.active` is read here, not at index time: the slug tag stays on
  // the event's search document whatever `active` is, so this gate is the only
  // thing that takes a deactivated category's events out of category browse.
  describe("category gate", () => {
    it("refuses an INACTIVE category with CATEGORY_NOT_FOUND and never searches", async () => {
      const search = makeSearch(
        ok({ suggestions: [eventSuggestion], latencyMs: 7 }),
      );
      const reportError = vi.fn();

      await expect(
        discoverEventsByCategory(
          { search, repos: makeRepos({ active: false }), reportError },
          input,
        ),
      ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
      expect(search.autocomplete).not.toHaveBeenCalled();
      // A thrown refusal, not a swallowed failure: nothing to report.
      expect(reportError).not.toHaveBeenCalled();
    });

    it("refuses a MISSING category with CATEGORY_NOT_FOUND and never searches", async () => {
      const search = makeSearch(
        ok({ suggestions: [eventSuggestion], latencyMs: 7 }),
      );

      await expect(
        discoverEventsByCategory({ search, repos: makeRepos(null) }, input),
      ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
      expect(search.autocomplete).not.toHaveBeenCalled();
    });

    it("looks the category up by the requested slug, then filters on it for an ACTIVE one", async () => {
      const search = makeSearch(
        ok({ suggestions: [eventSuggestion], latencyMs: 7 }),
      );
      const repos = makeRepos({ active: true });

      const result = await discoverEventsByCategory({ search, repos }, input);

      expect(repos.categories.getBySlug).toHaveBeenCalledWith("open-mic");
      expect(search.autocomplete.mock.calls[0]![0].filters?.tags).toEqual([
        "open-mic",
      ]);
      expect(result.events).toHaveLength(1);
    });
  });
});
