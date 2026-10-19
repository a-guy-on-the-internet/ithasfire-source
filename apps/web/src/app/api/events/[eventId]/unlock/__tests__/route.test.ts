// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * The unlock route calls `events.validatePassword` from the WEB SERVER, so the
 * API sees our egress IP for every guest unless the visitor's IP rides along
 * as a signed forward. These pin that the forward carries the visitor's
 * `cf-connecting-ip`, that it needs ORIGIN_SHARED_SECRET, and that the inbound
 * `x-origin-secret` is required only when ENFORCE_ORIGIN_SECRET="true" (the
 * origin-secret rollout flag) — see client-ip-forward.ts.
 *
 * WHAT THIS CANNOT SEE: the API side (verification + bucket keys) — that is
 * packages/transport/trpc/src/routers/__tests__/events-client-ip-forward.test.ts.
 */

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("@/config/trpc", () => ({
  getTrpcHttpUrl: () => "https://api.example.test/trpc",
}));

vi.mock("@/lib/event-unlock-cookie", () => ({
  buildEventUnlockSetCookie: (eventId: string) =>
    `th_eu_${eventId}=signed; Path=/; HttpOnly`,
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const EVENT_ID = "00000000-0000-4000-8000-00000000d031";

const fetchMock = vi.fn();
let savedSecret: string | undefined;
let savedEnforce: string | undefined;

const setEnforcement = (on: boolean) => {
  if (on) process.env.ENFORCE_ORIGIN_SECRET = "true";
  else delete process.env.ENFORCE_ORIGIN_SECRET;
};

const forwardedNames = (headers: Record<string, string>) =>
  Object.keys(headers).filter((k) => k.startsWith("x-th-"));

function request(
  headers: Record<string, string>,
  body: Record<string, unknown> = { password: "open-sesame" },
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/events/${EVENT_ID}/unlock`,
    {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

const call = (
  headers: Record<string, string>,
  body?: Record<string, unknown>,
) =>
  POST(request(headers, body), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });

/** The JSON body of the single upstream fetch the route made. */
const upstreamBody = (n = 0): { "0": { json: Record<string, unknown> } } => {
  const init = fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
};

/** A tRPC v11 batch error response carrying `appCode`. */
const upstreamError = (appCode: string, status: number) =>
  new Response(
    JSON.stringify([
      { error: { json: { message: appCode, data: { appCode } } } },
    ]),
    { status, headers: { "content-type": "application/json" } },
  );

/** Headers of the single upstream fetch the route made. */
const upstreamHeaders = (n = 0): Record<string, string> => {
  const init = fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
};

beforeEach(() => {
  savedSecret = process.env.ORIGIN_SHARED_SECRET;
  savedEnforce = process.env.ENFORCE_ORIGIN_SECRET;
  process.env.ORIGIN_SHARED_SECRET = SECRET;
  setEnforcement(false);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify([
          {
            result: {
              data: {
                json: { unlocked: true, bypassed: false, persisted: false },
              },
            },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
  else process.env.ORIGIN_SHARED_SECRET = savedSecret;
  if (savedEnforce === undefined) delete process.env.ENFORCE_ORIGIN_SECRET;
  else process.env.ENFORCE_ORIGIN_SECRET = savedEnforce;
});

describe("POST /api/events/[eventId]/unlock — client-IP forward", () => {
  it("forwards a signed x-th-client-ip carrying the visitor's cf-connecting-ip", async () => {
    const res = await call({
      "x-origin-secret": SECRET,
      "cf-connecting-ip": "198.51.100.23",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = upstreamHeaders();
    expect(headers["x-th-client-ip"]).toBe("198.51.100.23");
    expect(headers["x-th-client-ip-ts"]).toMatch(/^\d+$/);
    // The forward verifies against the API's verifier with the real clock.
    expect(
      verifyClientIpForward(headers, SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("198.51.100.23");
    // Caller-supplied proxy headers are still NOT copied through.
    expect(headers["cf-connecting-ip"]).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  it("gives two visitors two different forwarded IPs", async () => {
    await call({ "x-origin-secret": SECRET, "cf-connecting-ip": "198.51.100.23" });
    await call({ "x-origin-secret": SECRET, "cf-connecting-ip": "203.0.113.99" });

    expect(upstreamHeaders(0)["x-th-client-ip"]).toBe("198.51.100.23");
    expect(upstreamHeaders(1)["x-th-client-ip"]).toBe("203.0.113.99");
  });

  describe.each([
    ["missing", {}],
    ["wrong", { "x-origin-secret": "wrong" }],
  ] as Array<[string, Record<string, string>]>)(
    "inbound origin secret %s",
    (_label, originHeader) => {
      it("log-only mode: still forwards the signed cf-connecting-ip", async () => {
        await call({ ...originHeader, "cf-connecting-ip": "198.51.100.23" });

        const headers = upstreamHeaders();
        expect(
          verifyClientIpForward(headers, SECRET, Math.floor(Date.now() / 1000)),
        ).toBe("198.51.100.23");
      });

      it("enforcing mode: forwards no IP", async () => {
        setEnforcement(true);
        const res = await call({
          ...originHeader,
          "cf-connecting-ip": "198.51.100.23",
        });

        expect(res.status).toBe(200);
        expect(forwardedNames(upstreamHeaders())).toEqual([]);
      });
    },
  );

  it("enforcing mode: forwards the IP when the inbound origin secret matches", async () => {
    setEnforcement(true);
    await call({ "x-origin-secret": SECRET, "cf-connecting-ip": "198.51.100.23" });

    expect(upstreamHeaders()["x-th-client-ip"]).toBe("198.51.100.23");
  });

  it.each([false, true])(
    "forwards no IP when ORIGIN_SHARED_SECRET is unset (enforcing=%s)",
    async (enforcing) => {
      setEnforcement(enforcing);
      delete process.env.ORIGIN_SHARED_SECRET;

      const res = await call({
        "x-origin-secret": SECRET,
        "cf-connecting-ip": "198.51.100.23",
      });

      expect(res.status).toBe(200);
      expect(forwardedNames(upstreamHeaders())).toEqual([]);
    },
  );
});

describe("POST /api/events/[eventId]/unlock — Turnstile challenge", () => {
  it("forwards the Turnstile token to events.validatePassword", async () => {
    await call({}, { password: "open-sesame", turnstileToken: "tt-abc" });

    expect(upstreamBody()["0"].json).toEqual({
      eventId: EVENT_ID,
      password: "open-sesame",
      turnstileToken: "tt-abc",
    });
  });

  it("sends no turnstileToken key when the client sent none", async () => {
    await call({});

    expect(upstreamBody()["0"].json).toEqual({
      eventId: EVENT_ID,
      password: "open-sesame",
    });
  });

  it("maps EVENT_PASSWORD_CHALLENGE_REQUIRED to 403 event_password_challenge_required", async () => {
    fetchMock.mockImplementationOnce(async () =>
      upstreamError("EVENT_PASSWORD_CHALLENGE_REQUIRED", 403),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await call({});

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "event_password_challenge_required",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(
      logSpy.mock.calls.some(([line]) =>
        String(line).includes('"outcome":"challenge_required"'),
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it("keeps EVENT_PASSWORD_INVALID as 401 and an upstream 429 as 429", async () => {
    fetchMock.mockImplementationOnce(async () =>
      upstreamError("EVENT_PASSWORD_INVALID", 400),
    );
    const invalid = await call({});
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "event_password_invalid" });

    fetchMock.mockImplementationOnce(
      async () => new Response("[]", { status: 429 }),
    );
    const limited = await call({});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too_many_attempts" });
  });

  it.each([
    ["oversized (4097 chars)", "x".repeat(4097)],
    ["empty", ""],
    ["non-string", 42],
  ])("rejects a %s turnstileToken with 400 before calling the API", async (_label, token) => {
    const res = await call({}, { password: "open-sesame", turnstileToken: token });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a token at the 4096-char bound", async () => {
    const res = await call(
      {},
      { password: "open-sesame", turnstileToken: "x".repeat(4096) },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
