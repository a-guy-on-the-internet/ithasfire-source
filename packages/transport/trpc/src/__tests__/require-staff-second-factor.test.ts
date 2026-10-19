import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { router, authedProcedure } from "../init";
import { buildBaseCtx } from "../routers/__tests__/test-helpers";
import type { Ctx } from "../context";

/**
 * Coverage for `requireStaffSecondFactor` (guard.ts) — the middleware that
 * raises `SECOND_FACTOR_REQUIRED` early on the `/platform` and `/moderate`
 * tRPC paths. The rule itself is the authz port's (`hasStaffRole`); the
 * stand-in procedures below have no role check of their own, so what these
 * tests pin is the early error and the paths it applies to. Exercised through
 * a minimal stand-in router tree (mirrors `default-rate-limit.test.ts`'s
 * pattern) rather than the real `platformRouter`/`communityRouter`, so the
 * test targets ONLY the middleware's path-matching + enforcement behavior,
 * independent of any one procedure's business logic.
 */
const testProcedures = {
  platform: router({
    // Any `platform.*` path is gated except `checkStaffAccess` (the probe).
    someAction: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    checkStaffAccess: authedProcedure
      .input(z.object({}).optional())
      .query(() => "probe-ok"),
  }),
  community: router({
    createListing: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    // The ownerless place a listing can be held at, its edit, archive and
    // restore.
    createPlace: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    updatePlace: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    archivePlace: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    restorePlace: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    // The read the place card asks before opening the edit dialog.
    getPlaceEditability: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    // The DRAFT-authoring pair that goes with createListing.
    updateListing: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    publishListing: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    checkModeratorAccess: authedProcedure
      .input(z.object({}).optional())
      .query(() => "probe-ok"),
    // Not on the gated allowlist — must never be touched by the gate.
    myRsvps: authedProcedure.input(z.object({}).optional()).query(() => "ok"),
  }),
  settlements: router({
    createFromOrder: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
  }),
  splits: router({
    listForOrder: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
  }),
  consent: router({
    listForHuman: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    listForAnonymous: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
  }),
  credits: router({
    grant: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
  }),
  placeReviews: router({
    hide: authedProcedure.input(z.object({}).optional()).mutation(() => "ok"),
    unhide: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    listPlatform: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    reassignPlace: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    toggleDirectoryListing: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    recalculateStats: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
  }),
  places: router({
    // The /platform/places venue-verification cluster: unconditionally
    // staff-only use cases that happen to live outside the `platform.*`
    // prefix, so they need explicit allowlist entries.
    acknowledgePlaceVerification: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    releasePlaceVerification: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    reviewPlaceVerification: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    getPlatformVerificationQueue: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    setPlaceDirectoryListing: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    // Deliberately NOT gated — its staff check is a conditional branch (the
    // request's own submitter is authorized too), so path-level gating would
    // over-gate ordinary org users who happen to hold a staff role.
    getVerificationDocumentUrl: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    // An ordinary org-side write; must never be touched by the gate.
    upsertPlace: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
  }),
  quotas: router({
    listExpansionRequests: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    reviewExpansionRequest: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    listDefaultLimits: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    updateDefaultLimit: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
  }),
  support: router({
    listThreads: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    replyToThread: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
  }),
  categories: router({
    listRequests: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    reviewRequest: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    create: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    delete: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    setSeoType: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    rename: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    setTranslations: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    changeSlug: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    suggestTranslations: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    setActive: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    reorder: authedProcedure
      .input(z.object({}).optional())
      .mutation(() => "ok"),
    listAll: authedProcedure
      .input(z.object({}).optional())
      .query(() => "ok"),
    // The public, active-only list: NOT in the allowlist.
    list: authedProcedure.input(z.object({}).optional()).query(() => "ok"),
  }),
  unrelated: router({
    // Outside `platform.*` / the moderation allowlist entirely.
    ping: authedProcedure.input(z.object({}).optional()).query(() => "pong"),
  }),
};

const callerFor = (ctx: Ctx) => router(testProcedures).createCaller(ctx);

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

/**
 * The middleware's one question to the port: the default probe (no
 * `allowWithoutSecondFactor`) for any gated role.
 */
const GATED_ROLE_PROBE = {
  actorHumanId: ACTOR_ID,
  requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER", "COMMUNITY_MODERATOR"],
};

/** The port's answer for a role holder with no second factor enrolled. */
const UNENROLLED_HOLDER = {
  allowed: false,
  secondFactorRequired: true as const,
};

