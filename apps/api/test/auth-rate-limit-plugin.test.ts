import { connect } from "node:net";

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

import type { RateLimitResult } from "@th/ports/rate-limit";

/**
 * Wire-level test for the Fastify plugin: the 429 has to come back with
 * better-auth's EXACT status/headers/body, and a covered request that is
 * allowed must actually reach the downstream handler. Asserting the shape on
 * a constant (as `auth-atomic-rate-limit.test.ts` does) is not enough —
 * Fastify can and does rewrite content-type on `send`.
 *
 * ## Why the path cases use a RAW SOCKET and not `app.inject`
 *
 * `inject` (light-my-request) NORMALIZES the target before Fastify's router
 * or any hook sees it. Measured, after these cases were first written with
 * `inject` and passed:
 *
 *   sent /api/auth/x/../sign-in/email  → hook saw /api/auth/sign-in/email
 *   sent /api/auth/./sign-in/email     → hook saw /api/auth/sign-in/email
 *   sent /api/auth/%2e/sign-in/email   → hook saw /api/auth/sign-in/email
 *   sent /api/auth/sign-in\email       → hook saw /api/auth/sign-in/email
 *
 * So an `inject`-based assertion that a dot-segment form gets limited passes
 * against the VULNERABLE code too — it is a gate that looks real and is not,
 * and it is precisely how the bypass shipped green the first time. A real
 * listening socket with a hand-written request line is the only way to put an
 * un-normalized target in front of the hook.
 */

/** Send a hand-built request line; returns the raw response text. */
async function rawRequest(
  port: number,
  requestLine: string,
  headers: Record<string, string> = {},
  body = "",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [
        requestLine,
        "Host: 127.0.0.1",
        "Connection: close",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body,
      ];
      socket.write(lines.join("\r\n"));
    });
    let out = "";
    socket.setTimeout(10_000, () =>
      socket.destroy(new Error("socket timeout")),
    );
    socket.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}

const statusOf = (raw: string): number =>
  Number(/^HTTP\/1\.\d (\d{3})/.exec(raw)?.[1] ?? 0);

// `Sentry.captureException` is imported at plugin module load; stub the whole
// instrument module so importing the plugin can't initialise a real client.
vi.mock("../src/instrument", () => ({
  Sentry: { captureException: vi.fn() },
}));

const allow: RateLimitResult = {
  allowed: true,
  remaining: 4,
  retryAfterSeconds: 0,
};
const denied: RateLimitResult = {
  allowed: false,
  remaining: 0,
  retryAfterSeconds: 37,
};

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

