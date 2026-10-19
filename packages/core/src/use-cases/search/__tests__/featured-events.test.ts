import { describe, expect, it, vi } from "vitest";

import { SearchPortError, err, ok } from "@th/ports/search";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { featuredEvents } from "../featured-events";

// ── Helpers ──────────────────────────────────────────────────────────────────

const eventSuggestion: EventSuggestion = {
  type: "event",
  id: "event_00000000-0000-4000-8000-000000000001",
  eventId: "00000000-0000-4000-8000-000000000001",
  title: "Summer Nights",
  subtitle: "Nashville, TN",
  helper: "Jun 1",
  confidence: 0.9,
  slug: "summer-nights",
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("featuredEvents", () => {
  it("returns mapped events and latency on success", async () => {
    const search = makeSearch(
      ok({ suggestions: [eventSuggestion], latencyMs: 9 }),
    );
    const reportError = vi.fn();

    const result = await featuredEvents(
      { search, reportError },
      { regionCode: "US-TN" },
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: eventSuggestion.eventId,
      title: eventSuggestion.title,
      slug: eventSuggestion.slug,
    });
    expect(result.latencyMs).toBe(9);
  });

  it("requests date ordering (soonest-first) from the search port", async () => {
    const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));

    await featuredEvents({ search }, { regionCode: "US-TN" });

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

      const result = await featuredEvents(
        { search, reportError },
        { regionCode: "US-TN" },
      );

      expect(result).toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "featuredEvents" },
        extra: { regionCode: "US-TN", hasGeo: false },
      });
    });

    it("includes hasGeo=true in the report context when a geo filter is set", async () => {
      const searchError = new SearchPortError("transient", "timeout");
      const search = makeSearch(err(searchError));
      const reportError = vi.fn();

      const result = await featuredEvents(
        { search, reportError },
        { lat: 36.16, lng: -86.78, radiusKm: 25 },
      );

      expect(result).toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "featuredEvents" },
        extra: { regionCode: undefined, hasGeo: true },
      });
    });

    it("still returns the empty fallback when reportError is not wired", async () => {
      const search = makeSearch(
        err(new SearchPortError("transient", "connect ETIMEDOUT")),
      );

      const result = await featuredEvents({ search }, { regionCode: "US-TN" });

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
        featuredEvents({ search, reportError }, { regionCode: "US-TN" }),
      ).resolves.toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 3 }));
      const reportError = vi.fn();

      await featuredEvents({ search, reportError }, { regionCode: "US-TN" });

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  // ── Optional whole-result cache ────────────────────────────────────────
  describe("with a cache", () => {
    /**
     * Minimal cache with the port's contract: failures are not stored, and a
     * failed reload falls back to the last good value when one exists (the
     * adapter reports that itself — see ttl-read-through-cache).
     */
    const mapCache = () => {
      const store = new Map<string, unknown>();
      const getOrLoad = vi.fn(
        async <T,>(key: string, load: () => Promise<T>, fresh = true) => {
          if (fresh && store.has(key)) return store.get(key) as T;
          try {
            const value = await load();
            store.set(key, value);
            return value;
          } catch (e) {
            if (store.has(key)) return store.get(key) as T;
            throw e;
          }
        },
      );
      return {
        getOrLoad,
        clear: () => store.clear(),
        /** Force the next read to reload, as an expired TTL would. */
        expire: () => {
          const inner = getOrLoad.getMockImplementation()!;
          getOrLoad.mockImplementationOnce((key, load) =>
            inner(key, load, false),
          );
        },
      };
    };

    it("serves a repeat of the same input without a second search", async () => {
      const search = makeSearch(
        ok({ suggestions: [eventSuggestion], latencyMs: 4 }),
      );
      const cache = mapCache();

      const first = await featuredEvents(
        { search, cache },
        { regionCode: "US", limit: 12 },
      );
      const second = await featuredEvents(
        { search, cache },
        { regionCode: "US", limit: 12 },
      );

      expect(second).toBe(first);
      expect(search.autocomplete).toHaveBeenCalledTimes(1);
    });

    it("keys on regionCode and limit", async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));
      const cache = mapCache();

      await featuredEvents({ search, cache }, { regionCode: "US", limit: 12 });
      await featuredEvents({ search, cache }, { regionCode: "US", limit: 6 });
      await featuredEvents({ search, cache }, { regionCode: "CA", limit: 12 });
      await featuredEvents({ search, cache }, { limit: 12 });

      expect(search.autocomplete).toHaveBeenCalledTimes(4);
    });

    it('treats "" as no region (same key) but keeps region case distinct', async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));
      const cache = mapCache();

      await featuredEvents({ search, cache }, { regionCode: "", limit: 12 });
      await featuredEvents({ search, cache }, { limit: 12 });
      expect(search.autocomplete).toHaveBeenCalledTimes(1);

      // The index compares region codes exactly: different answers.
      await featuredEvents({ search, cache }, { regionCode: "TN", limit: 12 });
      await featuredEvents({ search, cache }, { regionCode: "tn", limit: 12 });
      expect(search.autocomplete).toHaveBeenCalledTimes(3);
    });

    it("never caches a malformed region code", async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));
      const cache = mapCache();

      await featuredEvents({ search, cache }, { regionCode: "not a region" });
      expect(cache.getOrLoad).not.toHaveBeenCalled();
    });

    it("never caches a geo-filtered request", async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));
      const cache = mapCache();
      const geo = { lat: 36.16, lng: -86.78, radiusKm: 25 };

      await featuredEvents({ search, cache }, geo);
      await featuredEvents({ search, cache }, geo);

      expect(cache.getOrLoad).not.toHaveBeenCalled();
      expect(search.autocomplete).toHaveBeenCalledTimes(2);
    });

    it("does not cache the empty fallback: a failure with nothing to fall back on reports, and the next call searches again", async () => {
      const searchError = new SearchPortError("dependency_failed", "db down");
      const search = {
        autocomplete: vi
          .fn<MultiSearchQueryPort["autocomplete"]>()
          .mockResolvedValueOnce(err(searchError))
          .mockResolvedValueOnce(
            ok({ suggestions: [eventSuggestion], latencyMs: 2 }),
          ),
      };
      const cache = mapCache();
      const reportError = vi.fn();

      await expect(
        featuredEvents({ search, cache, reportError }, { regionCode: "US" }),
      ).resolves.toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "featuredEvents" },
        extra: { regionCode: "US", hasGeo: false },
      });

      const next = await featuredEvents(
        { search, cache, reportError },
        { regionCode: "US" },
      );
      expect(next.events).toHaveLength(1);
      expect(search.autocomplete).toHaveBeenCalledTimes(2);
    });

    it("lets the cache serve its last good answer when a reload fails", async () => {
      const search = {
        autocomplete: vi
          .fn<MultiSearchQueryPort["autocomplete"]>()
          .mockResolvedValueOnce(
            ok({ suggestions: [eventSuggestion], latencyMs: 2 }),
          )
          .mockResolvedValueOnce(
            err(new SearchPortError("dependency_failed", "db down")),
          ),
      };
      const cache = mapCache();
      const reportError = vi.fn();

      const good = await featuredEvents(
        { search, cache, reportError },
        { regionCode: "US" },
      );
      cache.expire();
      const afterFailure = await featuredEvents(
        { search, cache, reportError },
        { regionCode: "US" },
      );

      expect(search.autocomplete).toHaveBeenCalledTimes(2);
      expect(afterFailure).toBe(good);
      // The fallback was the cache's; the use case's empty-list swallow (and
      // its report) did not run.
      expect(reportError).not.toHaveBeenCalled();
    });
  });
});
