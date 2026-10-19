import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  CLIENT_IP_FORWARD_HEADER,
  CLIENT_IP_FORWARD_SIG_HEADER,
  CLIENT_IP_FORWARD_TS_HEADER,
  VERIFIED_CLIENT_IP_HEADER,
  signClientIpForward,
} from "@th/trpc/client-ip";

/**
 * plugins/verified-client-ip.ts — the hook that owns `x-th-verified-client-ip`
 * — and the three consumers that trust it because of that hook: the Better
 * Auth mount (header copied into the Web Request), the atomic auth
 * pre-limiter, and the ban-gate network sightings. Better Auth's OWN limiter
 * is driven for real in verified-client-ip-better-auth.test.ts.
 */

const SECRET = "o".repeat(40);

const envMock = vi.hoisted(() => ({
  ORIGIN_SHARED_SECRET: "o".repeat(40) as string | undefined,
  TRPC_GLOBAL_RATE_LIMIT_MODE: "shadow" as const,
  BETTER_AUTH_SECRET: "b".repeat(32),
}));
vi.mock("../src/lib/env", () => ({ env: envMock }));

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../src/instrument", () => ({ Sentry: { captureException } }));

/** The Web Request the Better Auth mount hands to `auth.handler`. */
const handler = vi.hoisted(() =>
  vi.fn(async (_req: Request) => new Response(null, { status: 204 })),
);
vi.mock("../src/auth/better-auth", () => ({ auth: { handler } }));

const nowSeconds = () => Math.floor(Date.now() / 1000);

const signed = (ip: string, secret = SECRET, ts = nowSeconds()) =>
  signClientIpForward({ ip, secret, nowSeconds: ts });

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

