import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  router,
  publicProcedure,
  optionalProcedure,
  authedProcedure,
} from "../init";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createInMemoryRateLimit } from "@th/test-utils/fakes/rate-limit";

import {
  DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  GLOBAL_RATE_LIMIT_MAX_REQUESTS,
  GLOBAL_RATE_LIMIT_WINDOW_SECONDS,
  rateLimit,
} from "../guard";
import { buildBaseCtx } from "../routers/__tests__/test-helpers";
import type { Ctx } from "../context";

// A minimal test procedure map exercising each of the three procedure
// factories (public/optional/authed) with no procedure-level rate limiting
// of its own, so the only limiter in play is the global default floor wired
// into `publicProcedure` / `optionalProcedure` / `authedProcedure` in
// init.ts. Mirrors the `createCaller` pattern in
// `routers/__tests__/test-helpers.ts` — `router(...)` is called fresh per
// caller so each test gets an isolated instance bound to its own ctx.
const testProcedures = {
  ping: publicProcedure.input(z.object({}).optional()).query(() => "pong"),
  optionalPing: optionalProcedure
    .input(z.object({}).optional())
    .query(() => "pong"),
  authedPing: authedProcedure
    .input(z.object({}).optional())
    .mutation(() => "pong"),
};

const callerFor = (ctx: Ctx) => router(testProcedures).createCaller(ctx);

describe("default rate limit floor (guard.ts defaultRateLimit)", () => {
  it("rejects with TOO_MANY_REQUESTS when ctx.rateLimit.consume denies the request", async () => {
    const consume = vi.fn(async () => ({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
    }));
    const ctx = buildBaseCtx({ rateLimit: { consume } as unknown as Ctx["rateLimit"] });
    const caller = callerFor(ctx);

    await expect(caller.authedPing({})).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("allows the request through when ctx.rateLimit.consume allows it (default test stub)", async () => {
    const ctx = buildBaseCtx();
    const caller = callerFor(ctx);

    await expect(caller.authedPing({})).resolves.toBe("pong");
    await expect(caller.ping({})).resolves.toBe("pong");
    await expect(caller.optionalPing({})).resolves.toBe("pong");
  });

  it("keys the default limiter on (procedure path, actorHumanId) for authed procedures", async () => {
    const consume = vi.fn(async () => ({
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      retryAfterSeconds: 0,
    }));
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      actorHumanId: "human-1",
    });
    const caller = callerFor(ctx);

    await caller.authedPing({});

    expect(consume).toHaveBeenCalledWith(
      "default:authedPing:human-1",
      DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    );
  });

  it("falls back to clientIp for anonymous callers on public/optional procedures", async () => {
    const consume = vi.fn(async () => ({
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      retryAfterSeconds: 0,
    }));
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp: "203.0.113.99",
    });
    const caller = callerFor(ctx);

    await caller.ping({});

    expect(consume).toHaveBeenCalledWith(
      "default:ping:203.0.113.99",
      DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    );
  });

  it("uses a generous default so normal rapid multi-call UI usage never trips it in practice", () => {
    // Documents the chosen floor: pagination/search-as-you-type/polling can
    // legitimately fire dozens of calls to the same procedure per minute.
    expect(DEFAULT_RATE_LIMIT_MAX_REQUESTS).toBeGreaterThanOrEqual(120);
    expect(DEFAULT_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("fails open (request still succeeds) when ctx.rateLimit.consume throws — Redis must never be a single point of total-API-outage", async () => {
    const consume = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    const caller = callerFor(ctx);

    await expect(caller.authedPing({})).resolves.toBe("pong");
    await expect(caller.ping({})).resolves.toBe("pong");
    await expect(caller.optionalPing({})).resolves.toBe("pong");
    expect(consume).toHaveBeenCalled();
  });

  it("logs the failure when failing open so a wedged Redis is still observable", async () => {
    const consume = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp: null,
    });
    const caller = callerFor(ctx);

    await caller.ping({});

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "rate_limit_consume_failed",
      expect.objectContaining({
        key: "default:ping:unknown",
        error: "ECONNREFUSED",
      }),
    );
  });
});

