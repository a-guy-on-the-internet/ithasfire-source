import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { EventRecord, Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import { listEventsByCategory } from "../list-events-by-category";

const HERO_KEY = "events/e/images/hero.png";
const HERO_URL = "https://cdn.example/events/e/images/hero.png";

const CATEGORY = {
  id: "cat-1",
  slug: "open-mics",
  name: "Open Mics",
  active: true,
  sortOrder: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const heroEvent = () =>
  ({
    id: "evt-1",
    title: "Tuesday Open Mic",
    status: "PUBLISHED",
    slug: "tuesday-open-mic",
    startsAt: new Date("2026-03-01T00:00:00Z"),
    addressText: "123 Broadway",
    regionCode: "tn",
    heroImageUrl: HERO_URL,
    heroImageKey: HERO_KEY,
  }) as unknown as EventRecord;

function makeDeps(statusByKey: Record<string, ImageModerationStatus> = {}) {
  const gate = makeImageModerationGateFake(statusByKey);
  const repos = {
    categories: { getBySlug: vi.fn(async () => CATEGORY) },
    events: {
      filterByCategory: vi.fn(async () =>
        buildOffsetPaginatedResult({
          items: [heroEvent()],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      ),
      countIndexableByCategory: vi.fn(async () => 1),
    },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;
  return {
    deps: { repos, logger: createTestLogger() },
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("listEventsByCategory hero moderation gate (FR-005)", () => {
  it("shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const { deps, resolveByKeys } = makeDeps({ [HERO_KEY]: "APPROVED" });
    const result = await listEventsByCategory(deps, { categorySlug: "open-mics" });
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const { deps } = makeDeps({ [HERO_KEY]: status });
      const result = await listEventsByCategory(deps, {
        categorySlug: "open-mics",
      });
      expect(result.events[0]!.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const { deps } = makeDeps({});
    const result = await listEventsByCategory(deps, { categorySlug: "open-mics" });
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
  });
});

describe("listEventsByCategory gateType", () => {
  it.each([
    ["PASSWORD", "PASSWORD"],
    ["APPLICATION", "APPLICATION"],
    ["NONE", undefined],
  ] as const)("a %s event carries gateType %s", async (gate, expected) => {
    const { deps } = makeDeps({ [HERO_KEY]: "APPROVED" });
    (
      deps.repos.events.filterByCategory as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      buildOffsetPaginatedResult({
        items: [{ ...heroEvent(), gateType: gate } as EventRecord],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );

    const result = await listEventsByCategory(deps, {
      categorySlug: "open-mics",
    });

    expect(result.events[0]!.gateType).toBe(expected);
  });
});

describe("listEventsByCategory indexableTotal (owner ruling 2026-10-13)", () => {
  const gatedPage = () =>
    buildOffsetPaginatedResult({
      items: [
        { ...heroEvent(), id: "evt-pw", gateType: "PASSWORD" } as EventRecord,
        {
          ...heroEvent(),
          id: "evt-app",
          gateType: "APPLICATION",
        } as EventRecord,
      ],
      total: 2,
      limit: 20,
      offset: 0,
    });

  it("lists gated events but reports zero indexable when every upcoming event is gated", async () => {
    const { deps } = makeDeps({ [HERO_KEY]: "APPROVED" });
    const events = deps.repos.events as unknown as {
      filterByCategory: ReturnType<typeof vi.fn>;
      countIndexableByCategory: ReturnType<typeof vi.fn>;
    };
    events.filterByCategory.mockResolvedValueOnce(gatedPage());
    events.countIndexableByCategory.mockResolvedValueOnce(0);

    const result = await listEventsByCategory(deps, {
      categorySlug: "open-mics",
    });

    // The listing is unchanged: both gated events show.
    expect(result.events.map((e) => e.gateType)).toEqual([
      "PASSWORD",
      "APPLICATION",
    ]);
    expect(result.total).toBe(2);
    expect(result.indexableTotal).toBe(0);
  });

  it("asks the count for the same category and the same instant as the listing", async () => {
    const { deps } = makeDeps({ [HERO_KEY]: "APPROVED" });
    const events = deps.repos.events as unknown as {
      filterByCategory: ReturnType<typeof vi.fn>;
      countIndexableByCategory: ReturnType<typeof vi.fn>;
    };
    events.countIndexableByCategory.mockResolvedValueOnce(4);

    const result = await listEventsByCategory(deps, {
      categorySlug: "open-mics",
    });

    expect(result.indexableTotal).toBe(4);
    const listArgs = events.filterByCategory.mock.calls[0]![0];
    const countArgs = events.countIndexableByCategory.mock.calls[0]![0];
    expect(countArgs).toEqual({
      categorySlug: "open-mics",
      startsAfter: listArgs.startsAfter,
    });
    expect(countArgs.startsAfter).toBeInstanceOf(Date);
  });

  it("does not count when the category is unknown", async () => {
    const { deps } = makeDeps();
    (
      deps.repos.categories.getBySlug as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);

    await expect(
      listEventsByCategory(deps, { categorySlug: "nope" }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
    expect(deps.repos.events.countIndexableByCategory).not.toHaveBeenCalled();
  });
});

describe("listEventsByCategory timezone", () => {
  // The category grid renders through `countryEventsToDto`, which formats the
  // card's date and passes the zone to the card's stamp. Without the event's
  // zone here both fell back to a default instead of the event's own clock.
  it.each([
    ["America/Los_Angeles", "America/Los_Angeles"],
    [undefined, "America/Chicago"],
    ["Mars/Olympus_Mons", "America/Chicago"],
  ] as const)("Event.timezone %s → %s", async (zone, expected) => {
    const { deps } = makeDeps({ [HERO_KEY]: "APPROVED" });
    (
      deps.repos.events.filterByCategory as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      buildOffsetPaginatedResult({
        items: [{ ...heroEvent(), timezone: zone } as EventRecord],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );

    const result = await listEventsByCategory(deps, {
      categorySlug: "open-mics",
    });

    expect(result.events[0]!.timezone).toBe(expected);
  });
});
