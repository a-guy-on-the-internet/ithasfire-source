import { describe, expect, it, vi } from "vitest";

import { regenerateEventSlug } from "../regenerate-event-slug";
import type { RegenerateEventSlugDeps } from "../regenerate-event-slug";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { OrgRole } from "@th/ports/repos/authz";
import type { EventRecord, EventSlugContext } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { buildOffsetPaginatedResult } from "@th/ports";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { generateEventSlug } from "../_shared/slug";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_KEY = "slug-client-abc123";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2025-01-02T12:00:00.000Z");
const IDEMPOTENCY_KEY = `event:slug:regenerate:${EVENT_ID}:${CLIENT_KEY}`;
const EXPECTED_PAYLOAD_HASH = JSON.stringify({
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
});

function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Launch Party",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2025-05-01T20:00:00.000Z"),
    endsAt: new Date("2024-01-01T01:00:00Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "legacy/slug",
    shortId: "abcdef",
    regionCode: "ca",
    publishedAt: new Date("2024-12-01T00:00:00.000Z"),
    agreementPrimaryId: "agreement-primary-id",
    agreementResaleId: null,
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    ...overrides,
  } satisfies EventRecord;
}

function buildSlugContext(
  event: EventRecord,
  overrides: Partial<EventSlugContext> = {},
): EventSlugContext {
  return {
    eventId: event.id,
    orgId: event.orgId,
    humanId: event.humanId,
    eventTitle: event.title,
    startsAt: event.startsAt,
    timezone: event.timezone,
    orgName: "Acme Org",
    countryCode: "US",
    regionCode: "CA",
    cityOrRegionCode: "San Francisco",
    shortId: event.shortId,
    ...overrides,
  } satisfies EventSlugContext;
}

type MakeDepsOptions = {
  eventOverrides?: Partial<EventRecord>;
  slugContextOverrides?: Partial<EventSlugContext>;
  membershipRole?: OrgRole | null;
  matchGeneratedSlug?: boolean;
  idempotencySeed?: {
    payloadHash: string;
    response: { eventId: string; newSlug: string; previousSlug: string };
  } | null;
};

