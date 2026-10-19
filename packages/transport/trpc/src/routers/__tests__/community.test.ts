import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { communityRouter } from "../community";
import { createTestLogger } from "@th/test-utils";
import { AppError } from "@th/errors";

// Booking-holds FR-018 at the transport: a listing born / re-pinned onto a
// held date returns notification intents that name OTHER acts' requests.
// The dispatcher is mocked so the post-commit hook can be asserted; the use
// cases are spied so a case can hand the router an output that owes intents
// without standing up the whole hold stack.
vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
vi.mock("@th/core/use-cases/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/core/use-cases/community")>();
  return {
    ...actual,
    createCommunityListing: vi.fn(actual.createCommunityListing),
    createCommunityPlace: vi.fn(actual.createCommunityPlace),
    updateCommunityPlace: vi.fn(actual.updateCommunityPlace),
    archiveCommunityPlace: vi.fn(actual.archiveCommunityPlace),
    restoreCommunityPlace: vi.fn(actual.restoreCommunityPlace),
    getCommunityPlaceEditability: vi.fn(actual.getCommunityPlaceEditability),
    publishCommunityListing: vi.fn(actual.publishCommunityListing),
    updateCommunityRecurrence: vi.fn(actual.updateCommunityRecurrence),
    updateCommunityListing: vi.fn(actual.updateCommunityListing),
    cancelEventDate: vi.fn(actual.cancelEventDate),
  };
});
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";
import {
  archiveCommunityPlace,
  cancelEventDate,
  createCommunityListing,
  createCommunityPlace,
  getCommunityPlaceEditability,
  updateCommunityPlace,
  publishCommunityListing,
  restoreCommunityPlace,
  updateCommunityListing,
  updateCommunityRecurrence,
} from "@th/core/use-cases/community";

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);

beforeEach(() => {
  dispatchMock.mockClear();
  dispatchMock.mockResolvedValue(undefined);
});

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const RSVP_ID = "44444444-4444-4444-8444-444444444444";
const APPLICATION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const rsvpEvent = {
  id: EVENT_ID,
  status: "PUBLISHED",
  attendanceMode: "RSVP",
  stewardship: "COMMUNITY",
  // Future-dated relative to NOW so the ended-event guard (endsAt ?? startsAt
  // <= clock.now()) doesn't reject these fixtures.
  startsAt: new Date("2026-07-15T18:00:00.000Z"),
  endsAt: new Date("2026-07-15T21:00:00.000Z"),
};

const rsvpRecord = {
  id: RSVP_ID,
  eventId: EVENT_ID,
  humanId: ACTOR_ID,
  createdAt: NOW,
};

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {} as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => NOW } as Ctx["clock"],
    contentFilter: {
      hasBlockedContent: vi.fn(async () => false),
    } as unknown as Ctx["contentFilter"],
    rateLimit: withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }) as unknown as Ctx["rateLimit"],
    logger: createTestLogger(),
    actorHumanId: ACTOR_ID,
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
    clientIp: "203.0.113.9",
    ...overrides,
  }) as unknown as Ctx;

const callerFor = (ctx: Ctx) =>
  trpcRouter({ community: router(communityRouter) }).createCaller(ctx);

describe("community.rsvp / cancelRsvp / myRsvps / myRsvpForEvent", () => {
  it("RSVPs the ctx actor to a published RSVP event (fresh RSVP enqueues a confirmation)", async () => {
    const upsert = vi.fn(async () => ({ record: rsvpRecord, created: true }));
    const createNotice = vi.fn(async () => ({
      id: "notice-1",
      eventId: EVENT_ID,
      humanId: ACTOR_ID,
      createdAt: NOW,
      dispatchedAt: null,
      attempts: 0,
    }));
    const repos = {
      events: { getById: vi.fn(async () => rsvpEvent) },
      eventRsvps: { upsert },
      rsvpNotices: { create: createNotice },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.rsvp({ eventId: EVENT_ID });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: ACTOR_ID,
    });
    // Fresh RSVP → one confirmation outbox row (drained by the jobs service).
    expect(createNotice).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: ACTOR_ID,
    });
  });

  it("maps a ticketed target to CONFLICT (EVENT_NOT_COMMUNITY)", async () => {
    const repos = {
      events: {
        getById: vi.fn(async () => ({
          ...rsvpEvent,
          attendanceMode: "TICKETED",
        })),
      },
      eventRsvps: { upsert: vi.fn() },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    await expect(
      caller.community.rsvp({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repos.eventRsvps.upsert).not.toHaveBeenCalled();
  });

  it("cancels the ctx actor's RSVP idempotently", async () => {
    const del = vi.fn(async () => undefined);
    const repos = { eventRsvps: { delete: del } };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.cancelRsvp({ eventId: EVENT_ID });

    expect(result).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith({ eventId: EVENT_ID, humanId: ACTOR_ID });
  });

  it("lists the viewer's own RSVPs with event summaries", async () => {
    const repos = {
      eventRsvps: {
        listForUser: vi.fn(async () => ({
          items: [rsvpRecord],
          nextCursor: null,
        })),
      },
      events: {
        findManyByIds: vi.fn(async () => [
          {
            id: EVENT_ID,
            title: "Weekly Open Mic",
            slug: "event/us/austin/weekly-open-mic--abc123",
            status: "PUBLISHED",
            attendanceMode: "RSVP",
            startsAt: new Date("2026-08-01T20:00:00.000Z"),
            endsAt: null,
            timezone: "America/Chicago",
            addressText: null,
            locality: "Austin",
            region: "TX",
            heroImageUrl: null,
          },
        ]),
      },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.myRsvps({});

    expect(result.items).toHaveLength(1);
    expect(result.items[0].event.title).toBe("Weekly Open Mic");
    expect(repos.eventRsvps.listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: ACTOR_ID }),
    );
  });

  it("accepts the tRPC-injected `direction` key and never forwards it", async () => {
    // Regression: tRPC's useInfiniteQuery injects a top-level `direction`
    // ("forward" | "backward") on every request. listMyRsvpsInputSchema is
    // `.strict()`, so the procedure input must allow it or the call 400s with
    // unrecognized_keys and the /my-rsvps list breaks on scroll. The handler
    // must also strip it before the use case (whose strict schema would reject
    // it a second time) — so it must never reach the repo.
    const repos = {
      eventRsvps: {
        listForUser: vi.fn(async () => ({ items: [], nextCursor: null })),
      },
      events: { findManyByIds: vi.fn(async () => []) },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    await expect(
      caller.community.myRsvps({ direction: "forward" } as never),
    ).resolves.toMatchObject({ items: [], nextCursor: null });

    expect(repos.eventRsvps.listForUser).toHaveBeenCalledWith(
      expect.not.objectContaining({ direction: expect.anything() }),
    );
  });

  it("returns the viewer's per-event RSVP state", async () => {
    const existsForUser = vi.fn(async () => true);
    const repos = { eventRsvps: { existsForUser } };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.myRsvpForEvent({
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ rsvped: true });
    expect(existsForUser).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: ACTOR_ID,
    });
  });
});