describe("stampVerifiedClientIp", () => {
  let stampVerifiedClientIp: typeof import("../src/plugins/verified-client-ip").stampVerifiedClientIp;

  beforeAll(async () => {
    ({ stampVerifiedClientIp } = await import(
      "../src/plugins/verified-client-ip"
    ));
  });

  it("strips a forged header (any casing) when there is no forward", () => {
    const headers: Record<string, unknown> = {
      [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6",
      "X-TH-Verified-Client-IP": "6.6.6.7",
    };
    const verdict = stampVerifiedClientIp(headers, SECRET, nowSeconds());
    expect(verdict).toMatchObject({ ok: false, reason: "absent" });
    expect(headers).toEqual({});
  });

  it("replaces a forged header with the verified IP on a valid forward", () => {
    const headers: Record<string, unknown> = {
      ...signed("198.51.100.23"),
      [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6",
    };
    stampVerifiedClientIp(headers, SECRET, nowSeconds());
    expect(headers[VERIFIED_CLIENT_IP_HEADER]).toBe("198.51.100.23");
  });

  it.each([
    ["wrong secret", () => signed("198.51.100.23", "x".repeat(40))],
    ["stale timestamp", () => signed("198.51.100.23", SECRET, nowSeconds() - 600)],
    [
      "tampered IP",
      () => ({ ...signed("198.51.100.23"), [CLIENT_IP_FORWARD_HEADER]: "198.51.100.24" }),
    ],
    [
      "incomplete forward",
      () => {
        const h = signed("198.51.100.23");
        delete h[CLIENT_IP_FORWARD_SIG_HEADER];
        return h;
      },
    ],
  ])("leaves the header absent on an invalid forward (%s)", (_label, build) => {
    const headers: Record<string, unknown> = {
      ...build(),
      [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6",
    };
    const verdict = stampVerifiedClientIp(headers, SECRET, nowSeconds());
    expect(verdict.ok).toBe(false);
    expect(VERIFIED_CLIENT_IP_HEADER in headers).toBe(false);
  });

  it("stamps nothing when this side has no secret", () => {
    const headers: Record<string, unknown> = { ...signed("198.51.100.23") };
    expect(stampVerifiedClientIp(headers, null, nowSeconds())).toMatchObject({
      ok: false,
      reason: "no_secret",
    });
    expect(VERIFIED_CLIENT_IP_HEADER in headers).toBe(false);
  });
});

describe("verified-client-ip plugin (wire)", () => {
  let app: FastifyInstance;
  let logger: ReturnType<typeof makeLogger>;
  let consume: ReturnType<typeof vi.fn>;

  const build = async () => {
    vi.resetModules();
    const { default: verifiedClientIp } = await import(
      "../src/plugins/verified-client-ip"
    );
    const { default: authRateLimit } = await import(
      "../src/plugins/auth-rate-limit"
    );
    const { default: betterAuthMount } = await import(
      "../src/plugins/better-auth"
    );
    logger = makeLogger();
    app = Fastify({ logger: false });
    app.decorate("deps", {
      logger,
      trpc: { rateLimit: { consume } },
    } as never);
    // Registration order mirrors app.ts.
    await app.register(verifiedClientIp as never);
    await app.register(authRateLimit as never);
    await app.register(betterAuthMount as never);
    app.get("/echo", async (request) => ({
      verified: request.headers[VERIFIED_CLIENT_IP_HEADER] ?? null,
    }));
    app.get("/trpc/:path", async (request) => ({
      verified: request.headers[VERIFIED_CLIENT_IP_HEADER] ?? null,
    }));
    await app.ready();
  };

  const echo = async (headers: Record<string, string>, url = "/echo") => {
    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { verified: string | null }).verified;
  };

  beforeEach(async () => {
    envMock.ORIGIN_SHARED_SECRET = SECRET;
    captureException.mockReset();
    handler.mockClear();
    consume = vi.fn(async () => ({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 0,
    }));
    await build();
  });

  afterEach(async () => {
    await app.close();
  });

  it("strips an inbound forged x-th-verified-client-ip", async () => {
    expect(
      await echo({
        [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6",
        "cf-connecting-ip": "203.0.113.1",
      }),
    ).toBeNull();
  });

  it("stamps the verified IP on a valid forward", async () => {
    expect(
      await echo({ ...signed("198.51.100.23"), "cf-connecting-ip": "203.0.113.1" }),
    ).toBe("198.51.100.23");
  });

  it("leaves it absent on an invalid forward, even alongside a forged stamp", async () => {
    expect(
      await echo({
        ...signed("198.51.100.23", "x".repeat(40)),
        [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6",
      }),
    ).toBeNull();
  });

  it("ignores forwards entirely when ORIGIN_SHARED_SECRET is unset (local dev)", async () => {
    envMock.ORIGIN_SHARED_SECRET = undefined;
    await app.close();
    await build();
    expect(await echo({ ...signed("198.51.100.23") })).toBeNull();
  });

  it("reaches Better Auth: the mount copies the stamp into the Web Request", async () => {
    await app.inject({
      method: "GET",
      url: "/api/auth/token",
      headers: { ...signed("198.51.100.23"), "cf-connecting-ip": "203.0.113.1" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const req = handler.mock.calls[0]![0];
    expect(req.headers.get(VERIFIED_CLIENT_IP_HEADER)).toBe("198.51.100.23");
  });

  it("a forged stamp never reaches Better Auth", async () => {
    await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6" },
    });
    const req = handler.mock.calls[0]![0];
    expect(req.headers.get(VERIFIED_CLIENT_IP_HEADER)).toBeNull();
  });

  it("the atomic pre-limiter keys its IP bucket on the verified IP", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { ...signed("198.51.100.23"), "cf-connecting-ip": "203.0.113.1" },
      payload: { email: "a@b.com", password: "nope" },
    });
    const keys = consume.mock.calls.map((call) => String(call[0]));
    expect(keys.some((k) => k.includes(":ip:") && k.endsWith(":198.51.100.23"))).toBe(true);
    expect(keys.some((k) => k.includes("203.0.113.1"))).toBe(false);
  });

  it("the atomic pre-limiter ignores a forged stamp and keys on cf-connecting-ip", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        [VERIFIED_CLIENT_IP_HEADER]: "6.6.6.6",
        "cf-connecting-ip": "203.0.113.1",
      },
      payload: { email: "a@b.com", password: "nope" },
    });
    const keys = consume.mock.calls.map((call) => String(call[0]));
    expect(keys.some((k) => k.endsWith(":203.0.113.1"))).toBe(true);
    expect(keys.some((k) => k.includes("6.6.6.6"))).toBe(false);
  });

  it("reports a complete-but-rejected forward on a non-tRPC path (throttled)", async () => {
    const bad = signed("198.51.100.23", "x".repeat(40));
    await echo(bad);
    await echo(bad);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0]!;
    expect(String((error as Error).message)).toBe(
      "client_ip_forward_rejected: bad_sig via direct",
    );
    expect(context.tags).toMatchObject({
      area: "client_ip_forward_rejected",
      reason: "bad_sig",
      via: "direct",
      surface: "http",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "client_ip_forward_rejected",
      expect.objectContaining({ reason: "bad_sig", path: "/echo" }),
    );
  });

  it("does not report on tRPC paths (the tRPC context reports those)", async () => {
    await echo(signed("198.51.100.23", "x".repeat(40)), "/trpc/events.list");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not report absent or partial forwards", async () => {
    await echo({});
    await echo({ [CLIENT_IP_FORWARD_TS_HEADER]: String(nowSeconds()) });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("ban gate: networkContextFromHook", () => {
  let networkContextFromHook: typeof import("../src/auth/ban-gate").networkContextFromHook;

  beforeAll(async () => {
    ({ networkContextFromHook } = await import("../src/auth/ban-gate"));
  });

  afterAll(() => {
    vi.resetModules();
  });

  it("records the stamped visitor IP, not the web server's", () => {
    const headers = new Headers({
      [VERIFIED_CLIENT_IP_HEADER]: "198.51.100.23",
      "cf-connecting-ip": "203.0.113.1",
    });
    expect(networkContextFromHook({ headers }).clientIp).toBe("198.51.100.23");
  });

  it("falls back to the proxy headers when nothing is stamped", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.1" });
    expect(networkContextFromHook({ headers }).clientIp).toBe("203.0.113.1");
  });
});

/**
 * Registration ORDER in app.ts, pinned on the source text (the full app needs
 * Prisma, Redis and Stripe to build). Why it matters: a non-`fp` (encapsulated)
 * plugin copies its parent's hooks at the moment it is registered, so a route
 * plugin registered BEFORE verifiedClientIp never gets the strip-and-stamp
 * hook, and its routes would see a client-sent `x-th-verified-client-ip`.
 *
 * Rule: everything except the hook-only infra plugins listed below must come
 * after `register(verifiedClientIp)`. New route plugins are covered without
 * editing this test.
 */
describe("app.ts registers verifiedClientIp before every route plugin", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app.ts", import.meta.url)),
    "utf8",
  );
  const registrations = [
    ...source.matchAll(/\bapp\.register\(\s*([A-Za-z_$][\w$]*)/g),
  ].map((m) => ({ name: m[1]!, index: m.index! }));

  /** Hook-only, route-free plugins that legitimately run first. */
  const ALLOWED_BEFORE = new Set([
    "devRequestLogging",
    "securityHeaders",
    "cors",
    "originGuard",
  ]);

  const stamp = registrations.filter((r) => r.name === "verifiedClientIp");

  it("registers the hook exactly once", () => {
    expect(stamp).toHaveLength(1);
  });

  it("registers it after originGuard and before every other plugin", () => {
    const at = stamp[0]!.index;
    const before = registrations
      .filter((r) => r.index < at)
      .map((r) => r.name);
    expect(before).toContain("originGuard");
    expect(before.filter((name) => !ALLOWED_BEFORE.has(name))).toEqual([]);
  });

  it("still sees the route plugins it is guarding (the parser matches)", () => {
    const at = stamp[0]!.index;
    const after = registrations.filter((r) => r.index > at).map((r) => r.name);
    expect(after).toEqual(
      expect.arrayContaining([
        "authRateLimit",
        "betterAuth",
        "trpc",
        "health",
        "cart",
        "accountEmailChange",
        "e2e",
        "e2eDebugAuth",
        "stripeWebhook",
        "resendWebhook",
        "snsSmsInbound",
        "ical",
      ]),
    );
  });
});
