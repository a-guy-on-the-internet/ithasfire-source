import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  addRoute as addRou3Route,
  createRouter as createRou3Router,
  findRoute as findRou3Route,
} from "rou3";

import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";

import {
  AUTH_RATE_LIMIT_RESPONSE_BODY,
  AUTH_RATE_LIMIT_RESPONSE_CONTENT_TYPE,
  AUTH_RATE_LIMIT_RETRY_AFTER_HEADER,
  buildAccountBucketKey,
  buildIpBucketKey,
  createAccountIdentifierHasher,
  createAtomicAuthRateLimiter,
  extractAccountIdentifier,
  normalizeAuthPath,
  resolveLimiterIp,
} from "../src/auth/atomic-rate-limit";
import {
  AUTH_ACCOUNT_BUCKET_MULTIPLIER,
  AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND,
  AUTH_GUESS_SPACE_PATHS,
  AUTH_RATE_LIMIT_CUSTOM_RULES,
  resolveAccountCap,
  resolveGuessSpaceRule,
} from "../src/auth/rate-limit-rules";

/**
 * The single behaviour that makes this module worth existing — that N
 * concurrent requests consume N tokens — is NOT provable here: a mocked
 * limiter is atomic by construction. It is proven against a real Redis in
 * `test/integration/auth-atomic-rate-limit-concurrency.test.ts`. Everything
 * below is the surrounding contract: which paths are covered, how the keys
 * are built, and that no input shape can throw into the auth request path.
 */

const allow = (remaining = 1): RateLimitResult => ({
  allowed: true,
  remaining,
  retryAfterSeconds: 0,
});

const deny = (retryAfterSeconds = 42): RateLimitResult => ({
  allowed: false,
  remaining: 0,
  retryAfterSeconds,
});

function makeLogger() {
  return { warn: vi.fn() };
}

const TEST_HASH_KEY = "test-identifier-hash-key";

function makeLimiter(
  consume: RateLimitPort["consume"],
  extra: { reportError?: (err: unknown, ctx?: unknown) => void } = {},
) {
  const logger = makeLogger();
  const limiter = createAtomicAuthRateLimiter({
    rateLimit: { consume },
    logger,
    identifierHashKey: TEST_HASH_KEY,
    ...(extra.reportError ? { reportError: extra.reportError as never } : {}),
  });
  return { limiter, logger };
}

const signInBody = { email: "Person@Example.COM", password: "hunter2" };

// ─────────────────────────────────────────────────────────────────────────────
// better-call's OWN path derivation, copied VERBATIM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transcribed from `node_modules/better-call/dist/router.mjs`'s
 * `processRequest`, unchanged apart from hoisting `basePath` to a parameter:
 *
 *   const url = new URL(request.url);
 *   const pathname = url.pathname;
 *   const path = config?.basePath && config.basePath !== "/"
 *     ? pathname.split(config.basePath).reduce((acc, curr, index) => {
 *         if (index !== 0) if (index > 1) acc.push(`${config.basePath}${curr}`);
 *         else acc.push(curr);
 *         return acc;
 *       }, []).join("")
 *     : url.pathname;
 *   if (!path?.length) return 404;
 *   if (/\/{2,}/.test(path)) return 404;
 *   const route = findRoute(router, request.method, path);
 *   if (path.endsWith("/") !== route?.data?.path?.endsWith("/")) return 404;
 *   if (!route?.data) return 404;
 *
 * DO NOT "simplify" this. It exists so that a better-call upgrade which
 * changes the derivation makes the equivalence test below FAIL LOUDLY, rather
 * than silently reopening a bypass. Our production code uses `indexOf`, which
 * is algebraically the same thing — that claim is what gets asserted, not
 * assumed.
 */
function betterCallDerivedPath(rawUrl: string, basePath: string): string {
  const pathname = new URL(rawUrl, "http://localhost").pathname;
  return pathname
    .split(basePath)
    .reduce<string[]>((acc, curr, index) => {
      if (index !== 0)
        if (index > 1) acc.push(`${basePath}${curr}`);
        else acc.push(curr);
      return acc;
    }, [])
    .join("");
}

/**
 * The REAL rou3 router, built from our guess-space paths.
 *
 * The previous version of this file MODELLED the route decision with
 * `!derived.startsWith("/") → 404`. That premise was false — rou3 splits on
 * `/` and compares from index 1, so segment 0's CONTENT is never examined and
 * only the segment COUNT matters — and because the test shared the production
 * code's wrong assumption, it passed on vulnerable code. Same failure as the
 * `app.inject` normalization, one layer up: a hand-written model of a
 * dependency is only ever as good as the author's understanding of it.
 *
 * So execute the dependency instead of describing it.
 */
const rou3Router = createRou3Router<{ path: string }>();
for (const path of AUTH_GUESS_SPACE_PATHS) {
  addRou3Route(rou3Router, "POST", path, { path });
  addRou3Route(rou3Router, "GET", path, { path });
}
// Not guess-space, but they must stay OUT — pinning them needs them routable.
for (const path of ["/token", "/get-session", "/sign-up/email"]) {
  addRou3Route(rou3Router, "POST", path, { path });
  addRou3Route(rou3Router, "GET", path, { path });
}

/**
 * better-call's post-derivation gates, in order, with the ROUTE DECISION taken
 * from the real rou3 rather than modelled. Returns the endpoint path the
 * router would execute, or `null` for a 404.
 *
 * Order and semantics transcribed from `processRequest`:
 *   if (!path?.length) 404
 *   if (/\/{2,}/.test(path)) 404
 *   const route = findRoute(router, method, path)
 *   if (path.endsWith("/") !== route?.data?.path?.endsWith("/")) 404
 *   if (!route?.data) 404
 */
