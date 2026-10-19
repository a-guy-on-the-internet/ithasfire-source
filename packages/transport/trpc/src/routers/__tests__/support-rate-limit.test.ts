import { describe, expect, it, beforeEach, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { supportRouter } from "../support";
import * as supportUseCases from "@th/core/use-cases/support";
import { createTestLogger } from "@th/test-utils";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";

type ConsumeResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Build a fake `RateLimitPort.consume` that denies the given keys and allows
 * everything else. The two-tier send limiter uses distinct Redis keys, so
 * denying just one proves the windows compose independently.
 */
const fakeRateLimit = (deniedKeys: string[] = []) => {
  const consume = vi.fn(
    async (key: string): Promise<ConsumeResult> =>
      deniedKeys.includes(key)
        ? { allowed: false, remaining: 0, retryAfterSeconds: 5 }
        : {
            allowed: true,
            remaining: Number.POSITIVE_INFINITY,
            retryAfterSeconds: 0,
          },
  );
  return withConsumeMany({ consume }) as unknown as Ctx["rateLimit"] & {
    consume: typeof consume;
  };
};

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {} as Ctx["repos"],
    // `replyToThread` / `listThreads` are on the step-up 2FA allowlist
    // (guard.ts `SECOND_FACTOR_GATED_MODERATION_PATHS`), so every authed
    // procedure now runs `requireStaffSecondFactor`, which calls
    // `ctx.authz.hasStaffRole`. These tests are about rate limiting, not
    // the 2FA gate, so default to "not a gated-role holder" — the gate
    // no-ops and lets the procedure's own role check / the rate limiter
    // run exactly as before.
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => new Date("2024-01-01T00:00:00.000Z") } as Ctx["clock"],
    logger: createTestLogger(),
    notifySupport: null,
    rateLimit: fakeRateLimit(),
    actorHumanId: ACTOR_ID,
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
    ...overrides,
  }) as unknown as Ctx;

const callerFor = (ctx: Ctx) =>
  trpcRouter({ support: router(supportRouter) }).createCaller(ctx);

const NOW = new Date("2024-01-01T00:00:00.000Z");
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