function makeDeps(options: MakeDepsOptions = {}) {
  let currentEvent = buildEvent(options.eventOverrides);
  const slugContext = buildSlugContext(
    currentEvent,
    options.slugContextOverrides,
  );
  if (options.matchGeneratedSlug) {
    const generated = generateEventSlug(slugContext);
    currentEvent = {
      ...currentEvent,
      slug: generated.slug,
      regionCode: generated.regionCode,
    };
  }

  const slugHistory: Array<{
    eventId: string;
    slug: string;
    recordedAt: Date;
  }> = [];

  const eventsTx = {
    getById: vi.fn(async (eventId: string) =>
      eventId === currentEvent.id ? { ...currentEvent } : null,
    ),
    getContent: vi.fn(async () => null),
    updateContent: vi.fn(async () => ({ ...currentEvent })),
    listPublishedByCountry: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listTicketTypes: vi.fn(),
    ensureHostPermission: vi.fn(),
    upsertDraft: vi.fn(),
    publish: vi.fn(),
    setCategory: vi.fn(),
    setListingPriority: vi.fn(),
    filterByCategory: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listPublishedByRegion: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    searchPublished: vi.fn(async () => []),
    getSlugContext: vi.fn(async () => ({ ...slugContext })),
    recordSlugHistory: vi.fn(
      async (input: { eventId: string; slug: string; recordedAt: Date }) => {
        slugHistory.push(input);
      },
    ),
    updateSlug: vi.fn(
      async (input: {
        eventId: string;
        slug: string;
        regionCode: string | null;
        updatedAt: Date;
      }) => {
        if (input.eventId !== currentEvent.id) {
          throw Object.assign(new Error("event not found"), {
            code: "not_found",
          });
        }
        currentEvent = {
          ...currentEvent,
          slug: input.slug,
          regionCode: input.regionCode ?? currentEvent.regionCode,
        };
        return { ...currentEvent } satisfies EventRecord;
      },
    ),
    assignSlug: vi.fn(async () => ({ ...currentEvent })),
    resolveBySlug: vi.fn(async () => null),
    updateVisibility: vi.fn(async () => ({ ...currentEvent })),
    updateGateType: vi.fn(async () => ({ ...currentEvent })),
    updatePassword: vi.fn(async () => ({ ...currentEvent })),
    updateWaitlistSettings: vi.fn(async () => ({ ...currentEvent })),
    getGateSettings: vi.fn(async () => ({
      eventId: currentEvent.id,
      visibility: currentEvent.visibility,
      gateType: currentEvent.gateType,
      passwordHash: currentEvent.passwordHash,
      passwordUpdatedAt: currentEvent.passwordUpdatedAt,
      waitlistStatus: currentEvent.waitlistStatus,
      waitlistPublishAt: currentEvent.waitlistPublishAt,
      waitlistDescription: currentEvent.waitlistDescription,
      waitlistCap: currentEvent.waitlistCap,
      payoutTermsId: null,
      resalePayoutTermsId: null,
      placeLayoutId: null,
    })),
    listPublishedForSitemap: vi.fn(async () => []),
  };

  const authz = {
    getOrgMembership: vi.fn(async () => {
      if (!currentEvent.orgId) {
        return null;
      }
      const role = options.membershipRole ?? "ADMIN";
      if (role === null) {
        return null;
      }
      return { orgId: currentEvent.orgId, humanId: ACTOR_ID, role } as const;
    }),
    listOrgMembershipsByHumanId: vi.fn(async () => []),
    getEventOrgId: vi.fn(async () => currentEvent.orgId),
    getPlaceAccessContext: vi.fn(async () => null),
    isPlaceVerifiedForOrg: vi.fn(async () => false),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };

  const audit = {
    log: vi.fn(async () => undefined),
  };

  const txRepos = {
    events: eventsTx,
    authz,
    audit,
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
    events: eventsTx as Repos["events"],
    featuredEvents: {} as Repos["featuredEvents"],
    eventApplications: {} as Repos["eventApplications"],
    eventWaitlists: {} as Repos["eventWaitlists"],
    inviteLists: {} as Repos["inviteLists"],
    humans: {} as Repos["humans"],
    categories: {} as Repos["categories"],
    orders: {} as Repos["orders"],
    tickets: {} as Repos["tickets"],
    agreements: {} as Repos["agreements"],
    feePolicies: {} as Repos["feePolicies"],
    splits: {} as Repos["splits"],
    payees: {} as Repos["payees"],
    settlements: {} as Repos["settlements"],
    resaleListings: {} as Repos["resaleListings"],
    idempotency: {} as Repos["idempotency"],
    audit,
    authz,
    apiKeys: {} as Repos["apiKeys"],
    organizations: {} as Repos["organizations"],
    places: {} as Repos["places"],
    savedLocations: {} as Repos["savedLocations"],
    seats: {} as Repos["seats"],
    eventTemplates: {} as Repos["eventTemplates"],
    eventHumans: {} as Repos["eventHumans"],
    series: {} as Repos["series"],
    seriesOccurrences: {} as Repos["seriesOccurrences"],
    pushDevices: {} as Repos["pushDevices"],
    notificationPrefs: {} as Repos["notificationPrefs"],
    notificationDigests: {} as Repos["notificationDigests"],
    notifications: {} as Repos["notifications"],
    placeLayouts: {} as Repos["placeLayouts"],
    placeLayoutBlobs: {} as Repos["placeLayoutBlobs"],
    placeLayoutStatuses: {} as Repos["placeLayoutStatuses"],
    orderItems: {} as Repos["orderItems"],
    orderItemSettlementLines: {} as Repos["orderItemSettlementLines"],
    settlementLines: {} as Repos["settlementLines"],
    payouts: {} as Repos["payouts"],
  } satisfies Repos;

  const idempotencyStore = new Map<
    string,
    {
      payloadHash: string;
      response: { eventId: string; newSlug: string; previousSlug: string };
    }
  >();
  if (options.idempotencySeed) {
    idempotencyStore.set(IDEMPOTENCY_KEY, options.idempotencySeed);
  }

  const getMock = vi.fn(
    async (key: string) => idempotencyStore.get(key) ?? null,
  );
  const beginMock = vi.fn(async () => true);
  const commitMock = vi.fn(async (key: string, value: unknown) => {
    idempotencyStore.set(
      key,
      value as {
        payloadHash: string;
        response: { eventId: string; newSlug: string; previousSlug: string };
      },
    );
  });
  const failMock = vi.fn(async () => undefined);

  const idempotency: IdempotencyPort = {
    get: getMock as unknown as IdempotencyPort["get"],
    begin: beginMock as unknown as IdempotencyPort["begin"],
    commit: commitMock as unknown as IdempotencyPort["commit"],
    fail: failMock as unknown as IdempotencyPort["fail"],
    run: vi.fn(),
    purgeExpired: async () => 0,
  };

  const clock: ClockPort = {
    now: () => NOW,
  };

  const logger = createTestLogger();

  const deps: RegenerateEventSlugDeps = {
    repos,
    idempotency,
    clock,
    logger,
  };

  return {
    deps,
    eventsTx,
    authz,
    audit,
    idempotency,
    idempotencyStore,
    slugHistory,
    currentEvent: () => currentEvent,
    slugContext,
    logger,
  };
}

