// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * The claim link calls `events.redeemApplicationToken` from the WEB SERVER,
 * so the visitor's IP must ride along as a signed forward or the API keys its
 * limits on our egress IP. The signing policy itself is tested in
 * src/server/__tests__/client-ip-forward.test.ts; this pins that the route
 * actually sends the headers (remove the spread and these fail).
 */

vi.mock("@/config/trpc", () => ({
  getTrpcHttpUrl: () => "https://api.example.test/trpc",
}));

vi.mock("@/lib/event-unlock-cookie", () => ({
  buildEventUnlockSetCookie: (eventId: string) =>
    `th_eu_${eventId}=signed; Path=/; HttpOnly`,
  buildEventApplicationGrantSetCookie: (
    eventId: string,
    submissionId: string,
    approvedAtMs: number,
  ) => `th_ea_${eventId}=${submissionId}.${approvedAtMs}.signed; Path=/; HttpOnly`,
}));

import { NextRequest } from "next/server";

import { GET } from "../route";

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const EVENT_ID = "00000000-0000-4000-8000-00000000d032";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
/** What superjson puts in `json` for the redeem output's `approvedAt` Date. */
const APPROVED_AT_ISO = "2025-12-05T12:00:00.123Z";
const APPROVED_AT_MS = Date.parse(APPROVED_AT_ISO);

const upstreamOk = (json: Record<string, unknown>) =>
  new Response(JSON.stringify([{ result: { data: { json } } }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fetchMock = vi.fn();
let savedSecret: string | undefined;
let savedEnforce: string | undefined;

const call = (headers: Record<string, string>) =>
  GET(
    new NextRequest(
      `http://localhost:3000/api/events/${EVENT_ID}/claim?token=tok-123`,
      { method: "GET", headers },
    ),
    { params: Promise.resolve({ eventId: EVENT_ID }) },
  );

const upstreamHeaders = (): Record<string, string> => {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
};

beforeEach(() => {
  savedSecret = process.env.ORIGIN_SHARED_SECRET;
  savedEnforce = process.env.ENFORCE_ORIGIN_SECRET;
  process.env.ORIGIN_SHARED_SECRET = SECRET;
  delete process.env.ENFORCE_ORIGIN_SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify([
          {
            result: {
              data: {
                json: {
                  slug: "great-show",
                  submissionId: SUBMISSION_ID,
                  approvedAt: APPROVED_AT_ISO,
                  unlocked: true,
                  persisted: false,
                },
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

describe("GET /api/events/[eventId]/claim — client-IP forward", () => {
  it("forwards a signed x-th-client-ip carrying the visitor's cf-connecting-ip", async () => {
    const res = await call({ "cf-connecting-ip": "198.51.100.23" });

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/events/great-show");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = upstreamHeaders();
    expect(
      verifyClientIpForward(headers, SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("198.51.100.23");
    expect(headers["cf-connecting-ip"]).toBeUndefined();
  });

  it("forwards no IP when ORIGIN_SHARED_SECRET is unset", async () => {
    delete process.env.ORIGIN_SHARED_SECRET;

    await call({ "cf-connecting-ip": "198.51.100.23" });

    expect(
      Object.keys(upstreamHeaders()).filter((k) => k.startsWith("x-th-")),
    ).toEqual([]);
  });
});

describe("GET /api/events/[eventId]/claim — application grant", () => {
  it("sets the APPLICATION grant carrying the submissionId and approval stamp, and NOT the password cookie", async () => {
    const res = await call({});

    expect(res.headers.get("location")).toContain("/events/great-show");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(
      `th_ea_${EVENT_ID}=${SUBMISSION_ID}.${APPROVED_AT_MS}.`,
    );
    // `th_eu_` means "entered the password" to every reader; minting it here
    // would open a PASSWORD gate if the organizer ever switched gate types.
    expect(setCookie).not.toContain("th_eu_");
  });

  it("redirects to ?claim=error when upstream omits a usable submissionId and nothing was persisted", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamOk({
        slug: "great-show",
        submissionId: "not-a-uuid",
        unlocked: true,
        persisted: false,
      }),
    );

    const res = await call({});

    expect(res.headers.get("location")).toContain("/?claim=error");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["unparseable", "not-a-date"],
  ])(
    "sets no grant when upstream's approvedAt is %s (nothing to bind it to)",
    async (_label, approvedAt) => {
      fetchMock.mockImplementation(async () =>
        upstreamOk({
          slug: "great-show",
          submissionId: SUBMISSION_ID,
          ...(approvedAt === undefined ? {} : { approvedAt }),
          unlocked: true,
          persisted: false,
        }),
      );

      const res = await call({});

      expect(res.headers.get("location")).toContain("/?claim=error");
      expect(res.headers.get("set-cookie")).toBeNull();
    },
  );

  it("a signed-in subject with a persisted row still redirects to the event (grant set alongside)", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamOk({
        slug: "great-show",
        submissionId: SUBMISSION_ID,
        approvedAt: APPROVED_AT_ISO,
        unlocked: true,
        persisted: true,
      }),
    );

    const res = await call({});

    expect(res.headers.get("location")).toContain("/events/great-show");
    expect(res.headers.get("set-cookie") ?? "").toContain(`th_ea_${EVENT_ID}=`);
  });
});

describe("GET /api/events/[eventId]/claim — caching", () => {
  // The URL carries a bearer token and the success redirect sets a cookie:
  // no response from this route may be stored by a browser or a CDN.
  const NO_STORE = "private, no-store, max-age=0";

  it("marks the success redirect no-store", async () => {
    const res = await call({});
    expect(res.headers.get("location")).toContain("/events/great-show");
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("marks the bad-input redirect no-store", async () => {
    const res = await GET(
      new NextRequest(`http://localhost:3000/api/events/not-a-uuid/claim?token=x`),
      { params: Promise.resolve({ eventId: "not-a-uuid" }) },
    );
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("marks the upstream-error and invalid-token redirects no-store", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("down");
    });
    const failed = await call({});
    expect(failed.headers.get("location")).toContain("/?claim=error");
    expect(failed.headers.get("cache-control")).toBe(NO_STORE);

    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify([
            { error: { json: { message: "APPLICATION_TOKEN_INVALID" } } },
          ]),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const invalid = await call({});
    expect(invalid.headers.get("location")).toContain("/?claim=invalid");
    expect(invalid.headers.get("cache-control")).toBe(NO_STORE);
  });
});