function betterCallRoutedPath(
  derived: string,
  method: "GET" | "POST" = "POST",
): string | null {
  if (!derived.length) return null;
  if (/\/{2,}/.test(derived)) return null;
  const route = findRou3Route(rou3Router, method, derived);
  if (derived.endsWith("/") !== route?.data?.path?.endsWith("/")) return null;
  if (!route?.data) return null;
  return route.data.path;
}

describe("normalizeAuthPath", () => {
  it("strips the better-auth basePath", () => {
    expect(normalizeAuthPath("/api/auth/sign-in/email")).toBe("/sign-in/email");
  });

  it("strips the query string (magic-link/verify is a GET with ?token=)", () => {
    expect(normalizeAuthPath("/api/auth/magic-link/verify?token=abc")).toBe(
      "/magic-link/verify",
    );
  });

  it("strips trailing slashes so /sign-in/email/ can't dodge the rule", () => {
    expect(normalizeAuthPath("/api/auth/sign-in/email/")).toBe(
      "/sign-in/email",
    );
  });

  it("returns null for non-auth URLs", () => {
    expect(normalizeAuthPath("/trpc/events.list")).toBeNull();
    expect(normalizeAuthPath("/health")).toBeNull();
    // A path that merely starts with the same characters is not under it.
    expect(normalizeAuthPath("/api/authorize")).toBeNull();
  });

  /**
   * REGRESSION — these shipped green once, because this suite had no
   * normalization cases at all.
   *
   * `plugins/better-auth.ts` runs `new URL(request.url, ...)` before
   * better-call sees the path, so WHATWG normalization (dot-segment removal,
   * `%2e` decoded as a dot segment, `\` → `/`) happens BETWEEN the limiter and
   * the router. Matching on Fastify's raw target meant every row below reached
   * a live guess-space endpoint having consumed ZERO tokens. Measured on the
   * running dev API at 24 concurrent, cap 5: `/api/auth/./sign-in/email` and
   * `/api/auth/sign-in\email` both returned 24 x 401, no 429s.
   */
  describe("resolves the way the downstream router does", () => {
    it.each([
      ["/api/auth/x/../sign-in/email", "/sign-in/email"],
      ["/api/auth/./sign-in/email", "/sign-in/email"],
      ["/api/auth/%2e/sign-in/email", "/sign-in/email"],
      ["/api/auth/%2E/sign-in/email", "/sign-in/email"],
      ["/api/auth/x/.%2e/sign-in/email", "/sign-in/email"],
      ["/api/auth/x/%2e%2e/sign-in/email", "/sign-in/email"],
      ["/api/auth/sign-in\\email", "/sign-in/email"],
      ["/api/auth\\sign-in/email", "/sign-in/email"],
      ["/api/auth/x/../sign-in/email?cb=1", "/sign-in/email"],
      ["/api/auth/two-factor/x/../verify-totp", "/two-factor/verify-totp"],
      [
        "/api/auth/passkey/x/../verify-authentication",
        "/passkey/verify-authentication",
      ],
      [
        "/api/auth/email-otp/x/../send-verification-otp",
        "/email-otp/send-verification-otp",
      ],
      // ── basePath RE-OCCURRENCE (round 3) ────────────────────────────────
      // The raw target starts with `/api/auth/` so Fastify routes it and the
      // plugin's pre-filter fires, but WHATWG normalization moves the FIRST
      // `/api/auth` later in the string. A `startsWith` strip returned null
      // here — measured live at 24 x 401, zero 429s — while better-call's
      // substring strip still yielded `/sign-in/email` and ran sign-in.
      // All three normalize to a pathname whose FIRST `/api/auth` sits after
      // the leading `/api/…`, so the router's substring strip yields the bare
      // endpoint. (These expectations are computed by the equivalence test
      // below, not asserted by hand — an earlier hand-written guess here was
      // wrong in the direction of under-limiting.)
      ["/api/auth/../api/auth/sign-in/email", "/sign-in/email"],
      ["/api/auth/../x/api/auth/sign-in/email", "/sign-in/email"],
      ["/api/auth/..\\x/api/auth/sign-in/email", "/sign-in/email"],
    ])("%s → %s", (raw, expected) => {
      expect(normalizeAuthPath(raw)).toBe(expected);
    });

    /**
     * STRUCTURAL GUARD — the reason the round-3 bypass survived round 2 is
     * that the table above only enumerates escapes somebody thought of, and
     * the plugin tests drive a STUB `/api/auth/*` handler: they assert "the
     * limiter keys X" but never "better-call routes this target to X".
     *
     * So assert the mirror directly, against a VERBATIM copy of better-call's
     * own derivation (see `betterCallDerivedPath`). For every target the
     * router would actually route, `normalizeAuthPath` must return exactly
     * what the router derived. A better-call/better-auth upgrade that changes
     * the derivation now fails HERE instead of silently reopening the hole.
     */
    describe("equals better-call's own derivation (verbatim copy)", () => {
      const TARGETS = [
        "/api/auth/sign-in/email",
        "/api/auth/sign-in/username",
        "/api/auth/two-factor/verify-totp",
        "/api/auth/get-session",
        "/api/auth/token",
        "/api/auth/sign-up/email",
        // dot segments / encoded dots / backslashes
        "/api/auth/x/../sign-in/email",
        "/api/auth/./sign-in/email",
        "/api/auth/%2e/sign-in/email",
        "/api/auth/%2E/sign-in/email",
        "/api/auth/x/.%2e/sign-in/email",
        "/api/auth/x/%2e%2e/sign-in/email",
        "/api/auth/sign-in\\email",
        "/api/auth\\sign-in/email",
        "/api/auth/two-factor/x/../verify-totp",
        "/api/auth/passkey/x/../verify-authentication",
        // basePath re-occurrence
        "/api/auth/../api/auth/sign-in/email",
        "/api/auth/../x/api/auth/sign-in/email",
        "/api/auth/..\\x/api/auth/sign-in/email",
        "/api/auth/api/auth/sign-in/email",
        "/api/auth/x/api/auth/y/api/auth/sign-in/email",
        // %2f is NOT decoded as a separator — hook and router must agree
        "/api/auth/..%2fx/api/auth/sign-in/email",
        // query strings must not change the path
        "/api/auth/magic-link/verify?token=abc",
        "/api/auth/x/../sign-in/email?cb=1",
        // round 4: rou3 ignores segment-0 CONTENT, so these all EXECUTE
        "/api/auth/../api/authX/sign-in/email",
        "/api/auth/../api/auth9/sign-in/email",
        "/api/auth/..\\api/authZ/sign-in/email",
        "/api/auth/../api/auth;q/sign-in/email",
        "/api/auth/../api/auth-/two-factor/verify-totp",
        "/api/auth/../api/authX/token",
        // forms the router refuses
        "/api/auth//sign-in/email",
        "/api/auth/sign-in/email/",
        "/api/auth",
        "/api/authorize",
      ];

      /**
       * THE INVARIANT: wherever the REAL router selects an endpoint,
       * `normalizeAuthPath` must return that same endpoint path, so the right
       * rule and the right bucket apply.
       *
       * Where the router 404s we may reject (null) or resolve anyway — that is
       * over-inclusive in the SAFE direction and keeps us aligned with Better
       * Auth's own `normalizePathname` rule matching for the trailing-slash
       * form.
       */
      const checkTarget = (raw: string): string | null => {
        const derived = betterCallDerivedPath(raw, "/api/auth");
        const routed = betterCallRoutedPath(derived);
        const ours = normalizeAuthPath(raw);
        if (routed === null) return null;
        if (ours === routed) return null;
        return `${raw}  ->  router executes ${routed}, we resolved ${JSON.stringify(ours)}`;
      };

      it.each(TARGETS)("%s: agrees with the REAL router", (raw) => {
        expect(checkTarget(raw)).toBeNull();
      });

      /**
       * GENERATED CORPUS — coverage must not be bounded by what the author
       * thought to type. Every bypass in this file's history was a shape
       * nobody enumerated: dot segments (round 2), basePath re-occurrence
       * (round 3), a non-empty first segment (round 4).
       *
       * Cross-product of dangerous segments against tails, in the three shapes
       * that have actually produced bypasses. Misses are COLLECTED and
       * asserted empty in one go, so a failure names every offending target
       * rather than stopping at the first.
       */
      it("agrees with the REAL router across a generated corpus", () => {
        const segments = [
          "",
          "x",
          "X",
          "..",
          ".",
          "%2e",
          "%2E",
          ".%2e",
          "%2e%2e",
          "..%2f",
          "api",
          "auth",
          "api/auth",
          "\\",
          "9;1y",
          ":a",
          "!",
        ];
        const tails = [
          "/sign-in/email",
          "/two-factor/verify-totp",
          "/token",
          "/sign-in/email/",
          "//sign-in/email",
          "",
          "/",
        ];

        const targets = new Set<string>();
        for (const a of segments) {
          for (const b of segments) {
            for (const tail of tails) {
              targets.add(`/api/auth/${a}/${b}${tail}`);
              targets.add(`/api/auth/${a}/api/auth${b}${tail}`);
              targets.add(`/api/auth/../api/auth${a}${tail}`);
            }
          }
        }

        const misses: string[] = [];
        for (const raw of targets) {
          // Fastify's route is `/api/auth/*`; anything else never reaches the
          // hook, so it is out of scope for this equivalence.
          if (!raw.startsWith("/api/auth/")) continue;
          const miss = checkTarget(raw);
          if (miss) misses.push(miss);
        }

        expect(targets.size).toBeGreaterThan(1500);
        expect(misses).toEqual([]);
      });

      it("pins the mirror in BOTH directions on the re-occurrence pair", () => {
        // Routed → must be limited as /sign-in/email.
        expect(
          betterCallRoutedPath(
            betterCallDerivedPath(
              "/api/auth/../api/auth/sign-in/email",
              "/api/auth",
            ),
          ),
        ).toBe("/sign-in/email");
        expect(normalizeAuthPath("/api/auth/../api/auth/sign-in/email")).toBe(
          "/sign-in/email",
        );

        // NOT routed (segment count differs) → must NOT be treated as the
        // guess-space path. Verified live: 24 x 404.
        expect(
          betterCallRoutedPath(
            betterCallDerivedPath(
              "/api/auth/api/auth/sign-in/email",
              "/api/auth",
            ),
          ),
        ).toBeNull();
        expect(resolveGuessSpaceRule("/api/auth/sign-in/email")).toBeNull();
      });

      /**
       * ROUND-4 REGRESSION, pinned against the real router rather than a
       * model: rou3 ignores segment 0's CONTENT, so these execute.
       */
      it.each([
        ["/api/auth/../api/authX/sign-in/email", "/sign-in/email"],
        ["/api/auth/../api/auth9/sign-in/email", "/sign-in/email"],
        ["/api/auth/..\\api/authZ/sign-in/email", "/sign-in/email"],
        ["/api/auth/../api/auth;q/sign-in/email", "/sign-in/email"],
        [
          "/api/auth/../api/auth-/two-factor/verify-totp",
          "/two-factor/verify-totp",
        ],
      ])("%s executes %s and must share its bucket", (raw, endpoint) => {
        expect(
          betterCallRoutedPath(betterCallDerivedPath(raw, "/api/auth")),
        ).toBe(endpoint);
        expect(normalizeAuthPath(raw)).toBe(endpoint);
      });

      it("collapses the leading segment rather than sharding on it", () => {
        // Varying the free character must NOT create distinct buckets.
        const resolved = [
          "/api/auth/../api/authX/sign-in/email",
          "/api/auth/../api/authY/sign-in/email",
          "/api/auth/../api/auth9/sign-in/email",
          "/api/auth/../api/auth;q/sign-in/email",
          "/api/auth/sign-in/email",
        ].map((raw) => normalizeAuthPath(raw));

        expect(new Set(resolved)).toEqual(new Set(["/sign-in/email"]));
      });

      it("our indexOf strip is algebraically the router's split/reduce", () => {
        // The production code uses indexOf for clarity; this is the claim that
        // makes that safe, checked over every target rather than argued.
        for (const raw of TARGETS) {
          const pathname = new URL(raw, "http://localhost").pathname;
          const idx = pathname.indexOf("/api/auth");
          const viaIndexOf =
            idx === -1 ? "" : pathname.slice(idx + "/api/auth".length);
          expect(betterCallDerivedPath(raw, "/api/auth"), raw).toBe(viaIndexOf);
        }
      });

      /**
       * FRESHNESS PIN for the one thing that still has to be transcribed
       * (the basePath strip has no runtime to call). Reads the installed dist
       * and asserts the construct is still there, so an upgrade that rewrites
       * it fails HERE — which is what the transcription's doc comment claims
       * and, before this test, could not deliver.
       */
      it("the transcribed basePath strip still matches the installed better-call", () => {
        const require = createRequire(import.meta.url);
        // `dist/router.mjs` is not an exported subpath, so resolve the package
        // ENTRY and walk to its sibling rather than hard-coding a
        // node_modules layout (pnpm's is not flat).
        const entry = require.resolve("better-call");
        const routerPath = join(dirname(entry), "router.mjs");
        const source = readFileSync(routerPath, "utf8");
        expect(
          source.includes("pathname.split(config.basePath).reduce("),
          `better-call's basePath strip changed in ${routerPath} — re-derive betterCallDerivedPath and re-check normalizeAuthPath against it`,
        ).toBe(true);
      });
    });

    it("gives every variant the SAME rule as the plain path", async () => {
      for (const raw of [
        "/api/auth/sign-in/email",
        "/api/auth/x/../sign-in/email",
        "/api/auth/./sign-in/email",
        "/api/auth/%2e/sign-in/email",
        "/api/auth/x/.%2e/sign-in/email",
        "/api/auth/sign-in\\email",
      ]) {
        const keys: string[] = [];
        const consume = vi.fn(async (key: string) => {
          keys.push(key);
          return allow();
        });
        const { limiter } = makeLimiter(consume);

        await limiter({
          url: raw,
          headers: { "cf-connecting-ip": "203.0.113.1" },
          body: signInBody,
        });

        expect(keys, raw).toEqual([
          "authgate:ip:/sign-in/email:203.0.113.1",
          expect.stringMatching(
            /^authgate:acct:\/sign-in\/email:[0-9a-f]{32}$/,
          ),
        ]);
      }
    });

    /**
     * Rejecting something the router would EXECUTE is the failure mode that
     * matters, so these were confirmed against the live API (all 404) rather
     * than assumed: better-call/rou3 refuses duplicate slashes, and this
     * function must not "helpfully" collapse them into a match.
     */
    it.each([
      "/api/auth//sign-in/email",
      "//api/auth/sign-in/email",
      "//evil.example.com/api/auth/sign-in/email",
    ])("rejects %s (better-call 404s it; verified live)", (raw) => {
      expect(normalizeAuthPath(raw)).toBeNull();
    });

    it("returns null instead of throwing on an unparseable target", () => {
      for (const raw of ["", "not-a-path", "http://evil.com/api/auth/x"]) {
        expect(() => normalizeAuthPath(raw)).not.toThrow();
        expect(normalizeAuthPath(raw)).toBeNull();
      }
    });
  });
});