describe("regenerateEventSlug", () => {
  it("updates the slug, records history, and logs the change", async () => {
    const ctx = makeDeps();
    const previousSlug = ctx.currentEvent().slug!;

    const result = await regenerateEventSlug(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result).toMatchObject({
      eventId: EVENT_ID,
      previousSlug,
      newSlug: expect.any(String),
    });
    expect(result.newSlug).not.toEqual(previousSlug);
    expect(ctx.eventsTx.recordSlugHistory).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      slug: previousSlug,
      recordedAt: NOW,
    });
    expect(ctx.eventsTx.updateSlug).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      slug: result.newSlug,
      regionCode: expect.any(String),
      updatedAt: NOW,
    });
    expect(ctx.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: EVENT_ID,
      action: "event.slug_regenerated",
      data: { previousSlug, newSlug: result.newSlug },
      at: NOW,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("event.slug_regenerated", {
      eventId: EVENT_ID,
      newSlug: result.newSlug,
      previousSlug,
    });
    expect(ctx.idempotency.commit).toHaveBeenCalledWith(IDEMPOTENCY_KEY, {
      payloadHash: EXPECTED_PAYLOAD_HASH,
      response: result,
    });
  });

  it("short-circuits when the generated slug matches the current slug", async () => {
    const ctx = makeDeps({ matchGeneratedSlug: true });

    const result = await regenerateEventSlug(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.newSlug).toEqual(result.previousSlug);
    expect(ctx.eventsTx.recordSlugHistory).not.toHaveBeenCalled();
    expect(ctx.eventsTx.updateSlug).not.toHaveBeenCalled();
  });

  it("rejects when the actor lacks sufficient role", async () => {
    const ctx = makeDeps({ membershipRole: "VIEWER" });

    await expect(
      regenerateEventSlug(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(ctx.idempotency.fail).toHaveBeenCalledWith(
      IDEMPOTENCY_KEY,
      "INSUFFICIENT_ROLE",
    );
  });

  it("replays a stored result when payload hash matches", async () => {
    const storedResponse = {
      eventId: EVENT_ID,
      previousSlug: "stored-old",
      newSlug: "stored-new",
    };
    const ctx = makeDeps({
      idempotencySeed: {
        payloadHash: EXPECTED_PAYLOAD_HASH,
        response: storedResponse,
      },
    });

    const result = await regenerateEventSlug(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result).toEqual(storedResponse);
    expect(ctx.eventsTx.getById).not.toHaveBeenCalled();
    expect(ctx.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws a conflict when the payload hash differs", async () => {
    const ctx = makeDeps({
      idempotencySeed: {
        payloadHash: JSON.stringify({
          actorHumanId: "other",
          eventId: EVENT_ID,
        }),
        response: {
          eventId: EVENT_ID,
          previousSlug: "conflict-old",
          newSlug: "conflict-new",
        },
      },
    });

    await expect(
      regenerateEventSlug(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

    expect(ctx.idempotency.begin).not.toHaveBeenCalled();
  });
});