describe("rateLimit() helper (guard.ts) fails open on Redis errors", () => {
  it("allows the request through when ctx.rateLimit.consume throws", async () => {
    const consume = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    const guardedProcedures = {
      guardedPing: authedProcedure
        .use(
          rateLimit({
            key: () => "custom:ping",
            maxRequests: 5,
            windowSeconds: 60,
          }),
        )
        .input(z.object({}).optional())
        .mutation(() => "pong"),
    };
    const caller = router(guardedProcedures).createCaller(ctx);

    await expect(caller.guardedPing({})).resolves.toBe("pong");
    expect(consume).toHaveBeenCalled();
  });
});

describe("swallowed rate-limit-backend failure reporting", () => {
  // The fail-open allow keeps requests flowing, so without the reporter a
  // sustained Redis/rate-limit-backend outage would be invisible to
  // operators (the same class of gap behind the 2026-06 Neon outage).
  const throwingConsume = () =>
    vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

  it("reports the underlying error and still allows the request through", async () => {
    const consume = throwingConsume();
    const reportError = vi.fn();
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp: null,
      reportError,
    });
    const caller = callerFor(ctx);

    await expect(caller.ping({})).resolves.toBe("pong");

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "rate_limit_fail_open" },
      extra: { key: "default:ping:unknown", error: "ECONNREFUSED" },
    });
  });

  it("still allows the request through when reportError is not wired", async () => {
    const consume = throwingConsume();
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    const caller = callerFor(ctx);

    await expect(caller.authedPing({})).resolves.toBe("pong");
  });

  it("a throwing reporter never breaks the fail-open allow", async () => {
    const consume = throwingConsume();
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      reportError,
    });
    const caller = callerFor(ctx);

    await expect(caller.authedPing({})).resolves.toBe("pong");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("does not call reportError on the success path", async () => {
    const ctx = buildBaseCtx({ reportError: vi.fn() });
    const caller = callerFor(ctx);

    await caller.authedPing({});

    expect(ctx.reportError).not.toHaveBeenCalled();
  });

  it("throttles repeated reports for the same ctx.reportError instance within the window", async () => {
    const consume = throwingConsume();
    const reportError = vi.fn();
    const ctx = buildBaseCtx({
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      reportError,
    });
    const caller = callerFor(ctx);

    await caller.authedPing({});
    await caller.authedPing({});
    await caller.authedPing({});

    // Same reportError reference + same tags across all three calls within
    // this test → throttled to a single report, not one per request.
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("throttles across two independent per-request Ctx objects that share the same reportError reference (WeakMap-by-reference memoization in guard.ts)", async () => {
    // Mirrors production: `ctx.reportError` is a single `Sentry.captureException`
    // reference wired once at boot (see `TrpcDeps.reportError`), but a fresh
    // `Ctx` is built per request. `getThrottledRateLimitReporter` memoizes the
    // throttled wrapper in a `WeakMap<ReporterPort, ReporterPort>` keyed on
    // that shared reference, so the throttle window must survive across
    // distinct `Ctx` objects — not just distinct calls sharing one `ctx`, as
    // the test above covers.
    const reportError = vi.fn();

    const ctxOne = buildBaseCtx({
      rateLimit: { consume: throwingConsume() } as unknown as Ctx["rateLimit"],
      reportError,
    });
    const ctxTwo = buildBaseCtx({
      rateLimit: { consume: throwingConsume() } as unknown as Ctx["rateLimit"],
      reportError,
    });
    expect(ctxOne).not.toBe(ctxTwo);

    await callerFor(ctxOne).authedPing({});
    await callerFor(ctxTwo).authedPing({});

    // Second ctx's failure is still suppressed within the throttle window
    // because the wrapper is keyed on the shared `reportError` reference, not
    // on the (distinct) `Ctx` object.
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("global per-actor cap (guard.ts defaultRateLimit, `global:<actor>`)", () => {
  // Several public procedures with no limits of their own, so the per-procedure
  // floor and the global cap are the only limiters in play.
  const spread = {
    a: publicProcedure.query(() => "a"),
    b: publicProcedure.query(() => "b"),
    c: publicProcedure.query(() => "c"),
    d: publicProcedure.query(() => "d"),
    authedA: authedProcedure.query(() => "authedA"),
    optA: optionalProcedure.query(() => "optA"),
  };
  const spreadCaller = (ctx: Ctx) => router(spread).createCaller(ctx);

  // Frozen clock: every call lands in the same fixed window.
  const frozen = () => createInMemoryRateLimit({ now: () => 1_700_000_000_000 });

  // ENFORCE explicitly: these tests are about the bucket actually denying,
  // and an absent mode now means shadow (see guard.ts defaultRateLimit).
  const anonCtx = (rl: ReturnType<typeof frozen>, clientIp: string): Ctx => ({
    ...buildBaseCtx({
      rateLimit: rl,
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp,
    }),
    globalRateLimitMode: "enforce",
  });

  it("is 600/60s", () => {
    expect(GLOBAL_RATE_LIMIT_MAX_REQUESTS).toBe(600);
    expect(GLOBAL_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("trips across DIFFERENT procedures even though no per-procedure key reached 240", async () => {
    const rl = frozen();
    const caller = spreadCaller(anonCtx(rl, "198.51.100.7"));
    const paths = ["a", "b", "c", "d"] as const;

    // 600 calls, 150 per procedure: all allowed.
    for (let i = 0; i < GLOBAL_RATE_LIMIT_MAX_REQUESTS; i++) {
      await expect(caller[paths[i % paths.length]!]()).resolves.toBeDefined();
    }
    for (const path of paths) {
      expect(rl.count(`default:${path}:198.51.100.7`)).toBe(150);
    }
    expect(rl.count("global:198.51.100.7")).toBe(600);

    // 601st: its per-procedure bucket is at 151 (< 240), the global bucket is
    // over, so it's denied.
    await expect(caller.a()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(rl.count("default:a:198.51.100.7")).toBe(151);
  });

  it("keys anonymous callers on clientIp: another IP keeps its own full budget", async () => {
    const rl = frozen();
    const exhausted = spreadCaller(anonCtx(rl, "198.51.100.7"));
    for (let i = 0; i < GLOBAL_RATE_LIMIT_MAX_REQUESTS; i++) {
      await exhausted[(["a", "b", "c", "d"] as const)[i % 4]!]();
    }
    await expect(exhausted.b()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    const other = spreadCaller(anonCtx(rl, "198.51.100.8"));
    await expect(other.b()).resolves.toBe("b");
    expect(rl.count("global:198.51.100.8")).toBe(1);
  });

  it("keys signed-in callers on actorHumanId, not the IP they share", async () => {
    const rl = frozen();
    const sharedIp = "198.51.100.7";
    const anon = spreadCaller(anonCtx(rl, sharedIp));
    for (let i = 0; i < GLOBAL_RATE_LIMIT_MAX_REQUESTS; i++) {
      await anon[(["a", "b", "c", "d"] as const)[i % 4]!]();
    }
    await expect(anon.c()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // Same IP, signed in: charged to `global:<actor>`, so the exhausted IP
    // bucket doesn't touch it. Authed + OPTIONAL procedures only: those are
    // the ones that resolve an actor (a public procedure never does — see the
    // next test).
    const signedIn = spreadCaller(
      buildBaseCtx({ rateLimit: rl, actorHumanId: "human-9", clientIp: sharedIp }),
    );
    await expect(signedIn.authedA()).resolves.toBe("authedA");
    await expect(signedIn.optA()).resolves.toBe("optA");
    expect(rl.count("global:human-9")).toBe(2);
    expect(rl.count("default:optA:human-9")).toBe(1);
    expect(rl.keys().filter((k) => k.startsWith("global:"))).toEqual([
      `global:${sharedIp}`,
      "global:human-9",
    ]);
  });

  it("a PUBLIC procedure is keyed on the IP even when the caller has a session", async () => {
    // Prod shape: createContext starts at actorHumanId null, and publicOnly
    // never resolves the session. Only optional/authed procedures do.
    const rl = frozen();
    const authn = {
      ensureAuthedHuman: vi.fn(async () => ({ humanId: "human-9" })),
      ensureAuthedHumanFromApiKey: vi.fn(),
      getProviderUserId: vi.fn(async () => ({
        providerUserId: "user-1",
        sessionId: "session-1",
      })),
    } as unknown as Ctx["authn"];
    const ctx = buildBaseCtx({
      rateLimit: rl,
      authn,
      actorHumanId: null,
      auth: { userId: "user-1", sessionId: "session-1", token: "jwt" },
      authToken: "jwt",
      clientIp: "198.51.100.7",
    });
    const caller = spreadCaller(ctx);

    await expect(caller.a()).resolves.toBe("a");
    expect(rl.count("default:a:198.51.100.7")).toBe(1);
    expect(rl.count("global:198.51.100.7")).toBe(1);
    expect(authn.getProviderUserId).not.toHaveBeenCalled();

    // Same request context through an OPTIONAL procedure: the session resolves.
    await expect(caller.optA()).resolves.toBe("optA");
    expect(rl.count("default:optA:human-9")).toBe(1);
    expect(rl.count("global:human-9")).toBe(1);
  });

  it("IPv6: two addresses in one /64 share global:, per-procedure keys stay raw", async () => {
    const rl = frozen();
    const one = spreadCaller(anonCtx(rl, "2001:db8:1:2::a"));
    const two = spreadCaller(anonCtx(rl, "2001:db8:1:2:ffff::b"));

    await one.a();
    await two.a();

    expect(rl.count("global:2001:0db8:0001:0002::/64")).toBe(2);
    // Per-procedure keys are byte-identical to before (raw clientIp).
    expect(rl.count("default:a:2001:db8:1:2::a")).toBe(1);
    expect(rl.count("default:a:2001:db8:1:2:ffff::b")).toBe(1);
    // A different /64 is a different global bucket.
    await spreadCaller(anonCtx(rl, "2001:db8:1:3::a")).a();
    expect(rl.count("global:2001:0db8:0001:0003::/64")).toBe(1);
  });

  it("IPv4 global keys are unchanged (the bucket helper passes IPv4 through)", async () => {
    const rl = frozen();
    await spreadCaller(anonCtx(rl, "198.51.100.7")).a();
    expect(rl.count("global:198.51.100.7")).toBe(1);
  });

  it("per-procedure floor is unchanged: one path still denies at call 241", async () => {
    const rl = frozen();
    const caller = spreadCaller(anonCtx(rl, "198.51.100.7"));

    for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX_REQUESTS; i++) {
      await expect(caller.a()).resolves.toBe("a");
    }
    await expect(caller.a()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // The global bucket (241 of 600) was not what denied it.
    expect(rl.count("global:198.51.100.7")).toBe(241);
    // A different procedure is still open for the same caller.
    await expect(caller.b()).resolves.toBe("b");
  });

  it("charges both buckets in ONE consumeMany call per procedure call, per-procedure key first", async () => {
    const consumeMany = vi.fn(async (entries: ReadonlyArray<unknown>) =>
      entries.map(() => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 })),
    );
    const consume = vi.fn();
    const ctx = buildBaseCtx({
      rateLimit: { consume, consumeMany } as unknown as Ctx["rateLimit"],
      actorHumanId: "human-1",
    });

    await spreadCaller(ctx).authedA();

    expect(consumeMany).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(consumeMany).toHaveBeenCalledWith([
      {
        key: "default:authedA:human-1",
        maxTokens: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
        windowSeconds: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
      },
      {
        key: "global:human-1",
        maxTokens: GLOBAL_RATE_LIMIT_MAX_REQUESTS,
        windowSeconds: GLOBAL_RATE_LIMIT_WINDOW_SECONDS,
      },
    ]);
  });

  it("denies when only the global bucket is over, and Retry-After is the longest denied wait", async () => {
    const results = [
      [
        { allowed: true, remaining: 3, retryAfterSeconds: 0 },
        { allowed: false, remaining: 0, retryAfterSeconds: 17 },
      ],
      [
        { allowed: false, remaining: 0, retryAfterSeconds: 12 },
        { allowed: false, remaining: 0, retryAfterSeconds: 42 },
      ],
    ];
    const consumeMany = vi.fn(async () => results.shift()!);
    const ctx: Ctx = {
      ...buildBaseCtx({
        rateLimit: { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"],
      }),
      globalRateLimitMode: "enforce",
    };
    const caller = spreadCaller(ctx);

    await expect(caller.authedA()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Try again in 17s.",
    });
    await expect(caller.authedA()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Try again in 42s.",
    });
  });

  it("fails open when consumeMany throws, logging the per-procedure key", async () => {
    const consumeMany = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ctx = buildBaseCtx({
      rateLimit: { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"],
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp: "198.51.100.7",
    });

    await expect(spreadCaller(ctx).a()).resolves.toBe("a");
    expect(consumeMany).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "rate_limit_consume_failed",
      expect.objectContaining({ key: "default:a:198.51.100.7" }),
    );
  });

  it("a batched HTTP request (?batch=1) of N calls runs the limiter once PER CALL", async () => {
    const rl = frozen();
    // One context per HTTP request (tRPC creates it once per request)...
    const createContext = vi.fn(() => anonCtx(rl, "198.51.100.7"));
    const input = encodeURIComponent(
      JSON.stringify({ 0: { json: null }, 1: { json: null }, 2: { json: null } }),
    );

    const res = await fetchRequestHandler({
      endpoint: "/trpc",
      req: new Request(`http://localhost/trpc/a,b,a?batch=1&input=${input}`),
      router: router(spread),
      createContext,
    });

    expect(res.status).toBe(200);
    expect(createContext).toHaveBeenCalledTimes(1);
    // ...but three calls -> three global tokens and one per-procedure token
    // per call.
    expect(rl.count("global:198.51.100.7")).toBe(3);
    expect(rl.count("default:a:198.51.100.7")).toBe(2);
    expect(rl.count("default:b:198.51.100.7")).toBe(1);
  });
});

describe("global bucket rollout mode (TrpcDeps.globalRateLimitMode)", () => {
  const procs = {
    a: publicProcedure.query(() => "a"),
    authedA: authedProcedure.query(() => "authedA"),
  };
  const callerFor = (ctx: Ctx) => router(procs).createCaller(ctx);

  /** consumeMany that allows the per-procedure key and denies global:. */
  const globalOver = () =>
    vi.fn(async (entries: ReadonlyArray<{ key: string }>) =>
      entries.map((entry) =>
        entry.key.startsWith("global:")
          ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
          : { allowed: true, remaining: 5, retryAfterSeconds: 0 },
      ),
    );

  const anon = (
    consumeMany: ReturnType<typeof globalOver>,
    mode?: Ctx["globalRateLimitMode"],
    clientIp = "198.51.100.7",
  ): Ctx => ({
    // buildBaseCtx builds an explicit object (it would drop this override).
    ...buildBaseCtx({
      rateLimit: { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"],
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp,
    }),
    ...(mode ? { globalRateLimitMode: mode } : {}),
  });

  const keysOf = (consumeMany: ReturnType<typeof globalOver>) =>
    consumeMany.mock.calls.flatMap((call) => call[0].map((e) => e.key));

  const withMetrics = (ctx: Ctx) => {
    const metrics = { increment: vi.fn(), record: vi.fn() };
    return { ctx: { ...ctx, metrics } as Ctx, metrics };
  };

  it("enforce: a global would-deny is a 429", async () => {
    const consumeMany = globalOver();
    await expect(callerFor(anon(consumeMany, "enforce")).a()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Try again in 30s.",
    });
  });

  it("UNSET means shadow: a global would-deny is allowed and reported", async () => {
    const consumeMany = globalOver();
    const ctx = anon(consumeMany);
    expect(ctx.globalRateLimitMode).toBeUndefined();

    await expect(callerFor(ctx).a()).resolves.toBe("a");
    expect(keysOf(consumeMany)).toContain("global:198.51.100.7");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "global_rate_limit_would_deny",
      expect.objectContaining({ key: "global:198.51.100.7" }),
    );
  });

  it("enforce: a GLOBAL deny increments trpc.global_rate_limit.denied and logs at error", async () => {
    const consumeMany = globalOver();
    const { ctx, metrics } = withMetrics(anon(consumeMany, "enforce"));

    await expect(callerFor(ctx).a()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });

    expect(metrics.increment).toHaveBeenCalledWith(
      "trpc.global_rate_limit.denied",
      { source: "edge", actor: "ip" },
    );
    expect(ctx.logger.error).toHaveBeenCalledWith("global_rate_limit_denied", {
      key: "global:198.51.100.7",
      clientIpSource: "edge",
      retryAfterSeconds: 30,
      suppressedSinceLastLog: 0,
    });
  });

  it("enforce: a PER-PROCEDURE-only deny emits no global signal", async () => {
    const consumeMany = vi.fn(async (entries: ReadonlyArray<{ key: string }>) =>
      entries.map((entry) =>
        entry.key.startsWith("global:")
          ? { allowed: true, remaining: 5, retryAfterSeconds: 0 }
          : { allowed: false, remaining: 0, retryAfterSeconds: 7 },
      ),
    );
    const { ctx, metrics } = withMetrics(anon(consumeMany, "enforce"));

    await expect(callerFor(ctx).a()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(ctx.logger.error).not.toHaveBeenCalledWith(
      "global_rate_limit_denied",
      expect.anything(),
    );
  });

  it("shadow: increments trpc.global_rate_limit.would_deny on EVERY would-deny, tagged source + actor kind", async () => {
    const consumeMany = globalOver();
    const rateLimit = { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"];
    const metrics = { increment: vi.fn(), record: vi.fn() };
    const ctxFor = (over: Partial<Ctx>): Ctx => ({
      ...buildBaseCtx({ rateLimit, clientIp: "198.51.100.7" }),
      globalRateLimitMode: "shadow",
      metrics,
      ...over,
    });

    await callerFor(ctxFor({ actorHumanId: null, clientIpSource: "forwarded" })).a();
    await callerFor(ctxFor({ actorHumanId: null, clientIpSource: "forwarded" })).a();
    await callerFor(ctxFor({ actorHumanId: "human-1" })).authedA();

    // Not throttled: the metric counts every occurrence (the log is throttled).
    expect(metrics.increment.mock.calls).toEqual([
      ["trpc.global_rate_limit.would_deny", { source: "forwarded", actor: "ip" }],
      ["trpc.global_rate_limit.would_deny", { source: "forwarded", actor: "ip" }],
      ["trpc.global_rate_limit.would_deny", { source: "edge", actor: "human" }],
    ]);
  });

  it("a throwing metrics port never affects the request", async () => {
    const consumeMany = globalOver();
    const ctx: Ctx = {
      ...anon(consumeMany, "shadow"),
      metrics: {
        increment: vi.fn(() => {
          throw new Error("statsd down");
        }),
        record: vi.fn(),
      },
    };
    await expect(callerFor(ctx).a()).resolves.toBe("a");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "global_rate_limit_would_deny",
      expect.anything(),
    );
  });

  it("shadow: charges global: in the SAME consumeMany, allows the call, logs the would-deny", async () => {
    const consumeMany = globalOver();
    const ctx = anon(consumeMany, "shadow");

    await expect(callerFor(ctx).a()).resolves.toBe("a");

    expect(consumeMany).toHaveBeenCalledTimes(1);
    expect(keysOf(consumeMany)).toEqual([
      "default:a:198.51.100.7",
      "global:198.51.100.7",
    ]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "global_rate_limit_would_deny",
      {
        key: "global:198.51.100.7",
        clientIpSource: "edge",
        retryAfterSeconds: 30,
        suppressedSinceLastLog: 0,
      },
    );
  });

  it("shadow: the would-deny log is throttled and counts what it suppressed", async () => {
    const consumeMany = globalOver();
    // One rate-limit backend object across requests, as in production.
    const rateLimit = { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"];
    const ctxFor = (): Ctx => ({
      ...buildBaseCtx({
        rateLimit,
        actorHumanId: null,
        auth: null,
        authToken: null,
        apiKey: null,
        clientIp: "198.51.100.7",
      }),
      globalRateLimitMode: "shadow",
    });
    const first = ctxFor();
    await callerFor(first).a();
    const later = [ctxFor(), ctxFor(), ctxFor()];
    for (const ctx of later) await callerFor(ctx).a();

    expect(first.logger.error).toHaveBeenCalledTimes(1);
    for (const ctx of later) {
      expect(ctx.logger.error).not.toHaveBeenCalledWith(
        "global_rate_limit_would_deny",
        expect.anything(),
      );
    }
  });

  it("shadow: the throttle window is ONE minute, and the next line reports what it suppressed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
      const consumeMany = globalOver();
      const rateLimit = { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"];
      const ctxFor = (): Ctx => ({
        ...buildBaseCtx({
          rateLimit,
          actorHumanId: null,
          auth: null,
          authToken: null,
          apiKey: null,
          clientIp: "198.51.100.7",
        }),
        globalRateLimitMode: "shadow",
      });

      await callerFor(ctxFor()).a(); // logged
      await callerFor(ctxFor()).a(); // suppressed
      vi.setSystemTime(new Date("2026-09-30T12:00:59.000Z"));
      const stillInWindow = ctxFor();
      await callerFor(stillInWindow).a(); // suppressed (59s)
      expect(stillInWindow.logger.error).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-09-30T12:01:00.000Z"));
      const nextWindow = ctxFor();
      await callerFor(nextWindow).a();
      expect(nextWindow.logger.error).toHaveBeenCalledWith(
        "global_rate_limit_would_deny",
        expect.objectContaining({ suppressedSinceLastLog: 2 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shadow: a long actor is truncated in the log line", async () => {
    const consumeMany = globalOver();
    const ctx = anon(consumeMany, "shadow", "x".repeat(300));

    await callerFor(ctx).a();

    const [, fields] = (ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "global_rate_limit_would_deny",
    )!;
    expect(fields.key).toBe(`global:${"x".repeat(64)}…`);
  });

  it("shadow: a PER-PROCEDURE deny is still enforced, and the shadowed global wait is NOT in Retry-After", async () => {
    // Global over with a LONGER wait (30s) than the per-procedure one (9s): if
    // the shadowed result leaked into Math.max, the message would say 30s.
    const consumeMany = vi.fn(async (entries: ReadonlyArray<{ key: string }>) =>
      entries.map((entry) =>
        entry.key.startsWith("global:")
          ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
          : { allowed: false, remaining: 0, retryAfterSeconds: 9 },
      ),
    );
    await expect(
      callerFor(anon(consumeMany, "shadow")).a(),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded. Try again in 9s." });
  });

  it("off: global: is not charged at all; per-procedure still is", async () => {
    const consumeMany = globalOver();
    const ctx = anon(consumeMany, "off");

    await expect(callerFor(ctx).a()).resolves.toBe("a");

    expect(keysOf(consumeMany)).toEqual(["default:a:198.51.100.7"]);
  });

  it("off applies to signed-in actors too", async () => {
    const consumeMany = globalOver();
    const ctx: Ctx = {
      ...buildBaseCtx({
        rateLimit: { consume: vi.fn(), consumeMany } as unknown as Ctx["rateLimit"],
        actorHumanId: "human-1",
      }),
      globalRateLimitMode: "off",
    };

    await expect(callerFor(ctx).authedA()).resolves.toBe("authedA");
    expect(keysOf(consumeMany)).toEqual(["default:authedA:human-1"]);
  });
});

describe("consumeMany result validation (fail OPEN, not a 500)", () => {
  const procs = { a: publicProcedure.query(() => "a") };

  const badResults: Array<[string, () => Promise<unknown>]> = [
    ["a non-array", async () => ({ allowed: false })],
    ["too few results", async () => [{ allowed: true, remaining: 1, retryAfterSeconds: 0 }]],
    ["an entry without a boolean `allowed`", async () => [{}, { allowed: true }]],
    ["undefined", async () => undefined],
  ];

  it.each(badResults)("allows and reports when the backend returns %s", async (_label, impl) => {
    const reportError = vi.fn();
    const ctx = buildBaseCtx({
      rateLimit: { consume: vi.fn(), consumeMany: vi.fn(impl) } as unknown as Ctx["rateLimit"],
      actorHumanId: null,
      auth: null,
      authToken: null,
      apiKey: null,
      clientIp: "198.51.100.7",
      reportError,
    });

    await expect(router(procs).createCaller(ctx).a()).resolves.toBe("a");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "rate_limit_consume_failed",
      expect.objectContaining({ key: "default:a:198.51.100.7" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: "rate_limit_fail_open" } }),
    );
  });
});