describe("covered vs uncovered paths", () => {
  it.each([
    "/sign-in/email",
    "/sign-in/username",
    "/sign-in/phone-number",
    "/sign-in/email-otp",
    "/email-otp/verify-email",
    "/email-otp/send-verification-otp",
    "/phone-number/verify",
    "/phone-number/send-otp",
    "/two-factor/verify-totp",
    "/two-factor/verify-otp",
    "/two-factor/verify-backup-code",
    "/magic-link/verify",
    "/passkey/verify-authentication",
  ])("consumes a token for %s", async (path) => {
    const consume = vi.fn(async () => allow());
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: `/api/auth${path}`,
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: {},
    });

    expect(consume).toHaveBeenCalled();
  });

  it.each([
    // Deliberately exempt: polled on virtually every page load.
    "/get-session",
    // Deliberately excluded: server-to-server mint on ONE shared egress IP;
    // an atomic 300/60s there would re-create the staff-wide lockout.
    "/token",
    // Not guess-space: covered only by better-auth's global floor.
    "/sign-up/email",
    "/sign-out",
    "/forget-password",
    "/reset-password",
    "/callback/google",
  ])("does NOT consume a token for %s", async (path) => {
    const consume = vi.fn(async () => allow());
    const { limiter } = makeLimiter(consume);

    const decision = await limiter({
      url: `/api/auth${path}`,
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: signInBody,
    });

    expect(consume).not.toHaveBeenCalled();
    expect(decision).toEqual({ limited: false });
  });

  it("ignores requests that aren't under the auth basePath at all", async () => {
    const consume = vi.fn(async () => allow());
    const { limiter } = makeLimiter(consume);

    await limiter({ url: "/trpc/events.list", headers: {}, body: {} });

    expect(consume).not.toHaveBeenCalled();
  });
});

