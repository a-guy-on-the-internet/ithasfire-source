import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { orgsRouter } from "../orgs";
import * as orgsModule from "@th/core/use-cases/orgs";
import * as inviteMemberModule from "@th/core/use-cases/orgs/invite-member";
import * as transferOwnershipModule from "@th/core/use-cases/orgs/transfer-ownership";
import { createTestLogger } from "@th/test-utils";

const hasOwn = <T extends object>(obj: T | undefined, key: keyof T): boolean =>
  !!obj && Object.prototype.hasOwnProperty.call(obj, key);

const buildCtx = (overrides?: Partial<Ctx>): Ctx => {
  const repos = hasOwn(overrides, "repos")
    ? (overrides!.repos as Ctx["repos"])
    : ({} as unknown as Ctx["repos"]);
  const idempotency =
    overrides?.idempotency ??
    ({
      begin: vi.fn(),
      get: vi.fn(),
      commit: vi.fn(),
      fail: vi.fn(),
    } as unknown as Ctx["idempotency"]);
  const clock =
    overrides?.clock ??
    ({
      now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
    } as unknown as Ctx["clock"]);
  const logger = hasOwn(overrides, "logger")
    ? (overrides!.logger as Ctx["logger"])
    : createTestLogger();
  const payments =
    overrides?.payments ??
    ({
      createPaymentIntent: vi.fn(),
      refundPaymentIntent: vi.fn(),
      createTransfer: vi.fn(),
      getChargeIdForPaymentIntent: vi.fn(),
      getPaymentMethodType: vi.fn(),
    } as unknown as Ctx["payments"]);
  const authn =
    overrides?.authn ??
    ({
      ensureAuthedHuman: vi.fn(),
      ensureAuthedHumanFromApiKey: vi.fn(),
      getProviderUserId: vi.fn(),
    } as unknown as Ctx["authn"]);
  const authz =
    overrides?.authz ??
    ({
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"]);
  const placeLayoutParser =
    overrides?.placeLayoutParser ??
    ({
      parse: vi.fn(),
    } as unknown as Ctx["placeLayoutParser"]);
  const placeLayoutStreaming =
    overrides?.placeLayoutStreaming ??
    ({
      publishPlaceLayoutReplaced: vi.fn(),
    } as unknown as Ctx["placeLayoutStreaming"]);

  const searchQuery =
    overrides?.searchQuery ??
    ({
      autocomplete: vi.fn(),
      search: vi.fn(),
      related: vi.fn(),
      health: vi.fn(),
    } as unknown as Ctx["searchQuery"]);

  const searchPrompts =
    overrides?.searchPrompts ??
    ({
      listPrompts: vi.fn(),
    } as unknown as Ctx["searchPrompts"]);

  const geo = hasOwn(overrides, "geo")
    ? (overrides!.geo as Ctx["geo"])
    : ({
        nearbyEvents: vi.fn(),
        nearbyPlaces: vi.fn(),
        boxSearch: vi.fn(),
        distance: vi.fn(),
        health: vi.fn(),
      } as unknown as Ctx["geo"]);

  const notify =
    overrides?.notify ??
    (vi.fn(async () => ({ ok: true })) as unknown as Ctx["notify"]);

  const fileStorage =
    overrides?.fileStorage ?? ({} as unknown as Ctx["fileStorage"]);

  const rateLimit =
    overrides?.rateLimit ??
    (withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }) as unknown as Ctx["rateLimit"]);

  return {
    repos,
    fileStorage,
    idempotency,
    clock,
    logger,
    payments,
    authn,
    authz,
    placeLayoutParser,
    placeLayoutStreaming,
    searchQuery,
    searchPrompts,
    geo,
    notify,
    rateLimit,
    auth: hasOwn(overrides, "auth")
      ? (overrides!.auth ?? null)
      : {
          userId: overrides?.actorHumanId ?? "actor-1",
          sessionId: null,
          token: "token",
        },
    authToken: hasOwn(overrides, "authToken")
      ? (overrides!.authToken ?? null)
      : "token",
    apiKey: hasOwn(overrides, "apiKey") ? (overrides!.apiKey ?? null) : null,
    actorHumanId: hasOwn(overrides, "actorHumanId")
      ? (overrides!.actorHumanId ?? null)
      : "77777777-7777-4777-8777-777777777777",
    viewerLocation: hasOwn(overrides, "viewerLocation")
      ? (overrides!.viewerLocation ?? null)
      : null,
  };
};