const fakeThread = {
  id: THREAD_ID,
  humanId: ACTOR_ID,
  eventId: null,
  orderId: null,
  status: "OPEN" as const,
  source: "WIDGET" as const,
  lastMessageAt: NOW,
  resolvedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const fakeMessage = {
  id: MESSAGE_ID,
  threadId: THREAD_ID,
  authorType: "USER" as const,
  authorHumanId: ACTOR_ID,
  body: "hello",
  readAt: null,
  createdAt: NOW,
};

const okMessage = { thread: fakeThread, message: fakeMessage };

describe("supportRouter rate limiting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects sendMessage with TOO_MANY_REQUESTS when the burst window is exhausted", async () => {
    const sendSpy = vi.spyOn(supportUseCases, "sendSupportMessage");
    const rateLimit = fakeRateLimit([`support:sendMessage:burst:${ACTOR_ID}`]);
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await expect(
      caller.support.sendMessage({ body: "hello" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // Middleware short-circuits before the resolver runs.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects sendMessage when only the sustained window is exhausted (windows are independent)", async () => {
    const sendSpy = vi.spyOn(supportUseCases, "sendSupportMessage");
    // Burst allowed, sustained denied — passing the tight window must NOT
    // bypass the wider sustained cap.
    const rateLimit = fakeRateLimit([
      `support:sendMessage:sustained:${ACTOR_ID}`,
    ]);
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await expect(
      caller.support.sendMessage({ body: "hello" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("consumes both burst and sustained windows with the default tiers when allowed", async () => {
    vi.spyOn(supportUseCases, "sendSupportMessage").mockResolvedValue(
      okMessage,
    );
    const rateLimit = fakeRateLimit();
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await caller.support.sendMessage({ body: "hello" });

    // Burst is consulted BEFORE sustained — locks the documented ordering so a
    // future reorder can't silently let the sustained window run first. (The
    // very first call overall is the global default-rate-limit floor applied
    // to every authed procedure — see guard.ts `defaultRateLimit` — so we
    // compare positions among the support-specific keys only.)
    const supportKeys = rateLimit.consume.mock.calls
      .map((call) => call[0])
      .filter(
        (key): key is string =>
          typeof key === "string" && key.startsWith("support:"),
      );
    expect(supportKeys[0]).toBe(`support:sendMessage:burst:${ACTOR_ID}`);
    expect(supportKeys[1]).toBe(`support:sendMessage:sustained:${ACTOR_ID}`);

    // Burst: 5 / 10s, checked first.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:sendMessage:burst:${ACTOR_ID}`,
      5,
      10,
    );
    // Sustained: 30 / 300s, independent counter.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:sendMessage:sustained:${ACTOR_ID}`,
      30,
      300,
    );
  });

  it("honours env-threaded supportRateLimits over the built-in defaults", async () => {
    vi.spyOn(supportUseCases, "sendSupportMessage").mockResolvedValue(
      okMessage,
    );
    const rateLimit = fakeRateLimit();
    const ctx = buildCtx({
      rateLimit,
      supportRateLimits: {
        sendBurstMax: 2,
        sendBurstWindowS: 7,
        sendSustainedMax: 11,
        sendSustainedWindowS: 99,
        replyMax: 13,
        replyWindowS: 17,
      },
    });
    const caller = callerFor(ctx);

    await caller.support.sendMessage({ body: "hello" });

    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:sendMessage:burst:${ACTOR_ID}`,
      2,
      7,
    );
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:sendMessage:sustained:${ACTOR_ID}`,
      11,
      99,
    );
  });

  it("rejects replyToThread with TOO_MANY_REQUESTS over the staff cap (60/60)", async () => {
    const replySpy = vi.spyOn(supportUseCases, "replyToSupportThread");
    const rateLimit = fakeRateLimit([`support:replyToThread:${ACTOR_ID}`]);
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await expect(
      caller.support.replyToThread({ threadId: THREAD_ID, body: "hi" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:replyToThread:${ACTOR_ID}`,
      60,
      60,
    );
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("rejects setThreadStatus with TOO_MANY_REQUESTS over the per-actor cap (30/60)", async () => {
    const statusSpy = vi.spyOn(supportUseCases, "setSupportThreadStatus");
    const rateLimit = fakeRateLimit([`support:setStatus:${ACTOR_ID}`]);
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await expect(
      caller.support.setThreadStatus({
        threadId: THREAD_ID,
        status: "AWAITING_HUMAN",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // Distinct key from the other limiters, and the documented 30/60 tier.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:setStatus:${ACTOR_ID}`,
      30,
      60,
    );
    // Middleware short-circuits before the resolver runs.
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("allows setThreadStatus under the cap and consumes the per-actor key", async () => {
    vi.spyOn(supportUseCases, "setSupportThreadStatus").mockResolvedValue({
      thread: { ...fakeThread, status: "AWAITING_HUMAN" as const },
    });
    const rateLimit = fakeRateLimit();
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await caller.support.setThreadStatus({
      threadId: THREAD_ID,
      status: "AWAITING_HUMAN",
    });

    expect(rateLimit.consume).toHaveBeenCalledWith(
      `support:setStatus:${ACTOR_ID}`,
      30,
      60,
    );
  });

  it("never rate-limits the read path (getMessages) with a support-specific limiter", async () => {
    vi.spyOn(supportUseCases, "getSupportMessages").mockResolvedValue({
      thread: fakeThread,
      messages: [],
    });
    const rateLimit = fakeRateLimit();
    const ctx = buildCtx({ rateLimit });
    const caller = callerFor(ctx);

    await caller.support.getMessages({ threadId: THREAD_ID });

    // Every authed procedure passes through the global default rate-limit
    // floor (see guard.ts `defaultRateLimit`), but getMessages has no
    // support-specific limiter layered on top of it.
    const supportKeys = rateLimit.consume.mock.calls
      .map((call) => call[0])
      .filter(
        (key): key is string =>
          typeof key === "string" && key.startsWith("support:"),
      );
    expect(supportKeys).toHaveLength(0);
  });
});