describe("IP extraction", () => {
  it("prefers cf-connecting-ip over every other header (forgeable ones lose)", () => {
    expect(
      resolveLimiterIp({
        "cf-connecting-ip": "203.0.113.1",
        "true-client-ip": "203.0.113.2",
        "x-real-ip": "203.0.113.3",
        "x-forwarded-for": "203.0.113.4",
      }),
    ).toBe("203.0.113.1");
  });

  it("falls through the platform precedence in order", () => {
    expect(
      resolveLimiterIp({
        "x-real-ip": "203.0.113.3",
        "x-forwarded-for": "203.0.113.4",
      }),
    ).toBe("203.0.113.3");
  });

  it("takes the leftmost x-forwarded-for entry", () => {
    expect(
      resolveLimiterIp({
        "x-forwarded-for": "203.0.113.4, 10.0.0.1, 10.0.0.2",
      }),
    ).toBe("203.0.113.4");
  });

  it("falls back to the socket peer LAST (dev/localhost parity with better-auth)", () => {
    expect(resolveLimiterIp({}, "127.0.0.1")).toBe("127.0.0.1");
  });

  it("truncates an oversized header so a client can't write a huge Redis key", () => {
    const ip = resolveLimiterIp({ "x-real-ip": "9".repeat(5000) });
    expect(ip).toHaveLength(64);
  });

  it("returns null when nothing resolves", () => {
    expect(resolveLimiterIp({})).toBeNull();
    expect(resolveLimiterIp(null)).toBeNull();
  });
});

