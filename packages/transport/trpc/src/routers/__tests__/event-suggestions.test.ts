import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { eventSuggestionsRouter } from "../event-suggestions";
import { createTestLogger } from "@th/test-utils";

// Booking-holds FR-018 at the transport: the review use case may return hold
// notification intents (they name OTHER acts' requests). The dispatcher is
// mocked so the post-commit hook can be asserted; the use case is spied so
// one case can hand the router an output that owes intents without standing
// up the whole hold stack.
vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
vi.mock("@th/core/use-cases/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/core/use-cases/community")>();
  return { ...actual, reviewEventEditSuggestion: vi.fn(actual.reviewEventEditSuggestion) };
});
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";
import { reviewEventEditSuggestion } from "@th/core/use-cases/community";

const dispatchMock = vi.mocked(dispatchBookingHoldIntents);
const reviewMock = vi.mocked(reviewEventEditSuggestion);

beforeEach(() => {
  dispatchMock.mockClear();
  dispatchMock.mockResolvedValue(undefined);
});

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const MODERATOR_ID = "12121212-1212-4121-8121-121212121212";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const SUGGESTION_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_IP = "203.0.113.9";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const publishedPublicEvent = {
  id: EVENT_ID,
  orgId: null,
  humanId: null,
  title: "Weekly Open Mic",
  status: "PUBLISHED",
  attendanceMode: "RSVP",
  stewardship: "COMMUNITY",
  visibility: "PUBLIC",
  gateType: "NONE",
  passwordHash: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  locationMode: "EXACT",
  timezone: "America/Chicago",
  startsAt: new Date("2026-08-01T20:00:00.000Z"),
  endsAt: new Date("2026-08-01T23:00:00.000Z"),
  addressText: "123 Main St",
  countryCode: "US",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.27,
  lng: -97.74,
  categoryId: null,
  slug: "event/us/austin/weekly-open-mic--abc123",
  shortId: "abc123",
  heroImageUrl: null,
  ageLimit: null,
};

const suggestionRecord = (overrides: Record<string, unknown> = {}) => ({
  id: SUGGESTION_ID,
  eventId: EVENT_ID,
  submitterHumanId: null,
  submitterIpHash: "a".repeat(64),
  fields: { title: "Weekly Open Mic & Jam" },
  baseVersion: {},
  note: null,
  status: "PENDING",
  reviewedByHumanId: null,
  reviewedAt: null,
  reviewNote: null,
  appliedFields: null,
  conflictedFields: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

type ConsumeResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const fakeRateLimit = (deniedKeys: string[] = []) => {
  const consume = vi.fn(
    async (key: string): Promise<ConsumeResult> =>
      deniedKeys.includes(key)
        ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
        : {
            allowed: true,
            remaining: Number.POSITIVE_INFINITY,
            retryAfterSeconds: 0,
          },
  );
  return withConsumeMany({ consume });
};

const allowAllContentFilter = () => ({
  hasBlockedContent: vi.fn(async () => false),
});

/** Repos fake for the submit path (create runs inside repos.tx). */
const buildSubmitRepos = () => {
  const create = vi.fn(async (input: Record<string, unknown>) =>
    suggestionRecord({
      submitterHumanId: input.submitterHumanId ?? null,
      submitterIpHash: input.submitterIpHash ?? null,
      fields: input.fields,
      baseVersion: input.baseVersion,
      note: input.note ?? null,
    }),
  );
  const auditLog = vi.fn(async () => undefined);
  const txRepos = {
    eventEditSuggestions: { create },
    audit: { log: auditLog },
  };
  const repos = {
    events: {
      getById: vi.fn(async () => publishedPublicEvent),
      getContent: vi.fn(async () => null),
    },
    images: { listByEventId: vi.fn(async () => []) },
    eventEditSuggestions: {
      countPendingByIp: vi.fn(async () => 0),
    },
    tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
  };
  return { repos, create, auditLog };
};

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {} as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => NOW } as Ctx["clock"],
    contentFilter: allowAllContentFilter() as unknown as Ctx["contentFilter"],
    rateLimit: fakeRateLimit() as unknown as Ctx["rateLimit"],
    logger: createTestLogger(),
    actorHumanId: null,
    auth: null,
    authToken: null,
    apiKey: null,
    clientIp: CLIENT_IP,
    identityHashSecret: "k".repeat(48),
    ...overrides,
  }) as unknown as Ctx;

const callerFor = (ctx: Ctx) =>
  trpcRouter({ eventSuggestions: router(eventSuggestionsRouter) }).createCaller(
    ctx,
  );

