// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";
import { INVALID_ATTEMPTS_RATE_LIMITED } from "@th/trpc/rate-limit-markers";

/**
 * RFC 8058 one-click "Stop invites from this organiser": the mail provider's
 * server POSTs `List-Unsubscribe=One-Click` to the List-Unsubscribe URL. This
 * route forwards the query-string token to `events.stopOrganiserInvites`.
 * No Origin check (the caller is the provider), POST only, token never
 * logged.
 */

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: sentry.captureException }));
vi.mock("@/config/trpc", () => ({
  getTrpcHttpUrl: () => "https://api.example.test/trpc",
}));

import { NextRequest } from "next/server";

import * as route from "../route";

const IP_SECRET = "test-origin-shared-secret-0123456789abcdef";
const TOKEN = "iso_bzpTRUNSRVRQQVlMT0FEZXhhbXBsZS5jb20_SECRETMACSECRETMACSECRETMACSECRETMACSECRET";
const URL_WITH_TOKEN = `http://localhost:3000/api/invites/stop?token=${encodeURIComponent(TOKEN)}`;

const upstreamJson = (json: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify([{ result: { data: { json } } }]), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchMock = vi.fn();
const logSpy = vi.fn();
let savedSecret: string | undefined;

const post = (
  opts: {
    url?: string;
    body?: string | FormData;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {},
) => {
  const headers: Record<string, string> = { ...opts.headers };
  const contentType =
    opts.contentType === undefined
      ? "application/x-www-form-urlencoded"
      : opts.contentType;
  if (contentType) headers["content-type"] = contentType;
  return route.POST(
    new NextRequest(opts.url ?? URL_WITH_TOKEN, {
      method: "POST",
      headers,
      body: (opts.body ?? "List-Unsubscribe=One-Click") as BodyInit,
    }),
  );
};

const upstreamInit = () => fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
const upstreamBody = () => JSON.parse(String(upstreamInit()?.body ?? "null"));

beforeEach(() => {
  savedSecret = process.env.ORIGIN_SHARED_SECRET;
  process.env.ORIGIN_SHARED_SECRET = IP_SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    upstreamJson({ ok: true, organiserName: "Night Owl Collective" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  sentry.captureException.mockReset();
  logSpy.mockReset();
  vi.spyOn(console, "log").mockImplementation(logSpy);
  vi.spyOn(console, "error").mockImplementation(logSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
  else process.env.ORIGIN_SHARED_SECRET = savedSecret;
});

describe("POST /api/invites/stop (RFC 8058 one-click)", () => {
  it("forwards the query-string token to events.stopOrganiserInvites and answers 200, private", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.example.test/trpc/events.stopOrganiserInvites?batch=1",
    );
    expect(upstreamBody()).toEqual({ "0": { json: { token: TOKEN } } });
    // The response never echoes the organiser or anything about the address.
    expect(JSON.stringify(await (await post()).json())).not.toContain("Night Owl");
  });

  it("needs no Origin: a provider's server-side POST from anywhere is accepted", async () => {
    const res = await post({ headers: { origin: "https://mail.google.com" } });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts multipart/form-data too (RFC 8058 allows either)", async () => {
    const form = new FormData();
    form.append("List-Unsubscribe", "One-Click");
    const res = await post({ body: form, contentType: null });
    expect(res.status).toBe(200);
  });

  it("forwards the caller's IP signed, and sends no cookies upstream", async () => {
    await post({
      headers: { "cf-connecting-ip": "198.51.100.23", cookie: "session=abc" },
    });
    const headers = upstreamInit()?.headers as Record<string, string>;
    expect(headers.cookie).toBeUndefined();
    expect(
      verifyClientIpForward(headers, IP_SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("198.51.100.23");
  });

  it.each([
    ["no token", { url: "http://localhost:3000/api/invites/stop" }],
    ["an over-long token", { url: `http://localhost:3000/api/invites/stop?token=${"x".repeat(1025)}` }],
    ["a JSON body", { body: '{"List-Unsubscribe":"One-Click"}', contentType: "application/json" }],
    ["the wrong form value", { body: "List-Unsubscribe=Yes" }],
    ["an empty body", { body: "" }],
  ])("rejects %s as invalid_request without calling the API", async (_label, opts) => {
    const res = await post(opts);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a forged or dead token (ok:false outcome) is 400 invalid_token", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamJson({ ok: false, reason: "INVALID" }),
    );
    const res = await post();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "invalid_token" });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  const trpc429 = (message: string) =>
    new Response(
      JSON.stringify([
        { error: { json: { message, code: -32029, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } } } },
      ]),
      { status: 429, headers: { "content-type": "application/json" } },
    );

  it("a default-floor 429 passes through and is reported (it may have dropped a real opt-out), without the token", async () => {
    fetchMock.mockImplementation(async () =>
      trpc429("Rate limit exceeded for events.stopOrganiserInvites. Try again in 30s."),
    );
    const res = await post();
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "too_many_requests" });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0]![1]).toMatchObject({
      tags: { reason: "rate_limited" },
    });
    expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain(TOKEN);
  });

  it("a 429 with no readable body is treated as the floor and reported", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 429 }));
    const res = await post();
    expect(res.status).toBe(429);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("the invalid-token bucket's 429 passes through but is NOT reported (it can't drop a real opt-out)", async () => {
    fetchMock.mockImplementation(async () =>
      trpc429(
        `${INVALID_ATTEMPTS_RATE_LIMITED}: Rate limit exceeded for stopping invites. Try again in 30s.`,
      ),
    );
    const res = await post();
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "too_many_requests" });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(JSON.stringify(logSpy.mock.calls)).toContain("invalid_attempts_rate_limited");
  });

  it("an upstream failure is 502 and reported, without the token", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await post();
    expect(res.status).toBe(502);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logSpy.mock.calls) + JSON.stringify(sentry.captureException.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("SECRETMAC");
  });

  it("exports POST only: a link scanner's GET can't change anything", () => {
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"]);
  });
});
