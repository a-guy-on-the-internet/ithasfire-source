// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * sync-unlock calls `events.recordSignedPasswordUnlock` from the WEB SERVER,
 * so the visitor's IP must ride along as a signed forward or the API keys its
 * limits on our egress IP. The signing policy itself is tested in
 * src/server/__tests__/client-ip-forward.test.ts; this pins that the route
 * actually sends the headers (remove the spread and these fail).
 */

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("@/config/trpc", () => ({
  getTrpcHttpUrl: () => "https://api.example.test/trpc",
}));

vi.mock("@/server/trpc-client", () => ({
  mintTokenFromCookie: async () => "jwt-token",
  filterEventUnlockCookies: (cookie: string) =>
    cookie
      .split(";")
      .map((p) => p.trim())
      .filter(
        (p) =>
          p.startsWith("th_eu_") ||
          p.startsWith("th_ea_") ||
          p.startsWith("th_ei_"),
      )
      .join("; ") || null,
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const SECRET = "test-origin-shared-secret-0123456789abcdef";
const EVENT_ID = "00000000-0000-4000-8000-00000000d033";
const COOKIE = `better-auth.session_token=abc; th_eu_${EVENT_ID}=sig`;

const fetchMock = vi.fn();
let savedSecret: string | undefined;
let savedEnforce: string | undefined;

const call = (headers: Record<string, string>) =>
  POST(
    new NextRequest(
      `http://localhost:3000/api/events/${EVENT_ID}/sync-unlock`,
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: COOKIE,
          ...headers,
        },
      },
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
        JSON.stringify([{ result: { data: { json: { persisted: true } } } }]),
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

describe("POST /api/events/[eventId]/sync-unlock — client-IP forward", () => {
  it("forwards a signed x-th-client-ip carrying the visitor's cf-connecting-ip", async () => {
    const res = await call({ "cf-connecting-ip": "198.51.100.23" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = upstreamHeaders();
    expect(headers.Authorization).toBe("Bearer jwt-token");
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

describe("POST /api/events/[eventId]/sync-unlock — application grant", () => {
  const GRANT = `th_ea_${EVENT_ID}=70000000-0000-4000-8000-000000000007.1.1.sig`;
  const callWith = (
    cookie: string,
    gateType?: "PASSWORD" | "APPLICATION" | "NONE",
  ) =>
    POST(
      new NextRequest(
        `http://localhost:3000/api/events/${EVENT_ID}/sync-unlock`,
        {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            cookie,
            ...(gateType ? { "content-type": "application/json" } : {}),
          },
          ...(gateType ? { body: JSON.stringify({ gateType }) } : {}),
        },
      ),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
  const upstreamOk = (json: Record<string, unknown>) =>
    new Response(JSON.stringify([{ result: { data: { json } } }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const calledProcedures = () =>
    fetchMock.mock.calls.map((c) => String(c[0]).split("/trpc/")[1]);

  it("syncs a grant through recordSignedApplicationUnlock, forwarding the grant cookie", async () => {
    const res = await callWith(`better-auth.session_token=abc; ${GRANT}`);

    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(calledProcedures()).toEqual([
      "events.recordSignedApplicationUnlock?batch=1",
    ]);
    expect(upstreamHeaders().cookie).toBe(GRANT);
  });

  it("reports persisted:false when the API refuses to persist (not the subject / revoked)", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamOk({ persisted: false, outcome: "not_subject" }),
    );

    const res = await callWith(`better-auth.session_token=abc; ${GRANT}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ persisted: false });
    // No password cookie, so nothing else is tried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps event_application_required to 403", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { error: { json: { message: "event_application_required" } } },
          ]),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await callWith(`better-auth.session_token=abc; ${GRANT}`);

    expect(res.status).toBe(403);
  });

  it("without a gateType hint (a tab loaded before it existed), falls through to the PASSWORD sync when the grant did not persist", async () => {
    fetchMock
      .mockImplementationOnce(async () => upstreamOk({ persisted: false }))
      .mockImplementationOnce(async () => upstreamOk({ persisted: true }));

    const res = await callWith(
      `better-auth.session_token=abc; ${GRANT}; th_eu_${EVENT_ID}=sig`,
    );

    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(calledProcedures()).toEqual([
      "events.recordSignedApplicationUnlock?batch=1",
      "events.recordSignedPasswordUnlock?batch=1",
    ]);
  });

  it("PASSWORD path unchanged: a password cookie alone only calls recordSignedPasswordUnlock", async () => {
    await callWith(`better-auth.session_token=abc; th_eu_${EVENT_ID}=sig`);

    expect(calledProcedures()).toEqual([
      "events.recordSignedPasswordUnlock?batch=1",
    ]);
  });

  it("APPLICATION gate: a non-subject grant holder with a stale th_eu_ gets persisted:false, and the password path is never tried", async () => {
    fetchMock.mockImplementation(async () =>
      upstreamOk({ persisted: false, outcome: "not_subject" }),
    );

    const res = await callWith(
      `better-auth.session_token=abc; ${GRANT}; th_eu_${EVENT_ID}=sig`,
      "APPLICATION",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ persisted: false });
    expect(calledProcedures()).toEqual([
      "events.recordSignedApplicationUnlock?batch=1",
    ]);
  });

  it("APPLICATION gate: a refused grant stays a 403 even with a stale th_eu_ (no EVENT_NOT_PASSWORD_GATED 502)", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { error: { json: { message: "event_application_required" } } },
          ]),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await callWith(
      `better-auth.session_token=abc; ${GRANT}; th_eu_${EVENT_ID}=sig`,
      "APPLICATION",
    );

    expect(res.status).toBe(403);
    expect(calledProcedures()).toEqual([
      "events.recordSignedApplicationUnlock?batch=1",
    ]);
  });

  it("APPLICATION gate with only a th_eu_ cookie: nothing is synced", async () => {
    const res = await callWith(
      `better-auth.session_token=abc; th_eu_${EVENT_ID}=sig`,
      "APPLICATION",
    );

    await expect(res.json()).resolves.toEqual({ persisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PASSWORD gate: only the password cookie is synced, a stray grant is ignored", async () => {
    const res = await callWith(
      `better-auth.session_token=abc; ${GRANT}; th_eu_${EVENT_ID}=sig`,
      "PASSWORD",
    );

    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(calledProcedures()).toEqual([
      "events.recordSignedPasswordUnlock?batch=1",
    ]);
  });

  it("does nothing without a gate cookie for THIS event", async () => {
    const res = await callWith(
      "better-auth.session_token=abc; th_ea_00000000-0000-4000-8000-0000000000ff=x.1.sig",
    );

    await expect(res.json()).resolves.toEqual({ persisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/events/[eventId]/sync-unlock — invite grant", () => {
  const INVITE = `th_ei_${EVENT_ID}=90000000-0000-4000-8000-000000000009.4102444800000.sig`;
  const APP_GRANT = `th_ea_${EVENT_ID}=70000000-0000-4000-8000-000000000007.1.1.sig`;
  const callWith = (
    cookie: string,
    gateType?: "PASSWORD" | "APPLICATION",
  ) =>
    POST(
      new NextRequest(
        `http://localhost:3000/api/events/${EVENT_ID}/sync-unlock`,
        {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            cookie,
            ...(gateType ? { "content-type": "application/json" } : {}),
          },
          ...(gateType ? { body: JSON.stringify({ gateType }) } : {}),
        },
      ),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
  const upstreamOk = (json: Record<string, unknown>) =>
    new Response(JSON.stringify([{ result: { data: { json } } }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const calledProcedures = () =>
    fetchMock.mock.calls.map((c) => String(c[0]).split("/trpc/")[1]);

  it.each([undefined, "PASSWORD", "APPLICATION"] as const)(
    "syncs an invite grant through recordSignedInviteUnlock on either gate (hint %s)",
    async (gateType) => {
      const res = await callWith(
        `better-auth.session_token=abc; ${INVITE}`,
        gateType,
      );

      await expect(res.json()).resolves.toEqual({ persisted: true });
      expect(calledProcedures()).toEqual([
        "events.recordSignedInviteUnlock?batch=1",
      ]);
      // Only the gate cookie is forwarded, never the session cookie.
      expect(upstreamHeaders().cookie).toBe(INVITE);
    },
  );

  it("maps event_invite_grant_required to 403", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { error: { json: { message: "event_invite_grant_required" } } },
          ]),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await callWith(`better-auth.session_token=abc; ${INVITE}`);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "event_invite_grant_required",
    });
  });

  it("reports persisted:false when the invite no longer holds", async () => {
    fetchMock.mockImplementation(async () => upstreamOk({ persisted: false }));

    const res = await callWith(`better-auth.session_token=abc; ${INVITE}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ persisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("APPLICATION gate: tries the application grant first, then the invite grant", async () => {
    fetchMock
      .mockImplementationOnce(async () => upstreamOk({ persisted: false }))
      .mockImplementationOnce(async () => upstreamOk({ persisted: true }));

    const res = await callWith(
      `better-auth.session_token=abc; ${APP_GRANT}; ${INVITE}`,
      "APPLICATION",
    );

    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(calledProcedures()).toEqual([
      "events.recordSignedApplicationUnlock?batch=1",
      "events.recordSignedInviteUnlock?batch=1",
    ]);
  });

  it("PASSWORD gate: a refused invite grant falls through to the password cookie", async () => {
    fetchMock
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              { error: { json: { message: "event_invite_grant_required" } } },
            ]),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      )
      .mockImplementationOnce(async () => upstreamOk({ persisted: true }));

    const res = await callWith(
      `better-auth.session_token=abc; ${INVITE}; th_eu_${EVENT_ID}=sig`,
      "PASSWORD",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(calledProcedures()).toEqual([
      "events.recordSignedInviteUnlock?batch=1",
      "events.recordSignedPasswordUnlock?batch=1",
    ]);
  });

  it("stops at the first proof that persists", async () => {
    const res = await callWith(
      `better-auth.session_token=abc; ${INVITE}; th_eu_${EVENT_ID}=sig`,
    );

    await expect(res.json()).resolves.toEqual({ persisted: true });
    expect(calledProcedures()).toEqual([
      "events.recordSignedInviteUnlock?batch=1",
    ]);
  });

  it("ignores an invite grant for another event", async () => {
    const res = await callWith(
      "better-auth.session_token=abc; th_ei_00000000-0000-4000-8000-0000000000ff=x.1.sig",
    );

    await expect(res.json()).resolves.toEqual({ persisted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
