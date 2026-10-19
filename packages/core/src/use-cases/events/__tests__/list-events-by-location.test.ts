import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports";
import type {
  EventGateType,
  EventRecord,
  EventVisibility,
  Repos,
  WaitlistStatus,
} from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import {
  listEventsByLocation,
  type ListEventsByLocationDeps,
} from "../list-events-by-location";
import { describeCardVenueName } from "./_card-venue-name-cases";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? randomUUID(),
  orgId: overrides.orgId ?? randomUUID(),
  humanId: overrides.humanId ?? null,
  title: overrides.title ?? "Denver Music Night",
  status: overrides.status ?? "PUBLISHED",
  visibility: overrides.visibility ?? ("PUBLIC" as EventVisibility),
  gateType: overrides.gateType ?? ("NONE" as EventGateType),
  locationMode: overrides.locationMode ?? "EXACT",
  locationRadiusMeters: overrides.locationRadiusMeters ?? null,
  locationLabel: overrides.locationLabel ?? null,
  startsAt: overrides.startsAt ?? new Date("2025-07-01T18:00:00.000Z"),
  endsAt: overrides.endsAt ?? null,
  placeId: overrides.placeId ?? null,
  savedLocationId: overrides.savedLocationId ?? null,
  categoryId: overrides.categoryId ?? null,
  addressText: overrides.addressText ?? "Main Hall — Denver, CO",
  lat: overrides.lat ?? null,
  lng: overrides.lng ?? null,
  slug: overrides.slug ?? "denver-music-night",
  shortId: overrides.shortId ?? "den001",
  regionCode: overrides.regionCode ?? "co",
  publishedAt: overrides.publishedAt ?? new Date("2025-05-01T12:00:00.000Z"),
  agreementPrimaryId: overrides.agreementPrimaryId ?? randomUUID(),
  agreementResaleId: overrides.agreementResaleId ?? null,
  defaultLocale: overrides.defaultLocale ?? "en-US",
  listingPriority: overrides.listingPriority ?? null,
  passwordHash: overrides.passwordHash ?? null,
  passwordUpdatedAt: overrides.passwordUpdatedAt ?? null,
  waitlistStatus: overrides.waitlistStatus ?? ("CLOSED" as WaitlistStatus),
  waitlistPublishAt: overrides.waitlistPublishAt ?? null,
  waitlistDescription: overrides.waitlistDescription ?? null,
  waitlistCap: overrides.waitlistCap ?? null,
  payoutTermsId: overrides.payoutTermsId ?? null,
  resalePayoutTermsId: overrides.resalePayoutTermsId ?? null,
  placeLayoutId: overrides.placeLayoutId ?? null,
  currency: null,
  recurrenceSchedule: overrides.recurrenceSchedule ?? null,
  heroImageUrl: overrides.heroImageUrl ?? null,
  heroImageKey: overrides.heroImageKey ?? null,
});