describe("orgsRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards dependencies to createOrg", async () => {
    const createOrgSpy = vi
      .spyOn(orgsModule, "createOrg")
      .mockResolvedValue({ orgId: "88888888-8888-4888-8888-888888888888" });
    const ctx = buildCtx();
    const testRouter = trpcRouter({ orgs: router(orgsRouter) });
    const caller = testRouter.createCaller(ctx);

    const input = { name: "Test Org", clientKey: "org-key-123" };

    const result = await caller.orgs.createOrg(input);

    expect(result).toEqual({ orgId: "88888888-8888-4888-8888-888888888888" });
    expect(createOrgSpy).toHaveBeenCalledTimes(1);
    expect(createOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        name: input.name,
      }),
    );
  });

  it("rejects createOrg when actor is missing", async () => {
    const createOrgSpy = vi
      .spyOn(orgsModule, "createOrg")
      .mockResolvedValue({ orgId: "88888888-8888-4888-8888-888888888888" });
    const ctx = buildCtx({ actorHumanId: null, auth: null, authToken: null });
    const testRouter = trpcRouter({ orgs: router(orgsRouter) });
    const caller = testRouter.createCaller(ctx);

    await expect(
      caller.orgs.createOrg({ name: "No Actor", clientKey: "org-key-123" }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    expect(createOrgSpy).not.toHaveBeenCalled();
  });

  it("no longer exposes addMember (memberships are only created by the invitee accepting)", () => {
    expect(Object.keys(orgsRouter)).not.toContain("addMember");
    expect(Object.keys(orgsRouter)).toContain("inviteMember");
    expect(Object.keys(orgsRouter)).toContain("acceptInvitation");
    expect(Object.keys(orgsRouter)).toContain("previewInvitation");
    // Platform-wide email oracle removed (security review F13).
    expect(Object.keys(orgsRouter)).not.toContain("lookupHumanByEmail");
  });

  it("forwards rateLimit + reportError to inviteMember so the per-org daily cap is enforced", async () => {
    const spy = vi.spyOn(inviteMemberModule, "inviteMember").mockResolvedValue({
      invitation: {
        id: "inv-1",
        email: "x@example.com",
        role: "EDITOR",
        status: "PENDING",
        expiresAt: new Date("2024-01-08T00:00:00.000Z"),
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      },
      addedDirectly: false,
    });
    const reportError = vi.fn();
    const ctx = { ...buildCtx(), reportError } as Ctx;
    const caller = trpcRouter({ orgs: router(orgsRouter) }).createCaller(ctx);

    await caller.orgs.inviteMember({
      orgId: "99999999-9999-4999-8999-999999999999",
      email: "x@example.com",
      role: "EDITOR",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimit: ctx.rateLimit, reportError }),
      expect.objectContaining({ actorHumanId: ctx.actorHumanId }),
    );
  });

  it("forwards dependencies and the signed-in actor to transferOrgOwnership", async () => {
    const spy = vi
      .spyOn(transferOwnershipModule, "transferOrgOwnership")
      .mockResolvedValue({ ok: true, previousTargetRole: "EDITOR" });
    const ctx = buildCtx();
    const caller = trpcRouter({ orgs: router(orgsRouter) }).createCaller(ctx);
    const input = {
      orgId: "99999999-9999-4999-8999-999999999999",
      targetHumanId: "66666666-6666-4666-8666-666666666666",
    };

    await expect(caller.orgs.transferOwnership(input)).resolves.toEqual({
      ok: true,
      previousTargetRole: "EDITOR",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      { ...input, actorHumanId: ctx.actorHumanId },
    );
  });

  it("rejects transferOwnership when the actor is missing, and takes no actor id from the input", async () => {
    const spy = vi.spyOn(transferOwnershipModule, "transferOrgOwnership");
    const signedOut = trpcRouter({ orgs: router(orgsRouter) }).createCaller(
      buildCtx({ actorHumanId: null, auth: null, authToken: null }),
    );
    const input = {
      orgId: "99999999-9999-4999-8999-999999999999",
      targetHumanId: "66666666-6666-4666-8666-666666666666",
    };

    await expect(signedOut.orgs.transferOwnership(input)).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );

    const signedIn = trpcRouter({ orgs: router(orgsRouter) }).createCaller(
      buildCtx(),
    );
    await expect(
      signedIn.orgs.transferOwnership({
        ...input,
        actorHumanId: "55555555-5555-4555-8555-555555555555",
      } as typeof input),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("applies a per-actor hourly cap to inviteMember before the use case runs", async () => {
    const spy = vi.spyOn(inviteMemberModule, "inviteMember");
    const consume = vi.fn(async (key: string) => ({
      allowed: !key.startsWith("orgs:invite:actor:"),
      remaining: 0,
      retryAfterSeconds: 60,
    }));
    const ctx = buildCtx({
      rateLimit: withConsumeMany({ consume }) as unknown as Ctx["rateLimit"],
    });
    const caller = trpcRouter({ orgs: router(orgsRouter) }).createCaller(ctx);

    await expect(
      caller.orgs.inviteMember({
        orgId: "99999999-9999-4999-8999-999999999999",
        email: "x@example.com",
        role: "EDITOR",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(
      `orgs:invite:actor:${ctx.actorHumanId}`,
      20,
      3600,
    );
    expect(spy).not.toHaveBeenCalled();
  });
  it("rate-limits previewInvitation per actor (30/min) before the use case runs", async () => {
    const previewModule = await import("@th/core/use-cases/orgs/preview-invitation");
    const spy = vi.spyOn(previewModule, "previewInvitation");
    const consume = vi.fn(async (key: string) => ({
      allowed: !key.startsWith("orgs:previewInvitation:"),
      remaining: 0,
      retryAfterSeconds: 30,
    }));
    const ctx = buildCtx({ rateLimit: withConsumeMany({ consume }) as unknown as Ctx["rateLimit"] });
    const caller = trpcRouter({ orgs: router(orgsRouter) }).createCaller(ctx);

    await expect(caller.orgs.previewInvitation({ token: "t" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(consume).toHaveBeenCalledWith(`orgs:previewInvitation:${ctx.actorHumanId}`, 30, 60);
    expect(spy).not.toHaveBeenCalled();
  });
});