describe("account identifier extraction", () => {
  it.each([
    ["/sign-in/email", { email: "A@B.com" }, "a@b.com"],
    ["/sign-in/email-otp", { email: " A@B.com " }, "a@b.com"],
    ["/email-otp/verify-email", { email: "A@B.com" }, "a@b.com"],
    ["/email-otp/send-verification-otp", { email: "A@B.com" }, "a@b.com"],
    ["/sign-in/username", { username: "  MixedCase " }, "mixedcase"],
    [
      "/sign-in/phone-number",
      { phoneNumber: "+1 (615) 555-0100" },
      "+16155550100",
    ],
    [
      "/phone-number/verify",
      { phoneNumber: "+1-615-555-0100" },
      "+16155550100",
    ],
    ["/phone-number/send-otp", { phoneNumber: "+16155550100" }, "+16155550100"],
  ])("normalizes %s's identifier", (path, body, expected) => {
    expect(extractAccountIdentifier(path, body)).toBe(expected);
  });

  it("does not assume one field name — /sign-in/username has no `email`", () => {
    expect(
      extractAccountIdentifier("/sign-in/username", { email: "a@b.com" }),
    ).toBeNull();
  });

  it.each([
    "/two-factor/verify-totp",
    "/two-factor/verify-otp",
    "/two-factor/verify-backup-code",
    "/magic-link/verify",
    "/passkey/verify-authentication",
  ])("has no body identifier for %s (IP-only by design)", (path) => {
    expect(extractAccountIdentifier(path, { code: "123456" })).toBeNull();
  });

  it.each([
    ["undefined body", undefined],
    ["null body", null],
    ["string body", "email=a@b.com"],
    ["array body", [{ email: "a@b.com" }]],
    ["non-string email", { email: 12345 }],
    ["object email (JSON injection attempt)", { email: { toString: "x" } }],
    ["empty email", { email: "   " }],
  ])("never throws and yields null for a %s", (_label, body) => {
    expect(() =>
      extractAccountIdentifier("/sign-in/email", body),
    ).not.toThrow();
    expect(extractAccountIdentifier("/sign-in/email", body)).toBeNull();
  });

  /**
   * REGRESSION — `Content-Type: application/jsonx` used to skip the account
   * bucket entirely.
   *
   * `plugins/raw-body.ts` registers Fastify's JSON parser for the LITERAL
   * `application/json`, so anything else arrives as a Buffer. But better-call
   * gates on `base.includes("application/json")` (SUBSTRING) and parses with
   * `/^application\/([a-z0-9.+-]*\+)?json/i` (END-UNANCHORED), so
   * `application/jsonx` is a valid sign-in body to Better Auth. Measured live,
   * 24 concurrent from 24 DISTINCT IPs against one account (cap 20):
   * `application/json` → 20 x 401 + 4 x 429, `application/jsonx` → 24 x 401.
   */
  describe("Buffer bodies better-call WOULD parse as JSON", () => {
    const buf = () =>
      Buffer.from(JSON.stringify({ email: "Person@Example.COM" }));

    it.each([
      "application/json",
      "application/jsonx", // the bypass
      "application/JSONX", // predicate is case-insensitive
      "application/json; charset=utf-8",
      "application/vnd.api+json",
      "application/problem+json",
      "application/json;charset=utf-8",
    ])("re-parses a Buffer sent as %s", (contentType) => {
      expect(
        extractAccountIdentifier("/sign-in/email", buf(), contentType),
      ).toBe("person@example.com");
    });

    it.each([
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain",
      "text/json", // better-call's regex is ^application/ anchored
      "application/xjson", // ...and so is this
    ])("leaves a Buffer sent as %s alone (IP-only)", (contentType) => {
      expect(
        extractAccountIdentifier("/sign-in/email", buf(), contentType),
      ).toBeNull();
    });

    it("handles an array-valued content-type header (Fastify allows it)", () => {
      expect(
        extractAccountIdentifier("/sign-in/email", buf(), [
          "application/jsonx",
        ]),
      ).toBe("person@example.com");
    });

    it("is IP-only when the content-type is missing entirely", () => {
      expect(
        extractAccountIdentifier("/sign-in/email", buf(), undefined),
      ).toBeNull();
    });

    it("never throws on malformed JSON in a json-typed Buffer", () => {
      const bad = Buffer.from("{not json");
      expect(() =>
        extractAccountIdentifier("/sign-in/email", bad, "application/json"),
      ).not.toThrow();
      expect(
        extractAccountIdentifier("/sign-in/email", bad, "application/json"),
      ).toBeNull();
    });

    it("refuses to re-parse an oversized body (sync JSON.parse is an event-loop stall)", () => {
      // Fastify's bodyLimit is 10 MiB; re-parsing that per auth request would
      // be a DoS through the very endpoint being protected.
      const huge = Buffer.from(
        JSON.stringify({ email: "a@b.com", pad: "x".repeat(70 * 1024) }),
      );
      expect(
        extractAccountIdentifier("/sign-in/email", huge, "application/json"),
      ).toBeNull();
    });
  });
});