const makeDeps = (
  events: EventRecord[] = [eventFactory()],
  overrides: Partial<ListEventsByLocationDeps> = {},
  statusByKey: Record<string, ImageModerationStatus> = {},
) => {
  const gate = makeImageModerationGateFake(statusByKey);
  const repos = {
    events: {
      listPublishedByRegion: vi.fn(async () =>
        buildOffsetPaginatedResult({
          items: events,
          total: events.length,
          limit: events.length === 0 ? 1 : events.length,
          offset: 0,
        }),
      ),
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;

  return {
    repos,
    clock: testClock,
    logger: overrides.logger ?? createTestLogger(),
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  } satisfies ListEventsByLocationDeps & {
    resolveByKeys: ReturnType<typeof vi.fn>;
  };
};

describe("listEventsByLocation", () => {
  it("reads the clock ONCE: the page query and its prices share one instant", async () => {
    const deps = makeDeps();
    const now = vi.fn(() => TEST_NOW);

    await listEventsByLocation(
      { ...deps, clock: { now } },
      { regionCode: "CO", limit: 5, offset: 0 },
    );

    expect(now).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(deps.repos.events.listPublishedByRegion).mock.calls[0]?.[0]
        .startsAfter,
    ).toBe(TEST_NOW);
  });

  it("returns events scoped to the provided region", async () => {
    const deps = makeDeps();

    const result = await listEventsByLocation(deps, {
      regionCode: " CO ",
      limit: 5,
      offset: 2,
    });

    expect(deps.repos.events.listPublishedByRegion).toHaveBeenCalledWith({
      regionCode: "co",
      limit: 5,
      offset: 2,
      startsAfter: expect.any(Date),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: expect.any(String),
      title: "Denver Music Night",
      slug: "denver-music-night",
    });
    // Single-date listing (no recurrence schedule) is not recurring.
    expect(result.events[0].isRecurring).toBe(false);
  });

  it("flags a recurring listing when the event carries a recurrence schedule", async () => {
    const recurringId = randomUUID();
    const deps = makeDeps([
      eventFactory({
        id: recurringId,
        title: "Weekly Open Mic",
        recurrenceSchedule: { kind: "RRULE", rrule: "FREQ=WEEKLY" },
      }),
    ]);

    const result = await listEventsByLocation(deps, { regionCode: "co" });

    expect(result.events[0].id).toBe(recurringId);
    expect(result.events[0].isRecurring).toBe(true);
  });

  it("logs the query metadata", async () => {
    const logger = createTestLogger();
    const deps = makeDeps([], { logger });

    await listEventsByLocation(deps, { regionCode: "ny", limit: 3 });

    expect(logger.info).toHaveBeenCalledWith(
      "events.list_by_location",
      expect.objectContaining({
        regionCode: "ny",
        limit: 3,
        offset: 0,
        resultCount: 0,
      }),
    );
  });

  it("validates the incoming payload", async () => {
    const deps = makeDeps();

    await expect(
      listEventsByLocation(deps, { regionCode: "", limit: 0 }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  // ── Hero moderation gate (FR-005) ──────────────────────────────────────
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";
  const heroEvent = () =>
    eventFactory({ heroImageUrl: HERO_URL, heroImageKey: HERO_KEY });

  it("shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const deps = makeDeps([heroEvent()], {}, { [HERO_KEY]: "APPROVED" });
    const result = await listEventsByLocation(deps, { regionCode: "co" });
    expect(result.events[0].heroImageUrl).toBe(HERO_URL);
    expect(deps.resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const deps = makeDeps([heroEvent()], {}, { [HERO_KEY]: status });
      const result = await listEventsByLocation(deps, { regionCode: "co" });
      expect(result.events[0].heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const deps = makeDeps([heroEvent()], {}, {});
    const result = await listEventsByLocation(deps, { regionCode: "co" });
    expect(result.events[0].heroImageUrl).toBe(HERO_URL);
  });
});

describeCardVenueName({
  makeEvent: () => eventFactory(),
  cardPlaceName: async (event, place) => {
    const deps = makeDeps([event]);
    (deps.repos as unknown as { places: unknown }).places = {
      getById: vi.fn(async () => place),
    };
    const result = await listEventsByLocation(deps, {
      regionCode: "CO",
      limit: 5,
      offset: 0,
    });
    return result.events[0]!.placeName;
  },
});

// The transport mapper formats the card date in this zone; without it a UTC
// server printed a 7pm Chicago show as the next day (prod, 2026-10-13).
describe("listEventsByLocation carries the event's timezone", () => {
  it("returns Event.timezone, and the platform default for an unknown or absent zone", async () => {
    const deps = makeDeps([
      { ...eventFactory({ id: randomUUID() }), timezone: "America/Los_Angeles" },
      { ...eventFactory({ id: randomUUID() }), timezone: "Mars/Olympus_Mons" },
      eventFactory({ id: randomUUID() }),
    ]);

    const result = await listEventsByLocation(deps, { regionCode: "co" });

    expect(result.events.map((e) => e.timezone)).toEqual([
      "America/Los_Angeles",
      "America/Chicago",
      "America/Chicago",
    ]);
  });
});
