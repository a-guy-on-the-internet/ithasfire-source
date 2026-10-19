import { describe, expect, it, vi } from "vitest";

import type { EventDTO } from "@th/ports/geo";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import {
  listEventsForMapOverview,
  type ListEventsForMapOverviewDeps,
} from "../list-events-for-map-overview";

const HERO_KEY = "events/e/images/hero.png";
const HERO_URL = "https://cdn.example/events/e/images/hero.png";

const heroEvent = (overrides: Partial<EventDTO> = {}): EventDTO => ({
  id: "00000000-0000-4000-8000-000000000000",
  title: "Map Event",
  lat: 40,
  lng: -105,
  addressText: "Boulder, CO",
  heroImageUrl: HERO_URL,
  heroImageKey: HERO_KEY,
  ...overrides,
});

function makeDeps(
  statusByKey: Record<string, ImageModerationStatus> = {},
  events: EventDTO[] = [heroEvent()],
): ListEventsForMapOverviewDeps & { resolveByKeys: ReturnType<typeof vi.fn> } {
  const gate = makeImageModerationGateFake(statusByKey);
  return {
    geo: { boxSearch: vi.fn(async () => events) },
    repos: gate as unknown as ListEventsForMapOverviewDeps["repos"],
    logger: createTestLogger(),
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("listEventsForMapOverview hero moderation gate (FR-005)", () => {
  it("shows an APPROVED hero, strips the raw key, and batches one call", async () => {
    const deps = makeDeps({ [HERO_KEY]: "APPROVED" });
    const result = await listEventsForMapOverview(deps, {});
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
    expect(
      (result.events[0] as Record<string, unknown>).heroImageKey,
    ).toBeUndefined();
    expect(deps.resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const deps = makeDeps({ [HERO_KEY]: status });
      const result = await listEventsForMapOverview(deps, {});
      expect(result.events[0]!.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const deps = makeDeps({});
    const result = await listEventsForMapOverview(deps, {});
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
  });
});
