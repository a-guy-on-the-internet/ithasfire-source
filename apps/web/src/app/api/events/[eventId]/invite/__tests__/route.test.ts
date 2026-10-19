// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * The invite redeem route (gated-event invite links FR-004 / FR-005 / FR-010,
 * NFR-002): proxies the token to `events.redeemInvite` and sets the cookie the
 * grant needs. The cookie signers are tested (golden vector) in
 * src/lib/__tests__/event-unlock-cookie.test.ts; here they are stubs that
 * record their arguments.
 */

const signers = vi.hoisted(() => ({
  invite: vi.fn(
    (eventId: string, inviteId: string, expMs: number): string | null =>
      `th_ei_${eventId}=${inviteId}.${expMs}.signed; Path=/; HttpOnly`,
  ),
  application: vi.fn(
    (eventId: string, submissionId: string, approvedAtMs: number): string | null =>
      `th_ea_${eventId}=${submissionId}.${approvedAtMs}.signed; Path=/; HttpOnly`,
  ),
}));

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

vi.mock("@/lib/event-unlock-cookie", () => ({
  buildEventInviteGrantSetCookie: signers.invite,
  buildEventApplicationGrantSetCookie: signers.application,
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const IP_SECRET = "test-origin-shared-secret-0123456789abcdef";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-0000000000ff";
const INVITE_ID = "90000000-0000-4000-8000-000000000009";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const TOKEN = "inv_SUPERSECRETTOKENVALUE_0123456789abcdefghijklmnopqrstuvwxyz";
const EXPIRES_AT_MS = 4102444800000;
const APPROVED_AT_MS = 1764936000123;

const okResult = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  eventId: EVENT_ID,
  slug: "secret-show",
  grant: "INVITE_GRANT",
  inviteId: INVITE_ID,
  submissionId: null,
  approvedAtMs: null,
  expiresAtMs: EXPIRES_AT_MS,
  created: true,
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
    new NextRequest(`http://localhost:3000/api/events/${eventId}/invite`, {
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
};

beforeEach(() => {
  savedSecret = process.env.ORIGIN_SHARED_SECRET;
  savedEnforce = process.env.ENFORCE_ORIGIN_SECRET;
  process.env.ORIGIN_SHARED_SECRET = IP_SECRET;
  delete process.env.ENFORCE_ORIGIN_SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => upstreamJson(okResult()));
  vi.stubGlobal("fetch", fetchMock);
  sentry.captureException.mockReset();
  signers.invite.mockClear();
  signers.application.mockClear();
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

describe("POST /api/events/[eventId]/invite — request handling", () => {
  it("refuses a cross-site origin without calling the API or setting a cookie", async () => {
    const res = await call({ headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "invalid_origin",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
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
  });

  it("rejects a non-uuid event id", async () => {
    const res = await call({ eventId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies the token and the URL's event id (expectedEventId) to events.redeemInvite, forwarding the cookie and a signed client IP", async () => {
    const cookie = `better-auth.session_token=abc; th_ei_${EVENT_ID}=held`;
    await call({
      headers: { cookie, "cf-connecting-ip": "203.0.113.7" },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.test/trpc/events.redeemInvite?batch=1",
    );
    // expectedEventId: core refuses another event's token before any write.
    expect(JSON.parse(String(upstreamInit()?.body))).toEqual({
      "0": { json: { token: TOKEN, expectedEventId: EVENT_ID } },
    });
    const headers = upstreamHeaders();
    expect(headers.cookie).toBe(cookie);
    expect(
      verifyClientIpForward(headers, IP_SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("203.0.113.7");
    expect(headers["cf-connecting-ip"]).toBeUndefined();
  });

  it("passes a rate limit through as 429 with no cookie", async () => {
    fetchMock.mockImplementation(
      async () => new Response("[]", { status: 429 }),
    );

    const res = await call();

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "too_many_attempts",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expectPrivateHeaders(res);
  });

  it("maps an upstream tRPC error to 502 redeem_failed", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([{ error: { json: { message: "INTERNAL" } } }]),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await call();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "redeem_failed",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/events/[eventId]/invite — cookie per grant", () => {
  it("INVITE_GRANT sets th_ei_ with the invite id and the event end", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      grant: "INVITE_GRANT",
      slug: "secret-show",
    });
    expect(signers.invite).toHaveBeenCalledWith(
      EVENT_ID,
      INVITE_ID,
      EXPIRES_AT_MS,
    );
    expect(signers.application).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toContain(`th_ei_${EVENT_ID}=`);
    expectPrivateHeaders(res);
  });

  it("APPLICATION_GRANT sets th_ea_ with the submission and approval stamp", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(
        okResult({
          grant: "APPLICATION_GRANT",
          submissionId: SUBMISSION_ID,
          approvedAtMs: APPROVED_AT_MS,
        }),
      ),
    );

    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      grant: "APPLICATION_GRANT",
      slug: "secret-show",
    });
    expect(signers.application).toHaveBeenCalledWith(
      EVENT_ID,
      SUBMISSION_ID,
      APPROVED_AT_MS,
    );
    expect(signers.invite).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toContain(`th_ea_${EVENT_ID}=`);
  });

  it("UNLOCK sets no cookie (the unlock is on the account)", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(okResult({ grant: "UNLOCK" })),
    );

    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      grant: "UNLOCK",
      slug: "secret-show",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(signers.invite).not.toHaveBeenCalled();
    expect(signers.application).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it("APPLICATION_GRANT without a submission is a failure, not a cookie-less success", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(okResult({ grant: "APPLICATION_GRANT" })),
    );

    const res = await call();

    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("fails without a signing secret instead of reporting success", async () => {
    signers.invite.mockReturnValueOnce(null);

    const res = await call();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "redeem_failed",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/events/[eventId]/invite — dead links and mismatches", () => {
  it.each([
    "INVALID",
    "REVOKED",
    "EVENT_ENDED",
    "EVENT_CANCELLED",
    "EVENT_UNAVAILABLE",
    "NOT_GATED",
  ])("a %s link returns the reason and slug, with no cookie", async (reason) => {
    fetchMock.mockImplementation(async () =>
      upstreamJson({
        ok: false,
        reason,
        eventId: reason === "INVALID" ? null : EVENT_ID,
        slug: reason === "INVALID" ? null : "secret-show",
      }),
    );

    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason,
      slug: reason === "INVALID" ? null : "secret-show",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(signers.invite).not.toHaveBeenCalled();
    expect(signers.application).not.toHaveBeenCalled();
    expectPrivateHeaders(res);
  });

  it("refuses an invite for another event: no cookie, nothing about that event", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson(okResult({ eventId: OTHER_EVENT_ID, slug: "other-show" })),
    );

    const res = await call();

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "event_mismatch" });
    expect(JSON.stringify(body)).not.toContain("other-show");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(signers.invite).not.toHaveBeenCalled();
  });

  it("refuses a dead link for another event without leaking its slug", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson({
        ok: false,
        reason: "REVOKED",
        eventId: OTHER_EVENT_ID,
        slug: "other-show",
      }),
    );

    const res = await call();

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("other-show");
  });
});

describe("POST /api/events/[eventId]/invite — the token stays secret", () => {
  const scenarios: Array<[string, () => Response | Promise<Response>]> = [
    ["success", () => upstreamJson(okResult())],
    ["dead link", () => upstreamJson({ ok: false, reason: "REVOKED", eventId: EVENT_ID, slug: "s" })],
    [
      "upstream error",
      () =>
        new Response(
          JSON.stringify([{ error: { json: { message: "BAD_REQUEST" } } }]),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    ],
    ["fetch throws", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["mismatch", () => upstreamJson(okResult({ eventId: OTHER_EVENT_ID }))],
  ];

  it.each(scenarios)(
    "%s: the token is in neither the response nor any log line",
    async (_label, upstream) => {
      fetchMock.mockImplementation(async () => upstream());

      const res = await call();
      const text = await res.text();

      expect(text).not.toContain(TOKEN);
      expect(res.headers.get("set-cookie") ?? "").not.toContain(TOKEN);
      expect(logSpy).toHaveBeenCalled();
      for (const args of logSpy.mock.calls) {
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
});

describe("POST /api/events/[eventId]/invite — Sentry capture", () => {
  it("reports cookie_signing_unavailable with route/reason tags and no token", async () => {
    signers.invite.mockReturnValueOnce(null);

    const res = await call();

    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureException.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({
      tags: { route: "event-invite", reason: "cookie_signing_unavailable" },
      extra: { eventId: EVENT_ID, grant: "INVITE_GRANT" },
    });
    expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain(
      TOKEN,
    );
    expect(String((err as Error).message)).not.toContain(TOKEN);
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
        tags: { route: "event-invite", reason },
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

  it("reports malformed_result and trpc_error", async () => {
    fetchMock.mockImplementationOnce(async () =>
      upstreamJson(okResult({ grant: "SOMETHING_NEW" })),
    );
    await call();
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify([{ error: { json: { message: "INTERNAL" } } }]),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    await call();

    const reasons = sentry.captureException.mock.calls.map(
      (c) => (c[1] as { tags: { reason: string } }).tags.reason,
    );
    expect(reasons).toEqual(["malformed_result", "trpc_error"]);
    expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain(
      TOKEN,
    );
  });

  it("does not report a dead link or a success", async () => {
    await call();
    fetchMock.mockImplementationOnce(async () =>
      upstreamJson({ ok: false, reason: "REVOKED", eventId: EVENT_ID, slug: "s" }),
    );
    await call();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("a throwing reporter does not change the response", async () => {
    sentry.captureException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    signers.invite.mockReturnValueOnce(null);

    const res = await call();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "redeem_failed",
    });
  });
});
