import { describe, expect, it, vi } from "vitest";

import {
  countDirectoryPlaces,
  type CountDirectoryPlacesDeps,
} from "../count-directory-places";

import type { Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

function buildDeps(count = 0): CountDirectoryPlacesDeps {
  const placesRepo = {
    countDirectory: vi.fn(async () => count),
  };

  return {
    repos: {
      places: placesRepo,
    } as unknown as Repos,
    logger: createTestLogger(),
  };
}

describe("countDirectoryPlaces", () => {
  it("forwards no `near` when unscoped", async () => {
    const deps = buildDeps(38);

    const result = await countDirectoryPlaces(deps, {});

    expect(result).toEqual({ count: 38 });
    expect(deps.repos.places.countDirectory).toHaveBeenCalledTimes(1);
    expect(deps.repos.places.countDirectory).toHaveBeenCalledWith(undefined);
  });

  it("forwards the exact `near` scope when given", async () => {
    const deps = buildDeps(2);
    const near = { lat: 36.16, lng: -86.78, radiusKm: 25 };

    const result = await countDirectoryPlaces(deps, { near });

    expect(result).toEqual({ count: 2 });
    expect(deps.repos.places.countDirectory).toHaveBeenCalledWith({ near });
  });

  it("returns the repo count untouched", async () => {
    const deps = buildDeps(1234);
    await expect(countDirectoryPlaces(deps, {})).resolves.toEqual({
      count: 1234,
    });
  });

  it("rejects an out-of-range latitude", async () => {
    const deps = buildDeps();
    await expect(
      countDirectoryPlaces(deps, { near: { lat: 91, lng: 0, radiusKm: 10 } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(deps.repos.places.countDirectory).not.toHaveBeenCalled();
  });

  it("rejects a negative radius", async () => {
    const deps = buildDeps();
    await expect(
      countDirectoryPlaces(deps, { near: { lat: 0, lng: 0, radiusKm: -1 } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a radius above the 500 km cap", async () => {
    const deps = buildDeps();
    await expect(
      countDirectoryPlaces(deps, { near: { lat: 0, lng: 0, radiusKm: 501 } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown keys (strict schema)", async () => {
    const deps = buildDeps();
    await expect(
      countDirectoryPlaces(deps, { extra: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      countDirectoryPlaces(deps, {
        near: { lat: 0, lng: 0, radiusKm: 1, extra: true },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
