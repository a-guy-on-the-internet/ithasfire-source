import { describe, expect, it, vi } from "vitest";

import { SearchPortError, err, ok } from "@th/ports/search";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { nearbyEvents } from "../nearby-events";

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

const input = { lat: 36.16, lng: -86.78 };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("nearbyEvents", () => {
  it("returns mapped events and latency on success", async () => {
    const search = makeSearch(
      ok({ suggestions: [eventSuggestion], latencyMs: 12 }),
    );
    const reportError = vi.fn();

    const result = await nearbyEvents({ search, reportError }, input);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: eventSuggestion.eventId,
      title: eventSuggestion.title,
      slug: eventSuggestion.slug,
    });
    expect(result.latencyMs).toBe(12);
  });

  // The zone `helper` was formatted in survives the output parse, so the
  // card mapper can stamp the time in it; an old document has none → null.
  it("carries the indexed timezone, null when the document has none", async () => {
    const search = makeSearch(
      ok({
        suggestions: [
          { ...eventSuggestion, timezone: "America/Los_Angeles" },
          { ...eventSuggestion, id: "event_old" },
        ],
        latencyMs: 1,
      }),
    );

    const result = await nearbyEvents({ search }, input);

    expect(result.events.map((e) => e.timezone)).toEqual([
      "America/Los_Angeles",
      null,
    ]);
  });

  it("requests distance ordering (nearest-first) from the search port", async () => {
    const search = makeSearch(ok({ suggestions: [], latencyMs: 1 }));

    await nearbyEvents({ search }, input);

    expect(search.autocomplete.mock.calls[0]![0].sort).toBe("distance");
  });

  describe("swallowed search-backend failure reporting", () => {
    it("reports the underlying error and returns the empty fallback", async () => {
      // The empty-list fallback keeps the request working, so without the
      // reporter this backend failure would be invisible to operators
      // (the 2026-06 Neon outage went unnoticed for 4 days this way).
      const searchError = new SearchPortError(
        "dependency_failed",
        "Meilisearch down",
      );
      const search = makeSearch(err(searchError));
      const reportError = vi.fn();

      const result = await nearbyEvents({ search, reportError }, input);

      expect(result).toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(searchError, {
        tags: { useCase: "nearbyEvents" },
        // radiusKm falls back to the schema default (50) when not provided.
        extra: { lat: input.lat, lng: input.lng, radiusKm: 50 },
      });
    });

    it("still returns the empty fallback when reportError is not wired", async () => {
      const search = makeSearch(
        err(new SearchPortError("transient", "connect ETIMEDOUT")),
      );

      const result = await nearbyEvents({ search }, input);

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
        nearbyEvents({ search, reportError }, input),
      ).resolves.toEqual({ events: [], latencyMs: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const search = makeSearch(ok({ suggestions: [], latencyMs: 3 }));
      const reportError = vi.fn();

      await nearbyEvents({ search, reportError }, input);

      expect(reportError).not.toHaveBeenCalled();
    });
  });
});