describe("key construction", () => {
  /**
   * The account component must be a KEYED hash. Emails are an enumerable
   * preimage space, so a bare SHA-256 in a leaked Redis dump is reversible by
   * wordlist at megahashes/second — it would obfuscate nothing from the exact
   * adversary the hashing exists to stop.
   */
  it("HMACs the identifier with the injected key — not a bare digest", () => {
    const hash =
      createAccountIdentifierHasher(TEST_HASH_KEY)("person@example.com");
    const key = buildAccountBucketKey("/sign-in/email", hash);

    expect(key).not.toContain("person@example.com");
    expect(hash).toBe(
      createHmac("sha256", TEST_HASH_KEY)
        // DOMAIN SEPARATION: the production key is BETTER_AUTH_SECRET, which
        // is used for other purposes too, so the message carries a
        // NUL-terminated label. Pinned here so it can't be dropped silently.
        .update("authgate:acct:v1\0")
        .update("person@example.com")
        .digest("hex")
        .slice(0, 32),
    );
  });

  it("is domain-separated — a bare HMAC over the same key differs", () => {
    const hasher = createAccountIdentifierHasher(TEST_HASH_KEY);
    const bare = createHmac("sha256", TEST_HASH_KEY)
      .update("person@example.com")
      .digest("hex")
      .slice(0, 32);
    expect(hasher("person@example.com")).not.toBe(bare);
  });

  it("produces a DIFFERENT digest under a different key (the secret actually matters)", () => {
    const a = createAccountIdentifierHasher("key-a")("person@example.com");
    const b = createAccountIdentifierHasher("key-b")("person@example.com");
    expect(a).not.toBe(b);
  });

  it("is deterministic for one key (buckets must survive across instances)", () => {
    const hasher = createAccountIdentifierHasher(TEST_HASH_KEY);
    expect(hasher("person@example.com")).toBe(hasher("person@example.com"));
  });

  it("namespaces away from the better-auth (bauth:rl:) and tRPC (default:) keyspaces", () => {
    const ipKey = buildIpBucketKey("/sign-in/email", "203.0.113.1");
    const acctKey = buildAccountBucketKey("/sign-in/email", "deadbeef");

    for (const key of [ipKey, acctKey]) {
      expect(key.startsWith("authgate:")).toBe(true);
      expect(key.startsWith("bauth:rl:")).toBe(false);
      expect(key.startsWith("default:")).toBe(false);
    }
    // The two dimensions must never share a bucket.
    expect(ipKey).not.toBe(acctKey);
  });

  it("keys the account bucket on the identifier, not the IP (distributed stuffing)", async () => {
    const keys: string[] = [];
    const consume = vi.fn(async (key: string) => {
      keys.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });
    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "198.51.100.7" },
      body: signInBody,
    });

    const accountKeys = keys.filter((k) => k.startsWith("authgate:acct:"));
    expect(accountKeys).toHaveLength(2);
    expect(accountKeys[0]).toBe(accountKeys[1]);
  });

  it("shares a bucket across identifier casing/whitespace variants", async () => {
    const keys: string[] = [];
    const consume = vi.fn(async (key: string) => {
      keys.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    for (const email of ["Foo@X.com", "foo@x.com", "  FOO@X.COM  "]) {
      await limiter({
        url: "/api/auth/sign-in/email",
        headers: {},
        body: { email, password: "x" },
      });
    }

    const accountKeys = keys.filter((k) => k.startsWith("authgate:acct:"));
    expect(new Set(accountKeys).size).toBe(1);
  });
});

