import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

// arrival-areas FR-011: the gate pass is the transport's to decide. The real
// use case still runs (pass-through spy); only the gate read is stubbed.
const gateMocks = vi.hoisted(() => ({
  hasFullEventReadAccessByEventId: vi.fn(
    async (_ctx: unknown, _eventId: string): Promise<boolean> => true,
  ),
}));
vi.mock("../../event-read-access", () => ({
  hasFullEventReadAccessByEventId: gateMocks.hasFullEventReadAccessByEventId,
}));
const submitSpy = vi.hoisted(() => ({ fn: null as null | ReturnType<typeof vi.fn> }));
vi.mock("@th/core/use-cases/entity-reports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@th/core/use-cases/entity-reports")>();
  const fn = vi.fn(actual.submitEntityReport);
  submitSpy.fn = fn;
  return { ...actual, submitEntityReport: fn };
});

import { router, t } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { entityReportsRouter } from "../entity-reports";
import { createTestLogger } from "@th/test-utils";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const MODERATOR_ID = "12121212-1212-4121-8121-121212121212";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-17T12:00:00.000Z");

const reportRecord = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT_ID,
  subjectType: "PLACE",
  subjectId: PLACE_ID,
  reporterHumanId: ACTOR_ID,
  reason: "SPAM",
  details: null,
  subjectSnapshot: null,
  status: "PENDING",
  reviewedByHumanId: null,
  reviewedAt: null,
  reviewNote: null,
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

/** Repos fake for the submit path (create runs inside repos.tx). */
const buildSubmitRepos = () => {
  const create = vi.fn(async (input: Record<string, unknown>) =>
    reportRecord({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reporterHumanId: input.reporterHumanId,
      reason: input.reason,
      details: input.details ?? null,
    }),
  );
  const auditLog = vi.fn(async () => undefined);
  const txRepos = {
    entityReports: { create },
    audit: { log: auditLog },
  };
  const repos = {
    places: {
      getById: vi.fn(async () => ({ id: PLACE_ID, status: "ACTIVE" })),
    },
    entityReports: {
      findPendingByReporterAndSubject: vi.fn(async () => null),
    },
    // Post-commit moderator notification loop — empty recipient lists keep
    // the best-effort branch quiet without wiring a notifications repo.
    authz: { listHumanIdsByStaffRole: vi.fn(async () => []) },
    tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
  };
  return { repos, create, auditLog };
};

const authedSession = {
  auth: { userId: "user-1", sessionId: null, token: "token" },
  authToken: "token",
} as const;

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {} as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => NOW } as Ctx["clock"],
    rateLimit: fakeRateLimit() as unknown as Ctx["rateLimit"],
    logger: createTestLogger(),
    actorHumanId: null,
    auth: null,
    authToken: null,
    apiKey: null,
    clientIp: "203.0.113.9",
    ...overrides,
  }) as unknown as Ctx;

const callerFor = (ctx: Ctx) =>
  trpcRouter({ entityReports: router(entityReportsRouter) }).createCaller(ctx);

/**
 * The REAL wire errorFormatter (initTRPC.create in trpc.ts) — createCaller
 * throws raw TRPCErrors without running it, so serialization pins feed the
 * caught error through `t._config.errorFormatter` exactly like the fastify
 * adapter does (same probe as __tests__/trpc-error-formatter.test.ts).
 */
const formatWire = (error: unknown) =>
  (
    t._config.errorFormatter as unknown as (opts: {
      shape: unknown;
      error: unknown;
    }) => { data: Record<string, unknown> }
  )({
    shape: {
      message: "x",
      code: -32600,
      data: { code: "BAD_REQUEST", httpStatus: 400, path: "entityReports.submit" },
    },
    error,
  });

