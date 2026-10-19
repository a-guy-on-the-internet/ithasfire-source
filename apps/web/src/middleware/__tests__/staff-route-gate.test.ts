// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";

import { applyStaffRouteGate, STAFF_GATED_PREFIXES } from "../staff-route-gate";
import { config as middlewareConfig } from "../../middleware";

const captureException = vi.mocked(Sentry.captureException);

const makeRequest = (path: string, cookie?: string): NextRequest =>
  new NextRequest(`https://app.example.com${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

/**
 * A real Better Auth session cookie NAME. Load-bearing since the gate gained
 * its `hasSessionCookie` pre-filter (`lib/auth/session-cookie.ts`): a cookie
 * that isn't `<prefix>.session_token` is now treated as anonymous and costs
 * ZERO outbound fetches. `better-auth.session` — the old fixture — is exactly
 * such a near-miss, and is used deliberately in one test below.
 */
const SESSION_COOKIE = "better-auth.session_token=abc";
/** Cookies a plain anonymous visitor carries: theme, consent, event unlocks. */
const ANONYMOUS_COOKIES = "th-theme=stub; better-auth.session=abc; th_eu_x=1";

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const SESSION_URL = "https://api.example.com/api/auth/get-session";
const TOKEN_URL = "https://api.example.com/api/auth/token";
const MODERATOR_PROCEDURE_URL =
  "https://api.example.com/trpc/community.checkModeratorAccess";
const PLATFORM_PROCEDURE_URL =
  "https://api.example.com/trpc/platform.checkStaffAccess";

const signedInSession = () =>
  Promise.resolve(jsonResponse({ user: { id: "human_1" }, session: {} }));
const mintedToken = () => Promise.resolve(jsonResponse({ token: "jwt-token" }));
const accessResponse =
  (allowed: boolean, secondFactorEnrolled: boolean) => () =>
    Promise.resolve(
      jsonResponse({
        result: { data: { json: { allowed, secondFactorEnrolled } } },
      }),
    );

type FetchRoutes = {
  session?: () => Promise<Response>;
  token?: () => Promise<Response>;
  procedure?: (url: string) => Promise<Response>;
};

/**
 * Installs a `fetch` mock that routes by URL. Defaults are the happy path
 * (valid session, successful token mint) so each test only states the leg it
 * cares about; an unrouted URL throws loudly rather than silently resolving.
 */
const installFetchMock = (routes: FetchRoutes = {}) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === SESSION_URL) return (routes.session ?? signedInSession)();
    if (url === TOKEN_URL) return (routes.token ?? mintedToken)();
    if (url.startsWith("https://api.example.com/trpc/")) {
      if (!routes.procedure) throw new Error(`unexpected trpc fetch: ${url}`);
      return routes.procedure(url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

/**
 * The gate's Sentry reporter is throttled per tag-set on a 15-minute window,
 * and that state is MODULE-level (it has to be, or it would never throttle
 * anything across requests). Vitest keeps the module loaded for the whole
 * file, so without intervention test #2 would silently observe test #1's
 * consumed window and assert against zero reports — a vacuous pass.
 *
 * So: fake the clock and jump well past the window before each test, giving
 * every case a clean window. The throttle's own tests then advance (or don't)
 * deliberately. Nothing in the gate uses timers, only `Date.now()`, so faking
 * time doesn't otherwise perturb it.
 */
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const CLOCK_STEP_MS = THROTTLE_WINDOW_MS + 60_000;

describe("applyStaffRouteGate", () => {
  const originalFetch = global.fetch;
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com");
    captureException.mockClear();
    vi.useFakeTimers();
    now += CLOCK_STEP_MS;
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("no-ops for paths outside /admin, /moderate and /platform", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyStaffRouteGate(makeRequest("/events"));

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // `/platformers`, `/moderated`, `/admins` are the segment-boundary cases
  // `isUnderPath` exists for — a naive `startsWith` would gate all three.
  it.each(["/", "/events/x", "/platformers", "/moderated", "/admins"])(
    "no-ops (and makes no fetches) for %s",
    async (path) => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await applyStaffRouteGate(makeRequest(path));

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  /**
   * The `hasSessionCookie` pre-filter. Without it, any request carrying any
   * cookie bought an unauthenticated caller a full outbound API round trip
   * from the edge — a request-amplification primitive on three prefixes.
   */
  describe("session-cookie pre-filter", () => {
    it.each([
      STAFF_GATED_PREFIXES.admin,
      STAFF_GATED_PREFIXES.moderate,
      STAFF_GATED_PREFIXES.platform,
    ])(
      "redirects %s to sign-in with ZERO fetches when cookies carry no session cookie",
      async (prefix) => {
        const fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;

        const result = await applyStaffRouteGate(
          makeRequest(`${prefix}/x`, ANONYMOUS_COOKIES),
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result?.status).toBe(307);
        expect(result?.headers.get("location")).toBe(
          `https://app.example.com/sign-in?redirect_url=${encodeURIComponent(`${prefix}/x`)}`,
        );
      },
    );

    it("still verifies for real when a session cookie IS present (presence is not proof)", async () => {
      // Presence-only filter: it must not be mistaken for authentication. A
      // forged session cookie still has to survive `/api/auth/get-session`.
      const fetchMock = installFetchMock({
        session: () => Promise.resolve(jsonResponse(null)),
      });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview", "better-auth.session_token=forged"),
      );

      expect(fetchMock).toHaveBeenCalledWith(
        SESSION_URL,
        expect.objectContaining({ method: "GET" }),
      );
      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/sign-in?redirect_url=%2Fplatform%2Foverview",
      );
    });

    // Every cookie-name shape the deployment matrix can actually produce:
    // deployed-dev's `SESSION_COOKIE_PREFIX=better-auth-dev`, and the
    // `__Secure-`/`__Host-` prefixes the browser/Better Auth add over https.
    // `apps/api/src/lib/env.ts` pins SESSION_COOKIE_PREFIX to a
    // `better-auth`-prefixed value so this list stays exhaustive.
    it.each([
      "better-auth.session_token=abc",
      "better-auth-dev.session_token=abc",
      "__Secure-better-auth.session_token=abc",
      "__Secure-better-auth-dev.session_token=abc",
      "__Host-better-auth.session_token=abc",
    ])("accepts the cookie shape %s", async (cookie) => {
      const fetchMock = installFetchMock({
        procedure: accessResponse(true, true),
      });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview", cookie),
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  it("redirects /admin to sign-in when there is no cookie at all", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyStaffRouteGate(makeRequest("/admin/acme"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.status).toBe(307);
    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/sign-in?redirect_url=%2Fadmin%2Facme",
    );
  });

  it("redirects /admin to sign-in when the session endpoint returns no session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyStaffRouteGate(
      makeRequest("/admin/acme", SESSION_COOKIE),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/auth/get-session",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result?.status).toBe(307);
    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/sign-in?redirect_url=%2Fadmin%2Facme",
    );
  });

  it("allows /admin through when a session exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ user: { id: "human_1" }, session: {} }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyStaffRouteGate(
      makeRequest("/admin/acme", SESSION_COOKIE),
    );

    expect(result).toBeNull();
  });

  it("does not run a staff-access probe for /admin (session check only)", async () => {
    const fetchMock = installFetchMock();

    const result = await applyStaffRouteGate(
      makeRequest("/admin/acme", SESSION_COOKIE),
    );

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      SESSION_URL,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails closed to sign-in when the session fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyStaffRouteGate(
      makeRequest("/admin/acme", SESSION_COOKIE),
    );

    expect(result?.status).toBe(307);
    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/sign-in?redirect_url=%2Fadmin%2Facme",
    );
  });

  it("redirects /moderate to /access-denied when signed in but not a moderator", async () => {
    installFetchMock({ procedure: accessResponse(false, false) });

    const result = await applyStaffRouteGate(
      makeRequest("/moderate/suggestions", SESSION_COOKIE),
    );

    expect(result?.status).toBe(307);
    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/access-denied",
    );
  });

  it("allows /moderate through when signed in, a moderator, and 2nd-factor enrolled", async () => {
    installFetchMock({ procedure: accessResponse(true, true) });

    const result = await applyStaffRouteGate(
      makeRequest("/moderate/suggestions", SESSION_COOKIE),
    );

    expect(result).toBeNull();
  });

  it("redirects /moderate to /enroll-2fa when signed in and a moderator but missing a 2nd factor", async () => {
    installFetchMock({ procedure: accessResponse(true, false) });

    const result = await applyStaffRouteGate(
      makeRequest("/moderate/suggestions", SESSION_COOKIE),
    );

    expect(result?.status).toBe(307);
    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/enroll-2fa?redirect_url=%2Fmoderate%2Fsuggestions",
    );
  });

  it("fails closed to /access-denied when the moderator-access fetch throws", async () => {
    installFetchMock({
      procedure: () => Promise.reject(new Error("network down")),
    });

    const result = await applyStaffRouteGate(
      makeRequest("/moderate/suggestions", SESSION_COOKIE),
    );

    expect(result?.status).toBe(307);
    expect(result?.headers.get("location")).toBe(
      "https://app.example.com/access-denied",
    );
  });

  describe("/platform", () => {
    it("redirects to sign-in when there is no cookie at all", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview"),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result?.status).toBe(307);
      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/sign-in?redirect_url=%2Fplatform%2Foverview",
      );
    });

    it("redirects to sign-in when the session endpoint returns no session", async () => {
      installFetchMock({ session: () => Promise.resolve(jsonResponse(null)) });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(result?.status).toBe(307);
      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/sign-in?redirect_url=%2Fplatform%2Foverview",
      );
    });

    it("redirects to /access-denied when signed in but not platform staff", async () => {
      installFetchMock({ procedure: accessResponse(false, false) });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(result?.status).toBe(307);
      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/access-denied",
      );
    });

    it("redirects to /enroll-2fa when staff but missing a 2nd factor", async () => {
      installFetchMock({ procedure: accessResponse(true, false) });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/reports", SESSION_COOKIE),
      );

      expect(result?.status).toBe(307);
      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/enroll-2fa?redirect_url=%2Fplatform%2Freports",
      );
    });

    it("allows through when staff with a 2nd factor enrolled", async () => {
      installFetchMock({ procedure: accessResponse(true, true) });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(result).toBeNull();
    });

    it("gates the bare /platform path too", async () => {
      installFetchMock({ procedure: accessResponse(false, false) });

      const result = await applyStaffRouteGate(
        makeRequest("/platform", SESSION_COOKIE),
      );

      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/access-denied",
      );
    });

    describe("fails closed", () => {
      it("when the token mint returns a non-2xx", async () => {
        installFetchMock({
          token: () =>
            Promise.resolve(jsonResponse({ error: "nope" }, { status: 401 })),
          // Must never be reached — no token, no probe.
          procedure: accessResponse(true, true),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/access-denied",
        );
      });

      it("when the token mint throws", async () => {
        installFetchMock({
          token: () => Promise.reject(new Error("network down")),
          procedure: accessResponse(true, true),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/access-denied",
        );
      });

      it("when the staff-access fetch throws", async () => {
        installFetchMock({
          procedure: () => Promise.reject(new Error("network down")),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/access-denied",
        );
      });

      it("when the staff-access probe returns a non-2xx", async () => {
        installFetchMock({
          procedure: () =>
            Promise.resolve(
              jsonResponse({ error: { message: "boom" } }, { status: 500 }),
            ),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/access-denied",
        );
      });

      it("when the staff-access probe returns malformed JSON", async () => {
        installFetchMock({
          procedure: () =>
            Promise.resolve(
              new Response("<html>gateway error</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              }),
            ),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/access-denied",
        );
      });

      it("when the staff-access probe returns a body missing `allowed`", async () => {
        installFetchMock({
          procedure: () => Promise.resolve(jsonResponse({ result: {} })),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/access-denied",
        );
      });

      /**
       * `allowed` is checked with `!== true`, not truthiness. If a future
       * transport change (superjson swap, a proxy that stringifies) ever made
       * the field a truthy non-boolean, a truthiness check would silently
       * admit everyone.
       */
      it.each([["yes"], [1], ["true"], [{}], [[]]])(
        "when `allowed` is the truthy non-boolean %p",
        async (allowed) => {
          installFetchMock({
            procedure: () =>
              Promise.resolve(
                jsonResponse({
                  result: {
                    data: { json: { allowed, secondFactorEnrolled: true } },
                  },
                }),
              ),
          });

          const result = await applyStaffRouteGate(
            makeRequest("/platform/overview", SESSION_COOKIE),
          );

          expect(result?.headers.get("location")).toBe(
            "https://app.example.com/access-denied",
          );
        },
      );

      it("when the session endpoint returns a non-2xx (as opposed to throwing)", async () => {
        installFetchMock({
          session: () =>
            Promise.resolve(jsonResponse({ error: "boom" }, { status: 503 })),
          procedure: accessResponse(true, true),
        });

        const result = await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(result?.headers.get("location")).toBe(
          "https://app.example.com/sign-in?redirect_url=%2Fplatform%2Foverview",
        );
      });
    });
  });

  /**
   * The gate fails closed on upstream failure, which by construction looks
   * exactly like a legitimate denial from the outside: staff get bounced and
   * the dashboard stays clean. These pin the SIGNAL, and — just as important —
   * pin that an ordinary denial stays quiet so the signal isn't drowned.
   */
  describe("Sentry reporting", () => {
    it("does NOT report an expected denial (200 body with allowed:false)", async () => {
      installFetchMock({ procedure: accessResponse(false, false) });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(captureException).not.toHaveBeenCalled();
    });

    it("does NOT report an anonymous request (200 body with no session)", async () => {
      installFetchMock({ session: () => Promise.resolve(jsonResponse(null)) });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(captureException).not.toHaveBeenCalled();
    });

    it("reports a non-2xx from the session endpoint", async () => {
      installFetchMock({
        session: () =>
          Promise.resolve(jsonResponse({ error: "boom" }, { status: 503 })),
      });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            area: "staff-route-gate",
            check: "session",
            outcome: "upstream-non-2xx",
          }),
          extra: expect.objectContaining({ status: 503 }),
        }),
      );
    });

    it("reports a 429 from the token mint (the staff-wide-lockout case)", async () => {
      installFetchMock({
        token: () =>
          Promise.resolve(
            jsonResponse({ error: "slow down" }, { status: 429 }),
          ),
        procedure: accessResponse(true, true),
      });

      const result = await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(result?.headers.get("location")).toBe(
        "https://app.example.com/access-denied",
      );
      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            check: "mint-token",
            outcome: "upstream-non-2xx",
          }),
          extra: expect.objectContaining({ status: 429 }),
        }),
      );
    });

    it("reports a non-2xx from the staff probe, with the procedure path", async () => {
      installFetchMock({
        procedure: () =>
          Promise.resolve(jsonResponse({ error: "boom" }, { status: 500 })),
      });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            check: "staff-access",
            outcome: "upstream-non-2xx",
          }),
          extra: expect.objectContaining({
            status: 500,
            procedurePath: "platform.checkStaffAccess",
          }),
        }),
      );
    });

    it("never puts the cookie or the minted token in the report", async () => {
      installFetchMock({
        procedure: () =>
          Promise.resolve(jsonResponse({ error: "boom" }, { status: 500 })),
      });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", "better-auth.session_token=SECRET"),
      );

      const serialized = JSON.stringify(captureException.mock.calls);
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain("jwt-token");
    });

    it("still reports thrown errors (the pre-existing catch paths)", async () => {
      installFetchMock({
        procedure: () => Promise.reject(new Error("network down")),
      });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "network down" }),
        expect.objectContaining({
          tags: expect.objectContaining({
            check: "staff-access",
            outcome: "threw",
          }),
        }),
      );
    });

    /**
     * The throttle exists so a high-volume failure can't crowd out a
     * low-volume one. `/admin` hits `hasSession` on EVERY request, so a
     * `get-session` outage is the flood; a mint 429 (staff-wide lockout) is
     * the rare signal that must survive it. These pin that the window is keyed
     * per check, not globally.
     */
    describe("throttling", () => {
      const checksOf = () =>
        captureException.mock.calls.map(
          ([, ctx]) =>
            `${(ctx as { tags?: Record<string, string> }).tags?.check}:${
              (ctx as { tags?: Record<string, string> }).tags?.outcome
            }`,
        );

      it("reports the same check only once per window", async () => {
        installFetchMock({
          session: () =>
            Promise.resolve(jsonResponse({ error: "boom" }, { status: 503 })),
        });

        for (let i = 0; i < 5; i++) {
          await applyStaffRouteGate(makeRequest("/admin/acme", SESSION_COOKIE));
        }

        expect(checksOf()).toEqual(["session:upstream-non-2xx"]);
      });

      it("does NOT let a session flood swallow a mint 429 (per-check keying)", async () => {
        // The flood.
        installFetchMock({
          session: () =>
            Promise.resolve(jsonResponse({ error: "boom" }, { status: 503 })),
        });
        for (let i = 0; i < 50; i++) {
          await applyStaffRouteGate(makeRequest("/admin/acme", SESSION_COOKIE));
        }

        // The rare, high-value signal, inside the SAME window.
        installFetchMock({
          token: () =>
            Promise.resolve(
              jsonResponse({ error: "slow down" }, { status: 429 }),
            ),
          procedure: accessResponse(true, true),
        });
        await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(checksOf()).toEqual([
          "session:upstream-non-2xx",
          "mint-token:upstream-non-2xx",
        ]);
      });

      it("separates a check's non-2xx window from its thrown window", async () => {
        installFetchMock({
          procedure: () =>
            Promise.resolve(jsonResponse({ error: "boom" }, { status: 500 })),
        });
        await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        installFetchMock({
          procedure: () => Promise.reject(new Error("network down")),
        });
        await applyStaffRouteGate(
          makeRequest("/platform/overview", SESSION_COOKIE),
        );

        expect(checksOf()).toEqual([
          "staff-access:upstream-non-2xx",
          "staff-access:threw",
        ]);
      });

      it("reports again once the window has elapsed (a sustained outage keeps breadcrumbing)", async () => {
        installFetchMock({
          session: () =>
            Promise.resolve(jsonResponse({ error: "boom" }, { status: 503 })),
        });

        await applyStaffRouteGate(makeRequest("/admin/acme", SESSION_COOKIE));
        vi.setSystemTime(Date.now() + THROTTLE_WINDOW_MS + 1_000);
        await applyStaffRouteGate(makeRequest("/admin/acme", SESSION_COOKIE));

        expect(checksOf()).toEqual([
          "session:upstream-non-2xx",
          "session:upstream-non-2xx",
        ]);
      });

      it("does not let a flapping status defeat the throttle (status is not part of the key)", async () => {
        for (const status of [500, 502, 503, 504]) {
          installFetchMock({
            procedure: () =>
              Promise.resolve(jsonResponse({ error: "boom" }, { status })),
          });
          await applyStaffRouteGate(
            makeRequest("/platform/overview", SESSION_COOKIE),
          );
        }

        expect(checksOf()).toEqual(["staff-access:upstream-non-2xx"]);
      });
    });
  });

  /**
   * The shared `checkStaffAccessViaTrpc` helper takes the procedure path as an
   * argument, so the one thing that could silently break is wiring the wrong
   * path to a prefix (e.g. asking the community moderator procedure whether
   * someone is platform staff). Pin the URL per prefix.
   */
  describe("routes each prefix to its own tRPC procedure", () => {
    it("uses community.checkModeratorAccess for /moderate", async () => {
      const fetchMock = installFetchMock({
        procedure: accessResponse(true, true),
      });

      await applyStaffRouteGate(
        makeRequest("/moderate/suggestions", SESSION_COOKIE),
      );

      const trpcUrls = fetchMock.mock.calls
        .map(([url]) => url as string)
        .filter((url) => url.includes("/trpc/"));
      expect(trpcUrls).toEqual([MODERATOR_PROCEDURE_URL]);
    });

    it("uses platform.checkStaffAccess for /platform", async () => {
      const fetchMock = installFetchMock({
        procedure: accessResponse(true, true),
      });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      const trpcUrls = fetchMock.mock.calls
        .map(([url]) => url as string)
        .filter((url) => url.includes("/trpc/"));
      expect(trpcUrls).toEqual([PLATFORM_PROCEDURE_URL]);
    });

    it("sends the probe as a plain non-batched GET with a Bearer token", async () => {
      const fetchMock = installFetchMock({
        procedure: accessResponse(true, true),
      });

      await applyStaffRouteGate(
        makeRequest("/platform/overview", SESSION_COOKIE),
      );

      expect(fetchMock).toHaveBeenCalledWith(PLATFORM_PROCEDURE_URL, {
        method: "GET",
        headers: { Authorization: "Bearer jwt-token" },
        cache: "no-store",
      });
    });
  });
});

describe("middleware config matcher", () => {
  /**
   * Next.js statically analyses `export const config`, so the matcher entries
   * are hand-written literals rather than derived from `STAFF_GATED_PREFIXES`.
   * This is the guard against those two drifting: add a gated prefix without a
   * matcher entry and the belt-and-suspenders coverage silently disappears if
   * the catch-all pattern is ever narrowed.
   */
  it("has an explicit entry for every staff-gated prefix", () => {
    for (const prefix of Object.values(STAFF_GATED_PREFIXES)) {
      expect(middlewareConfig.matcher).toContain(`${prefix}/:path*`);
    }
  });
});
