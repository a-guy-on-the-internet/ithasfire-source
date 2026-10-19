import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { humansRouter } from "../humans";
import * as humansModule from "@th/core/use-cases/humans";
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
    auth: hasOwn(overrides, "auth") ? (overrides!.auth ?? null) : null,
    authToken: hasOwn(overrides, "authToken")
      ? (overrides!.authToken ?? null)
      : null,
    apiKey: hasOwn(overrides, "apiKey") ? (overrides!.apiKey ?? null) : null,
    actorHumanId: hasOwn(overrides, "actorHumanId")
      ? (overrides!.actorHumanId ?? null)
      : null,
    viewerLocation: hasOwn(overrides, "viewerLocation")
      ? (overrides!.viewerLocation ?? null)
      : null,
  };
};

describe("humansRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // F1/F12 (2026-09-29): both were public and are now server-side only.
  it("does not expose createHuman or provisionHumanForAuthUser", async () => {
    expect(humansRouter).not.toHaveProperty("createHuman");
    expect(humansRouter).not.toHaveProperty("provisionHumanForAuthUser");

    const createHumanSpy = vi.spyOn(humansModule, "createHuman");
    const provisionSpy = vi.spyOn(humansModule, "provisionHumanForAuthUser");
    const testRouter = trpcRouter({ humans: router(humansRouter) });
    const caller = testRouter.createCaller(buildCtx()) as unknown as {
      humans: Record<string, ((input: unknown) => Promise<unknown>) | undefined>;
    };

    await expect(
      caller.humans.createHuman!({
        email: "victim@example.com",
        clientKey: "a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.humans.provisionHumanForAuthUser!({
        authUserId: "u1",
        email: "victim@example.com",
        clientKey: "a",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(createHumanSpy).not.toHaveBeenCalled();
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  describe("getMyWorkSummary", () => {
    const WORK_SUMMARY = {
      performerEnabled: true,
      acceptsBookingRequests: false,
      hasWorkRoles: true,
      degraded: false,
      sentBookingRequestCount: 3,
      receivedBookingRequestCount: 4,
      pendingReceivedBookingRequestCount: 1,
      placeClaimCount: 5,
      editSuggestionCount: 6,
    };

    it("takes the actor from the session and wires the reporter", async () => {
      const spy = vi
        .spyOn(humansModule, "getMyWorkSummary")
        .mockResolvedValue(WORK_SUMMARY);
      const reportError = vi.fn();
      const ctx = {
        ...buildCtx({
          actorHumanId: "44444444-4444-4444-8444-444444444444",
        }),
        reportError,
      } as Ctx;
      const testRouter = trpcRouter({ humans: router(humansRouter) });
      const caller = testRouter.createCaller(ctx);

      const result = await caller.humans.getMyWorkSummary();

      expect(result).toEqual(WORK_SUMMARY);
      expect(spy).toHaveBeenCalledWith(
        // NOTE: `logger` is intentionally not compared by identity —
        // `requireAuth`'s `withActor` swaps in `ctx.logger.child({ actorHumanId })`.
        expect.objectContaining({
          repos: ctx.repos,
          // The use case degrades sub-counts to 0; without this the swallow
          // would be invisible in Sentry.
          reportError,
        }),
        // No client-supplied target: the actor comes from the session only.
        { actorHumanId: "44444444-4444-4444-8444-444444444444" },
      );
    });

    it("requires authentication", async () => {
      const ctx = buildCtx({
        actorHumanId: null,
        auth: null,
        authToken: null,
        apiKey: null,
      });
      const testRouter = trpcRouter({ humans: router(humansRouter) });
      const caller = testRouter.createCaller(ctx);

      await expect(caller.humans.getMyWorkSummary()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("maps domain errors to TRPC errors", async () => {
      vi.spyOn(humansModule, "getMyWorkSummary").mockRejectedValue({
        code: "not_found",
        message: "human_not_found",
      });
      const ctx = buildCtx({
        actorHumanId: "44444444-4444-4444-8444-444444444444",
      });
      const testRouter = trpcRouter({ humans: router(humansRouter) });
      const caller = testRouter.createCaller(ctx);

      await expect(caller.humans.getMyWorkSummary()).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "human_not_found",
      });
    });
  });

  it("requires authentication for getHuman", async () => {
    vi.spyOn(humansModule, "getHuman").mockResolvedValue({
      human: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "person@example.com",
        name: "Person",
        phoneMasked: null,
        status: "ACTIVE",
      },
    });

    const ctx = buildCtx({
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
    });
    const testRouter = trpcRouter({ humans: router(humansRouter) });
    const caller = testRouter.createCaller(ctx);

    await expect(
      caller.humans.getHuman({
        targetHumanId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
