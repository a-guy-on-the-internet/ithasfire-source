import { afterEach, describe, expect, it, vi } from "vitest";

import * as eventsUseCases from "@th/core/use-cases/events";

import {
  CLIENT_IP_FORWARD_HEADER,
  CLIENT_IP_FORWARD_SIG_HEADER,
  CLIENT_IP_FORWARD_TS_HEADER,
  signClientIpForward,
} from "../../client-ip";
import {
  createContextFactory,
  type Ctx,
  type HeadersLike,
  type TrpcDeps,
} from "../../context";
import { router } from "../../init";
import { eventsRouter } from "../events";
import { buildBaseCtx } from "./test-helpers";

/**
 * End-to-end properties of the signed client-IP forward, driven through
 * `createContextFactory` (the unit that reads headers) and the real events
 * router with a recording rate limiter — so this covers the wiring
 * (`TrpcDeps.clientIpForwardSecret` → `extractClientIp` → rate-limit keys),
 * not just the pure protocol functions:
 *
 *  1. guests unlocking through our WEB SERVER land in their OWN
 *     `events.validatePassword` bucket, not one keyed on the web server;
 *  2. a rejected forward is logged at error + reported, throttled, and
 *     tagged `via` edge/direct so scanner junk never masks a real break;
 *  3. the global-bucket fail-safe: an anonymous call that did not transit
 *     Cloudflare and carries no valid forward skips `global:` — including
 *     when the origin secret itself is what broke.
 */

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
/** What the API sees as the peer on every web → API call: the web server. */
const WEB_EGRESS_IP = "34.120.0.10";
/** The context reads `deps.clock`; buildBaseCtx pins it here. */
const CLOCK_NOW_S = Date.parse("2024-01-01T00:00:00.000Z") / 1000;

type ConsumeCall = [key: string, max: number, windowSeconds: number];

const buildHarness = (
  opts: {
    secret?: string | null;
    reportError?: TrpcDeps["reportError"];
  } = {},
) => {
  const consume = vi.fn(async (..._args: ConsumeCall) => ({
    allowed: true,
    remaining: Number.POSITIVE_INFINITY,
    retryAfterSeconds: 0,
  }));
  const logger = {
    child: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    withTime: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  };
  logger.child.mockReturnValue(logger);
  // Request-scoped Ctx fields are stripped: createContext must derive them.
  const {
    auth: _auth,
    authToken: _authToken,
    apiKey: _apiKey,
    actorHumanId: _actorHumanId,
    viewerLocation: _viewerLocation,
    clientIp: _clientIp,
    userAgent: _userAgent,
    cookieHeader: _cookieHeader,
    ...deps
  } = buildBaseCtx({
    rateLimit: { consume } as unknown as Ctx["rateLimit"],
    logger: logger as unknown as Ctx["logger"],
    reportError: opts.reportError,
  });
  const createContext = createContextFactory({
    ...(deps as TrpcDeps),
    clientIpForwardSecret: opts.secret === undefined ? SECRET : opts.secret,
  });

  const context = (headers: HeadersLike) =>
    createContext({
      req: { headers, raw: { socket: { remoteAddress: "169.254.1.1" } } },
    });

  const unlock = async (headers: HeadersLike) => {
    const ctx = await context(headers);
    // Same construction as test-helpers' createCaller.
    await (router(eventsRouter).createCaller(ctx) as any).validatePassword({
      eventId: EVENT_ID,
      password: "open-sesame",
    });
    return ctx;
  };

  const keys = () => consume.mock.calls.map((call) => call[0]);
  /** The per-(event, actor, IP) bucket keys, in call order. */
  const perEventKeys = () =>
    keys().filter((key) => key.startsWith(`event:validatePassword:${EVENT_ID}:`));

  return { context, unlock, keys, perEventKeys, logger };
};