describe("eventSuggestions.submit", () => {
  it("accepts an anonymous submission and stamps identity/IP from ctx", async () => {
    const { repos, create } = buildSubmitRepos();
    const ctx = buildCtx({ repos: repos as unknown as Ctx["repos"] });
    const caller = callerFor(ctx);

    const result = await caller.eventSuggestions.submit({
      eventId: EVENT_ID,
      fields: { title: "Weekly Open Mic & Jam" },
    });

    expect(result.suggestion.id).toBe(SUGGESTION_ID);
    // The client IP is hashed in core (ban-that-sticks round 3): only a
    // 64-hex keyed hash reaches the repo, never the IP.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        submitterHumanId: null,
        submitterIpHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain(CLIENT_IP);
    expect(result.suggestion).not.toHaveProperty("submitterIpHash");
  });

  it("records the signed-in submitter from ctx (never the payload)", async () => {
    const { repos, create } = buildSubmitRepos();
    const rateLimit = fakeRateLimit();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      actorHumanId: ACTOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await caller.eventSuggestions.submit({
      eventId: EVENT_ID,
      fields: { title: "Weekly Open Mic & Jam" },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ submitterHumanId: ACTOR_ID }),
    );
    // Signed-in submitters rate-limit on their own bucket, not the shared IP.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `suggest:h:${ACTOR_ID}`,
      5,
      300,
    );

    // The transport contract must reject client-supplied identity fields.
    await expect(
      caller.eventSuggestions.submit({
        eventId: EVENT_ID,
        fields: { title: "x" },
        submitterHumanId: ACTOR_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rate limits per client IP with the suggest:<ip> key", async () => {
    const { repos } = buildSubmitRepos();
    const rateLimit = fakeRateLimit([`suggest:${CLIENT_IP}`]);
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.submit({
        eventId: EVENT_ID,
        fields: { title: "spam" },
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `suggest:${CLIENT_IP}`,
      5,
      300,
    );
  });
});

describe("eventSuggestions.review", () => {
  it("maps a missing suggestion to NOT_FOUND", async () => {
    const txRepos = {
      eventEditSuggestions: { getById: vi.fn(async () => null) },
    };
    const repos = {
      tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
    };
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: MODERATOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.review({
        suggestionId: SUGGESTION_ID,
        decision: "REJECT",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets a community moderator REJECT a pending suggestion", async () => {
    const pending = suggestionRecord();
    const rejected = suggestionRecord({
      status: "REJECTED",
      reviewedByHumanId: MODERATOR_ID,
      reviewedAt: NOW,
      reviewNote: "duplicate",
    });
    const txRepos = {
      eventEditSuggestions: {
        getById: vi.fn(async () => pending),
        claimPendingForReview: vi.fn(async () => pending),
        markReviewed: vi.fn(async () => rejected),
      },
      events: {
        getById: vi.fn(async () => publishedPublicEvent),
        // The review path row-locks the event before reading it.
        lockRows: vi.fn(async () => undefined),
      },
      audit: { log: vi.fn(async () => undefined) },
    };
    const repos = {
      tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
      // The moderator/staff step-up 2FA gate (guard.ts requireStaffSecondFactor)
      // runs ahead of the handler for this gated path and needs this.
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
    };
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    const result = await caller.eventSuggestions.review({
      suggestionId: SUGGESTION_ID,
      decision: "REJECT",
      reviewNote: "duplicate",
    });

    expect(result.suggestion.status).toBe("REJECTED");
    expect(result.appliedFields).toEqual([]);
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: MODERATOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
    expect(txRepos.eventEditSuggestions.claimPendingForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SUGGESTION_ID,
        reviewedByHumanId: MODERATOR_ID,
      }),
    );
  });

  // A taken-down listing takes no edits: APPROVE is a clean CONFLICT the
  // client can read, and the PENDING claim is never taken.
  it("refuses APPROVE on a CANCELLED listing as CONFLICT / EVENT_ALREADY_CANCELLED", async () => {
    const pending = suggestionRecord();
    const txRepos = {
      eventEditSuggestions: {
        getById: vi.fn(async () => pending),
        claimPendingForReview: vi.fn(async () => pending),
        markReviewed: vi.fn(),
      },
      events: {
        getById: vi.fn(async () => ({
          ...publishedPublicEvent,
          status: "CANCELLED",
        })),
        lockRows: vi.fn(async () => undefined),
      },
      audit: { log: vi.fn(async () => undefined) },
    };
    const repos = {
      tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
    };
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.review({
        suggestionId: SUGGESTION_ID,
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { appCode: "EVENT_ALREADY_CANCELLED" },
    });
    expect(txRepos.eventEditSuggestions.claimPendingForReview).not.toHaveBeenCalled();
  });
});

describe("eventSuggestions.listForModeration / listForOwner", () => {
  it("forbids non-moderators from the moderation queue", async () => {
    const ctx = buildCtx({
      actorHumanId: ACTOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.listForModeration({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns the community queue with event context for moderators", async () => {
    const pending = suggestionRecord();
    const repos = {
      eventEditSuggestions: {
        listPending: vi.fn(async () => ({
          items: [pending],
          nextCursor: "next-1",
        })),
      },
      events: {
        findManyByIds: vi.fn(async () => [publishedPublicEvent]),
      },
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
    };
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    const result = await caller.eventSuggestions.listForModeration({
      limit: 10,
    });

    expect(result.nextCursor).toBe("next-1");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].event).toMatchObject({
      id: EVENT_ID,
      title: publishedPublicEvent.title,
      // The listing's status rides the wire so the queue can mark one that
      // is over (APPROVE refuses there).
      status: "PUBLISHED",
    });
    expect(repos.eventEditSuggestions.listPending).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "community" }, limit: 10 }),
    );
  });

  it("accepts the tRPC-injected `direction` key on the infinite-query input", async () => {
    // Regression: tRPC's useInfiniteQuery injects a top-level `direction`
    // ("forward" | "backward") on every request. The `.strict()` list inputs
    // must allow it, or the call 400s with unrecognized_keys and the whole
    // suggestions / moderation / applications / saved-events queue silently
    // breaks. Guards the class for cursorPageInput here.
    const repos = {
      eventEditSuggestions: {
        listPending: vi.fn(async () => ({ items: [], nextCursor: null })),
      },
      events: { findManyByIds: vi.fn(async () => []) },
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
    };
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.listForModeration({
        limit: 10,
        direction: "forward",
      } as never),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
    // `direction` is not forwarded to the repo — only cursor/limit/scope are.
    expect(repos.eventEditSuggestions.listPending).toHaveBeenCalledWith(
      expect.not.objectContaining({ direction: expect.anything() }),
    );
  });

  it("rejects a community scope smuggled into listForOwner", async () => {
    const ctx = buildCtx({
      actorHumanId: ACTOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.listForOwner({
        scope: { kind: "community" },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("eventSuggestions.getBaseForEvent", () => {
  const baseRepos = (event: Record<string, unknown> | null) => ({
    events: {
      getById: vi.fn(async () => event),
      resolveBySlug: vi.fn(async () =>
        event ? { eventId: EVENT_ID, currentSlug: "s", redirect: false } : null,
      ),
      getContent: vi.fn(async () => null),
    },
    images: { listByEventId: vi.fn(async () => []) },
  });

  it("is publicly readable for a PUBLISHED PUBLIC event", async () => {
    const repos = baseRepos(publishedPublicEvent);
    const ctx = buildCtx({ repos: repos as unknown as Ctx["repos"] });
    const caller = callerFor(ctx);

    const result = await caller.eventSuggestions.getBaseForEvent({
      eventId: EVENT_ID,
    });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.attendanceMode).toBe("RSVP");
    expect(result.stewardship).toBe("COMMUNITY");
    expect(result.base.title).toBe(publishedPublicEvent.title);
    expect(result.attachedImages).toEqual([]);
  });

  it("collapses non-published events to NOT_FOUND", async () => {
    const repos = baseRepos({ ...publishedPublicEvent, status: "DRAFT" });
    const ctx = buildCtx({ repos: repos as unknown as Ctx["repos"] });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.getBaseForEvent({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces the password gate for anonymous viewers (same collapse as getEventSeo)", async () => {
    const gated = {
      ...publishedPublicEvent,
      gateType: "PASSWORD",
      passwordHash: "set",
    };
    const base = baseRepos(gated);
    const repos = {
      ...base,
      events: {
        ...base.events,
        // REDIRECTING legacy slug — the exact bypass shape the router guards
        // against (ensureFullEventReadAccessBySlug would early-return here).
        resolveBySlug: vi.fn(async () => ({
          eventId: EVENT_ID,
          currentSlug: "current-slug",
          redirect: true,
        })),
      },
      eventUnlocks: { isUnlocked: vi.fn(async () => false) },
      authz: { getOrgMembership: vi.fn() },
    };
    const ctx = buildCtx({ repos: repos as unknown as Ctx["repos"] });
    const caller = callerFor(ctx);

    // Both address forms are gated — including a redirecting legacy slug
    // (resolved before the gate check so the redirect can't bypass it).
    await expect(
      caller.eventSuggestions.getBaseForEvent({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_password_required",
    });
    await expect(
      caller.eventSuggestions.getBaseForEvent({ slug: "legacy-slug" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_password_required",
    });
    expect(repos.events.getContent).not.toHaveBeenCalled();
  });

  it("enforces the application gate for signed-in non-holders", async () => {
    const gated = { ...publishedPublicEvent, gateType: "APPLICATION" };
    const repos = {
      ...baseRepos(gated),
      eventUnlocks: { isUnlocked: vi.fn(async () => false) },
      authz: { getOrgMembership: vi.fn(async () => null) },
    };
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    await expect(
      caller.eventSuggestions.getBaseForEvent({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_application_required",
    });
  });

  // N3 parity: a hidden event (DRAFT / never-live) answers exactly like a slug
  // or id that never existed — code, message AND meta — and the gate is never
  // asked about it (its answer would say "real, gated event").
  describe("hidden events answer like unknown ones (N3)", () => {
    const shape = (err: unknown) => {
      const e = err as { code?: unknown; message?: unknown; meta?: unknown };
      return { code: e.code, message: e.message, meta: e.meta };
    };
    const reposFor = (
      event: Record<string, unknown> | null,
      resolution: { redirect: boolean } | null,
    ) => {
      const base = baseRepos(event);
      return {
        ...base,
        events: {
          ...base.events,
          resolveBySlug: vi.fn(async () =>
            resolution
              ? { eventId: EVENT_ID, currentSlug: "s", ...resolution }
              : null,
          ),
        },
        eventUnlocks: { isUnlocked: vi.fn(async () => false) },
        authz: {
          getOrgMembership: vi.fn(async () => null),
          getStaffRolesForHumanId: vi.fn(async () => []),
        },
      };
    };
    const ask = async (
      repos: ReturnType<typeof reposFor>,
      input: { slug: string } | { eventId: string },
    ) => {
      const caller = callerFor(
        buildCtx({ repos: repos as unknown as Ctx["repos"] }),
      );
      return caller.eventSuggestions
        .getBaseForEvent(input)
        .then(() => undefined, (e: unknown) => e);
    };
    const DRAFT = { ...publishedPublicEvent, status: "DRAFT", publishedAt: null };
    const GATED_DRAFT = { ...DRAFT, gateType: "PASSWORD", passwordHash: "set" };

    it.each([
      ["an ungated DRAFT, current slug", DRAFT, { redirect: false }],
      ["an ungated DRAFT, old slug", DRAFT, { redirect: true }],
      ["a PASSWORD-gated DRAFT, current slug", GATED_DRAFT, { redirect: false }],
      ["a PASSWORD-gated DRAFT, old slug", GATED_DRAFT, { redirect: true }],
      [
        "a PUBLISHED OWNED event (not suggestible)",
        { ...publishedPublicEvent, stewardship: "OWNED", humanId: ACTOR_ID },
        { redirect: false },
      ],
    ] as const)("slug path: %s == an unknown slug", async (_l, event, res) => {
      const unknown = shape(await ask(reposFor(null, null), { slug: "nope" }));
      const repos = reposFor(event, res);
      const hidden = shape(await ask(repos, { slug: "s" }));

      expect(unknown).toMatchObject({
        code: "NOT_FOUND",
        meta: { via: "slug", appCode: "EVENT_NOT_FOUND" },
      });
      expect(hidden).toEqual(unknown);
      expect(repos.eventUnlocks.isUnlocked).not.toHaveBeenCalled();
    });

    it.each([
      ["an ungated DRAFT", DRAFT],
      ["a PASSWORD-gated DRAFT", GATED_DRAFT],
    ] as const)("id path: %s == an unknown id", async (_l, event) => {
      const unknown = shape(
        await ask(reposFor(null, null), { eventId: EVENT_ID }),
      );
      const repos = reposFor(event, { redirect: false });
      const hidden = shape(await ask(repos, { eventId: EVENT_ID }));

      expect(unknown).toMatchObject({ code: "NOT_FOUND" });
      expect(hidden).toEqual(unknown);
      expect(repos.eventUnlocks.isUnlocked).not.toHaveBeenCalled();
    });
  });

  it("hydrates unlocked viewers of gated events", async () => {
    const gated = {
      ...publishedPublicEvent,
      gateType: "PASSWORD",
      passwordHash: "set",
    };
    const repos = {
      ...baseRepos(gated),
      eventUnlocks: { isUnlocked: vi.fn(async () => true) },
      authz: { getOrgMembership: vi.fn(async () => null) },
    };
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
    });
    const caller = callerFor(ctx);

    const result = await caller.eventSuggestions.getBaseForEvent({
      eventId: EVENT_ID,
    });
    expect(result.base.title).toBe(publishedPublicEvent.title);
  });
});

describe("eventSuggestions.review — hold intents (FR-018)", () => {
  const HOLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PLACE_ID = "33333333-3333-4333-8333-333333333333";
  const ORG_ID = "22222222-2222-4222-8222-222222222222";
  const approved = suggestionRecord({
    status: "APPROVED",
    reviewedByHumanId: MODERATOR_ID,
    reviewedAt: NOW,
    fields: { startsAt: "2026-08-08T20:00:00.000Z", endsAt: "2026-08-08T23:00:00.000Z" },
    appliedFields: { startsAt: "2026-08-08T20:00:00.000Z", endsAt: "2026-08-08T23:00:00.000Z" },
    conflictedFields: [],
  });
  const intents = [
    { kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "act", date: "2026-08-08", reason: "EVENT_SCHEDULED" },
    { kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "staff", date: "2026-08-08", reason: "EVENT_SCHEDULED", staff: { assigneeHumanId: null, placedByHumanId: MODERATOR_ID } },
  ];
  const hint = { assigneeHumanId: null, placedByHumanId: MODERATOR_ID, orgId: ORG_ID, placeId: PLACE_ID };
  const moderatorCtx = (overrides?: Partial<Ctx>) =>
    buildCtx({
      repos: { humans: { hasSecondFactorEnrolled: vi.fn(async () => true) } } as unknown as Ctx["repos"],
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      auth: { userId: "user-1", sessionId: null, token: "token" },
      authToken: "token",
      notify: vi.fn(async () => undefined) as unknown as Ctx["notify"],
      ...overrides,
    });

  it("strips the intents + hint from the wire and dispatches them post-commit with core's hint", async () => {
    reviewMock.mockResolvedValueOnce({
      suggestion: approved,
      appliedFields: ["startsAt", "endsAt"],
      conflictedFields: [],
      notificationIntents: intents,
      staffRecipientHint: hint,
    } as never);
    const caller = callerFor(moderatorCtx());

    const result = await caller.eventSuggestions.review({ suggestionId: SUGGESTION_ID, decision: "APPROVE" });

    expect(result).not.toHaveProperty("notificationIntents");
    expect(result).not.toHaveProperty("staffRecipientHint");
    expect(result.suggestion.status).toBe("APPROVED");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [, args] = dispatchMock.mock.calls[0]!;
    expect(args).toEqual({ intents, hint, bookingRequestId: REQUEST_ID });
  });

  // The approve path is how a public "the venue moved" report reaches a live
  // listing. Without `search` threaded from ctx the use case's reindex no-ops
  // and search keeps serving the old venue until the nightly full reindex, so
  // the threading is pinned here rather than left to the composition root.
  it("threads ctx.multiSearch and ctx.reportError into the use case", async () => {
    reviewMock.mockResolvedValueOnce({
      suggestion: approved,
      appliedFields: ["title"],
      conflictedFields: [],
    } as never);
    const multiSearch = {} as unknown as Ctx["multiSearch"];
    const reportError = vi.fn();

    await callerFor(
      moderatorCtx({ multiSearch, reportError }),
    ).eventSuggestions.review({
      suggestionId: SUGGESTION_ID,
      decision: "APPROVE",
    });

    const [deps] = reviewMock.mock.calls.at(-1)!;
    expect(deps.search).toBe(multiSearch);
    expect(deps.reportError).toBe(reportError);
  });

  it("nothing owed → no dispatch; a dispatcher failure never fails a committed review", async () => {
    reviewMock.mockResolvedValueOnce({ suggestion: approved, appliedFields: ["title"], conflictedFields: [] } as never);
    const caller = callerFor(moderatorCtx());
    await caller.eventSuggestions.review({ suggestionId: SUGGESTION_ID, decision: "APPROVE" });
    expect(dispatchMock).not.toHaveBeenCalled();

    reviewMock.mockResolvedValueOnce({
      suggestion: approved,
      appliedFields: ["startsAt", "endsAt"],
      conflictedFields: [],
      notificationIntents: intents,
      staffRecipientHint: hint,
    } as never);
    dispatchMock.mockRejectedValueOnce(new Error("notify down"));
    const reportError = vi.fn();
    const result = await callerFor(moderatorCtx({ reportError })).eventSuggestions.review({ suggestionId: SUGGESTION_ID, decision: "APPROVE" });
    expect(result.suggestion.status).toBe("APPROVED");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
