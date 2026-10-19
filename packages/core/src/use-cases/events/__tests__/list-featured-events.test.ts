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

import {
  listFeaturedEvents,
  type ListFeaturedEventsDeps,
} from "../list-featured-events";
import { describeCardVenueName } from "./_card-venue-name-cases";

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? randomUUID(),
  orgId: overrides.orgId ?? randomUUID(),
  humanId: overrides.humanId ?? null,
  title: overrides.title ?? "Featured Event",
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
  slug: overrides.slug ?? "featured-event",
  shortId: overrides.shortId ?? "feature001",
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
});

const makeDeps = (
  events: EventRecord[] = [eventFactory()],
  overrides: Partial<ListFeaturedEventsDeps> = {},
) => {
  const repos = {
    events: {
      filterByCategory: vi.fn(async () =>
        buildOffsetPaginatedResult({
          items: events,
          total: events.length,
          limit: events.length === 0 ? 1 : events.length,
          offset: 0,
        }),
      ),
    },
  } as unknown as Repos;

  return {
    repos,
    clock: overrides.clock ?? {
      now: vi.fn(() => new Date("2025-01-15T00:00:00.000Z")),
    },
    logger: overrides.logger ?? createTestLogger(),
  } satisfies ListFeaturedEventsDeps;
};

describe("listFeaturedEvents", () => {
  it("returns events from the repo", async () => {
    const deps = makeDeps();

    const result = await listFeaturedEvents(deps, { limit: 5 });

    expect(deps.repos.events.filterByCategory).toHaveBeenCalledWith({
      categorySlug: null,
      limit: 5,
      offset: 0,
      startsAfter: expect.any(Date),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: expect.any(String),
      title: "Featured Event",
      slug: "featured-event",
    });
  });

  it("supports optional category filters and logs metadata", async () => {
    const logger = createTestLogger();
    const deps = makeDeps([], { logger });

    await listFeaturedEvents(deps, { limit: 3, categorySlug: "music" });

    expect(logger.info).toHaveBeenCalledWith(
      "events.list_featured",
      expect.objectContaining({
        limit: 3,
        categorySlug: "music",
        resultCount: 0,
      }),
    );
  });

  it("validates the incoming payload", async () => {
    const deps = makeDeps();

    await expect(listFeaturedEvents(deps, { limit: 0 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describeCardVenueName({
  makeEvent: () => eventFactory(),
  cardPlaceName: async (event, place) => {
    const deps = makeDeps([event]);
    (deps.repos as unknown as { places: unknown }).places = {
      getById: vi.fn(async () => place),
    };
    const result = await listFeaturedEvents(deps, { limit: 5 });
    return result.events[0]!.placeName;
  },
});
