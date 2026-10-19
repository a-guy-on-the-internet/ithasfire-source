import { describe, expect, it, vi } from "vitest";

import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";

import { fillLocationTaxRate } from "../fill-location-tax-rate";
import {
  reindexEventsAtTaxLocation,
  runReindexEventsAtTaxLocation,
} from "../reindex-events-at-tax-location";
import {
  TAX_RATE_FILL_JOB,
  TAX_RATE_FILL_SLOT_MS,
  createTaxRateFillQueue,
} from "../tax-rate-fill-queue";

/**
 * The background half of "never 0% for an unknown rate" (owner ruling
 * 2026-10-06): a listing queues a fill for a venue with no cached rate; the
 * job looks it up, fills the cache by compare-and-set, and re-indexes the
 * venue's unstamped upcoming events so their cards get an all-in total.
 */

const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const SAVED_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-06T12:00:00.000Z");

function makeRepos(opts: { cachedBps?: number | null } = {}) {
  const place = {
    id: PLACE_ID,
    addressLine1: "600 N 1st Ave",
    city: "Minneapolis",
    region: "MN",
    postalCode: "55403",
    countryCode: "US",
    admissionTaxRateBps: opts.cachedBps ?? null,
    taxRateSource: opts.cachedBps != null ? "ziptax" : null,
  };
  const repos = {
    events: {
      listUnstampedUpcomingIdsAtTaxLocation: vi.fn(async () => ["e-1", "e-2"]),
    },
    places: {
      getById: vi.fn(async () => ({ ...place })),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    savedLocations: { getById: vi.fn(async () => null) },
    searchReindexPending: {
      mark: vi.fn(async () => undefined),
      getMany: vi.fn(async () => []),
      clearIfUnchanged: vi.fn(async () => undefined),
    },
    tx: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
        fn(repos),
    ),
  };
  return repos;
}

describe("reindexEventsAtTaxLocation — sibling reindex after a cache fill", () => {
  it("marks the venue's unstamped upcoming events (plus any named) for the search drain", async () => {
    const repos = makeRepos();
    const result = await runReindexEventsAtTaxLocation(
      { repos: repos as never },
      { kind: "place", placeId: PLACE_ID },
      { now: NOW, useCase: "test", alsoEventIds: ["e-0"] },
    );

    expect(result.eventIds).toEqual(["e-0", "e-1", "e-2"]);
    expect(repos.events.listUnstampedUpcomingIdsAtTaxLocation).toHaveBeenCalledWith({
      target: { kind: "place", placeId: PLACE_ID },
      now: NOW,
      limit: 200,
    });
    expect(repos.searchReindexPending.mark).toHaveBeenCalledWith(
      [
        { entityType: "event", entityId: "e-0" },
        { entityType: "event", entityId: "e-1" },
        { entityType: "event", entityId: "e-2" },
      ],
      NOW,
    );
  });

  it("with a search port, re-indexes each event at once", async () => {
    const repos = makeRepos();
    const search = {
      upsertDocuments: vi.fn(async () => undefined),
      deleteDocuments: vi.fn(async () => undefined),
    };
    // The single-event index pass itself is buildSearchIndex's business; here
    // it only has to be attempted per event without failing the helper.
    const reportError = vi.fn();
    await runReindexEventsAtTaxLocation(
      { repos: repos as never, search: search as never, reportError },
      { kind: "saved-location", savedLocationId: SAVED_ID },
      { now: NOW, useCase: "test" },
    );
    expect(repos.events.listUnstampedUpcomingIdsAtTaxLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "saved-location", savedLocationId: SAVED_ID },
      }),
    );
    // Snapshots the pending marks per event before indexing it.
    expect(repos.searchReindexPending.getMany).toHaveBeenCalledTimes(2);
  });

  it("a failing reindex is REPORTED, never thrown (fire-and-forget)", async () => {
    const repos = makeRepos();
    repos.events.listUnstampedUpcomingIdsAtTaxLocation.mockRejectedValueOnce(
      new Error("db down"),
    );
    const reportError = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };

    expect(() =>
      reindexEventsAtTaxLocation(
        { repos: repos as never, reportError, logger: logger as never },
        { kind: "place", placeId: PLACE_ID },
        { now: NOW, useCase: "test" },
      ),
    ).not.toThrow();

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "test", op: "reindexEventsAtTaxLocation" },
      extra: { target: { kind: "place", id: PLACE_ID } },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "tax.location_events_reindex_failed",
      expect.anything(),
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const repos = makeRepos();
    repos.tx.mockRejectedValueOnce(new Error("mark failed"));
    await expect(
      runReindexEventsAtTaxLocation(
        {
          repos: repos as never,
          reportError: () => {
            throw new Error("reporter down");
          },
        },
        { kind: "place", placeId: PLACE_ID },
        { now: NOW, useCase: "test" },
      ),
    ).resolves.toEqual({ eventIds: ["e-1", "e-2"] });
  });
});

