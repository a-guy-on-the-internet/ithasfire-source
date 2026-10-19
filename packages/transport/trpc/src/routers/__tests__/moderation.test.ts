import { describe, expect, it, vi } from "vitest";

import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { moderationRouter } from "../moderation";
import {
  MIDDLEWARE_STAFF_PROBE,
  buildBaseCtx,
  portHasStaffRole,
} from "./test-helpers";

const callerFor = (overrides?: Partial<Ctx>) =>
  trpcRouter({ moderation: trpcRouter(moderationRouter) }).createCaller(
    buildBaseCtx(overrides),
  );

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const MODERATOR_ID = "12121212-1212-4121-8121-121212121212";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-08T12:00:00.000Z");

const flaggedRecord = (overrides: Record<string, unknown> = {}) => ({
  id: RECORD_ID,
  storageKey: "events/hero/abc.jpg",
  kind: "EVENT_HERO",
  status: "FLAGGED",
  subjectType: "EVENT",
  subjectId: EVENT_ID,
  publicUrl: "https://cdn.example.com/events/hero/abc.jpg",
  contentType: "image/jpeg",
  createdByHumanId: ACTOR_ID,
  maxSeverity: 6,
  categories: [{ category: "SEXUAL", severity: 6 }],
  provider: "azure-content-safety",
  degraded: false,
  moderatedAt: NOW,
  reviewedByHumanId: null,
  reviewedAt: null,
  reviewNote: null,
  attempts: 0,
  lastError: null,
  nextAttemptAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// The 2FA step-up gate (guard.ts requireStaffSecondFactor) runs ahead of the
// handler for the gated `moderation.*` paths. It asks the authz port's default
// `hasStaffRole` probe, which refuses a role holder with no second factor
// (`secondFactorRequired`), and raises `SECOND_FACTOR_REQUIRED` on that flag.
// The step-up cases below use `portHasStaffRole`, which answers as the port does.

describe("moderation.listFlaggedImages", () => {
  it("forbids non-moderators", async () => {
    const caller = callerFor({ actorHumanId: ACTOR_ID });

    await expect(caller.moderation.listFlaggedImages({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("returns the mapped flagged-image DTO for moderators", async () => {
    const listFlagged = vi.fn(async () => ({
      items: [flaggedRecord()],
      nextCursor: "cursor-2",
    }));
    const caller = callerFor({
      actorHumanId: MODERATOR_ID,
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      repos: {
        imageModerationRecords: { listFlagged },
      } as unknown as Ctx["repos"],
    });

    const result = await caller.moderation.listFlaggedImages({ limit: 10 });

    expect(result.nextCursor).toBe("cursor-2");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      recordId: RECORD_ID,
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: EVENT_ID,
      maxSeverity: 6,
      degraded: false,
      categories: [{ category: "SEXUAL", severity: 6 }],
    });
    // The DTO must NOT leak internal outbox bookkeeping (attempts, storageKey…).
    expect(result.items[0]).not.toHaveProperty("storageKey");
    expect(result.items[0]).not.toHaveProperty("attempts");
    expect(listFlagged).toHaveBeenCalledWith({ limit: 10, cursor: undefined });
  });

  it("gives the client no way to widen the queue past FLAGGED", async () => {
    // The queue's FLAGGED-only rule lives in ONE place — the repo's
    // `listFlagged` WHERE (proved against real SQL in the adapter's
    // integration test). This router must never hand a caller a lever over it:
    // the `.strict()` input carries no status/filter key, so a client cannot
    // ask for ORPHANED (or PENDING, or REJECTED) rows.
    const listFlagged = vi.fn(async () => ({ items: [], nextCursor: null }));
    const caller = callerFor({
      actorHumanId: MODERATOR_ID,
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      repos: {
        imageModerationRecords: { listFlagged },
      } as unknown as Ctx["repos"],
    });

    await expect(
      caller.moderation.listFlaggedImages({ status: "ORPHANED" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listFlagged).not.toHaveBeenCalled();

    // And the pass-through carries pagination only.
    await caller.moderation.listFlaggedImages({ limit: 5 });
    expect(listFlagged).toHaveBeenCalledWith({ limit: 5, cursor: undefined });
  });

  it("defaults the limit and accepts the tRPC-injected `direction` key", async () => {
    const listFlagged = vi.fn(async () => ({ items: [], nextCursor: null }));
    const caller = callerFor({
      actorHumanId: MODERATOR_ID,
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      repos: {
        imageModerationRecords: { listFlagged },
      } as unknown as Ctx["repos"],
    });

    await caller.moderation.listFlaggedImages({ direction: "forward" });

    expect(listFlagged).toHaveBeenCalledWith({ limit: 30, cursor: undefined });
  });

  it("2FA step-up: blocks a moderator missing an enrolled 2nd factor", async () => {
    // Pins the path-string ↔ registration match: `moderation.listFlaggedImages`
    // must be on `SECOND_FACTOR_GATED_MODERATION_PATHS` (guard.ts). The actor
    // holds a moderator role with no second factor, so the port refuses them
    // everywhere; the middleware makes that refusal arrive first, as
    // `SECOND_FACTOR_REQUIRED` (the code `/moderate` redirects to
    // `/enroll-2fa` on). A rename that drops the path off the list breaks
    // this test: the handler's own check would answer instead.
    const hasStaffRole = portHasStaffRole({
      held: ["COMMUNITY_MODERATOR"],
      enrolled: false,
    });
    const listFlagged = vi.fn(async () => ({ items: [], nextCursor: null }));
    const caller = callerFor({
      actorHumanId: MODERATOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: {
        imageModerationRecords: { listFlagged },
      } as unknown as Ctx["repos"],
    });

    await expect(caller.moderation.listFlaggedImages({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "SECOND_FACTOR_REQUIRED" },
    });
    // The gate ran for this path, with the default probe (no opt-out)...
    expect(hasStaffRole).toHaveBeenCalledTimes(1);
    expect(hasStaffRole).toHaveBeenCalledWith(MIDDLEWARE_STAFF_PROBE(MODERATOR_ID));
    // ...and short-circuited before the handler reached the repo.
    expect(listFlagged).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Platform-ops surface: queueSnapshot + queueSignal.
//
// Different gate from the two moderator procedures above (ADMIN/DEVELOPER, not
// COMMUNITY_MODERATION_ROLES), same 2FA step-up. `hasStaffRole` answers from
// the roles it is ASKED for, as the port does, so these tests exercise the
// real requiredRoles argument rather than a blanket allow.
// ─────────────────────────────────────────────────────────────────────────────

const HEALTHY_COUNTS = {
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
};

/**
 * A staff fake that only allows the roles the actor actually holds, and
 * applies the port's second-factor rule (`enrolled: false` = a holder with no
 * passkey or TOTP).
 */
const staffWithRoles = (held: string[], enrolled = true) => ({
  hasStaffRole: portHasStaffRole({ held, enrolled }),
});
type StaffFake = ReturnType<typeof staffWithRoles>;

/** What the step-up middleware throws for a staff member with no second factor. */
const SECOND_FACTOR_REFUSAL = {
  code: "FORBIDDEN",
  meta: { appCode: "SECOND_FACTOR_REQUIRED" },
};

/**
 * The middleware asked the port once, with the default probe for every gated
 * role, and the procedure's own role check never ran: the refusal came from
 * the path being on the middleware's list.
 */
const expectOnlyTheMiddlewareAsked = (staff: StaffFake) => {
  expect(staff.hasStaffRole).toHaveBeenCalledTimes(1);
  expect(staff.hasStaffRole).toHaveBeenCalledWith(
    MIDDLEWARE_STAFF_PROBE(MODERATOR_ID),
  );
};

/**
 * Healthy defaults for every repo method the ops surface reads, so a test that
 * cares about ONE of them stubs only that one. Spread UNDER the caller's
 * overrides, never over them.
 */
const OPS_REPO_DEFAULTS = {
  countQueueHealth: vi.fn(async () => HEALTHY_COUNTS),
  countQueueTotals: vi.fn(async () => ({
    awaitingReviewAll: 0,
    orphanedAll: 0,
  })),
  countQueueHealthByKind: vi.fn(async () => ({
    byKind: {
      EVENT_HERO: HEALTHY_COUNTS,
      AVATAR: HEALTHY_COUNTS,
      BANNER: HEALTHY_COUNTS,
      PAGE_MEDIA: HEALTHY_COUNTS,
    },
    unrecognizedKinds: HEALTHY_COUNTS,
  })),
  countSeverityHistogram: vi.fn(async () => []),
  listQueueHealthSignal: vi.fn(async () => ({ items: [], nextCursor: null })),
  getByKey: vi.fn(async () => null),
};

const opsCaller = (
  held: string[],
  imageModerationRecords: Record<string, unknown>,
  staff: StaffFake = staffWithRoles(held),
  extraRepos: Record<string, unknown> = {},
) =>
  callerFor({
    actorHumanId: MODERATOR_ID,
    authz: staff as unknown as Ctx["authz"],
    clock: { now: () => NOW } as unknown as Ctx["clock"],
    repos: {
      imageModerationRecords: {
        ...OPS_REPO_DEFAULTS,
        ...imageModerationRecords,
      },
      // The snapshot's "rejected but not deleted" tile. Healthy by default.
      pendingObjectDeletions: {
        countOutboxHealth: vi.fn(async () => ({ dead: 0, overdue: 0 })),
      },
      platformSettings: {
        get: vi.fn(async () => null),
        getAll: vi.fn(async () => []),
        upsert: vi.fn(async () => {
          throw new Error("ops READ path wrote to platformSettings");
        }),
      },
      ...extraRepos,
    } as unknown as Ctx["repos"],
  });

describe("moderation.queueSnapshot", () => {
  it("forbids a COMMUNITY_MODERATOR — this is platform ops, not review", async () => {
    // The distinction is the point of the separate gate: a community moderator
    // judges images; provider telemetry and storage faults are not their
    // surface. `listFlaggedImages` (above) still admits them.
    const countQueueHealth = vi.fn(async () => HEALTHY_COUNTS);
    const caller = opsCaller(["COMMUNITY_MODERATOR"], { countQueueHealth });

    await expect(caller.moderation.queueSnapshot({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(countQueueHealth).not.toHaveBeenCalled();
  });

  it("admits a DEVELOPER who is not a moderator", async () => {
    const countQueueHealth = vi.fn(async () => ({
      ...HEALTHY_COUNTS,
      pendingOverdue: 4,
    }));
    const caller = opsCaller(["DEVELOPER"], { countQueueHealth });

    const out = await caller.moderation.queueSnapshot({});

    expect(out.counts.pendingOverdue).toBe(4);
    // The window is echoed so the page labels tiles from data, not from a
    // hardcoded "2h" that silently lies when a knob moves.
    expect(out.thresholds.degradedWindowMinutes).toBe(120);
    expect(out.cutoffs.degradedSince).toBeInstanceOf(Date);
  });

  it("admits an ADMIN", async () => {
    const countQueueHealth = vi.fn(async () => HEALTHY_COUNTS);
    const caller = opsCaller(["ADMIN"], { countQueueHealth });

    await expect(caller.moderation.queueSnapshot({})).resolves.toMatchObject({
      counts: HEALTHY_COUNTS,
    });
  });

  it("2FA step-up: blocks a platform-ops actor missing an enrolled 2nd factor", async () => {
    // Pins `moderation.queueSnapshot` onto SECOND_FACTOR_GATED_MODERATION_PATHS
    // (guard.ts). That list is explicit per path — without the entry this
    // procedure is silently un-2FA'd, and nothing else would notice.
    const countQueueHealth = vi.fn(async () => HEALTHY_COUNTS);
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsCaller(["ADMIN"], { countQueueHealth }, staff);

    await expect(caller.moderation.queueSnapshot({})).rejects.toMatchObject(
      SECOND_FACTOR_REFUSAL,
    );
    expectOnlyTheMiddlewareAsked(staff);
    expect(countQueueHealth).not.toHaveBeenCalled();
  });
});

describe("moderation.queueSignal", () => {
  const signalRecord = flaggedRecord({ requeues: 2, attempts: 5, lastError: "azure 401" });

  // Absolute cutoffs, exactly as `queueSnapshot` returns them. The drill-down
  // takes no relative knobs and reads no clock, so the page hands back the
  // window the tile it clicked was counted with.
  const WINDOW = {
    pendingDueBefore: new Date("2026-07-08T11:00:00.000Z"),
    moderatedBefore: new Date("2026-07-07T12:00:00.000Z"),
    degradedSince: new Date("2026-07-08T10:00:00.000Z"),
    maxRequeues: 3,
  };

  it("forbids a COMMUNITY_MODERATOR", async () => {
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const caller = opsCaller(["COMMUNITY_MODERATOR"], { listQueueHealthSignal });

    await expect(
      caller.moderation.queueSignal({ ...WINDOW, signal: "awaitingReview" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listQueueHealthSignal).not.toHaveBeenCalled();
  });

  it("withholds storageKey, lastError and any URL for awaitingReview", async () => {
    // `awaitingReview` is un-reviewed flagged CONTENT and this gate admits
    // DEVELOPERs who are not moderators. R2 public URLs are
    // `${publicBaseUrl}/${key}` by string join and gating is app-side, so the
    // key alone reconstructs the image — dropping `publicUrl` without dropping
    // `storageKey` would have been a control in name only.
    //
    // `lastError` is here for the same reason one layer along: it used to reach
    // the client and be hidden at render time by the page. This asserts the
    // SERIALIZED RESPONSE, which is what a DEVELOPER actually receives and what
    // no amount of client code can take back.
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [signalRecord],
      nextCursor: "cursor-2",
    }));
    const caller = opsCaller(["DEVELOPER"], { listQueueHealthSignal });

    const out = await caller.moderation.queueSignal({
      ...WINDOW,
      signal: "awaitingReview",
    });

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).not.toHaveProperty("storageKey");
    expect(out.items[0]).not.toHaveProperty("lastError");
    expect(out.items[0]).not.toHaveProperty("publicUrl");
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("events/hero/abc.jpg");
    expect(wire).not.toContain("cdn.example.com");
    expect(wire).not.toContain("azure 401");
    // The ops facts it DOES carry — enough for "7 holds, oldest 4 days".
    expect(out.items[0]).toMatchObject({
      recordId: RECORD_ID,
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      requeues: 2,
      attempts: 5,
    });
    expect(out.nextCursor).toBe("cursor-2");
  });

  it("keeps storageKey and lastError for the operational buckets", async () => {
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [signalRecord],
      nextCursor: null,
    }));
    const caller = opsCaller(["DEVELOPER"], { listQueueHealthSignal });

    const out = await caller.moderation.queueSignal({
      ...WINDOW,
      signal: "degradedExhausted",
    });

    expect(out.items[0]).toMatchObject({
      storageKey: "events/hero/abc.jpg",
      // For the degraded buckets this field IS the drill-down's purpose.
      lastError: "azure 401",
    });
    // Never a URL, in any bucket.
    expect(out.items[0]).not.toHaveProperty("publicUrl");
    expect(JSON.stringify(out)).not.toContain("cdn.example.com");
  });

  it("passes the caller's window through unchanged and echoes it back", async () => {
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const caller = opsCaller(["ADMIN"], { listQueueHealthSignal });

    const out = await caller.moderation.queueSignal({
      ...WINDOW,
      signal: "orphanedRecent",
      limit: 5,
      cursor: "rec-0",
    });

    expect(listQueueHealthSignal).toHaveBeenCalledWith({
      ...WINDOW,
      signal: "orphanedRecent",
      limit: 5,
      cursor: "rec-0",
    });
    expect(out.cutoffs).toEqual({
      pendingDueBefore: WINDOW.pendingDueBefore,
      moderatedBefore: WINDOW.moderatedBefore,
      degradedSince: WINDOW.degradedSince,
    });
    expect(out.maxRequeues).toBe(3);
  });

  it("accepts useInfiniteQuery's injected `direction` and a null cursor", async () => {
    // Without both, the page breaks twice: `unrecognized_keys` on the first
    // paginated load and `invalid_type` on the last page. Same contract as
    // `listFlaggedImages`.
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const caller = opsCaller(["ADMIN"], { listQueueHealthSignal });

    await caller.moderation.queueSignal({
      ...WINDOW,
      signal: "pendingOverdue",
      cursor: null,
      direction: "forward",
    });

    expect(listQueueHealthSignal).toHaveBeenCalledWith({
      ...WINDOW,
      signal: "pendingOverdue",
      limit: 30,
      cursor: undefined,
    });
  });

  it("rejects a bucket outside the five counted signals", async () => {
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const caller = opsCaller(["ADMIN"], { listQueueHealthSignal });

    await expect(
      caller.moderation.queueSignal({
        ...WINDOW,
        signal: "everything",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listQueueHealthSignal).not.toHaveBeenCalled();
  });

  it("rejects a request with no window rather than inventing one", async () => {
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const caller = opsCaller(["ADMIN"], { listQueueHealthSignal });

    await expect(
      caller.moderation.queueSignal({ signal: "pendingOverdue" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listQueueHealthSignal).not.toHaveBeenCalled();
  });

  it("2FA step-up: blocks a platform-ops actor missing an enrolled 2nd factor", async () => {
    // Pins `moderation.queueSignal` onto SECOND_FACTOR_GATED_MODERATION_PATHS.
    const listQueueHealthSignal = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsCaller(["ADMIN"], { listQueueHealthSignal }, staff);

    await expect(
      caller.moderation.queueSignal({ ...WINDOW, signal: "pendingOverdue" }),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expectOnlyTheMiddlewareAsked(staff);
    expect(listQueueHealthSignal).not.toHaveBeenCalled();
  });
});

describe("moderation.reviewImage", () => {
  it("forbids non-moderators", async () => {
    const caller = callerFor({ actorHumanId: ACTOR_ID });

    await expect(
      caller.moderation.reviewImage({ recordId: RECORD_ID, decision: "APPROVE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("threads the ctx actor into the use case and approves a flagged record", async () => {
    const record = flaggedRecord();
    const review = vi.fn(async () => 1);
    const txRepos = {
      imageModerationRecords: {
        getById: vi.fn(async () => record),
        review,
      },
      pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
      audit: { log: vi.fn(async () => undefined) },
    };
    const notify = vi.fn(async () => ({ ok: true }));
    const caller = callerFor({
      actorHumanId: MODERATOR_ID,
      authz: {
        hasStaffRole: vi.fn(async () => ({ allowed: true })),
      } as unknown as Ctx["authz"],
      notify: notify as unknown as Ctx["notify"],
      repos: {
        tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
      } as unknown as Ctx["repos"],
    });

    const result = await caller.moderation.reviewImage({
      recordId: RECORD_ID,
      decision: "APPROVE",
    });

    expect(result).toEqual({ status: "APPROVED", alreadyDecided: false });
    // The moderator identity is taken from ctx, never the client payload.
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RECORD_ID,
        status: "APPROVED",
        reviewedByHumanId: MODERATOR_ID,
      }),
    );
  });

  it("2FA step-up: blocks a moderator missing an enrolled 2nd factor", async () => {
    // Pins the path-string ↔ registration match: `moderation.reviewImage` must
    // be on `SECOND_FACTOR_GATED_MODERATION_PATHS` (guard.ts). The role check
    // is refused at the port for a moderator with no second factor; the
    // requireStaffSecondFactor step-up gate must raise that first, as
    // `SECOND_FACTOR_REQUIRED`, and short-circuit before the use case runs.
    const hasStaffRole = portHasStaffRole({
      held: ["COMMUNITY_MODERATOR"],
      enrolled: false,
    });
    const tx = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    const caller = callerFor({
      actorHumanId: MODERATOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { tx } as unknown as Ctx["repos"],
    });

    await expect(
      caller.moderation.reviewImage({ recordId: RECORD_ID, decision: "APPROVE" }),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expect(hasStaffRole).toHaveBeenCalledTimes(1);
    expect(hasStaffRole).toHaveBeenCalledWith(MIDDLEWARE_STAFF_PROBE(MODERATOR_ID));
    // Gate short-circuited before the use case opened a transaction.
    expect(tx).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Second-wave ops surface: queueBreakdown / severityHistogram / alertState /
// lookupByKey (reads, ADMIN+DEVELOPER) and resolveUnscannable / rescanImage
// (writes, ADMIN ONLY).
//
// The read/write gate SPLIT is the thing these tests exist to pin. A DEVELOPER
// must be able to see that the drain is dead at 3am and must NOT be able to
// terminally resolve a record or discard a machine verdict.
// ─────────────────────────────────────────────────────────────────────────────

const OPS_WINDOW = {
  pendingDueBefore: new Date("2026-07-08T11:00:00.000Z"),
  moderatedBefore: new Date("2026-07-07T12:00:00.000Z"),
  degradedSince: new Date("2026-07-08T10:00:00.000Z"),
  maxRequeues: 3,
};

describe("moderation.queueBreakdown", () => {
  it("forbids a COMMUNITY_MODERATOR and admits ADMIN/DEVELOPER", async () => {
    await expect(
      opsCaller(["COMMUNITY_MODERATOR"], {}).moderation.queueBreakdown(
        OPS_WINDOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    for (const role of ["ADMIN", "DEVELOPER"]) {
      await expect(
        opsCaller([role], {}).moderation.queueBreakdown(OPS_WINDOW),
      ).resolves.toMatchObject({ maxRequeues: 3 });
    }
  });

  it("passes the caller's window through untouched", async () => {
    const countQueueHealthByKind = vi.fn(async () => ({
      byKind: {
        EVENT_HERO: { ...HEALTHY_COUNTS, degradedRecent: 9 },
        AVATAR: HEALTHY_COUNTS,
        BANNER: HEALTHY_COUNTS,
        PAGE_MEDIA: HEALTHY_COUNTS,
      },
      unrecognizedKinds: HEALTHY_COUNTS,
    }));
    const caller = opsCaller(["ADMIN"], { countQueueHealthByKind });

    const out = await caller.moderation.queueBreakdown(OPS_WINDOW);

    expect(countQueueHealthByKind).toHaveBeenCalledWith(OPS_WINDOW);
    expect(out.byKind.EVENT_HERO.degradedRecent).toBe(9);
  });

  it("2FA step-up: blocks an ops actor missing an enrolled 2nd factor", async () => {
    // Pins `moderation.queueBreakdown` onto guard.ts's per-path allowlist.
    // Without the entry this procedure is silently un-2FA'd.
    const countQueueHealthByKind = vi.fn();
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsCaller(["ADMIN"], { countQueueHealthByKind }, staff);

    await expect(
      caller.moderation.queueBreakdown(OPS_WINDOW),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expectOnlyTheMiddlewareAsked(staff);
    expect(countQueueHealthByKind).not.toHaveBeenCalled();
  });
});

describe("moderation.severityHistogram", () => {
  const WINDOW = {
    since: new Date("2026-06-08T12:00:00.000Z"),
    until: NOW,
  };

  it("forbids a COMMUNITY_MODERATOR", async () => {
    await expect(
      opsCaller(["COMMUNITY_MODERATOR"], {}).moderation.severityHistogram(
        WINDOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns aggregate buckets and NO row identity", async () => {
    const countSeverityHistogram = vi.fn(async () => [
      { severity: 6, count: 4 },
    ]);
    const caller = opsCaller(["DEVELOPER"], { countSeverityHistogram });

    const out = await caller.moderation.severityHistogram(WINDOW);

    expect(out.scanned).toBe(4);
    expect(out.buckets).toHaveLength(7);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("publicUrl");
  });

  it("2FA step-up: blocks an ops actor missing an enrolled 2nd factor", async () => {
    const countSeverityHistogram = vi.fn();
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsCaller(["ADMIN"], { countSeverityHistogram }, staff);

    await expect(
      caller.moderation.severityHistogram(WINDOW),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expectOnlyTheMiddlewareAsked(staff);
    expect(countSeverityHistogram).not.toHaveBeenCalled();
  });
});

describe("moderation.alertState", () => {
  it("forbids a COMMUNITY_MODERATOR", async () => {
    await expect(
      opsCaller(["COMMUNITY_MODERATOR"], {}).moderation.alertState({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads the edge-trigger state WITHOUT writing it", async () => {
    // The `platformSettings.upsert` in `OPS_REPO_DEFAULTS` throws, so a write
    // on this path fails the test rather than quietly resetting the Discord
    // fingerprint and re-arming a suppressed alert.
    const sentAt = new Date("2026-07-08T09:00:00.000Z");
    const caller = opsCaller(["ADMIN"], {}, undefined, {
      platformSettings: {
        get: vi.fn(async (key: string) => ({
          key,
          value: JSON.stringify({
            fingerprint: "pendingOverdue|awaitingReview",
            sentAt: sentAt.toISOString(),
          }),
          createdAt: NOW,
          updatedAt: NOW,
        })),
        getAll: vi.fn(async () => []),
        upsert: vi.fn(async () => {
          throw new Error("alertState WROTE to platformSettings");
        }),
      },
    });

    const out = await caller.moderation.alertState({});

    expect(out).toMatchObject({
      state: "paged",
      fingerprint: "pendingOverdue|awaitingReview",
      firingSignals: ["pendingOverdue", "awaitingReview"],
      lastPagedAt: sentAt,
    });
  });

  it("2FA step-up: blocks an ops actor missing an enrolled 2nd factor", async () => {
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsCaller(["ADMIN"], {}, staff);

    await expect(caller.moderation.alertState({})).rejects.toMatchObject(
      SECOND_FACTOR_REFUSAL,
    );
    expectOnlyTheMiddlewareAsked(staff);
  });
});

describe("moderation.lookupByKey", () => {
  const KEY = "events/hero/abc.jpg";

  it("forbids a COMMUNITY_MODERATOR", async () => {
    const getByKey = vi.fn(async () => null);
    const caller = opsCaller(["COMMUNITY_MODERATOR"], { getByKey });

    await expect(
      caller.moderation.lookupByKey({ storageKey: KEY }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getByKey).not.toHaveBeenCalled();
  });

  it("WITHHOLDS everything that DESCRIBES an un-reviewed hold, not just the key", async () => {
    // Withholding the key alone looked like a control and was not: the caller
    // SUPPLIED the key, so the key is not the disclosure. The disclosure is
    // "this key is un-reviewed flagged content, on that event, held since
    // then" — status, degraded, subject and timing — and the first cut returned
    // all of it to a gate that admits DEVELOPERs who are not moderators.
    const getByKey = vi.fn(async () =>
      flaggedRecord({
        degraded: false,
        reviewedAt: null,
        requeues: 0,
        lastError: "azure 401",
      }),
    );
    const caller = opsCaller(["DEVELOPER"], { getByKey });

    const out = await caller.moderation.lookupByKey({ storageKey: KEY });

    expect(out.found).toBe(true);
    expect(out.withheld).toEqual({
      storageKey: true,
      lastError: true,
      status: true,
      subjectType: true,
      subjectId: true,
      degraded: true,
      moderatedAt: true,
      nextAttemptAt: true,
    });
    expect(out.item).toEqual({
      recordId: RECORD_ID,
      kind: "EVENT_HERO",
      requeues: 0,
      attempts: 0,
    });
    expect(out.item).not.toHaveProperty("publicUrl");
    // The serialized ITEM, not the whole response: the top-level `storageKey`
    // is a verbatim echo of what the caller typed, so asserting over the whole
    // payload would only assert that they did not look themselves up.
    const wire = JSON.stringify(out.item);
    expect(wire).not.toContain(EVENT_ID);
    expect(wire).not.toContain("FLAGGED");
    expect(wire).not.toContain("azure 401");
    // The echo is still there so a racing response can be matched to its
    // request — and it is safe, because the caller already had it.
    expect(out.storageKey).toBe(KEY);
  });

  it("returns the FULL record for an operational row", async () => {
    // A DEVELOPER at 3am with a key from a Sentry report is the reason this
    // procedure exists, and PENDING / ORPHANED / degraded rows are where that
    // actually happens. There is no content to protect here, so nothing is
    // withheld — which is why the gate stays ADMIN/DEVELOPER rather than being
    // narrowed to ADMIN.
    const getByKey = vi.fn(async () =>
      flaggedRecord({ degraded: true, requeues: 3, lastError: "azure 401" }),
    );
    const caller = opsCaller(["DEVELOPER"], { getByKey });

    const out = await caller.moderation.lookupByKey({ storageKey: KEY });

    expect(out.withheld).toEqual({
      storageKey: false,
      lastError: false,
      status: false,
      subjectType: false,
      subjectId: false,
      degraded: false,
      moderatedAt: false,
      nextAttemptAt: false,
    });
    expect(out.item).toMatchObject({
      storageKey: "events/hero/abc.jpg",
      lastError: "azure 401",
      status: "FLAGGED",
      degraded: true,
      subjectType: "EVENT",
      subjectId: EVENT_ID,
    });
  });

  it("reports a miss without throwing", async () => {
    const caller = opsCaller(["ADMIN"], {});

    await expect(
      caller.moderation.lookupByKey({ storageKey: "events/legacy.jpg" }),
    ).resolves.toMatchObject({ found: false, item: null });
  });

  it("2FA step-up: blocks an ops actor missing an enrolled 2nd factor", async () => {
    const getByKey = vi.fn(async () => null);
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsCaller(["ADMIN"], { getByKey }, staff);

    await expect(
      caller.moderation.lookupByKey({ storageKey: KEY }),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expectOnlyTheMiddlewareAsked(staff);
    expect(getByKey).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two ops WRITES. ADMIN only.
// ─────────────────────────────────────────────────────────────────────────────

const opsWriteCaller = (
  held: string[],
  txRepos: Record<string, unknown>,
  staff: StaffFake = staffWithRoles(held),
) => {
  const repos: Record<string, unknown> = { ...txRepos };
  repos.tx = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(repos));
  return callerFor({
    actorHumanId: MODERATOR_ID,
    authz: staff as unknown as Ctx["authz"],
    clock: { now: () => NOW } as unknown as Ctx["clock"],
    repos: repos as unknown as Ctx["repos"],
  });
};

const exhaustedRecord = flaggedRecord({
  degraded: true,
  requeues: 3,
  reviewedAt: null,
});

describe("moderation.resolveUnscannable", () => {
  const makeRepos = (over: Record<string, unknown> = {}) => ({
    imageModerationRecords: {
      getById: vi.fn(async () => exhaustedRecord),
      resolveUnscannable: vi.fn(async () => 1),
      ...over,
    },
    audit: { log: vi.fn(async () => {}) },
  });

  it("FORBIDS a DEVELOPER — reads and writes are not the same privilege", async () => {
    // THE gate split. A DEVELOPER can see the queue is broken (queueSnapshot
    // admits them) and cannot terminally resolve a record.
    const repos = makeRepos();
    const caller = opsWriteCaller(["DEVELOPER"], repos);

    await expect(
      caller.moderation.resolveUnscannable({
        recordId: RECORD_ID,
        maxRequeues: 3,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repos.imageModerationRecords.resolveUnscannable).not.toHaveBeenCalled();
  });

  it("FORBIDS a COMMUNITY_MODERATOR", async () => {
    const caller = opsWriteCaller(["COMMUNITY_MODERATOR"], makeRepos());

    await expect(
      caller.moderation.resolveUnscannable({
        recordId: RECORD_ID,
        maxRequeues: 3,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admits an ADMIN and takes the actor from ctx, never the payload", async () => {
    const repos = makeRepos();
    const caller = opsWriteCaller(["ADMIN"], repos);

    const out = await caller.moderation.resolveUnscannable({
      recordId: RECORD_ID,
      maxRequeues: 3,
    });

    expect(out).toEqual({
      resolved: true,
      status: "ORPHANED",
      reason: "resolved",
    });
    expect(repos.imageModerationRecords.resolveUnscannable).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedByHumanId: MODERATOR_ID }),
    );
  });

  it("gives the client no way to name a different actor", async () => {
    const caller = opsWriteCaller(["ADMIN"], makeRepos());

    await expect(
      caller.moderation.resolveUnscannable({
        recordId: RECORD_ID,
        maxRequeues: 3,
        actorHumanId: ACTOR_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("2FA step-up: blocks an ADMIN missing an enrolled 2nd factor", async () => {
    const repos = makeRepos();
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsWriteCaller(["ADMIN"], repos, staff);

    await expect(
      caller.moderation.resolveUnscannable({
        recordId: RECORD_ID,
        maxRequeues: 3,
      }),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expectOnlyTheMiddlewareAsked(staff);
    expect(repos.imageModerationRecords.resolveUnscannable).not.toHaveBeenCalled();
  });
});

describe("moderation.rescanImage", () => {
  const makeRepos = (record: unknown = exhaustedRecord) => ({
    imageModerationRecords: {
      getById: vi.fn(async () => record),
      requeueForRescan: vi.fn(async () => 1),
    },
    audit: { log: vi.fn(async () => {}) },
  });

  it("FORBIDS a DEVELOPER", async () => {
    const repos = makeRepos();
    const caller = opsWriteCaller(["DEVELOPER"], repos);

    await expect(
      caller.moderation.rescanImage({ recordId: RECORD_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repos.imageModerationRecords.requeueForRescan).not.toHaveBeenCalled();
  });

  it("admits an ADMIN for a machine-state row", async () => {
    const repos = makeRepos();
    const caller = opsWriteCaller(["ADMIN"], repos);

    await expect(
      caller.moderation.rescanImage({ recordId: RECORD_ID }),
    ).resolves.toEqual({
      requeued: true,
      status: "PENDING",
      reason: "requeued",
    });
  });

  it("refuses a REJECTED row through the transport too", async () => {
    const repos = makeRepos(
      flaggedRecord({
        status: "REJECTED",
        degraded: false,
        reviewedAt: NOW,
        requeues: 0,
      }),
    );
    const caller = opsWriteCaller(["ADMIN"], repos);

    await expect(
      caller.moderation.rescanImage({ recordId: RECORD_ID }),
    ).resolves.toEqual({
      requeued: false,
      status: "REJECTED",
      reason: "human_decided",
    });
    expect(repos.imageModerationRecords.requeueForRescan).not.toHaveBeenCalled();
  });

  it("2FA step-up: blocks an ADMIN missing an enrolled 2nd factor", async () => {
    const repos = makeRepos();
    const staff = staffWithRoles(["ADMIN"], false);
    const caller = opsWriteCaller(["ADMIN"], repos, staff);

    await expect(
      caller.moderation.rescanImage({ recordId: RECORD_ID }),
    ).rejects.toMatchObject(SECOND_FACTOR_REFUSAL);
    expectOnlyTheMiddlewareAsked(staff);
    expect(repos.imageModerationRecords.requeueForRescan).not.toHaveBeenCalled();
  });
});
