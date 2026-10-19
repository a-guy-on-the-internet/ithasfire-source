// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { verifyClientIpForward } from "@th/trpc/client-ip";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { applyStaffRouteGate } from "../staff-route-gate";

/**
 * Every API call the staff gate makes (get-session, the `/token` mint, the
 * tRPC staff probe) leaves from the web server, so each carries the signed
 * visitor IP. The `/token` mint is the one that matters most: Better Auth
 * caps it per IP, and a shared-egress 429 there is a staff-wide lockout.
 */

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const SESSION_COOKIE = "better-auth.session_token=abc";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const makeRequest = (path: string, headers: Record<string, string>) =>
  new NextRequest(`https://app.example.com${path}`, { headers });

describe("applyStaffRouteGate — signed client-IP forward", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com");
    vi.stubEnv("ORIGIN_SHARED_SECRET", SECRET);
    vi.stubEnv("ENFORCE_ORIGIN_SECRET", "");
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/auth/get-session")) {
        return Promise.resolve(
          jsonResponse({ user: { id: "human_1" }, session: {} }),
        );
      }
      if (url.endsWith("/api/auth/token")) {
        return Promise.resolve(jsonResponse({ token: "jwt-token" }));
      }
      return Promise.resolve(
        jsonResponse({
          result: { data: { json: { allowed: true, secondFactorEnrolled: true } } },
        }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  const sentHeaders = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      headers: (init as { headers: Record<string, string> }).headers,
    }));

  it("signs the visitor IP onto get-session, the token mint and the staff probe", async () => {
    const result = await applyStaffRouteGate(
      makeRequest("/platform", {
        cookie: SESSION_COOKIE,
        "cf-connecting-ip": "198.51.100.23",
      }),
    );

    expect(result).toBeNull();
    const calls = sentHeaders();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/auth/get-session",
      "/api/auth/token",
      "/trpc/platform.checkStaffAccess",
    ]);
    const now = Math.floor(Date.now() / 1000);
    for (const call of calls) {
      expect(verifyClientIpForward(call.headers, SECRET, now), call.url).toBe(
        "198.51.100.23",
      );
    }
    expect(calls[0]!.headers.cookie).toBe(SESSION_COOKIE);
    expect(calls[1]!.headers.cookie).toBe(SESSION_COOKIE);
    expect(calls[2]!.headers.Authorization).toBe("Bearer jwt-token");
  });

  it("sends no forward when the visitor IP is missing", async () => {
    await applyStaffRouteGate(
      makeRequest("/admin", { cookie: SESSION_COOKIE }),
    );

    for (const call of sentHeaders()) {
      expect(
        Object.keys(call.headers).filter((k) => k.startsWith("x-th-client-ip")),
        call.url,
      ).toEqual([]);
    }
  });
});