describe("createTaxRateFillQueue — one Cloud Tasks request per venue per slot", () => {
  it("schedules the fill job once per venue, deduped in-process and by key", async () => {
    const scheduleOnce = vi.fn(async () => ({ status: "scheduled" as const }));
    const queue = createTaxRateFillQueue({
      scheduler: { scheduleOnce },
      clock: { now: () => NOW },
    });
    const place = { kind: "place" as const, placeId: PLACE_ID };
    const saved = {
      kind: "saved-location" as const,
      savedLocationId: SAVED_ID,
    };

    await queue.request([place, saved, place]);
    await queue.request([place]); // same slot, same process: no call

    expect(scheduleOnce).toHaveBeenCalledTimes(2);
    const slot = Math.floor(NOW.getTime() / TAX_RATE_FILL_SLOT_MS);
    expect(scheduleOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: TAX_RATE_FILL_JOB,
        payload: { target: place },
        dedupeKey: `tax-fill-place-${PLACE_ID}-${slot}`,
      }),
    );
    expect(scheduleOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { target: saved },
        dedupeKey: `tax-fill-saved-${SAVED_ID}-${slot}`,
      }),
    );
  });

  it("a failed schedule rejects and is NOT remembered (the next listing asks again)", async () => {
    const scheduleOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("cloud_tasks_create_failed: 503"))
      .mockResolvedValueOnce({ status: "scheduled" });
    const queue = createTaxRateFillQueue({
      scheduler: { scheduleOnce },
      clock: { now: () => NOW },
    });
    const place = { kind: "place" as const, placeId: PLACE_ID };

    await expect(queue.request([place])).rejects.toThrow("503");
    await queue.request([place]);
    expect(scheduleOnce).toHaveBeenCalledTimes(2);
  });
});

describe("fillLocationTaxRate — the background fill job", () => {
  const clock = { now: () => NOW };
  const input = { target: { kind: "place", placeId: PLACE_ID } };

  it("looks the rate up, fills the cache by compare-and-set, and marks the venue's events", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 903,
      source: "ziptax",
    }));

    const result = await fillLocationTaxRate(
      { repos: repos as never, taxRateLookup: { lookupByPostalCode }, clock },
      input,
    );

    expect(result).toEqual({ status: "filled", reindexedEventCount: 2 });
    expect(repos.places.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PLACE_ID,
        expectedPostalCode: "55403",
        expectedCountryCode: "US",
        admissionTaxRateBps: 903,
        taxRateSource: "ziptax",
      }),
    );
    expect(repos.searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });

  it("a FAILED lookup throws (so Cloud Tasks retries) and writes nothing", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError("Ziptax rCode 108", { providerCode: 108 });
    });

    await expect(
      fillLocationTaxRate(
        { repos: repos as never, taxRateLookup: { lookupByPostalCode }, clock },
        input,
      ),
    ).rejects.toMatchObject({ providerCode: 108 });
    expect(repos.places.fillTaxRateIfUnset).not.toHaveBeenCalled();
  });

  it("an already-cached venue makes no provider call", async () => {
    const repos = makeRepos({ cachedBps: 903 });
    const lookupByPostalCode = vi.fn();

    const result = await fillLocationTaxRate(
      { repos: repos as never, taxRateLookup: { lookupByPostalCode }, clock },
      input,
    );
    expect(result.status).toBe("already_cached");
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("an already-cached venue still re-indexes its unpriced upcoming events (the event page cached the rate first)", async () => {
    const repos = makeRepos({ cachedBps: 825 });
    const lookupByPostalCode = vi.fn();

    const result = await fillLocationTaxRate(
      { repos: repos as never, taxRateLookup: { lookupByPostalCode }, clock },
      input,
    );

    expect(result).toEqual({ status: "already_cached", reindexedEventCount: 2 });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(repos.places.fillTaxRateIfUnset).not.toHaveBeenCalled();
    expect(repos.events.listUnstampedUpcomingIdsAtTaxLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "place", placeId: PLACE_ID },
        now: NOW,
      }),
    );
    expect(repos.searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });

  it("a provider that has no rate for the place → no_rate, nothing written", async () => {
    const repos = makeRepos();
    const result = await fillLocationTaxRate(
      {
        repos: repos as never,
        taxRateLookup: { lookupByPostalCode: vi.fn(async () => null) },
        clock,
      },
      input,
    );
    expect(result.status).toBe("no_rate");
    expect(repos.places.fillTaxRateIfUnset).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload", async () => {
    await expect(
      fillLocationTaxRate(
        { repos: makeRepos() as never, taxRateLookup: null, clock },
        { target: { kind: "place", placeId: "not-a-uuid" } },
      ),
    ).rejects.toBeTruthy();
  });
});