describe("auth-rate-limit plugin", () => {
  let app: FastifyInstance;
  let consume: ReturnType<typeof vi.fn>;
  let handled: string[];
  /**
   * EVERY instance `build()` creates, not just the latest. Some cases call
   * `build()` twice; closing only `app` would leak the earlier one (and its
   * listening socket) into the rest of the worker.
   */
  let built: FastifyInstance[] = [];

  const build = async () => {
    const { default: authRateLimit } =
      await import("../src/plugins/auth-rate-limit");

    handled = [];
    app = Fastify({ logger: false });
    built.push(app);
    // Mirrors plugins/raw-body.ts, which is registered ahead of this plugin in
    // app.ts: JSON arrives as a parsed object, everything else as a Buffer.
    app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    app.decorate("deps", {
      logger: makeLogger(),
      trpc: { rateLimit: { consume } },
    } as never);
    await app.register(authRateLimit as never);
    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      handler: async (request, reply) => {
        handled.push(request.url);
        return reply.code(401).send({ code: "INVALID_EMAIL_OR_PASSWORD" });
      },
    });
    app.get("/health", async () => ({ ok: true }));
    await app.ready();
  };

  /** Boot a real listener so raw, un-normalized targets can be sent. */
  const listen = async (): Promise<number> => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind a test port");
    }
    return address.port;
  };

  /**
   * The plugin reads BETTER_AUTH_SECRET at register time for the identifier
   * HMAC key. Set it around this suite only and RESTORE the previous value —
   * a bare `process.env.X ??= ...` is global state visible to every other
   * suite sharing the worker, with nothing to undo it.
   */
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = "x".repeat(32);
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
  });

  beforeEach(() => {
    consume = vi.fn(async () => allow);
  });

  afterEach(async () => {
    await Promise.all(
      built.map((instance) => instance.close().catch(() => {})),
    );
    built = [];
  });

  it("lets an allowed request reach the better-auth handler untouched", async () => {
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      payload: { email: "a@b.com", password: "nope" },
    });

    expect(response.statusCode).toBe(401);
    expect(handled).toEqual(["/api/auth/sign-in/email"]);
    expect(consume).toHaveBeenCalledTimes(2); // ip + account
  });

  it("returns better-auth's exact 429 and never reaches the handler", async () => {
    consume = vi.fn(async () => denied);
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      payload: { email: "a@b.com", password: "nope" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(response.headers["x-retry-after"]).toBe("37");
    expect(response.body).toBe(
      '{"message":"Too many requests. Please try again later."}',
    );
    expect(handled).toEqual([]);
  });

  it("does not leak which dimension tripped", async () => {
    const bodies: string[] = [];
    for (const trippedKeyPrefix of ["authgate:ip:", "authgate:acct:"]) {
      consume = vi.fn(async (key: string) =>
        key.startsWith(trippedKeyPrefix) ? denied : allow,
      );
      await build();
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        payload: { email: "a@b.com", password: "nope" },
      });
      expect(response.statusCode).toBe(429);
      bodies.push(response.body);
    }

    expect(bodies[0]).toBe(bodies[1]);
  });

  it("leaves /get-session and /token alone even when the limiter would deny", async () => {
    consume = vi.fn(async () => denied);
    await build();

    for (const path of ["/api/auth/get-session", "/api/auth/token"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(401);
    }
    expect(consume).not.toHaveBeenCalled();
    expect(handled).toEqual(["/api/auth/get-session", "/api/auth/token"]);
  });

  it("ignores non-auth routes entirely", async () => {
    consume = vi.fn(async () => denied);
    await build();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  it("fails OPEN when Redis throws — a Redis outage must not brick sign-in", async () => {
    consume = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      payload: { email: "a@b.com", password: "nope" },
    });

    expect(response.statusCode).toBe(401);
    expect(handled).toEqual(["/api/auth/sign-in/email"]);
  });

  /**
   * "Buffer body ⇒ IP-only" is ONLY correct for content types better-call
   * itself rejects. form-urlencoded is one: better-call 415s it for these
   * endpoints, so there is no request to account-limit.
   */
  it("is IP-only for a Buffer body better-call would REJECT (form-urlencoded)", async () => {
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        "cf-connecting-ip": "203.0.113.1",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "email=a%40b.com&password=nope",
    });

    expect(response.statusCode).toBe(401);
    expect(handled).toEqual(["/api/auth/sign-in/email"]);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]![0]).toMatch(/^authgate:ip:/);
  });

  /**
   * REGRESSION: `application/jsonx` used to skip the account bucket entirely.
   * Fastify's parser is registered for the LITERAL `application/json`, so this
   * arrives as a Buffer — but better-call's own predicate accepts it and
   * parses it as a sign-in body. The plugin must thread `content-type` through
   * so the limiter can re-parse.
   */
  it("STILL applies the account bucket for content-type: application/jsonx", async () => {
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        "cf-connecting-ip": "203.0.113.1",
        "content-type": "application/jsonx",
      },
      payload: JSON.stringify({ email: "a@b.com", password: "nope" }),
    });

    expect(response.statusCode).toBe(401);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume.mock.calls[1]![0]).toMatch(/^authgate:acct:/);
  });

  /**
   * REGRESSION (raw socket — see the note at the top of this file).
   *
   * WHATWG normalization in `plugins/better-auth.ts`' `new URL()` happens
   * between this hook and better-call's router, so a raw target that does not
   * literally spell the endpoint still EXECUTES it. Every row here reached a
   * live guess-space endpoint with ZERO tokens consumed before the fix.
   */
  describe("un-normalized targets (raw socket)", () => {
    /**
     * META-TEST for the cases below. It asserts the two halves that make them
     * meaningful at all:
     *
     *  1. the RAW target reaches the app un-normalized (what `app.inject`
     *     silently destroys), and
     *  2. the limiter nonetheless resolved it to the endpoint's rule.
     *
     * If (1) ever regresses, every case below keeps passing while testing
     * nothing — so assert it explicitly rather than trusting the transport.
     */
    it("proves the raw target survives un-normalized AND still resolves to the rule", async () => {
      await build(); // consume allows, so the handler runs and records the URL
      const port = await listen();

      await rawRequest(
        port,
        "POST /api/auth/x/../sign-in/email HTTP/1.1",
        {
          "cf-connecting-ip": "203.0.113.1",
          "content-type": "application/json",
        },
        JSON.stringify({ email: "a@b.com", password: "nope" }),
      );

      expect(handled).toEqual(["/api/auth/x/../sign-in/email"]);
      expect(consume.mock.calls[0]![0]).toBe(
        "authgate:ip:/sign-in/email:203.0.113.1",
      );
    });

    it.each([
      "/api/auth/x/../sign-in/email",
      "/api/auth/./sign-in/email",
      "/api/auth/%2e/sign-in/email",
      "/api/auth/x/.%2e/sign-in/email",
      "/api/auth/sign-in\\email",
      // basePath RE-OCCURRENCE: the raw target starts with `/api/auth/` (so
      // Fastify routes it and the pre-filter fires) but normalization moves
      // the first `/api/auth` later, defeating a `startsWith` strip. Measured
      // live at 24 x 401 before the substring strip landed.
      "/api/auth/../api/auth/sign-in/email",
      // NON-EMPTY FIRST SEGMENT: rou3 ignores segment 0's CONTENT, so the
      // strip yields `X/sign-in/email` and the endpoint still executes.
      // Measured live at 24 x 401 before the collapse landed.
      "/api/auth/../api/authX/sign-in/email",
      "/api/auth/../api/auth9/sign-in/email",
      "/api/auth/..\\api/authZ/sign-in/email",
      "/api/auth/../api/auth;q/sign-in/email",
    ])("429s %s", async (target) => {
      consume = vi.fn(async () => denied);
      await build();
      const port = await listen();

      const raw = await rawRequest(
        port,
        `POST ${target} HTTP/1.1`,
        {
          "cf-connecting-ip": "203.0.113.1",
          "content-type": "application/json",
        },
        JSON.stringify({ email: "a@b.com", password: "nope" }),
      );

      expect(statusOf(raw)).toBe(429);
      expect(handled).toEqual([]);
      expect(consume.mock.calls[0]![0]).toBe(
        "authgate:ip:/sign-in/email:203.0.113.1",
      );
    });

    it.each([
      ["/api/auth/two-factor/x/../verify-totp", "/two-factor/verify-totp"],
      [
        "/api/auth/passkey/x/../verify-authentication",
        "/passkey/verify-authentication",
      ],
    ])("429s %s and keys it as %s", async (target, expectedPath) => {
      consume = vi.fn(async () => denied);
      await build();
      const port = await listen();

      const raw = await rawRequest(
        port,
        `POST ${target} HTTP/1.1`,
        {
          "cf-connecting-ip": "203.0.113.1",
          "content-type": "application/json",
        },
        JSON.stringify({ code: "000000" }),
      );

      expect(statusOf(raw)).toBe(429);
      expect(consume.mock.calls[0]![0]).toBe(
        `authgate:ip:${expectedPath}:203.0.113.1`,
      );
    });

    it("shares ONE bucket across first-segment variants (no sharding)", async () => {
      const keys: string[] = [];
      consume = vi.fn(async (key: string) => {
        keys.push(key);
        return allow;
      });
      await build();
      const port = await listen();

      for (const target of [
        "/api/auth/sign-in/email",
        "/api/auth/../api/authX/sign-in/email",
        "/api/auth/../api/auth9/sign-in/email",
        "/api/auth/../api/auth;q/sign-in/email",
      ]) {
        await rawRequest(
          port,
          `POST ${target} HTTP/1.1`,
          {
            "cf-connecting-ip": "203.0.113.1",
            "content-type": "application/json",
          },
          JSON.stringify({ email: "a@b.com", password: "nope" }),
        );
      }

      const ipKeys = keys.filter((k) => k.startsWith("authgate:ip:"));
      expect(ipKeys).toHaveLength(4);
      expect(new Set(ipKeys)).toEqual(
        new Set(["authgate:ip:/sign-in/email:203.0.113.1"]),
      );
    });

    it("still leaves /token alone when reached via a dot-segment form", async () => {
      consume = vi.fn(async () => denied);
      await build();
      const port = await listen();

      const raw = await rawRequest(port, "GET /api/auth/x/../token HTTP/1.1", {
        "cf-connecting-ip": "203.0.113.1",
      });

      expect(statusOf(raw)).toBe(401);
      expect(consume).not.toHaveBeenCalled();
    });
  });
});