const signedFor = (visitorIp: string, nowSeconds = CLOCK_NOW_S) =>
  signClientIpForward({ ip: visitorIp, secret: SECRET, nowSeconds });

/** Headers as they arrive from the web unlock route: CF saw the web server. */
const fromWebServer = (visitorIp: string) => ({
  "cf-connecting-ip": WEB_EGRESS_IP,
  "x-forwarded-for": `${WEB_EGRESS_IP}, 172.70.0.1`,
  ...signedFor(visitorIp),
});

/** An SSR call to the API's internal origin: no Cloudflare, origin secret set. */
const internalCall = (extra: Record<string, string> = {}) => ({
  "x-origin-secret": SECRET,
  "x-forwarded-for": WEB_EGRESS_IP,
  ...extra,
});

const stubUseCase = () =>
  vi.spyOn(eventsUseCases, "validateEventPassword").mockResolvedValue({
    eventId: EVENT_ID,
    unlocked: false,
    bypassed: false,
    persisted: false,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("events.validatePassword — signed client-IP forward", () => {
  it("puts two guests unlocking through the web server in two different buckets", async () => {
    stubUseCase();
    const { unlock, perEventKeys } = buildHarness();

    const a = await unlock(fromWebServer("198.51.100.23"));
    const b = await unlock(fromWebServer("203.0.113.99"));

    expect(a.clientIp).toBe("198.51.100.23");
    expect(a.clientIpSource).toBe("forwarded");
    expect(b.clientIp).toBe("203.0.113.99");
    const [keyA, keyB] = perEventKeys();
    expect(keyA).toBe(
      `event:validatePassword:${EVENT_ID}:anonymous:ip:198.51.100.23`,
    );
    expect(keyB).toBe(
      `event:validatePassword:${EVENT_ID}:anonymous:ip:203.0.113.99`,
    );
    expect(keyA).not.toBe(keyB);
    // Neither landed in the shared web-server bucket.
    expect(perEventKeys().some((k) => k.includes(WEB_EGRESS_IP))).toBe(false);
  });

  it("ignores a forged forward and keys on cf-connecting-ip instead", async () => {
    stubUseCase();
    const { unlock, perEventKeys } = buildHarness();

    const forged = await unlock({
      "cf-connecting-ip": "192.0.2.77",
      [CLIENT_IP_FORWARD_HEADER]: "10.9.8.7",
      [CLIENT_IP_FORWARD_TS_HEADER]: String(CLOCK_NOW_S),
      [CLIENT_IP_FORWARD_SIG_HEADER]: "not-a-real-signature",
    });

    expect(forged.clientIp).toBe("192.0.2.77");
    expect(forged.clientIpSource).toBe("edge");
    expect(perEventKeys()).toEqual([
      `event:validatePassword:${EVENT_ID}:anonymous:ip:192.0.2.77`,
    ]);
  });

  it("ignores even a correctly signed forward when the API has no secret", async () => {
    stubUseCase();
    const { unlock, perEventKeys } = buildHarness({ secret: null });

    const ctx = await unlock(fromWebServer("198.51.100.23"));

    // Today's behaviour, exactly: the web server's address.
    expect(ctx.clientIp).toBe(WEB_EGRESS_IP);
    expect(perEventKeys()).toEqual([
      `event:validatePassword:${EVENT_ID}:anonymous:ip:${WEB_EGRESS_IP}`,
    ]);
  });

  it("ignores a stale forward (outside the ±60s window of deps.clock)", async () => {
    stubUseCase();
    const { unlock } = buildHarness();

    const stale = await unlock({
      "cf-connecting-ip": WEB_EGRESS_IP,
      ...signedFor("198.51.100.23", CLOCK_NOW_S - 120),
    });

    expect(stale.clientIp).toBe(WEB_EGRESS_IP);
  });
});

describe("createContext — rejected forwards are visible", () => {
  it("logs at error and reports a rejected forward, tagged with the reason", async () => {
    const reportError = vi.fn();
    const { context, logger } = buildHarness({ reportError });

    await context({
      "cf-connecting-ip": WEB_EGRESS_IP,
      ...signedFor("198.51.100.23", CLOCK_NOW_S - 120),
    });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          area: "client_ip_forward_rejected",
          reason: "stale",
          via: "edge",
        },
        extra: expect.objectContaining({
          reason: "stale",
          via: "edge",
          skewSeconds: 120,
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "client_ip_forward_rejected",
      expect.objectContaining({ reason: "stale", skewSeconds: 120 }),
    );
  });

  it("throttles per reason: a repeat is silent, a different reason still reports", async () => {
    const reportError = vi.fn();
    const { context, logger } = buildHarness({ reportError });
    const badSig = {
      "cf-connecting-ip": WEB_EGRESS_IP,
      [CLIENT_IP_FORWARD_HEADER]: "198.51.100.23",
      [CLIENT_IP_FORWARD_TS_HEADER]: String(CLOCK_NOW_S),
      [CLIENT_IP_FORWARD_SIG_HEADER]: "garbage",
    };

    await context(badSig);
    await context(badSig);
    await context(badSig);
    await context({
      "cf-connecting-ip": WEB_EGRESS_IP,
      ...signedFor("198.51.100.23", CLOCK_NOW_S - 120),
    });

    expect(reportError.mock.calls.map((c) => c[1].tags.reason)).toEqual([
      "bad_sig",
      "stale",
    ]);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("does not report when no forward was sent, or only part of one", async () => {
    const reportError = vi.fn();
    const { context, logger } = buildHarness({ reportError });

    await context({ "cf-connecting-ip": "203.0.113.50" });
    await context({
      "cf-connecting-ip": "203.0.113.50",
      [CLIENT_IP_FORWARD_HEADER]: "10.0.0.1",
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reports (as no_secret) when the web sends a forward the API cannot check", async () => {
    const reportError = vi.fn();
    const { context } = buildHarness({ secret: null, reportError });

    await context(fromWebServer("198.51.100.23"));

    expect(reportError.mock.calls[0]?.[1].tags).toEqual({
      area: "client_ip_forward_rejected",
      reason: "no_secret",
      via: "edge",
    });
  });

  it("tags via=direct for our own SSR path and throttles it apart from edge junk", async () => {
    const reportError = vi.fn();
    const { context } = buildHarness({ reportError });
    // A browser/scanner behind Cloudflare sending junk forward headers...
    const edgeJunk = {
      "cf-connecting-ip": "203.0.113.50",
      [CLIENT_IP_FORWARD_HEADER]: "198.51.100.23",
      [CLIENT_IP_FORWARD_TS_HEADER]: String(CLOCK_NOW_S),
      [CLIENT_IP_FORWARD_SIG_HEADER]: "garbage",
    };
    // ...and our web server's internal call signed with a rotated secret.
    const directBreak = internalCall(
      signClientIpForward({
        ip: "198.51.100.23",
        secret: "rotated-secret-on-web-only",
        nowSeconds: CLOCK_NOW_S,
      }),
    );

    await context(edgeJunk);
    await context(edgeJunk);
    await context(directBreak);

    // The junk's report did NOT swallow the real break's: separate windows.
    expect(reportError.mock.calls.map((c) => c[1].tags)).toEqual([
      { area: "client_ip_forward_rejected", reason: "bad_sig", via: "edge" },
      { area: "client_ip_forward_rejected", reason: "bad_sig", via: "direct" },
    ]);
  });

  it("a throwing reporter never breaks context creation", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { context } = buildHarness({ reportError });

    const ctx = await context({
      "cf-connecting-ip": WEB_EGRESS_IP,
      ...signedFor("198.51.100.23", CLOCK_NOW_S - 120),
    });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(ctx.clientIp).toBe(WEB_EGRESS_IP);
  });
});

describe("defaultRateLimit — global-bucket fail-safe for calls that did not transit Cloudflare", () => {
  const globalKeys = (keys: string[]) => keys.filter((k) => k.startsWith("global:"));

  it("our SSR call with a valid origin secret and no forward skips global:, still pays per-procedure", async () => {
    stubUseCase();
    const { unlock, keys } = buildHarness();

    const ctx = await unlock(internalCall());

    expect(ctx.clientIpSource).toBe("direct");
    expect(ctx.clientIp).toBe(WEB_EGRESS_IP);
    expect(keys()).toContain(`default:validatePassword:${WEB_EGRESS_IP}`);
    expect(globalKeys(keys())).toEqual([]);
  });

  it("SECRET ROTATION: origin secret mismatched and the forward fails bad_sig — still skips global:", async () => {
    // The likeliest real break: API and web disagree on ORIGIN_SHARED_SECRET
    // mid-rollout, so the forward AND the origin secret both fail. Without the
    // skip every anonymous SSR call would share global:<web egress> → a
    // site-wide 429.
    stubUseCase();
    const { unlock, keys } = buildHarness();

    const ctx = await unlock({
      "x-origin-secret": "the-other-sides-new-secret",
      "x-forwarded-for": WEB_EGRESS_IP,
      ...signClientIpForward({
        ip: "198.51.100.23",
        secret: "the-other-sides-new-secret",
        nowSeconds: CLOCK_NOW_S,
      }),
    });

    expect(ctx.clientIpSource).toBe("direct");
    expect(ctx.clientIp).toBe(WEB_EGRESS_IP);
    expect(keys()).toContain(`default:validatePassword:${WEB_EGRESS_IP}`);
    expect(globalKeys(keys())).toEqual([]);
  });

  it("no origin secret at all and no cf-connecting-ip (local dev / e2e loopback) skips global:", async () => {
    stubUseCase();
    const { unlock, keys } = buildHarness({ secret: null });

    const ctx = await unlock({ "x-forwarded-for": "127.0.0.1" });

    expect(ctx.clientIpSource).toBe("direct");
    expect(keys()).toContain("default:validatePassword:127.0.0.1");
    expect(globalKeys(keys())).toEqual([]);
  });

  it("cf-connecting-ip present and no forward → does NOT skip", async () => {
    stubUseCase();
    const { unlock, keys } = buildHarness();

    const ctx = await unlock(internalCall({ "cf-connecting-ip": "203.0.113.50" }));

    expect(ctx.clientIpSource).toBe("edge");
    expect(globalKeys(keys())).toEqual(["global:203.0.113.50"]);
  });

  it("cf-connecting-ip present WITH a valid forward → does NOT skip, global keyed on the visitor", async () => {
    stubUseCase();
    const { unlock, keys } = buildHarness();

    const ctx = await unlock(fromWebServer("198.51.100.23"));

    expect(ctx.clientIpSource).toBe("forwarded");
    expect(globalKeys(keys())).toEqual(["global:198.51.100.23"]);
  });

  it("valid forward on the internal path (no cf header) → does NOT skip, global keyed on the visitor", async () => {
    stubUseCase();
    const { unlock, keys } = buildHarness();

    const ctx = await unlock(internalCall(signedFor("198.51.100.23")));

    expect(ctx.clientIpSource).toBe("forwarded");
    expect(globalKeys(keys())).toEqual(["global:198.51.100.23"]);
  });

  it("a signed-in actor on a direct call → does NOT skip (keyed on the human)", async () => {
    stubUseCase();
    const { context, keys } = buildHarness();
    const ctx = await context(internalCall());

    await (
      router(eventsRouter).createCaller({
        ...ctx,
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      }) as any
    ).validatePassword({ eventId: EVENT_ID, password: "open-sesame" });

    expect(globalKeys(keys())).toEqual([
      "global:11111111-1111-4111-8111-111111111111",
    ]);
  });
});