describe("cap sizing", () => {
  it("uses the rules table's numbers for the IP bucket (no duplicated constants)", async () => {
    const calls: [string, number, number][] = [];
    const consume = vi.fn(async (key: string, max: number, window: number) => {
      calls.push([key, max, window]);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });

    const rule = AUTH_RATE_LIMIT_CUSTOM_RULES["/sign-in/email"];
    const ipCall = calls.find(([key]) => key.startsWith("authgate:ip:"))!;
    expect(ipCall[1]).toBe(rule.max);
    expect(ipCall[2]).toBe(rule.window);
  });

  it("makes the account bucket MORE generous than the IP bucket (lockout-DoS trade-off)", async () => {
    const calls: [string, number, number][] = [];
    const consume = vi.fn(async (key: string, max: number, window: number) => {
      calls.push([key, max, window]);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });

    const rule = AUTH_RATE_LIMIT_CUSTOM_RULES["/sign-in/email"];
    const ipCall = calls.find(([key]) => key.startsWith("authgate:ip:"))!;
    const acctCall = calls.find(([key]) => key.startsWith("authgate:acct:"))!;

    expect(acctCall[1]).toBe(rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER);
    expect(acctCall[1]).toBeGreaterThan(ipCall[1]);
    expect(acctCall[2]).toBe(ipCall[2]);
  });

  /**
   * ANTI-BOMBING endpoints must NOT ride the guess-space multiplier.
   *
   * The 12x is justified entirely by "one account absorbs at most 60
   * GUESSES/min, which is nothing against a real password". A send is not a
   * guess: 12x there buys zero brute-force resistance and simply triples the
   * emails/SMS an IP-rotating attacker can aim at one victim's inbox. Raising
   * the shared multiplier 4→12 did exactly that, invisibly.
   */
  describe("send endpoints get the tighter multiplier", () => {
    const SEND_PATHS = [
      "/email-otp/send-verification-otp",
      "/phone-number/send-otp",
    ] as const;

    it.each(SEND_PATHS)("%s uses the SEND multiplier", (path) => {
      const rule = resolveGuessSpaceRule(path)!;
      expect(resolveAccountCap(path)).toEqual({
        window: rule.window,
        max: rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND,
      });
    });

    it.each(SEND_PATHS)(
      "%s is strictly tighter than the guess-space cap",
      (path) => {
        const rule = resolveGuessSpaceRule(path)!;
        expect(AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND).toBeLessThan(
          AUTH_ACCOUNT_BUCKET_MULTIPLIER,
        );
        expect(resolveAccountCap(path)!.max).toBeLessThan(
          rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER,
        );
      },
    );

    it.each([
      "/sign-in/email",
      "/sign-in/username",
      "/sign-in/email-otp",
      "/email-otp/verify-email",
      "/two-factor/verify-totp",
      "/magic-link/verify",
    ])("%s keeps the guess-space multiplier", (path) => {
      const rule = resolveGuessSpaceRule(path)!;
      expect(resolveAccountCap(path)!.max).toBe(
        rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER,
      );
    });

    it("still leaves headroom for a legitimate resend (>= 2x the IP cap)", () => {
      for (const path of SEND_PATHS) {
        const rule = resolveGuessSpaceRule(path)!;
        expect(resolveAccountCap(path)!.max).toBeGreaterThanOrEqual(
          rule.max * 2,
        );
      }
    });

    it("the EVALUATOR actually applies it (not just the resolver)", async () => {
      const calls: [string, number][] = [];
      const consume = vi.fn(async (key: string, max: number) => {
        calls.push([key, max]);
        return allow();
      });
      const { limiter } = makeLimiter(consume);

      await limiter({
        url: "/api/auth/email-otp/send-verification-otp",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: { email: "victim@example.com", type: "email-verification" },
      });

      const rule =
        AUTH_RATE_LIMIT_CUSTOM_RULES["/email-otp/send-verification-otp"];
      const acctCall = calls.find(([key]) => key.startsWith("authgate:acct:"))!;
      expect(acctCall[1]).toBe(rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER_SEND);
      expect(acctCall[1]).not.toBe(rule.max * AUTH_ACCOUNT_BUCKET_MULTIPLIER);
    });
  });
});

describe("both-dimension denial", () => {
  it("denies when only the IP bucket trips", async () => {
    const consume = vi.fn(async (key: string) =>
      key.startsWith("authgate:ip:") ? deny(17) : allow(),
    );
    const { limiter } = makeLimiter(consume);

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 17 });
  });

  it("denies when only the ACCOUNT bucket trips (distributed stuffing from fresh IPs)", async () => {
    const consume = vi.fn(async (key: string) =>
      key.startsWith("authgate:acct:") ? deny(23) : allow(),
    );
    const { limiter } = makeLimiter(consume);

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 23 });
  });

  /**
   * TARGETED-LOCKOUT GUARD. The account bucket belongs to the VICTIM, so a
   * token must only ever be spent on a request that was not already refused.
   * Burning it on requests we are 429ing anyway makes targeted lockout cost
   * `accountCap` requests from ONE host rather than requiring
   * ceil(accountCap / ipCap) distinct IPs — turning a stuffing defence into a
   * cheap denial-of-service button aimed at a specific user.
   */
  it("does NOT consume the victim's ACCOUNT token once the IP bucket has denied", async () => {
    const seen: string[] = [];
    const consume = vi.fn(async (key: string) => {
      seen.push(key);
      return key.startsWith("authgate:ip:") ? deny(17) : allow();
    });
    const { limiter } = makeLimiter(consume);

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 17 });

    expect(seen).toEqual(["authgate:ip:/sign-in/email:203.0.113.1"]);
    expect(seen.some((k) => k.startsWith("authgate:acct:"))).toBe(false);
  });

  it("consumes IP BEFORE account (ordering is the guard, not an accident)", async () => {
    const seen: string[] = [];
    const consume = vi.fn(async (key: string) => {
      seen.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.startsWith("authgate:ip:")).toBe(true);
    expect(seen[1]!.startsWith("authgate:acct:")).toBe(true);
  });

  it("still counts an IP-rotating stuffer against the account bucket", async () => {
    // The attack per-IP limiting misses entirely: every request from a fresh
    // IP, so the IP bucket never trips and the account consume always runs.
    const seen: string[] = [];
    const consume = vi.fn(async (key: string) => {
      seen.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    for (let i = 0; i < 5; i += 1) {
      await limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": `198.51.100.${i}` },
        body: signInBody,
      });
    }

    expect(seen.filter((k) => k.startsWith("authgate:acct:"))).toHaveLength(5);
  });

  it("falls back to IP-only limiting for a body better-call would NOT read as JSON", async () => {
    const seen: string[] = [];
    const consume = vi.fn(async (key: string) => {
      seen.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: Buffer.from("email=a%40b.com"),
      contentType: "application/x-www-form-urlencoded",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith("authgate:ip:")).toBe(true);
  });

  it("STILL applies the account bucket for a Buffer body better-call WOULD read as JSON", async () => {
    const seen: string[] = [];
    const consume = vi.fn(async (key: string) => {
      seen.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: Buffer.from(JSON.stringify(signInBody)),
      // One character off `application/json` — Fastify's parser misses it,
      // better-call accepts it. This used to skip the account bucket entirely.
      contentType: "application/jsonx",
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]!.startsWith("authgate:acct:")).toBe(true);
  });

  it("buckets a jsonx Buffer body IDENTICALLY to the parsed-object form", async () => {
    const keyOf = async (
      body: unknown,
      contentType?: string,
    ): Promise<string> => {
      const seen: string[] = [];
      const consume = vi.fn(async (key: string) => {
        seen.push(key);
        return allow();
      });
      const { limiter } = makeLimiter(consume);
      await limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body,
        ...(contentType ? { contentType } : {}),
      });
      return seen.find((k) => k.startsWith("authgate:acct:"))!;
    };

    expect(
      await keyOf(Buffer.from(JSON.stringify(signInBody)), "application/jsonx"),
    ).toBe(await keyOf(signInBody, "application/json"));
  });

  it("falls back to ACCOUNT-only limiting when no IP resolves", async () => {
    const seen: string[] = [];
    const consume = vi.fn(async (key: string) => {
      seen.push(key);
      return allow();
    });
    const { limiter } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: {},
      body: signInBody,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith("authgate:acct:")).toBe(true);
  });

  it("allows (and consumes nothing) when neither dimension resolves", async () => {
    const consume = vi.fn(async () => allow());
    const { limiter } = makeLimiter(consume);

    const decision = await limiter({
      url: "/api/auth/two-factor/verify-totp",
      headers: {},
      body: { code: "000000" },
    });

    expect(consume).not.toHaveBeenCalled();
    expect(decision).toEqual({ limited: false });
  });

  it("logs a denial at warn but never reports it to Sentry (429 is expected)", async () => {
    const reportError = vi.fn();
    const consume = vi.fn(async () => deny(9));
    const { limiter, logger } = makeLimiter(consume, { reportError });

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "auth_atomic_rate_limit_denied",
      expect.objectContaining({ path: "/sign-in/email" }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("never puts the raw identifier in the denial log line", async () => {
    // Denies on the ACCOUNT bucket specifically, so the identifier is in
    // scope at the moment the line is written.
    const consume = vi.fn(async (key: string) =>
      key.startsWith("authgate:acct:") ? deny(9) : allow(),
    );
    const { limiter, logger } = makeLimiter(consume);

    await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });

    const serialized = JSON.stringify(logger.warn.mock.calls);
    expect(serialized).toContain("auth_atomic_rate_limit_denied");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("Person@Example.COM");
  });
});

