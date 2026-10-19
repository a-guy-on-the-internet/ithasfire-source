import { describe, expect, it, vi } from "vitest";

import { SearchPortError, err, ok } from "@th/ports/search";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { tieredPopularEvents } from "../tiered-popular-events";

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

const input = { lat: 36.16, lng: -86.78 };

describe("tieredPopularEvents", () => {
  it("returns mapped events from the first satisfied tier", async () => {
    const search = {
      autocomplete: vi.fn(async () =>
        ok({
          suggestions: Array.from({ length: 6 }, () => eventSuggestion),
          latencyMs: 5,
        }),
      ),
    } satisfies MultiSearchQueryPort;

    const result = await tieredPopularEvents({ search }, input);

    expect(result.tier).toBe("local");
    expect(result.events.length).toBe(6);
  });

  it("requests date ordering (soonest-first) from the search port on every tier", async () => {
    const search = {
      // Return an empty set so it walks through all tiers.
      autocomplete: vi.fn(async () => ok({ suggestions: [], latencyMs: 1 })),
    } satisfies MultiSearchQueryPort;

    await tieredPopularEvents({ search }, { ...input, regionCode: "US-TN" });

    expect(search.autocomplete).toHaveBeenCalled();
    for (const call of search.autocomplete.mock.calls) {
      expect(call[0].sort).toBe("date");
    }
  });

  describe("swallowed tier failure reporting", () => {
    // A failing tier is swallowed (next tier, or an empty section), and
    // logger.warn is not captured, so the reporter is the only way a backend
    // or schema-drift failure reaches Sentry.
    const searchError = new SearchPortError(
      "dependency_failed",
      'column d.timezone does not exist',
    );
    const failLocalThenServe = () => {
      let call = 0;
      return {
        autocomplete: vi.fn(async () =>
          call++ === 0
            ? err(searchError)
            : ok({
                suggestions: Array.from({ length: 6 }, () => eventSuggestion),
                latencyMs: 1,
              }),
        ),
      } satisfies MultiSearchQueryPort;
    };

    it("reports the failing tier's error and falls through to the next tier", async () => {
      const reportError = vi.fn();
      const result = await tieredPopularEvents(
        { search: failLocalThenServe(), reportError },
        input,
      );

      expect(result.tier).toBe("regional");
      expect(result.events).toHaveLength(6);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        searchError,
        expect.objectContaining({
          tags: { useCase: "tieredPopularEvents", tier: "local" },
        }),
      );
    });

    it("reports every tier when all fail and still returns the empty section", async () => {
      const reportError = vi.fn();
      const search = {
        autocomplete: vi.fn(async () => err(searchError)),
      } satisfies MultiSearchQueryPort;

      const result = await tieredPopularEvents({ search, reportError }, input);

      expect(result.events).toEqual([]);
      expect(result.tier).toBe("global");
      expect(reportError).toHaveBeenCalledTimes(4);
    });

    it("a throwing reporter does not change the result", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const result = await tieredPopularEvents(
        { search: failLocalThenServe(), reportError },
        input,
      );

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(result.tier).toBe("regional");
      expect(result.events).toHaveLength(6);
    });
  });
});
