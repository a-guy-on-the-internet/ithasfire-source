// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * The read-only invite peek route (gated-event invite links FR-010): proxies
 * the token to `events.peekInvite` for the `?invite=` landing. Mirrors the
 * redeem route's tests (../../__tests__/route.test.ts) minus the cookies:
 * this route sets none and forwards none.
 */

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({
  captureException: sentry.captureException,
}));

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("@/config/trpc", () => ({
  getTrpcHttpUrl: () => "https://api.example.test/trpc",
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const IP_SECRET = "test-origin-shared-secret-0123456789abcdef";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-0000000000ff";
const TOKEN = "inv_SUPERSECRETTOKENVALUE_0123456789abcdefghijklmnopqrstuvwxyz";

const personalResult = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  eventId: EVENT_ID,
  kind: "PERSONAL",
  inviteeShortName: "Maya R.",
  organizerName: "Stub Collective",
  ...overrides,
});

const upstreamJson = (json: Record<string, unknown>) =>
  new Response(JSON.stringify([{ result: { data: { json } } }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fetchMock = vi.fn();
const logSpy = vi.fn();
let savedSecret: string | undefined;
let savedEnforce: string | undefined;

const call = (
  opts: {
    headers?: Record<string, string>;
    body?: unknown;
    eventId?: string;
  } = {},
) => {
  const eventId = opts.eventId ?? EVENT_ID;
  return POST(
    new NextRequest(`http://localhost:3000/api/events/${eventId}/invite/peek`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        ...opts.headers,
      },
      body: JSON.stringify(opts.body ?? { token: TOKEN }),
    }),
    { params: Promise.resolve({ eventId }) },
  );
};

const upstreamInit = () =>
  fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
const upstreamHeaders = () =>
  (upstreamInit()?.headers ?? {}) as Record<string, string>;

const expectPrivateHeaders = (res: Response) => {
  expect(res.headers.get("cache-control")).toContain("private");
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("set-cookie")).toBeNull();
};

beforeEach(() => {
  savedSecret = process.env.ORIGIN_SHARED_SECRET;
  savedEnforce = process.env.ENFORCE_ORIGIN_SECRET;
  process.env.ORIGIN_SHARED_SECRET = IP_SECRET;
  delete process.env.ENFORCE_ORIGIN_SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => upstreamJson(personalResult()));
  vi.stubGlobal("fetch", fetchMock);
  sentry.captureException.mockReset();
  logSpy.mockReset();
  vi.spyOn(console, "log").mockImplementation(logSpy);
  vi.spyOn(console, "error").mockImplementation(logSpy);
  vi.spyOn(console, "warn").mockImplementation(logSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
  else process.env.ORIGIN_SHARED_SECRET = savedSecret;
  if (savedEnforce === undefined) delete process.env.ENFORCE_ORIGIN_SECRET;
  else process.env.ENFORCE_ORIGIN_SECRET = savedEnforce;
});

describe("POST /api/events/[eventId]/invite/peek — request handling", () => {
  it("refuses a cross-site origin without calling the API", async () => {
    const res = await call({ headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "invalid_origin",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it.each([
    ["a missing token", {}],
    ["an empty token", { token: "" }],
    ["an over-long token", { token: "x".repeat(257) }],
    ["an extra field", { token: TOKEN, eventId: EVENT_ID }],
  ])("rejects %s as invalid_body", async (_label, body) => {
    const res = await call({ body });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it("rejects a non-uuid event id", async () => {
    const res = await call({ eventId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it("POSTs the token and the URL's event id (expectedEventId) to events.peekInvite with a signed client IP, and forwards NO cookies", async () => {
    await call({
      headers: {
        cookie: `better-auth.session_token=abc; th_ei_${EVENT_ID}=held`,
        "cf-connecting-ip": "203.0.113.7",
      },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.test/trpc/events.peekInvite?batch=1",
    );
    expect(upstreamInit()?.method).toBe("POST");
    expect(JSON.parse(String(upstreamInit()?.body))).toEqual({
      "0": { json: { token: TOKEN, expectedEventId: EVENT_ID } },
    });
    const headers = upstreamHeaders();
    expect(headers.cookie).toBeUndefined();
    expect(
      verifyClientIpForward(headers, IP_SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("203.0.113.7");
    expect(headers["cf-connecting-ip"]).toBeUndefined();
  });

  it("passes a rate limit through as 429", async () => {
    fetchMock.mockImplementation(
      async () => new Response("[]", { status: 429 }),
    );

    const res = await call();

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "too_many_attempts",
    });
    expectPrivateHeaders(res);
  });

  it("maps an upstream tRPC error to 502 peek_failed and reports it", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              error: {
                json: { message: "x", data: { appCode: "NOT_CONFIGURED" } },
              },
            },
          ]),
          { status: 412, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await call();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "peek_failed",
    });
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { route: "event-invite-peek", reason: "trpc_error" },
      extra: { eventId: EVENT_ID, status: 412, code: "NOT_CONFIGURED" },
    });
  });

  it.each([
    [
      "fetch_threw",
      () => Promise.reject(new Error(`ECONNREFUSED ${TOKEN}`)),
      { eventId: EVENT_ID },
    ],
    [
      "non_json",
      () => new Response("<html>bad gateway</html>", { status: 503 }),
      { eventId: EVENT_ID, status: 503 },
    ],
    [
      "no_result",
      () =>
        new Response(JSON.stringify([{ result: {} }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { eventId: EVENT_ID },
    ],
  ] as const)(
    "reports %s (502) with the reason code only: no token, no error message",
    async (reason, upstream, extra) => {
      fetchMock.mockImplementation(async () => upstream());

      const res = await call();

      expect(res.status).toBe(502);
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { route: "event-invite-peek", reason },
        extra,
      });
      const sent = JSON.stringify(sentry.captureException.mock.calls);
      expect(sent).not.toContain(TOKEN);
      expect(sent).not.toContain("ECONNREFUSED");
      expect(
        String((sentry.captureException.mock.calls[0]![0] as Error).message),
      ).not.toContain(TOKEN);
    },
  );

  it("fetch throwing → 502 peek_failed", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await call();
    expect(res.status).toBe(502);
  });
});

describe("POST /api/events/[eventId]/invite/peek — live links", () => {
  it("PERSONAL → kind, short name and organizer; private headers, no cookie", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      kind: "PERSONAL",
      inviteeShortName: "Maya R.",
      organizerName: "Stub Collective",
    });
    expectPrivateHeaders(res);
  });

  it("SHARED → no invitee name even if upstream sent one", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(personalResult({ kind: "SHARED", inviteeShortName: "Leak E." })),
    );
    const res = await call();
    await expect(res.json()).resolves.toEqual({
      ok: true,
      kind: "SHARED",
      inviteeShortName: null,
      organizerName: "Stub Collective",
    });
  });

  it("null organizer passes through as null", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(personalResult({ organizerName: null, inviteeShortName: null })),
    );
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({
      inviteeShortName: null,
      organizerName: null,
    });
  });

  it("an unknown kind is a malformed result: 502, reported", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(personalResult({ kind: "MYSTERY" })),
    );
    const res = await call();
    expect(res.status).toBe(502);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { route: "event-invite-peek", reason: "malformed_result" },
      extra: { eventId: EVENT_ID },
    });
  });
});