describe("entityReports.submit", () => {
  it("stamps the reporter from ctx and creates the report", async () => {
    const { repos, create, auditLog } = buildSubmitRepos();
    const rateLimit = fakeRateLimit();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    const result = await caller.entityReports.submit({
      subjectType: "PLACE",
      subjectId: PLACE_ID,
      reason: "SPAM",
    });

    expect(result).toEqual({ reportId: REPORT_ID });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reporterHumanId: ACTOR_ID,
        reason: "SPAM",
      }),
    );
    expect(auditLog).toHaveBeenCalled();
    // Per-human transport cap (NFR-001): 5 / 300s on the actor's own bucket.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `report:h:${ACTOR_ID}`,
      5,
      300,
    );
  });

  it("rejects a client-supplied actorHumanId (identity comes from ctx only)", async () => {
    const { repos } = buildSubmitRepos();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    // `.omit` keeps `.strict()`, so the unknown key fails input parsing.
    await expect(
      caller.entityReports.submit({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "SPAM",
        actorHumanId: MODERATOR_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns TOO_MANY_REQUESTS when the per-human window is exhausted", async () => {
    const { repos, create } = buildSubmitRepos();
    const rateLimit = fakeRateLimit([`report:h:${ACTOR_ID}`]);
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    await expect(
      caller.entityReports.submit({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "SPAM",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces the dedupe error as CONFLICT (errorCodeMap report_already_open row)", async () => {
    const { repos, create } = buildSubmitRepos();
    repos.entityReports.findPendingByReporterAndSubject = vi.fn(async () =>
      reportRecord(),
    );
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    // Without the `report_already_open: "CONFLICT"` errorCodeMap row this
    // legacy-shaped error falls through to INTERNAL_SERVER_ERROR — assert the
    // TRPC code, not just the thrown domain shape.
    await expect(
      caller.entityReports.submit({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "SPAM",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "report_already_open",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("serializes field rejections with meta.reason on the wire (details_required)", async () => {
    const { repos } = buildSubmitRepos();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    let caught: unknown;
    try {
      await caller.entityReports.submit({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "OTHER",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });

    // Pin: the AppError meta bag DOES survive to the client via the initTRPC
    // errorFormatter — `data.meta.reason` / `data.meta.fields` /
    // `data.appCode` are the contract the report dialog may rely on.
    const { data } = formatWire(caught);
    expect(data.appCode).toBe("INVALID_INPUT");
    expect(data.meta).toMatchObject({
      reason: "details_required",
      fields: ["details"],
    });
  });

  it("serializes invalid_reason_for_subject the same way", async () => {
    const { repos } = buildSubmitRepos();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    let caught: unknown;
    try {
      // CLOSED_OR_GONE is PLACE-only — invalid for a HUMAN subject.
      await caller.entityReports.submit({
        subjectType: "HUMAN",
        subjectId: PLACE_ID,
        reason: "CLOSED_OR_GONE",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
    const { data } = formatWire(caught);
    expect(data.meta).toMatchObject({ reason: "invalid_reason_for_subject" });
  });
});

describe("entityReports.listForModeration", () => {
  it("forbids non-staff actors (STAFF_ONLY → FORBIDDEN)", async () => {
    const ctx = buildCtx({
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    await expect(
      caller.entityReports.listForModeration({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  const buildListRepos = (opts?: {
    place?: Record<string, unknown> | null;
  }) => {
    const listPaged = vi.fn(async () => ({
      items: [reportRecord()],
      nextCursor: "next-1",
    }));
    const countPending = vi.fn(async () => 1);
    const placesGetById = vi.fn(async () =>
      opts?.place !== undefined
        ? opts.place
        : { id: PLACE_ID, name: "The Dive Bar" },
    );
    const repos = {
      entityReports: { listPaged, countPending },
      // Subject hydration (subjectName/subjectSlug on each queue row).
      places: { getById: placesGetById },
      humans: {
        // Resolves the REPORTER's display name (merged batch).
        getByIds: vi.fn(async () => [{ id: ACTOR_ID, name: "Ada Reporter" }]),
        // The moderator/staff step-up 2FA gate (guard.ts
        // requireStaffSecondFactor) runs ahead of the handler for this gated
        // path and needs this.
        hasSecondFactorEnrolled: vi.fn(async () => true),
      },
      // `subjectSlug` for a PLACE is its ENTITY PAGE slug — `/places/[slug]`
      // resolves that, never the deprecated `Place.slug`.
      entityPages: {
        getByOwners: vi.fn(async (ownerType: string, ownerIds: string[]) =>
          ownerType === "PLACE"
            ? ownerIds.map((ownerId) => ({
                ownerId,
                slug: "the-dive-bar-a1b2c3d4",
                displayName: "The Dive Bar",
              }))
            : [],
        ),
      },
      organizations: { getByIds: vi.fn(async () => []) },
    };
    return { repos, listPaged, countPending, placesGetById };
  };

  it("returns the hydrated queue + pendingCount for staff, stripping `direction`", async () => {
    const { repos, listPaged } = buildListRepos();
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    const result = await caller.entityReports.listForModeration({
      subjectType: "PLACE",
      limit: 10,
      // tRPC's useInfiniteQuery injects this on every request — the strict
      // input must allow it and the use case must never see it.
      direction: "forward",
    } as never);

    expect(result.nextCursor).toBe("next-1");
    expect(result.pendingCount).toBe(1);
    expect(result.items).toHaveLength(1);
    // FR-007: queue rows carry subject + reporter display data, not just
    // raw UUIDs.
    expect(result.items[0]).toMatchObject({
      subjectName: "The Dive Bar",
      subjectSlug: "the-dive-bar-a1b2c3d4",
      reporterName: "Ada Reporter",
    });
    // Spec v1.1: platform-staff class (ADMIN/SUPPORT/DEVELOPER) — the
    // COMMUNITY_MODERATOR role must NOT be part of the required set.
    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: MODERATOR_ID,
        requiredRoles: expect.arrayContaining(["ADMIN", "SUPPORT", "DEVELOPER"]),
      }),
    );
    // NOTE: calls[0] is the requireStaffSecondFactor middleware's role probe
    // (its gated set legitimately includes COMMUNITY_MODERATOR); the USE
    // CASE's authz check is the LAST call — that one must exclude it.
    const requiredRoles = (
      hasStaffRole.mock.calls.at(-1)![0] as { requiredRoles: string[] }
    ).requiredRoles;
    expect(requiredRoles).toEqual(
      expect.arrayContaining(["ADMIN", "SUPPORT", "DEVELOPER"]),
    );
    expect(requiredRoles).not.toContain("COMMUNITY_MODERATOR");
    expect(listPaged).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "PLACE", limit: 10 }),
    );
    expect(listPaged).toHaveBeenCalledWith(
      expect.not.objectContaining({ direction: expect.anything() }),
    );
  });

  it("hydration failure degrades to null display data AND reaches the ctx-wired reportError", async () => {
    const { repos, placesGetById } = buildListRepos();
    const hydrationError = new Error("places db down");
    placesGetById.mockRejectedValueOnce(hydrationError);
    const reportError = vi.fn();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      reportError: reportError as unknown as Ctx["reportError"],
      ...authedSession,
    });
    const caller = callerFor(ctx);

    const result = await caller.entityReports.listForModeration({});

    expect(result.items[0]).toMatchObject({
      subjectName: null,
      subjectSlug: null,
      reporterName: null,
    });
    // Proves the router threads ctx.reportError into the list deps.
    expect(reportError).toHaveBeenCalledWith(
      hydrationError,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "list-entity-reports" }),
      }),
    );
  });
});

describe("entityReports.review", () => {
  const buildReviewRepos = (opts?: {
    claimed?: Record<string, unknown> | null;
    existing?: Record<string, unknown> | null;
    notificationsCreate?: ReturnType<typeof vi.fn>;
  }) => {
    const claimPendingForReview = vi.fn(async () => opts?.claimed ?? null);
    const getById = vi.fn(async () => opts?.existing ?? null);
    const txRepos = {
      entityReports: { claimPendingForReview, getById },
      audit: { log: vi.fn(async () => undefined) },
    };
    const repos = {
      tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
      ...(opts?.notificationsCreate
        ? { notifications: { create: opts.notificationsCreate } }
        : {}),
    };
    return { repos, claimPendingForReview, getById };
  };

  const staffCtx = (repos: unknown, extra?: Partial<Ctx>) =>
    buildCtx({
      repos: repos as Ctx["repos"],
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      actorHumanId: MODERATOR_ID,
      ...authedSession,
      ...extra,
    });

  it("forbids non-staff actors before any repo read", async () => {
    const { repos, claimPendingForReview } = buildReviewRepos();
    const ctx = buildCtx({
      repos: repos as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    const caller = callerFor(ctx);

    await expect(
      caller.entityReports.review({
        reportId: REPORT_ID,
        verdict: "RESOLVED",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(claimPendingForReview).not.toHaveBeenCalled();
  });

  it("lets staff resolve a PENDING report and threads ctx.reportError into the swallow branches", async () => {
    const resolved = reportRecord({
      status: "RESOLVED",
      reviewedByHumanId: MODERATOR_ID,
      reviewedAt: NOW,
      reviewNote: "handled",
    });
    // A notifications-repo failure must be swallowed AND reach the Sentry
    // hook — proves the router passes ctx.reportError through (obligation:
    // reportError liveness at the transport layer).
    const notificationsCreate = vi.fn(async () => {
      throw new Error("notify backend down");
    });
    const { repos, claimPendingForReview } = buildReviewRepos({
      claimed: resolved,
      notificationsCreate,
    });
    const reportError = vi.fn();
    const ctx = staffCtx(repos, {
      reportError: reportError as unknown as Ctx["reportError"],
    });
    const caller = callerFor(ctx);

    const result = await caller.entityReports.review({
      reportId: REPORT_ID,
      verdict: "RESOLVED",
      reviewNote: "handled",
    });

    expect(result.report.status).toBe("RESOLVED");
    expect(claimPendingForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REPORT_ID,
        status: "RESOLVED",
        reviewedByHumanId: MODERATOR_ID,
        reviewNote: "handled",
      }),
    );
    // The notification failure never failed the mutation…
    expect(notificationsCreate).toHaveBeenCalled();
    // …and was reported to the Sentry hook the router wired from ctx.
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          area: "entity_report_notifications",
        }),
      }),
    );
  });

  it("maps a lost double-review race to CONFLICT (report_already_reviewed)", async () => {
    const { repos } = buildReviewRepos({
      claimed: null,
      existing: reportRecord({ status: "RESOLVED" }),
    });
    const caller = callerFor(staffCtx(repos));

    await expect(
      caller.entityReports.review({
        reportId: REPORT_ID,
        verdict: "DISMISSED",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "report_already_reviewed",
    });
  });

  it("maps a missing report to NOT_FOUND (distinct from already-reviewed)", async () => {
    const { repos } = buildReviewRepos({ claimed: null, existing: null });
    const caller = callerFor(staffCtx(repos));

    await expect(
      caller.entityReports.review({
        reportId: REPORT_ID,
        verdict: "RESOLVED",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "entity_report_not_found",
    });
  });
});

describe("entityReports.submit ARRIVAL_AREA (arrival-areas FR-011 / FR-017)", () => {
  const AREA_ID = "44444444-4444-4444-8444-444444444444";

  const ctxWithGate = (gateOn: boolean) => {
    const { repos, create } = buildSubmitRepos();
    const getById = vi.fn(async () => null);
    const getAll = vi.fn(async () =>
      gateOn ? [{ key: "feature:arrivalAreas", value: "true" }] : [],
    );
    const ctx = buildCtx({
      repos: {
        ...repos,
        arrivalAreas: { getById },
        platformSettings: { getAll },
      } as unknown as Ctx["repos"],
      actorHumanId: ACTOR_ID,
      ...authedSession,
    });
    return { ctx, create, getById, getAll };
  };

  beforeEach(() => {
    gateMocks.hasFullEventReadAccessByEventId.mockReset();
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
    submitSpy.fn?.mockClear();
  });

  const EVENT_ID = "55555555-5555-4555-8555-555555555555";
  const lastUseCaseInput = () =>
    submitSpy.fn?.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;

  it("a reporter who passed seenOnEventId's gate reaches the use case with gateAccessGranted true", async () => {
    const on = ctxWithGate(true);
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
    await callerFor(on.ctx)
      .entityReports.submit({
        subjectType: "ARRIVAL_AREA",
        subjectId: AREA_ID,
        reason: "SPAM",
        seenOnEventId: EVENT_ID,
      })
      .catch(() => undefined);
    expect(gateMocks.hasFullEventReadAccessByEventId).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: ACTOR_ID }),
      EVENT_ID,
    );
    expect(lastUseCaseInput()).toMatchObject({
      seenOnEventId: EVENT_ID,
      gateAccessGranted: true,
      actorHumanId: ACTOR_ID,
    });
  });

  it("a reporter who has not passed the gate reaches it with gateAccessGranted false", async () => {
    const on = ctxWithGate(true);
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(false);
    const err = await callerFor(on.ctx)
      .entityReports.submit({
        subjectType: "ARRIVAL_AREA",
        subjectId: AREA_ID,
        reason: "SPAM",
        seenOnEventId: EVENT_ID,
      })
      .catch((e: unknown) => e);
    expect(lastUseCaseInput()).toMatchObject({ gateAccessGranted: false });
    expect(formatWire(err).data.appCode).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(on.create).not.toHaveBeenCalled();
  });

  it("no seenOnEventId: no gate read, gateAccessGranted false", async () => {
    const on = ctxWithGate(true);
    await callerFor(on.ctx)
      .entityReports.submit({ subjectType: "ARRIVAL_AREA", subjectId: AREA_ID, reason: "SPAM" })
      .catch(() => undefined);
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
    expect(lastUseCaseInput()).toMatchObject({ gateAccessGranted: false });
  });

  it("a seenOnEventId the reporter may not read answers as the area's not-found", async () => {
    const on = ctxWithGate(true);
    gateMocks.hasFullEventReadAccessByEventId.mockRejectedValue(
      new AppError("EVENT_NOT_FOUND"),
    );
    const err = await callerFor(on.ctx)
      .entityReports.submit({
        subjectType: "ARRIVAL_AREA",
        subjectId: AREA_ID,
        reason: "SPAM",
        seenOnEventId: EVENT_ID,
      })
      .catch((e: unknown) => e);
    expect(submitSpy.fn).not.toHaveBeenCalled();
    expect(formatWire(err).data.appCode).toBe("ARRIVAL_AREA_NOT_FOUND");
  });

  it("a client cannot set gateAccessGranted", async () => {
    const on = ctxWithGate(true);
    await expect(
      callerFor(on.ctx).entityReports.submit({
        subjectType: "ARRIVAL_AREA",
        subjectId: AREA_ID,
        reason: "SPAM",
        seenOnEventId: EVENT_ID,
        gateAccessGranted: true,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(submitSpy.fn).not.toHaveBeenCalled();
  });

  it("gate off: refused before the use case reads anything, as the area's not-found", async () => {
    const off = ctxWithGate(false);
    const offErr = await callerFor(off.ctx)
      .entityReports.submit({ subjectType: "ARRIVAL_AREA", subjectId: AREA_ID, reason: "SPAM" })
      .catch((e: unknown) => e);
    expect(off.getById).not.toHaveBeenCalled();
    expect(off.create).not.toHaveBeenCalled();

    // Gate on, area missing: the same error on the wire (no gate oracle).
    const on = ctxWithGate(true);
    const onErr = await callerFor(on.ctx)
      .entityReports.submit({ subjectType: "ARRIVAL_AREA", subjectId: AREA_ID, reason: "SPAM" })
      .catch((e: unknown) => e);
    expect(on.getById).toHaveBeenCalledWith(AREA_ID);
    expect(on.create).not.toHaveBeenCalled();
    expect(formatWire(onErr).data.appCode).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(formatWire(offErr).data).toEqual(formatWire(onErr).data);
  });

  it("the listing subjects never read the gate", async () => {
    const off = ctxWithGate(false);
    await callerFor(off.ctx).entityReports.submit({
      subjectType: "PLACE",
      subjectId: PLACE_ID,
      reason: "SPAM",
    });
    expect(off.create).toHaveBeenCalled();
    expect(off.getAll).not.toHaveBeenCalled();
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
  });

  it("seenOnEventId on a listing subject is a field rejection", async () => {
    const on = ctxWithGate(true);
    await expect(
      callerFor(on.ctx).entityReports.submit({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "SPAM",
        seenOnEventId: AREA_ID,
      }),
    ).rejects.toMatchObject({ message: "seen_on_event_not_allowed" });
  });

  // Core's field checks run before the gate read, so a malformed report
  // never costs it and cannot tell a readable event from an unreadable one.
  const wireOf = async (ctx: Ctx, input: Record<string, unknown>) =>
    formatWire(
      await callerFor(ctx)
        .entityReports.submit(input as never)
        .catch((e: unknown) => e),
    ).data;

  it("a bad reason gets the same error with an unreadable or a readable seenOnEventId, and no gate read", async () => {
    const input = {
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "DUPLICATE",
      seenOnEventId: EVENT_ID,
    };

    gateMocks.hasFullEventReadAccessByEventId.mockRejectedValue(
      new AppError("EVENT_NOT_FOUND"),
    );
    const unreadable = ctxWithGate(true);
    const unreadableWire = await wireOf(unreadable.ctx, input);

    gateMocks.hasFullEventReadAccessByEventId.mockReset();
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
    const readable = ctxWithGate(true);
    const readableWire = await wireOf(readable.ctx, input);

    expect(unreadableWire.appCode).toBe("INVALID_INPUT");
    expect(unreadableWire.meta).toMatchObject({
      reason: "invalid_reason_for_subject",
    });
    expect(readableWire).toEqual(unreadableWire);
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
    expect(unreadable.getById).not.toHaveBeenCalled();
    expect(readable.getById).not.toHaveBeenCalled();
    expect(submitSpy.fn).not.toHaveBeenCalled();
  });

  it("OTHER without details is refused before the gate read, the same either way", async () => {
    const input = {
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "OTHER",
      details: "   ",
      seenOnEventId: EVENT_ID,
    };
    gateMocks.hasFullEventReadAccessByEventId.mockRejectedValue(
      new AppError("EVENT_NOT_FOUND"),
    );
    const unreadableWire = await wireOf(ctxWithGate(true).ctx, input);
    gateMocks.hasFullEventReadAccessByEventId.mockReset();
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
    const readableWire = await wireOf(ctxWithGate(true).ctx, input);

    expect(unreadableWire.meta).toMatchObject({ reason: "details_required" });
    expect(readableWire).toEqual(unreadableWire);
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
  });

  it("details the use case's second sanitize empties: refused before the gate read, the same either way", async () => {
    // "&\u200blt;b&\u200bgt;" sanitizes once to "&lt;b&gt;" (passes OTHER's
    // details check) and twice to "" (fails it). The use case sanitizes
    // twice (tRPC input, then parseInput), so the precheck must too.
    const input = {
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "OTHER",
      details: "&\u200blt;b&\u200bgt;",
      seenOnEventId: EVENT_ID,
    };
    gateMocks.hasFullEventReadAccessByEventId.mockRejectedValue(
      new AppError("EVENT_NOT_FOUND"),
    );
    const unreadableWire = await wireOf(ctxWithGate(true).ctx, input);
    gateMocks.hasFullEventReadAccessByEventId.mockReset();
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
    const readableWire = await wireOf(ctxWithGate(true).ctx, input);

    expect(unreadableWire.appCode).toBe("INVALID_INPUT");
    expect(unreadableWire.meta).toMatchObject({ reason: "details_required" });
    expect(readableWire).toEqual(unreadableWire);
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
    expect(submitSpy.fn).not.toHaveBeenCalled();
  });

  it("gate off still wins over a malformed report", async () => {
    const off = ctxWithGate(false);
    const wire = await wireOf(off.ctx, {
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "DUPLICATE",
      seenOnEventId: EVENT_ID,
    });
    expect(wire.appCode).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
  });
});
