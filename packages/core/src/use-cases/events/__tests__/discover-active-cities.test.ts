import { describe, expect, it, vi } from "vitest";

import type { ActiveCityRecord, Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";

import {
  discoverActiveCities,
  type DiscoverActiveCitiesDeps,
} from "../discover-active-cities";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

const cityFactory = (
  overrides: Partial<ActiveCityRecord> = {},
): ActiveCityRecord => ({
  city: overrides.city ?? "Nashville",
  // Use `in` checks so an explicit null override survives (?? would swallow it).
  regionCode: "regionCode" in overrides ? overrides.regionCode! : "TN",
  countryCode: "countryCode" in overrides ? overrides.countryCode! : "US",
  eventCount: overrides.eventCount ?? 1,
  lat: "lat" in overrides ? overrides.lat! : 36.1627,
  lng: "lng" in overrides ? overrides.lng! : -86.7816,
});

const makeDeps = (
  cities: ActiveCityRecord[] = [cityFactory()],
): DiscoverActiveCitiesDeps & {
  discoverActiveCities: ReturnType<typeof vi.fn>;
} => {
  const discoverActiveCitiesFn = vi.fn(async () => cities);
  const repos = {
    events: {
      discoverActiveCities: discoverActiveCitiesFn,
    },
  } as unknown as Repos;

  return {
    repos,
    logger: createTestLogger(),
    discoverActiveCities: discoverActiveCitiesFn,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("discoverActiveCities", () => {
  it("returns an empty list when no cities are active", async () => {
    const deps = makeDeps([]);

    const result = await discoverActiveCities(deps, {});

    expect(result.cities).toEqual([]);
    expect(deps.discoverActiveCities).toHaveBeenCalledTimes(1);
  });

  it("preserves the repo's most-active-first ordering", async () => {
    const deps = makeDeps([
      cityFactory({ city: "Nashville", regionCode: "TN", eventCount: 12 }),
      cityFactory({ city: "Austin", regionCode: "TX", eventCount: 7 }),
      cityFactory({ city: "Denver", regionCode: "CO", eventCount: 3 }),
    ]);

    const result = await discoverActiveCities(deps, {});

    expect(result.cities.map((c) => c.city)).toEqual([
      "Nashville",
      "Austin",
      "Denver",
    ]);
    expect(result.cities.map((c) => c.eventCount)).toEqual([12, 7, 3]);
    expect(result.cities[0]).toMatchObject({
      city: "Nashville",
      regionCode: "TN",
      countryCode: "US",
      eventCount: 12,
    });
  });

  it("maps a null regionCode/countryCode through to the output", async () => {
    const deps = makeDeps([
      cityFactory({ city: "London", regionCode: null, countryCode: null }),
    ]);

    const result = await discoverActiveCities(deps, {});

    expect(result.cities[0]).toMatchObject({
      city: "London",
      regionCode: null,
      countryCode: null,
    });
  });

  it("passes the country filter through to the repo with an upcoming floor", async () => {
    const deps = makeDeps();

    await discoverActiveCities(deps, { countryCode: "US" });

    expect(deps.discoverActiveCities).toHaveBeenCalledWith({
      startsAfter: expect.any(Date),
      countryCode: "US",
      limit: 20,
    });
  });

  it("omits the country filter when none is provided", async () => {
    const deps = makeDeps();

    await discoverActiveCities(deps, {});

    expect(deps.discoverActiveCities).toHaveBeenCalledWith({
      startsAfter: expect.any(Date),
      countryCode: undefined,
      limit: 20,
    });
  });

  it("rejects unknown input keys (strict schema)", async () => {
    const deps = makeDeps();

    await expect(
      discoverActiveCities(deps, { bogus: true }),
    ).rejects.toThrow();
  });

  it("rejects a too-short country code", async () => {
    const deps = makeDeps();

    await expect(
      discoverActiveCities(deps, { countryCode: "U" }),
    ).rejects.toThrow();
  });
});