describe("POST /api/events/[eventId]/invite/peek — dead links and mismatches", () => {
  it.each([
    "INVALID",
    "REVOKED",
    "EVENT_ENDED",
    "EVENT_CANCELLED",
    "EVENT_UNAVAILABLE",
    "NOT_GATED",
  ])("%s → 200 { ok: false, reason }", async (reason) => {
    fetchMock.mockImplementation(async () =>
      upstreamJson({ ok: false, reason, eventId: EVENT_ID }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: false, reason });
    expectPrivateHeaders(res);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("a forged token (INVALID, no event) is a plain dead link", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson({ ok: false, reason: "INVALID", eventId: null }),
    );
    const res = await call();
    await expect(res.json()).resolves.toEqual({ ok: false, reason: "INVALID" });
  });

  it("an unknown reason collapses to INVALID", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson({ ok: false, reason: "WHATEVER", eventId: EVENT_ID }),
    );
    const res = await call();
    await expect(res.json()).resolves.toEqual({ ok: false, reason: "INVALID" });
  });

  it.each([
    ["a live invite", personalResult({ eventId: OTHER_EVENT_ID })],
    ["a dead invite", { ok: false, reason: "REVOKED", eventId: OTHER_EVENT_ID }],
  ])("refuses %s for another event, saying nothing about it", async (_l, json) => {
    fetchMock.mockImplementation(async () => upstreamJson(json));
    const res = await call();
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: "event_mismatch" });
    expect(text).not.toContain("Maya");
    expect(text).not.toContain("Stub Collective");
    expectPrivateHeaders(res);
  });
});

describe("POST /api/events/[eventId]/invite/peek — the token stays secret", () => {
  const scenarios: Array<[string, () => Response | Promise<Response>]> = [
    ["live", () => upstreamJson(personalResult())],
    ["dead link", () => upstreamJson({ ok: false, reason: "REVOKED", eventId: EVENT_ID })],
    [
      "upstream error",
      () =>
        new Response(
          JSON.stringify([{ error: { json: { message: "BAD_REQUEST" } } }]),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    ],
    ["fetch throws", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["mismatch", () => upstreamJson(personalResult({ eventId: OTHER_EVENT_ID }))],
  ];

  it.each(scenarios)(
    "%s: the token is in neither the response nor any log line nor Sentry",
    async (_label, upstream) => {
      fetchMock.mockImplementation(async () => upstream());

      const res = await call();
      const text = await res.text();

      expect(text).not.toContain(TOKEN);
      expect(logSpy).toHaveBeenCalled();
      for (const args of logSpy.mock.calls) {
        expect(JSON.stringify(args)).not.toContain(TOKEN);
      }
      for (const args of sentry.captureException.mock.calls) {
        expect(JSON.stringify(args)).not.toContain(TOKEN);
      }
    },
  );

  it("an invalid body is refused without logging the token", async () => {
    await call({ body: { token: TOKEN, extra: 1 } });
    for (const args of logSpy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain(TOKEN);
    }
  });

  it("a throwing reporter does not change the response", async () => {
    sentry.captureException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    fetchMock.mockImplementation(async () =>
      upstreamJson(personalResult({ kind: "MYSTERY" })),
    );
    const res = await call();
    expect(res.status).toBe(502);
  });
});