describe("community.createListing", () => {
  it("forbids non-moderators (FR-005 gate lives in the use case)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(
      caller.community.createListing({
        title: "Weekly Open Mic",
        startsAt: "2026-08-01T20:00:00.000Z",
        endsAt: "2026-08-01T23:00:00.000Z",
        timezone: "America/Chicago",
        addressText: "123 Main St",
        countryCode: "US",
        lat: 30.27,
        lng: -97.74,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });

  it("rejects a client-supplied actorHumanId (identity comes from ctx)", async () => {
    const caller = callerFor(buildCtx());

    await expect(
      caller.community.createListing({
        actorHumanId: ACTOR_ID,
        title: "Weekly Open Mic",
        startsAt: "2026-08-01T20:00:00.000Z",
        endsAt: "2026-08-01T23:00:00.000Z",
        timezone: "America/Chicago",
        addressText: "123 Main St",
        countryCode: "US",
        lat: 30.27,
        lng: -97.74,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("community.createPlace", () => {
  const PLACE_ID = "66666666-6666-4666-8666-666666666666";
  const placeInput = {
    name: "Corner Bar South",
    address: {
      formatted: "2190A Nolensville Pike, Nashville, TN 37211, USA",
      countryCode: "US",
      lat: 36.1186,
      lng: -86.7553,
    },
    clientKey: "community-place-key-1",
  };
  const created = {
    placeId: PLACE_ID,
    name: "Corner Bar South",
    formattedAddress: placeInput.address.formatted,
    city: null,
    region: null,
    lat: 36.1186,
    lng: -86.7553,
    timezone: "America/Chicago",
    status: "ACTIVE" as const,
    verificationStatus: "UNVERIFIED" as const,
  };

  it("forbids non-moderators (the gate lives in the use case)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(caller.community.createPlace(placeInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });

  it("rejects a client-supplied actorHumanId (identity comes from ctx)", async () => {
    const caller = callerFor(buildCtx());

    await expect(
      caller.community.createPlace({ ...placeInput, actorHumanId: ACTOR_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("passes the ctx actor and the Place-write deps upsertPlace gets", async () => {
    vi.mocked(createCommunityPlace).mockResolvedValueOnce(created);
    const timezoneLookup = vi.fn(() => "America/Chicago");
    const taxRateLookup = { lookupByPostalCode: vi.fn() };
    const reportError = vi.fn();
    const idempotency = { get: vi.fn() };
    const caller = callerFor(
      buildCtx({
        timezoneLookup,
        taxRateLookup: taxRateLookup as unknown as Ctx["taxRateLookup"],
        reportError,
        idempotency: idempotency as unknown as Ctx["idempotency"],
      }),
    );

    await expect(caller.community.createPlace(placeInput)).resolves.toEqual(created);
    const [deps, input] = vi.mocked(createCommunityPlace).mock.calls.at(-1)!;
    expect(input).toEqual({ ...placeInput, actorHumanId: ACTOR_ID });
    expect(deps).toMatchObject({ timezoneLookup, taxRateLookup, reportError, idempotency });
  });

  it("maps PLACE_ALREADY_EXISTS to CONFLICT with the existing place on the wire", async () => {
    vi.mocked(createCommunityPlace).mockRejectedValueOnce(
      new AppError("PLACE_ALREADY_EXISTS", { meta: { existingPlace: created } }),
    );
    const caller = callerFor(buildCtx());

    await expect(caller.community.createPlace(placeInput)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { appCode: "PLACE_ALREADY_EXISTS", existingPlace: { placeId: PLACE_ID } },
    });
  });
});

describe("community place writes — rate limits, updatePlace, archivePlace, restorePlace", () => {
  const PLACE_ID = "66666666-6666-4666-8666-666666666666";
  const address = {
    formatted: "2190A Nolensville Pike, Nashville, TN 37211, USA",
    countryCode: "US",
    lat: 36.1186,
    lng: -86.7553,
  };
  const placeOut = {
    placeId: PLACE_ID,
    name: "Corner Bar South",
    formattedAddress: address.formatted,
    city: null,
    region: null,
    lat: address.lat,
    lng: address.lng,
    timezone: "America/Chicago",
    status: "ACTIVE" as const,
    verificationStatus: "UNVERIFIED" as const,
  };
  const createInput = { name: "Corner Bar South", address, clientKey: "community-place-key-1" };
  const updateInput = { ...createInput, placeId: PLACE_ID };
  const archiveInput = { placeId: PLACE_ID, clientKey: "community-place-key-1" };

  const fakeRateLimit = (deniedKeys: string[] = []) =>
    withConsumeMany({
      consume: vi.fn(async (key: string) =>
        deniedKeys.includes(key)
          ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
          : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
      ),
    });

  it.each([
    ["createPlace", `community:place:create:${ACTOR_ID}`, createCommunityPlace],
    ["updatePlace", `community:place:update:${ACTOR_ID}`, updateCommunityPlace],
    ["archivePlace", `community:place:archive:${ACTOR_ID}`, archiveCommunityPlace],
    ["restorePlace", `community:place:restore:${ACTOR_ID}`, restoreCommunityPlace],
  ] as const)(
    "%s is capped per actor (20 an hour) and refused before the use case runs",
    async (procedure, key, useCase) => {
      vi.mocked(useCase).mockClear();
      const denied = fakeRateLimit([key]);
      const caller = callerFor(
        buildCtx({ rateLimit: denied as unknown as Ctx["rateLimit"] }),
      );

      const call =
        procedure === "createPlace"
          ? caller.community.createPlace(createInput)
          : procedure === "updatePlace"
            ? caller.community.updatePlace(updateInput)
            : procedure === "archivePlace"
              ? caller.community.archivePlace(archiveInput)
              : caller.community.restorePlace(archiveInput);
      await expect(call).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      expect(useCase).not.toHaveBeenCalled();
      expect(denied.consume).toHaveBeenCalledWith(key, 20, 3600);
    },
  );

  it("updatePlace forbids non-moderators (the gate lives in the use case)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(caller.community.updatePlace(updateInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });

  it("updatePlace passes the ctx actor and the Place-write deps", async () => {
    vi.mocked(updateCommunityPlace).mockResolvedValueOnce(placeOut);
    const timezoneLookup = vi.fn(() => "America/Chicago");
    const reportError = vi.fn();
    const caller = callerFor(buildCtx({ timezoneLookup, reportError }));

    await expect(caller.community.updatePlace(updateInput)).resolves.toEqual(placeOut);
    const [deps, input] = vi.mocked(updateCommunityPlace).mock.calls.at(-1)!;
    expect(input).toEqual({ ...updateInput, actorHumanId: ACTOR_ID });
    expect(deps).toMatchObject({ timezoneLookup, reportError });
  });

  it("updatePlace accepts a name-only correction (no address) and passes it on without one", async () => {
    vi.mocked(updateCommunityPlace).mockResolvedValueOnce(placeOut);
    const caller = callerFor(buildCtx());
    const { address: _omitted, ...nameOnly } = updateInput;

    await expect(caller.community.updatePlace(nameOnly)).resolves.toEqual(placeOut);
    const [, input] = vi.mocked(updateCommunityPlace).mock.calls.at(-1)!;
    expect(input).toEqual({ ...nameOnly, actorHumanId: ACTOR_ID });
    expect(input).not.toHaveProperty("address");
  });

  it("updatePlace maps PLACE_HAS_OWNER to FORBIDDEN with the app code", async () => {
    vi.mocked(updateCommunityPlace).mockRejectedValueOnce(
      new AppError("PLACE_HAS_OWNER", { meta: { placeId: PLACE_ID } }),
    );
    const caller = callerFor(buildCtx());

    await expect(caller.community.updatePlace(updateInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "PLACE_HAS_OWNER" },
    });
  });

  it("archivePlace forbids non-moderators", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(caller.community.archivePlace(archiveInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("archivePlace passes the ctx actor, search and reporter, and returns ARCHIVED", async () => {
    vi.mocked(archiveCommunityPlace).mockResolvedValueOnce({
      placeId: PLACE_ID,
      status: "ARCHIVED",
    });
    const reportError = vi.fn();
    const multiSearch = { upsertDocuments: vi.fn() };
    const caller = callerFor(
      buildCtx({ reportError, multiSearch: multiSearch as unknown as Ctx["multiSearch"] }),
    );

    await expect(caller.community.archivePlace(archiveInput)).resolves.toEqual({
      placeId: PLACE_ID,
      status: "ARCHIVED",
    });
    const [deps, input] = vi.mocked(archiveCommunityPlace).mock.calls.at(-1)!;
    expect(input).toEqual({ ...archiveInput, actorHumanId: ACTOR_ID });
    expect(deps).toMatchObject({ reportError, search: multiSearch });
  });

  it("archivePlace rejects a client-supplied actorHumanId", async () => {
    const caller = callerFor(buildCtx());

    await expect(
      caller.community.archivePlace({ ...archiveInput, actorHumanId: ACTOR_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("archivePlace maps PLACE_HAS_LIVE_LISTINGS to CONFLICT, keeping the reason and count", async () => {
    vi.mocked(archiveCommunityPlace).mockRejectedValueOnce(
      new AppError("PLACE_HAS_LIVE_LISTINGS", {
        meta: { placeId: PLACE_ID, reason: "LINKED_LISTINGS", linkedListingCount: 2 },
      }),
    );
    const caller = callerFor(buildCtx());

    await expect(caller.community.archivePlace(archiveInput)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { appCode: "PLACE_HAS_LIVE_LISTINGS" },
    });
  });

  it("restorePlace forbids non-moderators", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(caller.community.restorePlace(archiveInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("restorePlace passes the ctx actor, search and reporter, and returns the place", async () => {
    vi.mocked(restoreCommunityPlace).mockResolvedValueOnce(placeOut);
    const reportError = vi.fn();
    const multiSearch = { upsertDocuments: vi.fn() };
    const caller = callerFor(
      buildCtx({ reportError, multiSearch: multiSearch as unknown as Ctx["multiSearch"] }),
    );

    await expect(caller.community.restorePlace(archiveInput)).resolves.toEqual(placeOut);
    const [deps, input] = vi.mocked(restoreCommunityPlace).mock.calls.at(-1)!;
    expect(input).toEqual({ ...archiveInput, actorHumanId: ACTOR_ID });
    expect(deps).toMatchObject({ reportError, search: multiSearch });
  });

  it("restorePlace maps PLACE_HAS_OWNER (claim pending) to FORBIDDEN", async () => {
    vi.mocked(restoreCommunityPlace).mockRejectedValueOnce(
      new AppError("PLACE_HAS_OWNER", {
        meta: { placeId: PLACE_ID, reason: "CLAIM_PENDING" },
      }),
    );
    const caller = callerFor(buildCtx());

    await expect(caller.community.restorePlace(archiveInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "PLACE_HAS_OWNER" },
    });
  });

  it("restorePlace rejects a client-supplied actorHumanId", async () => {
    const caller = callerFor(buildCtx());

    await expect(
      caller.community.restorePlace({ ...archiveInput, actorHumanId: ACTOR_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("community.getPlaceEditability", () => {
  const PLACE_ID = "66666666-6666-4666-8666-666666666666";
  const moderator = () =>
    ({
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    }) as unknown as Ctx["authz"];
  /** An ownerless ACTIVE place, read through the real use case. */
  const reposFor = (place: Record<string, unknown> | null, liveListings = 0) =>
    ({
      places: {
        getById: vi.fn(async () => place),
        listActiveOwnershipsForPlace: vi.fn(async () => []),
      },
      events: {
        hasOwnedLiveEventsAtPlace: vi.fn(async () => false),
        countLiveCommunityListingsAtPlace: vi.fn(async () => liveListings),
      },
      audit: { list: vi.fn(async () => ({ items: [], total: 0 })) },
      // The second-factor middleware's probe: an enrolled moderator.
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
    }) as unknown as Ctx["repos"];
  const place = {
    id: PLACE_ID,
    name: "Corner Bar South",
    formattedAddress: "2190A Nolensville Pike",
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    locationMode: "EXACT",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
  };

  it("answers a moderator with exactly the contract's fields", async () => {
    const caller = callerFor(
      buildCtx({ authz: moderator(), repos: reposFor(place, 1) }),
    );

    await expect(
      caller.community.getPlaceEditability({ placeId: PLACE_ID }),
    ).resolves.toStrictEqual({
      placeId: PLACE_ID,
      status: "ACTIVE",
      canEdit: true,
      canArchive: false,
      canRestore: false,
      reason: null,
      linkedListingCount: 1,
      duplicatePlaceId: null,
      archivedByModerator: false,
      statusChangedAt: null,
    });
  });

  it("carries statusChangedAt from the newest status audit row, as ISO", async () => {
    const at = new Date("2026-10-01T09:30:00.000Z");
    const repos = reposFor({ ...place, status: "ARCHIVED" });
    const mocks = repos as unknown as {
      places: Record<string, unknown>;
      audit: { list: ReturnType<typeof vi.fn> };
    };
    // Restore's duplicate guard runs for a moderator-archived place.
    mocks.places.findActiveExactByNormalizedName = vi.fn(async () => []);
    mocks.audit.list = vi.fn(async (input: { action?: string }) =>
      input.action === "place.community_archived"
        ? {
            items: [
              {
                id: "audit-1",
                entity: "place",
                entityId: PLACE_ID,
                action: "place.community_archived",
                at,
                data: null,
                actorHumanId: null,
              },
            ],
            total: 1,
          }
        : { items: [], total: 0 },
    );
    const caller = callerFor(buildCtx({ authz: moderator(), repos }));

    await expect(
      caller.community.getPlaceEditability({ placeId: PLACE_ID }),
    ).resolves.toMatchObject({
      status: "ARCHIVED",
      canRestore: true,
      archivedByModerator: true,
      statusChangedAt: "2026-10-01T09:30:00.000Z",
    });
  });

  it("passes the ctx actor and only the read deps", async () => {
    const caller = callerFor(
      buildCtx({ authz: moderator(), repos: reposFor(place) }),
    );

    await caller.community.getPlaceEditability({ placeId: PLACE_ID });
    const [deps, input] = vi.mocked(getCommunityPlaceEditability).mock.calls.at(-1)!;
    expect(input).toEqual({ placeId: PLACE_ID, actorHumanId: ACTOR_ID });
    expect(Object.keys(deps).sort()).toEqual(["authz", "clock", "repos"]);
  });

  it("forbids a non-moderator (the gate lives in the use case) before any read", async () => {
    const repos = reposFor(place);
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"], repos }),
    );

    await expect(
      caller.community.getPlaceEditability({ placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", meta: { appCode: "STAFF_ONLY" } });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
    expect(
      (repos as unknown as { places: { getById: ReturnType<typeof vi.fn> } }).places
        .getById,
    ).not.toHaveBeenCalled();
  });

  it("maps PLACE_NOT_FOUND to NOT_FOUND", async () => {
    const caller = callerFor(
      buildCtx({ authz: moderator(), repos: reposFor(null) }),
    );

    await expect(
      caller.community.getPlaceEditability({ placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", meta: { appCode: "PLACE_NOT_FOUND" } });
  });

  it("rejects a client-supplied actorHumanId and a non-uuid placeId", async () => {
    const caller = callerFor(
      buildCtx({ authz: moderator(), repos: reposFor(place) }),
    );

    await expect(
      caller.community.getPlaceEditability({
        placeId: PLACE_ID,
        actorHumanId: ACTOR_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.community.getPlaceEditability({ placeId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an anonymous caller", async () => {
    const caller = callerFor(
      buildCtx({
        authz: moderator(),
        repos: reposFor(place),
        actorHumanId: null,
        auth: null,
        authToken: null,
      } as unknown as Partial<Ctx>),
    );

    await expect(
      caller.community.getPlaceEditability({ placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("community.createListing draft mode", () => {
  it("accepts status: DRAFT on the wire", async () => {
    // The whole point of the change: the builder mints an invisible row.
    const createCommunityListingMock = vi.fn(async (
      _deps: unknown,
      _input: unknown,
    ) => ({
      event: {
        id: EVENT_ID,
        title: "Weekly Open Mic",
        slug: null,
        shortId: null,
        status: "DRAFT",
        attendanceMode: "RSVP",
        stewardship: "COMMUNITY",
        startsAt: new Date("2026-08-01T20:00:00.000Z"),
        endsAt: new Date("2026-08-01T23:00:00.000Z"),
        timezone: "America/Chicago",
      },
    }));
    vi.mocked(createCommunityListing).mockImplementationOnce(
      createCommunityListingMock as never,
    );

    const result = await callerFor(
      buildCtx({
        repos: {
          humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
        } as unknown as Ctx["repos"],
        authz: {
          hasStaffRole: vi.fn(async () => ({ allowed: true })),
        } as unknown as Ctx["authz"],
      }),
    ).community.createListing({
      title: "Weekly Open Mic",
      startsAt: "2026-08-01T20:00:00.000Z",
      endsAt: "2026-08-01T23:00:00.000Z",
      timezone: "America/Chicago",
      addressText: "123 Main St",
      countryCode: "US",
      lat: 30.27,
      lng: -97.74,
      status: "DRAFT",
    });

    expect(result.event.status).toBe("DRAFT");
    expect(createCommunityListingMock.mock.calls[0]![1]).toMatchObject({
      status: "DRAFT",
    });
  });

  it("rejects a status outside DRAFT | PUBLISHED at the boundary", async () => {
    await expect(
      callerFor(buildCtx()).community.createListing({
        title: "Weekly Open Mic",
        startsAt: "2026-08-01T20:00:00.000Z",
        endsAt: "2026-08-01T23:00:00.000Z",
        timezone: "America/Chicago",
        addressText: "123 Main St",
        countryCode: "US",
        lat: 30.27,
        lng: -97.74,
        status: "CANCELLED",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("community.publishListing", () => {
  it("forbids non-moderators behind the SAME gate createListing uses", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({
        repos: {
          events: { getById: vi.fn() },
        } as unknown as Ctx["repos"],
        authz: { hasStaffRole } as unknown as Ctx["authz"],
      }),
    );

    await expect(
      caller.community.publishListing({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });

  it("rejects a client-supplied actorHumanId (identity comes from ctx)", async () => {
    await expect(
      callerFor(buildCtx()).community.publishListing({
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("community.updateListing", () => {
  it("forbids non-moderators behind the SAME gate createListing uses", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(
      caller.community.updateListing({
        eventId: EVENT_ID,
        fields: { title: "Renamed" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });

  it("rejects a client-supplied actorHumanId (identity comes from ctx)", async () => {
    await expect(
      callerFor(buildCtx()).community.updateListing({
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        fields: { title: "Renamed" },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("community per-date RSVP + recurrence", () => {
  const DATE_ID = "33333333-3333-4333-8333-333333333333";

  const eventDate = {
    id: DATE_ID,
    eventId: EVENT_ID,
    ordinal: 1,
    startsAt: new Date("2026-08-04T20:00:00.000Z"),
    endsAt: new Date("2026-08-04T23:00:00.000Z"),
    status: "SCHEDULED",
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("rsvpToDate upserts the ctx actor onto a scheduled occurrence", async () => {
    const upsert = vi.fn(async () => ({
      record: {
        id: RSVP_ID,
        eventDateId: DATE_ID,
        humanId: ACTOR_ID,
        createdAt: NOW,
      },
      created: true,
    }));
    const createNotice = vi.fn(async () => ({
      id: "nnnnnnnn-1111-4111-8111-nnnnnnnnnnnn",
      eventId: EVENT_ID,
      eventDateId: DATE_ID,
      humanId: ACTOR_ID,
      createdAt: NOW,
      dispatchedAt: null,
      attempts: 0,
    }));
    const repos = {
      events: {
        getById: vi.fn(async () => ({ ...rsvpEvent, visibility: "PUBLIC" })),
      },
      eventDates: { getById: vi.fn(async () => eventDate) },
      eventDateRsvps: { upsert },
      rsvpNotices: { create: createNotice },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.rsvpToDate({ eventDateId: DATE_ID });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(upsert).toHaveBeenCalledWith({
      eventDateId: DATE_ID,
      humanId: ACTOR_ID,
    });
  });

  it("cancelDateRsvp deletes the ctx actor's per-date RSVP idempotently", async () => {
    const del = vi.fn(async () => undefined);
    const repos = { eventDateRsvps: { delete: del } };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.cancelDateRsvp({
      eventDateId: DATE_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith({
      eventDateId: DATE_ID,
      humanId: ACTOR_ID,
    });
  });

  it("listEventDates threads the ctx viewer's humanId (no public count) and returns viewerRsvped", async () => {
    const listDateIdsForHuman = vi.fn(async () => [DATE_ID]);
    const repos = {
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: { listDateIdsForHuman },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.listEventDates({ eventId: EVENT_ID });

    expect(result.dates).toHaveLength(1);
    expect(result.dates[0]).toMatchObject({
      eventDateId: DATE_ID,
      viewerRsvped: true,
    });
    // No public going-count is exposed on the row.
    expect(result.dates[0]).not.toHaveProperty("rsvpCount");
    expect(listDateIdsForHuman).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      eventDateIds: [DATE_ID],
    });
  });

  it("listEventDates forwards moderatorView and the use case gates it on the ctx actor's roles", async () => {
    const listDateIdsWithAnyRsvp = vi.fn(async () => [DATE_ID]);
    const repos = {
      events: { getById: vi.fn(async () => rsvpEvent) },
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: {
        listDateIdsForHuman: vi.fn(async () => []),
        listDateIdsWithAnyRsvp,
      },
    };

    // A moderator with a second factor enrolled (the port's `allowed: true`;
    // the un-enrolled answer is tested separately below): the presence flag
    // rides through the .strict() schema.
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const moderator = callerFor(
      buildCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: { hasStaffRole } as unknown as Ctx["authz"],
      }),
    );
    const result = await moderator.community.listEventDates({
      eventId: EVENT_ID,
      moderatorView: true,
    });
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
    });
    expect(result.dates[0]?.hasRsvp).toBe(true);

    // Anyone else: refused by the use case, presence never read.
    listDateIdsWithAnyRsvp.mockClear();
    const member = callerFor(
      buildCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: {
          hasStaffRole: vi.fn(async () => ({ allowed: false })),
        } as unknown as Ctx["authz"],
      }),
    );
    await expect(
      member.community.listEventDates({ eventId: EVENT_ID, moderatorView: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "STAFF_ONLY" },
    });
    expect(listDateIdsWithAnyRsvp).not.toHaveBeenCalled();

    // And the default read carries no such field at all.
    const plain = await member.community.listEventDates({ eventId: EVENT_ID });
    expect("hasRsvp" in plain.dates[0]!).toBe(false);
  });

  it("listEventDates moderatorView demands the same second factor the moderation writes do", async () => {
    // A moderator with no enrolled second factor: the edge gate keeps them
    // off /moderate, the 2FA middleware refuses every listed write — and
    // this read, which sits on the un-middlewared public procedure, must
    // not be the one thing they can still reach.
    const listDateIdsWithAnyRsvp = vi.fn(async () => [DATE_ID]);
    const repos = {
      events: { getById: vi.fn(async () => rsvpEvent) },
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: {
        listDateIdsForHuman: vi.fn(async () => []),
        listDateIdsWithAnyRsvp,
      },
    };
    // The port's answer for a role holder with nothing enrolled.
    const hasStaffRole = vi.fn(async () => ({
      allowed: false,
      secondFactorRequired: true as const,
    }));
    const caller = callerFor(
      buildCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: { hasStaffRole } as unknown as Ctx["authz"],
      }),
    );

    const err = await caller.community
      .listEventDates({ eventId: EVENT_ID, moderatorView: true })
      .then(
        () => null,
        (e: unknown) => e as { code?: string; meta?: { appCode?: string } },
      );
    expect(err?.code).toBe("FORBIDDEN");
    expect(err?.meta?.appCode).toBe("SECOND_FACTOR_REQUIRED");
    // The default probe: the port applies the second-factor rule itself.
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
    });
    expect(listDateIdsWithAnyRsvp).not.toHaveBeenCalled();

    // The public read is untouched: no step-up, no role probe.
    hasStaffRole.mockClear();
    await caller.community.listEventDates({ eventId: EVENT_ID });
    expect(hasStaffRole).not.toHaveBeenCalled();
  });

  it("listEventDates returns the recurrence summary through the .strict() output schema", async () => {
    // The output schema is `.strict()`, so a field the procedure returns but the
    // schema has not been taught about is dropped/refused here rather than in
    // the browser. America/Chicago on purpose: the rule is read on the event's
    // LOCAL calendar, so a Wed 20:00 listing must summarise as WE, not the
    // Thursday its UTC instant falls on.
    const repos = {
      events: {
        getById: vi.fn(async () => ({
          ...rsvpEvent,
          timezone: "America/Chicago",
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
            dtstart: "2026-09-09T20:00:00-05:00",
            until: "2026-12-30T23:59:00",
          },
        })),
      },
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: { listDateIdsForHuman: vi.fn(async () => []) },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.listEventDates({ eventId: EVENT_ID });

    expect(result.recurrence).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byday: ["WE"],
      until: new Date("2026-12-31T05:59:00.000Z"),
    });
    // The stored rule rides beside the summary through the same `.strict()`
    // schema — it is what the moderator's editor prefills from. The rule is
    // verbatim; both instants are normalised to UTC on the event's clock.
    expect(result.storedRule).toEqual({
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
      dtstart: "2026-09-10T01:00:00.000Z",
      until: "2026-12-31T05:59:00.000Z",
    });
    // TRUNCATED, and this fixture is why the old "UNTIL inside the
    // materialisation window ⇒ complete" rule was wrong: the rule runs every
    // other Wednesday to 30 Dec 2026 (nine occurrences) and exactly ONE of them
    // is a row. An UNTIL says nothing about how many occurrences BEFORE it got
    // materialised, so the only honest answer comes from expanding the rule past
    // the last row — which finds 9 Sep 2026 sitting right there.
    expect(result.truncated).toBe(true);
  });

  it("listEventDates reports a complete list when the last row ends the series", async () => {
    // The `false` half of the flag, so `truncated: true` is not just what this
    // procedure always says. 20:00 on 30 Dec in Chicago (CST) is the single
    // occurrence of this rule, it is the one row, and UNTIL lands hours later.
    const lastOccurrence = new Date("2026-12-31T02:00:00.000Z");
    const repos = {
      events: {
        getById: vi.fn(async () => ({
          ...rsvpEvent,
          timezone: "America/Chicago",
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
            dtstart: "2026-12-30T20:00:00-06:00",
            until: "2026-12-30T23:59:00",
          },
        })),
      },
      eventDates: {
        listUpcoming: vi.fn(async () => [
          { ...eventDate, startsAt: lastOccurrence, endsAt: null },
        ]),
      },
      eventDateRsvps: { listDateIdsForHuman: vi.fn(async () => []) },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.listEventDates({ eventId: EVENT_ID });

    expect(result.dates).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("listEventDates flags an open-ended rule as truncated, through the .strict() output schema", async () => {
    // The seeded Nashville weekly open mic: no UNTIL, so its dates stop at the
    // materialisation window and the page must not state the last ROW as the end
    // of the SERIES. `truncated` is the only way the client can know that.
    const repos = {
      events: {
        getById: vi.fn(async () => ({
          ...rsvpEvent,
          timezone: "America/Chicago",
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;BYDAY=WE",
            dtstart: "2026-09-09T20:00:00-05:00",
          },
        })),
      },
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: { listDateIdsForHuman: vi.fn(async () => []) },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.listEventDates({ eventId: EVENT_ID });

    expect(result.truncated).toBe(true);
    expect(result.recurrence?.until).toBeNull();
  });

  it("listEventDates skips the Event read when the caller passes includeRecurrence: false", async () => {
    // What the web viewer-state endpoint sends: `private, no-store`, wants only
    // the per-date flags, and was paying for an Event row it discarded on every
    // viewer of every RSVP event page.
    const getById = vi.fn(async () => ({
      ...rsvpEvent,
      timezone: "America/Chicago",
      recurrenceSchedule: {
        kind: "RRULE",
        rrule: "FREQ=WEEKLY;BYDAY=WE",
        dtstart: "2026-09-09T20:00:00-05:00",
      },
    }));
    const repos = {
      events: { getById },
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: { listDateIdsForHuman: vi.fn(async () => []) },
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.listEventDates({
      eventId: EVENT_ID,
      includeRecurrence: false,
    });

    expect(getById).not.toHaveBeenCalled();
    expect(result.dates).toHaveLength(1);
    expect(result.recurrence).toBeNull();
  });

  it("listEventDates still returns its dates when the event read blows up", async () => {
    // The cadence is decoration on the public event page's critical path. A
    // repo with no `events` surface at all stands in for any failure of that
    // read: the dates must survive it and the summary must come back null.
    // `truncated` then answers `true` — with no schedule to expand, the list
    // cannot be claimed complete (see `isTruncated`).
    const repos = {
      eventDates: { listUpcoming: vi.fn(async () => [eventDate]) },
      eventDateRsvps: { listDateIdsForHuman: vi.fn(async () => []) },
    };
    const reportError = vi.fn();
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"], reportError }),
    );

    const result = await caller.community.listEventDates({ eventId: EVENT_ID });

    expect(result.dates).toHaveLength(1);
    expect(result.recurrence).toBeNull();
    expect(result.truncated).toBe(true);
    // The swallow is wired to the reporter, so it is visible in Sentry.
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("updateRecurrence forbids non-moderators (gate lives in the use case)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(
      caller.community.updateRecurrence({
        eventId: EVENT_ID,
        recurrenceSchedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY",
          dtstart: "2026-08-04T20:00:00",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });
});

describe("community.applyToBeModerator", () => {
  it("creates a PENDING application for the ctx actor", async () => {
    const application = {
      id: APPLICATION_ID,
      applicantHumanId: ACTOR_ID,
      statement: "I run three open mics.",
      status: "PENDING",
      reviewedByHumanId: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const create = vi.fn(async () => application);
    const txRepos = {
      communityModeratorApplications: {
        findPendingByApplicant: vi.fn(async () => null),
        create,
      },
      audit: { log: vi.fn(async () => undefined) },
    };
    const repos = {
      tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
    };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    const result = await caller.community.applyToBeModerator({
      statement: "I run three open mics.",
    });

    expect(result.application.id).toBe(APPLICATION_ID);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ applicantHumanId: ACTOR_ID }),
    );
  });
});

describe("community.checkModeratorAccess", () => {
  it("returns allowed:true + secondFactorEnrolled for a community moderator without throwing", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const caller = callerFor(
      buildCtx({
        authz: { hasStaffRole } as unknown as Ctx["authz"],
        repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
      }),
    );

    await expect(caller.community.checkModeratorAccess()).resolves.toEqual({
      allowed: true,
      secondFactorEnrolled: true,
    });
    // A status probe: it asks for the role without the second-factor rule,
    // and reports enrolment in its own field.
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
      allowWithoutSecondFactor: true,
    });
    expect(hasSecondFactorEnrolled).toHaveBeenCalledWith(ACTOR_ID);
  });

  // The port refuses an un-enrolled role holder by default. The shell needs
  // `allowed: true, secondFactorEnrolled: false` to send them to /enroll-2fa;
  // `allowed: false` would show "not a moderator" instead.
  it("still answers allowed:true for an un-enrolled moderator against a port that applies the second-factor rule", async () => {
    const hasStaffRole = vi.fn(
      async (input: { allowWithoutSecondFactor?: boolean }) =>
        input.allowWithoutSecondFactor
          ? { allowed: true }
          : { allowed: false, secondFactorRequired: true as const },
    );
    const caller = callerFor(
      buildCtx({
        authz: { hasStaffRole } as unknown as Ctx["authz"],
        repos: {
          humans: { hasSecondFactorEnrolled: vi.fn(async () => false) },
        } as unknown as Ctx["repos"],
      }),
    );

    await expect(caller.community.checkModeratorAccess()).resolves.toEqual({
      allowed: true,
      secondFactorEnrolled: false,
    });
  });

  it("returns allowed:true, secondFactorEnrolled:false for a moderator missing a 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const caller = callerFor(
      buildCtx({
        authz: { hasStaffRole } as unknown as Ctx["authz"],
        repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
      }),
    );

    await expect(caller.community.checkModeratorAccess()).resolves.toEqual({
      allowed: true,
      secondFactorEnrolled: false,
    });
  });

  it("returns allowed:false (not FORBIDDEN) for regular users", async () => {
    const caller = callerFor(buildCtx());

    await expect(caller.community.checkModeratorAccess()).resolves.toEqual({
      allowed: false,
      secondFactorEnrolled: false,
    });
  });
});

describe("community — hold intents on the wire (FR-018)", () => {
  const HOLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const intents = [
    { kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "act", date: "2026-08-04", reason: "EVENT_SCHEDULED" },
  ];
  const hint = { assigneeHumanId: null, placedByHumanId: ACTOR_ID, orgId: null, placeId: "33333333-3333-4333-8333-333333333333" };
  const listing = {
    id: EVENT_ID,
    title: "Weekly Open Mic",
    slug: null,
    shortId: null,
    status: "PUBLISHED",
    attendanceMode: "RSVP",
    stewardship: "COMMUNITY",
    startsAt: new Date("2026-08-04T20:00:00.000Z"),
    endsAt: new Date("2026-08-04T23:00:00.000Z"),
    timezone: "UTC",
  };
  const moderatorCtx = (overrides?: Partial<Ctx>) =>
    buildCtx({
      repos: { humans: { hasSecondFactorEnrolled: vi.fn(async () => true) } } as unknown as Ctx["repos"],
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) } as unknown as Ctx["authz"],
      notify: vi.fn(async () => undefined) as unknown as Ctx["notify"],
      ...overrides,
    });

  it("updateRecurrence strips the intents + hint from the wire (the strict output must not refuse them) and dispatches post-commit", async () => {
    vi.mocked(updateCommunityRecurrence).mockResolvedValueOnce({
      event: listing,
      scheduledCount: 4,
      notificationIntents: intents,
      staffRecipientHint: hint,
    } as never);

    const result = await callerFor(moderatorCtx()).community.updateRecurrence({
      eventId: EVENT_ID,
      recurrenceSchedule: { kind: "RRULE", rrule: "FREQ=WEEKLY", dtstart: "2026-08-04T20:00:00" },
    });

    expect(result).toEqual({ event: listing, scheduledCount: 4 });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1]).toEqual({ intents, hint, bookingRequestId: REQUEST_ID });
  });

  it("publishListing strips the intents + hint from the wire and dispatches post-commit", async () => {
    // FR-018 moved with the status flip: a DRAFT listing takes its dates when
    // it goes live, so the publish path owes the same post-commit dispatch
    // create used to own alone.
    vi.mocked(publishCommunityListing).mockResolvedValueOnce({
      event: listing,
      changed: true,
      publishedAt: NOW,
      notificationIntents: intents,
      staffRecipientHint: hint,
    } as never);

    const result = await callerFor(moderatorCtx()).community.publishListing({
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ event: listing, changed: true, publishedAt: NOW });
    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1]).toEqual({
      intents,
      hint,
      bookingRequestId: REQUEST_ID,
    });
  });

  it("updateListing strips the intents + hint from the wire and dispatches post-commit", async () => {
    // A direct moderator edit that MOVES a live listing's start takes the
    // same held dates a publish does, so it owes the same post-commit
    // dispatch — and the intents (which name other acts' requests) must not
    // reach the wire.
    vi.mocked(updateCommunityListing).mockResolvedValueOnce({
      event: listing,
      updatedFields: ["startsAt", "endsAt"],
      notificationIntents: intents,
      staffRecipientHint: hint,
    } as never);

    const result = await callerFor(moderatorCtx()).community.updateListing({
      eventId: EVENT_ID,
      fields: {
        startsAt: "2026-08-11T20:00:00.000Z",
        endsAt: "2026-08-11T23:00:00.000Z",
      },
    });

    expect(result).toEqual({
      event: listing,
      updatedFields: ["startsAt", "endsAt"],
    });
    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![1]).toEqual({
      intents,
      hint,
      bookingRequestId: REQUEST_ID,
    });
  });

  // A saved title/venue on a live listing must stop serving stale from search
  // immediately. Without `search` threaded from ctx the use case's post-commit
  // reindex no-ops, so the threading is pinned here rather than left to the
  // composition root. (`eventSuggestions.review` — the other path through the
  // same shared pipeline — has the matching test.)
  it("updateListing threads ctx.multiSearch and ctx.reportError into the use case", async () => {
    vi.mocked(updateCommunityListing).mockResolvedValueOnce({
      event: listing,
      updatedFields: ["title"],
    } as never);
    const multiSearch = {} as unknown as Ctx["multiSearch"];
    const reportError = vi.fn();

    await callerFor(
      moderatorCtx({ multiSearch, reportError }),
    ).community.updateListing({
      eventId: EVENT_ID,
      fields: { title: "Weekly Open Mic & Jam" },
    });

    const [deps] = vi.mocked(updateCommunityListing).mock.calls.at(-1)!;
    expect(deps.search).toBe(multiSearch);
    expect(deps.reportError).toBe(reportError);
  });

  it("createListing strips the intents + hint from the wire and dispatches post-commit", async () => {
    vi.mocked(createCommunityListing).mockResolvedValueOnce({
      event: listing,
      notificationIntents: intents,
      staffRecipientHint: hint,
    } as never);

    const result = await callerFor(moderatorCtx()).community.createListing({
      title: "Weekly Open Mic",
      startsAt: "2026-08-04T20:00:00.000Z",
      endsAt: "2026-08-04T23:00:00.000Z",
      timezone: "UTC",
      addressText: "123 Main St",
      countryCode: "US",
      lat: 30.27,
      lng: -97.74,
    });

    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});

// ── the per-date call-off pair ───────────────────────────────────────────────
//
// THE GATE HAS TO LIVE AT THE TRANSPORT. Every other moderation write is
// reached through `/moderate/**`, which the web edge middleware fronts with the
// moderator check AND the step-up 2FA requirement. These two are designed to
// render inline on the PUBLIC event page, which has no edge gate — so the
// middleware chained into `authedProcedure` is not the second line of defence
// here, it is the only one.
describe("community.cancelEventDate / restoreEventDate", () => {
  const DATE_ID = "77777777-7777-4777-8777-777777777777";

  /** Repos reaching only as far as the gates under test need. */
  const gateOnlyRepos = (secondFactorEnrolled: boolean) =>
    ({
      humans: {
        hasSecondFactorEnrolled: vi.fn(async () => secondFactorEnrolled),
      },
      // Any call that gets past both gates lands here and stops: the use case
      // opens a transaction first, and this one refuses.
      tx: vi.fn(async () => {
        throw new Error("reached the use case");
      }),
    }) as unknown as Ctx["repos"];

  const ctxFor = (opts: {
    staff: boolean;
    secondFactor: boolean;
  }) =>
    buildCtx({
      repos: gateOnlyRepos(opts.secondFactor),
      authz: {
        // What the port answers: a holder with nothing enrolled is refused
        // with the flag, a non-holder is refused without it.
        hasStaffRole: vi.fn(async () =>
          !opts.staff
            ? { allowed: false }
            : opts.secondFactor
              ? { allowed: true }
              : { allowed: false, secondFactorRequired: true as const },
        ),
      } as unknown as Ctx["authz"],
    });

  for (const procedure of ["cancelEventDate", "restoreEventDate"] as const) {
    describe(procedure, () => {
      it("refuses an anonymous caller", async () => {
        const caller = callerFor(
          buildCtx({
            actorHumanId: null,
            auth: undefined,
            authToken: null,
          } as unknown as Partial<Ctx>),
        );

        await expect(
          caller.community[procedure]({ eventDateId: DATE_ID }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      });

      it("returns a DISTINGUISHABLE step-up error for a moderator with no second factor", async () => {
        // The whole reason the gate is here: on the public event page there is
        // no edge middleware to bounce this actor to /enroll-2fa, so the
        // mutation itself has to say "enrol a second factor" in a way the UI
        // can route on rather than surface as a generic toast.
        const caller = callerFor(ctxFor({ staff: true, secondFactor: false }));

        const err = await caller.community[procedure]({
          eventDateId: DATE_ID,
        }).then(
          () => {
            throw new Error("expected the step-up gate to refuse");
          },
          (e: unknown) => e as { code?: string; meta?: { appCode?: string } },
        );

        expect(err.code).toBe("FORBIDDEN");
        // `data.appCode` on the wire (the errorFormatter reads this `meta`) —
        // the machine-readable hook the public-page UI branches on.
        expect(err.meta?.appCode).toBe("SECOND_FACTOR_REQUIRED");
      });

      it("does NOT reach the use case when the step-up gate refuses", async () => {
        const ctx = ctxFor({ staff: true, secondFactor: false });
        const caller = callerFor(ctx);

        await expect(
          caller.community[procedure]({ eventDateId: DATE_ID }),
        ).rejects.toBeTruthy();
        // The gate runs BEFORE the handler, so no transaction was opened.
        expect(ctx.repos.tx).not.toHaveBeenCalled();
      });

      it("lets a non-staff caller through the step-up middleware and be refused by the ROLE check", async () => {
        // The middleware never decides role eligibility — a non-staff actor
        // passes through it untouched and is rejected by the use case's own
        // `requirePlatformStaff`. Asserting the error is STAFF_ONLY (not
        // SECOND_FACTOR_REQUIRED) proves the two gates stayed separate.
        const caller = callerFor(ctxFor({ staff: false, secondFactor: false }));

        await expect(
          caller.community[procedure]({ eventDateId: DATE_ID }),
        ).rejects.toMatchObject({ meta: { appCode: "STAFF_ONLY" } });
      });

      it("rejects a non-uuid eventDateId at the boundary", async () => {
        const caller = callerFor(ctxFor({ staff: true, secondFactor: true }));

        await expect(
          caller.community[procedure]({ eventDateId: "not-a-uuid" }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      });

      it("refuses a client-supplied actorHumanId — identity comes from ctx only", async () => {
        const caller = callerFor(ctxFor({ staff: true, secondFactor: true }));

        await expect(
          caller.community[procedure]({
            eventDateId: DATE_ID,
            actorHumanId: "99999999-9999-4999-8999-999999999999",
          } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      });
    });
  }

  it("cancelEventDate keeps the recipient count off the wire", async () => {
    // The strict wire schema must STRIP the count, not refuse the result —
    // built from the omitted `.shape` for exactly this reason.
    vi.mocked(cancelEventDate).mockResolvedValueOnce({
      eventDateId: DATE_ID,
      eventId: EVENT_ID,
      status: "CANCELLED",
      changed: true,
      eventStartsAt: NOW,
      startsAtRepinned: true,
      drained: false,
      notifiedCount: 12,
    } as never);

    const result = await callerFor(
      ctxFor({ staff: true, secondFactor: true }),
    ).community.cancelEventDate({ eventDateId: DATE_ID });

    // FR-004: a cancelled date's live-RSVP count IS a going-count, and a
    // moderator asking does not change what the number is.
    expect(result).not.toHaveProperty("notifiedCount");
    expect(JSON.stringify(result)).not.toMatch(/count/i);
    expect(result).toMatchObject({ status: "CANCELLED", changed: true });
  });
});

describe("community.createListing place link at the boundary", () => {
  const base = {
    title: "Weekly Open Mic",
    startsAt: "2026-08-01T20:00:00.000Z",
    endsAt: "2026-08-01T23:00:00.000Z",
    timezone: "America/Chicago",
  };

  it("accepts a placeId with no address fields (reaches the use-case gate)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const caller = callerFor(
      buildCtx({ authz: { hasStaffRole } as unknown as Ctx["authz"] }),
    );

    await expect(
      caller.community.createListing({
        ...base,
        placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(hasStaffRole).toHaveBeenCalled();
  });

  /**
   * Proves the ROUTER rejected the input, not the use case: tRPC's input
   * parser fails with the ZodError as the TRPCError's `cause`, while a
   * use-case rejection reaches the client through `toTrpcError` with an
   * AppError cause instead.
   */
  async function boundaryRejection(payload: unknown) {
    const caller = callerFor(buildCtx());
    const error = await caller.community
      .createListing(payload as never)
      .then(() => null, (err: unknown) => err);
    return { error: error as { code?: string; cause?: unknown } };
  }

  it("rejects a missing address without a placeId at the router, before the use case", async () => {
    const { error } = await boundaryRejection(base);

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.cause).toBeInstanceOf(ZodError);
    const paths = (error.cause as ZodError).issues.map((issue) =>
      issue.path.join("."),
    );
    expect(paths).toEqual(
      expect.arrayContaining(["addressText", "countryCode", "lat", "lng"]),
    );
  });

  it("rejects unknown keys at the router, before the use case", async () => {
    const { error } = await boundaryRejection({
      ...base,
      placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      venueConfirmedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(error.code).toBe("BAD_REQUEST");
    expect(error.cause).toBeInstanceOf(ZodError);
    expect((error.cause as ZodError).issues[0]!.code).toBe("unrecognized_keys");
  });
});