/**
 * An authz fake that answers `hasStaffRole` the way the port does: a role
 * holder with no second factor is refused, with `secondFactorRequired`,
 * unless the caller passes `allowWithoutSecondFactor`.
 */
const portStaffRole = (actor: { holdsRole: boolean; enrolled: boolean }) =>
  vi.fn(async (input: { allowWithoutSecondFactor?: boolean }) => {
    if (!actor.holdsRole) return { allowed: false };
    if (input.allowWithoutSecondFactor || actor.enrolled) {
      return { allowed: true };
    }
    return { allowed: false, secondFactorRequired: true as const };
  });

describe("requireStaffSecondFactor against a port that applies the second-factor rule", () => {
  const ctxFor = (
    hasStaffRole: ReturnType<typeof portStaffRole>,
    enrolled: boolean,
  ) => {
    const hasSecondFactorEnrolled = vi.fn(async () => enrolled);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    return { ctx, hasSecondFactorEnrolled };
  };

  // The port's default answer for an un-enrolled role holder is
  // `allowed: false` with `secondFactorRequired`. The middleware keys on the
  // flag: read as plain "not staff", the answer would let it step aside and
  // the caller would lose the code the web redirects on.
  it.each([
    ["platform.someAction", (c: ReturnType<typeof callerFor>) => c.platform.someAction({})],
    ["community.createListing", (c: ReturnType<typeof callerFor>) => c.community.createListing({})],
    ["settlements.createFromOrder", (c: ReturnType<typeof callerFor>) => c.settlements.createFromOrder({})],
  ] as const)(
    "%s: an un-enrolled staff member still gets SECOND_FACTOR_REQUIRED",
    async (_path, call) => {
      const hasStaffRole = portStaffRole({ holdsRole: true, enrolled: false });
      const { ctx } = ctxFor(hasStaffRole, false);

      await expect(call(callerFor(ctx))).rejects.toMatchObject({
        code: "FORBIDDEN",
        meta: { appCode: "SECOND_FACTOR_REQUIRED" },
      });
      // The default probe: the middleware never opts out of the rule.
      expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
    },
  );

  it("lets an enrolled staff member through a gated path", async () => {
    const hasStaffRole = portStaffRole({ holdsRole: true, enrolled: true });
    const { ctx } = ctxFor(hasStaffRole, true);

    await expect(callerFor(ctx).platform.someAction({})).resolves.toBe("ok");
  });

  it("steps aside for a non-staff actor on a gated path, with no enrolment read", async () => {
    const hasStaffRole = portStaffRole({ holdsRole: false, enrolled: false });
    const { ctx, hasSecondFactorEnrolled } = ctxFor(hasStaffRole, false);

    await expect(callerFor(ctx).platform.someAction({})).resolves.toBe("ok");
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("leaves both probe paths answering for an un-enrolled staff member", async () => {
    const hasStaffRole = portStaffRole({ holdsRole: true, enrolled: false });
    const { ctx, hasSecondFactorEnrolled } = ctxFor(hasStaffRole, false);
    const caller = callerFor(ctx);

    await expect(caller.platform.checkStaffAccess({})).resolves.toBe(
      "probe-ok",
    );
    await expect(caller.community.checkModeratorAccess({})).resolves.toBe(
      "probe-ok",
    );
    // The middleware does not run its check on a probe path at all.
    expect(hasStaffRole).not.toHaveBeenCalled();
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("does not raise the early error on an unlisted path; the procedure's own staff check refuses there", async () => {
    const hasStaffRole = portStaffRole({ holdsRole: true, enrolled: false });
    const { ctx, hasSecondFactorEnrolled } = ctxFor(hasStaffRole, false);

    await expect(callerFor(ctx).unrelated.ping({})).resolves.toBe("pong");
    expect(hasStaffRole).not.toHaveBeenCalled();
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });
});

// The fakes below answer as the port does. `repos.humans` stays wired with a
// spy so a test can show the middleware never reads enrolment itself: the
// port's answer is the only input.
describe("requireStaffSecondFactor (guard.ts)", () => {
  it("blocks a platform.* mutation for a staff member missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.platform.someAction({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      meta: { appCode: "SECOND_FACTOR_REQUIRED" },
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("allows a platform.* mutation through for a staff member WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.platform.someAction({})).resolves.toBe("ok");
  });

  it("never touches repos.humans for an actor holding no gated role at all (lets the procedure's own role check reject)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    // The stand-in procedure has no role check of its own, so it just
    // resolves — the point being that the GATE didn't block it, and
    // crucially never called hasSecondFactorEnrolled for a non-staff actor.
    await expect(caller.platform.someAction({})).resolves.toBe("ok");
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("excludes the platform.checkStaffAccess probe from the gate even when 2FA is missing", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.platform.checkStaffAccess({})).resolves.toBe(
      "probe-ok",
    );
    expect(hasStaffRole).not.toHaveBeenCalled();
  });

  it("blocks community.createListing for a moderator missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.community.createListing({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it.each([
    "createPlace",
    "updatePlace",
    "archivePlace",
    "restorePlace",
    "getPlaceEditability",
    "updateListing",
    "publishListing",
  ] as const)(
    "blocks community.%s for a moderator missing an enrolled 2nd factor",
    async (procedure) => {
      // The community-place writes and the DRAFT-authoring pair. Publishing
      // is the moment an ownerless listing becomes visible to everyone, and
      // a place is a public page; if createListing needs a second factor, so
      // do these. A new community.* procedure gets the early
      // SECOND_FACTOR_REQUIRED only once its path string is in
      // SECOND_FACTOR_GATED_MODERATION_PATHS; this pins that each listed
      // here does.
      const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
      const hasSecondFactorEnrolled = vi.fn(async () => false);
      const ctx = buildBaseCtx({
        actorHumanId: ACTOR_ID,
        authz: { hasStaffRole } as unknown as Ctx["authz"],
        repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
      });
      const caller = callerFor(ctx);

      await expect(caller.community[procedure]({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
    },
  );

  it.each([
    "createPlace",
    "updatePlace",
    "archivePlace",
    "restorePlace",
    "getPlaceEditability",
    "updateListing",
    "publishListing",
  ] as const)(
    "allows community.%s through for a moderator WITH an enrolled 2nd factor",
    async (procedure) => {
      const hasStaffRole = vi.fn(async () => ({ allowed: true }));
      const hasSecondFactorEnrolled = vi.fn(async () => true);
      const ctx = buildBaseCtx({
        actorHumanId: ACTOR_ID,
        authz: { hasStaffRole } as unknown as Ctx["authz"],
        repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
      });
      const caller = callerFor(ctx);

      await expect(caller.community[procedure]({})).resolves.toBe("ok");
    },
  );

  it("excludes the community.checkModeratorAccess probe from the gate", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.community.checkModeratorAccess({})).resolves.toBe(
      "probe-ok",
    );
  });

  it("does not gate a non-allowlisted community procedure (e.g. myRsvps) even for a staff member missing 2FA", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.community.myRsvps({})).resolves.toBe("ok");
    expect(hasStaffRole).not.toHaveBeenCalled();
  });

  it("blocks settlements.createFromOrder (money movement) for an ADMIN missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(
      caller.settlements.createFromOrder({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("blocks splits.listForOrder (order-split inspection) for an ADMIN missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.splits.listForOrder({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows splits.listForOrder through for an ADMIN WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.splits.listForOrder({})).resolves.toBe("ok");
  });

  it("does not gate splits.listForOrder for a non-staff actor (lets the procedure's own ADMIN check reject)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.splits.listForOrder({})).resolves.toBe("ok");
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("blocks consent.listForHuman (DSAR lookup) for an ADMIN missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.consent.listForHuman({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows consent.listForHuman through for an ADMIN WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.consent.listForHuman({})).resolves.toBe("ok");
  });

  it("blocks consent.listForAnonymous (DSAR lookup by device id) for an ADMIN missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.consent.listForAnonymous({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows consent.listForAnonymous through for an ADMIN WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.consent.listForAnonymous({})).resolves.toBe("ok");
  });

  it("does not gate consent.* for a non-staff actor (lets each procedure's own ADMIN check reject)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.consent.listForHuman({})).resolves.toBe("ok");
    await expect(caller.consent.listForAnonymous({})).resolves.toBe("ok");
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("blocks credits.grant (money-adjacent platform credit issuance) for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.credits.grant({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows credits.grant through for staff WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.credits.grant({})).resolves.toBe("ok");
  });

  it("does not gate credits.grant for a non-staff actor (lets the use case's own requirePlatformStaff reject)", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.credits.grant({})).resolves.toBe("ok");
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("blocks each newly-gated placeReviews.* path for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.placeReviews.hide({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.placeReviews.unhide({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.placeReviews.listPlatform({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.placeReviews.reassignPlace({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.placeReviews.toggleDirectoryListing({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.placeReviews.recalculateStats({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows placeReviews.hide through for staff WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.placeReviews.hide({})).resolves.toBe("ok");
  });

  // ── places.* venue verification ──────────────────────────────────────
  //
  // These sat outside the gate entirely: an ADMIN with no enrolled second
  // factor could work the whole venue-verification queue through `places.*`
  // while the identical `platform.*` procedures were gated. The write that
  // made it acute — the org-side `places.updatePlaceVerificationStatus` — was
  // deleted outright (it also let an org admin self-issue a verified badge);
  // these entries close the rest of the cluster.
  it("blocks each newly-gated places.* verification path for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(
      caller.places.acknowledgePlaceVerification({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.places.releasePlaceVerification({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.places.reviewPlaceVerification({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.places.getPlatformVerificationQueue({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.places.setPlaceDirectoryListing({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows places.reviewPlaceVerification through for staff WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.places.reviewPlaceVerification({})).resolves.toBe("ok");
  });

  it("does not gate the org-side places.* surface, nor the submitter-readable document URL", async () => {
    // `getPlatformVerificationQueue` is also called by the ORG-side /verify
    // page. A non-staff org admin must keep passing straight through to the
    // procedure's own STAFF_ONLY rejection, and ordinary org writes like
    // upsertPlace must never be gated for anyone.
    const hasStaffRole = vi.fn(async () => ({ allowed: false }));
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.places.getPlatformVerificationQueue({})).resolves.toBe(
      "ok",
    );
    await expect(caller.places.upsertPlace({})).resolves.toBe("ok");
    expect(hasSecondFactorEnrolled).not.toHaveBeenCalled();
  });

  it("leaves places.getVerificationDocumentUrl ungated (conditional staff branch)", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.places.getVerificationDocumentUrl({})).resolves.toBe(
      "ok",
    );
    expect(hasStaffRole).not.toHaveBeenCalled();
  });

  it("blocks each newly-gated quotas.* path for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(
      caller.quotas.listExpansionRequests({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.quotas.reviewExpansionRequest({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.quotas.listDefaultLimits({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.quotas.updateDefaultLimit({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows quotas.listExpansionRequests through for staff WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.quotas.listExpansionRequests({})).resolves.toBe("ok");
  });

  it("blocks each newly-gated support.* path for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.support.listThreads({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.support.replyToThread({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("allows support.listThreads through for staff WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.support.listThreads({})).resolves.toBe("ok");
  });

  it("blocks each newly-gated categories.* path for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.categories.listRequests({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.categories.reviewRequest({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.categories.create({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "SECOND_FACTOR_REQUIRED",
    });
    await expect(caller.categories.delete({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);
  });

  it("blocks the category lifecycle paths (setSeoType, rename, setActive, reorder, listAll) for staff missing an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);
    const refused = { code: "FORBIDDEN", message: "SECOND_FACTOR_REQUIRED" };

    await expect(caller.categories.setSeoType({})).rejects.toMatchObject(
      refused,
    );
    await expect(caller.categories.rename({})).rejects.toMatchObject(refused);
    await expect(caller.categories.setActive({})).rejects.toMatchObject(
      refused,
    );
    await expect(caller.categories.reorder({})).rejects.toMatchObject(refused);
    await expect(caller.categories.listAll({})).rejects.toMatchObject(refused);
    await expect(caller.categories.setTranslations({})).rejects.toMatchObject(
      refused,
    );
    await expect(caller.categories.changeSlug({})).rejects.toMatchObject(
      refused,
    );
    await expect(
      caller.categories.suggestTranslations({}),
    ).rejects.toMatchObject(refused);
    expect(hasStaffRole).toHaveBeenCalledWith(GATED_ROLE_PROBE);

    // The public list is not a staff path: the same holder still reads it.
    await expect(caller.categories.list({})).resolves.toBe("ok");
  });

  it("allows categories.listRequests through for staff WITH an enrolled 2nd factor", async () => {
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const hasSecondFactorEnrolled = vi.fn(async () => true);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.categories.listRequests({})).resolves.toBe("ok");
  });

  it("does not gate paths entirely outside the platform/moderation surface", async () => {
    const hasStaffRole = vi.fn(async () => UNENROLLED_HOLDER);
    const hasSecondFactorEnrolled = vi.fn(async () => false);
    const ctx = buildBaseCtx({
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole } as unknown as Ctx["authz"],
      repos: { humans: { hasSecondFactorEnrolled } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    await expect(caller.unrelated.ping({})).resolves.toBe("pong");
    expect(hasStaffRole).not.toHaveBeenCalled();
  });
});
