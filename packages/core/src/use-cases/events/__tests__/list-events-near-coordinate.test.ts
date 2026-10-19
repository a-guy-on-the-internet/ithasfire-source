import { describe, expect, it, vi } from "vitest";

import type { EventDTO } from "@th/ports/geo";
import { GEO_DEFAULT_LIMIT } from "@th/ports/geo";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import {
  listEventsNearCoordinate,
  type ListEventsNearCoordinateDeps,
} from "../list-events-near-coordinate";

const makeEvent = (overrides: Partial<EventDTO> = {}): EventDTO => ({
  id: overrides.id ?? "00000000-0000-4000-8000-000000000000",
  title: overrides.title ?? "Sunrise Jam",
  lat: overrides.lat ?? 40.0,
  lng: overrides.lng ?? -105.0,
  addressText: overrides.addressText ?? "Boulder, CO",
  distanceMeters: overrides.distanceMeters ?? 1200,
  ...overrides,
});

const makeDeps = (
  overrides: Partial<ListEventsNearCoordinateDeps> = {},
  statusByKey: Record<string, ImageModerationStatus> = {},
  events?: EventDTO[],
): ListEventsNearCoordinateDeps & {
  resolveByKeys: ReturnType<typeof vi.fn>;
} => {
  const gate = makeImageModerationGateFake(statusByKey);
  return {
    geo: {
      nearbyEvents: vi.fn().mockResolvedValue({
        items: events ?? [makeEvent()],
        pageInfo: { total: (events ?? [makeEvent()]).length },
      }),
    },
    repos: gate as unknown as ListEventsNearCoordinateDeps["repos"],
    logger: createTestLogger(),
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
    ...overrides,
  };
};

describe("listEventsNearCoordinate", () => {
  it("returns nearby events with sanitized payloads", async () => {
    const deps = makeDeps();

    const result = await listEventsNearCoordinate(deps, {
      lat: 39.7392,
      lng: -104.9903,
      radiusM: 25_000,
      limit: 5,
      offset: 2,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000000",
      title: "Sunrise Jam",
      lat: 40,
      lng: -105,
      distanceMeters: 1200,
    });

    expect(deps.geo.nearbyEvents).toHaveBeenCalledWith({
      lat: 39.7392,
      lng: -104.9903,
      radiusM: 25_000,
      limit: 5,
      offset: 2,
    });
  });

  it("applies default pagination when not provided", async () => {
    const deps = makeDeps();

    await listEventsNearCoordinate(deps, {
      lat: 34.05,
      lng: -118.25,
      radiusM: 5_000,
    });

    expect(deps.geo.nearbyEvents).toHaveBeenCalledWith({
      lat: 34.05,
      lng: -118.25,
      radiusM: 5_000,
      limit: GEO_DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it("throws on invalid input", async () => {
    const deps = makeDeps();

    await expect(
      listEventsNearCoordinate(deps, {
        lat: 91,
        lng: 0,
        radiusM: 1000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps geo failures to dependency_failed", async () => {
    const deps = makeDeps({
      geo: {
        nearbyEvents: vi.fn().mockRejectedValue(new Error("geo down")),
      },
    });

    await expect(
      listEventsNearCoordinate(deps, {
        lat: 40,
        lng: -105,
        radiusM: 10_000,
      }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "geo.nearby_events",
    });
  });

  // ── Hero moderation gate (FR-005) ──────────────────────────────────────
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";
  const heroEvent = () =>
    makeEvent({ heroImageUrl: HERO_URL, heroImageKey: HERO_KEY });
  const params = { lat: 40, lng: -105, radiusM: 10_000 };

  it("shows an APPROVED hero, strips the raw key, and batches one call", async () => {
    const deps = makeDeps({}, { [HERO_KEY]: "APPROVED" }, [heroEvent()]);
    const result = await listEventsNearCoordinate(deps, params);
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
    // heroImageKey is internal — never surfaced on the public DTO.
    expect(
      (result.events[0] as Record<string, unknown>).heroImageKey,
    ).toBeUndefined();
    expect(deps.resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const deps = makeDeps({}, { [HERO_KEY]: status }, [heroEvent()]);
      const result = await listEventsNearCoordinate(deps, params);
      expect(result.events[0]!.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const deps = makeDeps({}, {}, [heroEvent()]);
    const result = await listEventsNearCoordinate(deps, params);
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
  });
});