describe("fail open", () => {
  it("allows the request when the limiter throws", async () => {
    const consume = vi.fn(async () => {
      throw new Error("redis down");
    });
    const { limiter, logger } = makeLimiter(consume);

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "auth_atomic_rate_limit_consume_failed",
      expect.objectContaining({ dimension: "ip" }),
    );
  });

  it("still enforces the ACCOUNT dimension when the IP consume throws", async () => {
    const consume = vi.fn(async (key: string) => {
      if (key.startsWith("authgate:ip:")) throw new Error("redis blip");
      return deny(11);
    });
    const { limiter } = makeLimiter(consume);

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 11 });
  });

  it("still enforces the IP dimension when the ACCOUNT consume throws", async () => {
    const consume = vi.fn(async (key: string) => {
      if (key.startsWith("authgate:acct:")) throw new Error("redis blip");
      return deny(13);
    });
    const { limiter } = makeLimiter(consume);

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 13 });
  });

  it("reports the fail-open to Sentry, THROTTLED to one event per branch per window", async () => {
    const reportError = vi.fn();
    const consume = vi.fn(async () => {
      throw new Error("redis down");
    });
    const { limiter } = makeLimiter(consume, { reportError });

    for (let i = 0; i < 25; i += 1) {
      await limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      });
    }

    // 25 requests x 2 dimensions = 50 failures (the IP consume fails open, so
    // evaluation continues to the account consume, which also fails), but only
    // one report per branch (ip / account) inside the 15-minute window.
    expect(reportError).toHaveBeenCalledTimes(2);
    const branches = reportError.mock.calls.map(
      (call) => (call[1] as { tags: { branch: string } }).tags.branch,
    );
    expect(new Set(branches)).toEqual(new Set(["ip", "account"]));
    expect(
      (reportError.mock.calls[0]![1] as { tags: { area: string } }).tags.area,
    ).toBe("auth_atomic_rate_limit_fail_open");
  });

  it("a throwing reporter cannot turn the fail-open allow into a failure", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry exploded");
    });
    const consume = vi.fn(async () => {
      throw new Error("redis down");
    });
    const { limiter } = makeLimiter(consume, { reportError });

    await expect(
      limiter({
        url: "/api/auth/sign-in/email",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: signInBody,
      }),
    ).resolves.toEqual({ limited: false });
  });
});

describe("429 wire shape", () => {
  /**
   * Captured off the RUNNING dev API, not inferred from the dist:
   *
   *   HTTP/1.1 429 Too Many Requests
   *   content-type: text/plain;charset=UTF-8
   *   x-retry-after: 60
   *
   *   {"message":"Too many requests. Please try again later."}
   */
  it("matches better-auth's rateLimitResponse() byte for byte", () => {
    expect(AUTH_RATE_LIMIT_RESPONSE_BODY).toBe(
      '{"message":"Too many requests. Please try again later."}',
    );
    expect(AUTH_RATE_LIMIT_RESPONSE_CONTENT_TYPE).toBe(
      "text/plain;charset=UTF-8",
    );
    // Better Auth sends the NON-standard header name; matching it is the
    // point (a client that already handles better-auth 429s must not need to
    // learn a second shape).
    expect(AUTH_RATE_LIMIT_RETRY_AFTER_HEADER).toBe("x-retry-after");
  });

  it("never returns a zero/negative retry-after", async () => {
    const consume = vi.fn(async () => ({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 0,
    }));
    const { limiter } = makeLimiter(consume);

    const decision = await limiter({
      url: "/api/auth/sign-in/email",
      headers: { "cf-connecting-ip": "203.0.113.1" },
      body: signInBody,
    });

    expect(decision).toEqual({
      limited: true,
      retryAfterSeconds: AUTH_RATE_LIMIT_CUSTOM_RULES["/sign-in/email"].window,
    });
  });
});
