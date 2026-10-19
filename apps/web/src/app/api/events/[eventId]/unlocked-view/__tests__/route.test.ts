// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The uncacheable gated-event probe. For an APPLICATION gate it adds nothing
 * of its own: the API judged the forwarded `th_ea_` grant (signature +
 * submission still APPROVED) and folded the answer into
 * `applicationRequired`. The password cookie stays PASSWORD-only here.
 */

const mocks = vi.hoisted(() => ({
  gateState: null as Record<string, unknown> | null,
  passwordCookieValid: false,
  loadUnlocked: vi.fn(),
}));

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "anything" }) }),
}));

vi.mock("@/lib/event-unlock-cookie", () => ({
  eventUnlockCookieName: (id: string) => `th_eu_${id}`,
  verifyEventUnlockCookie: () => mocks.passwordCookieValid,
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
}));

vi.mock("@/server/event-page-data", () => ({
  loadUnlockedEventPageData: (...args: unknown[]) => mocks.loadUnlocked(...args),
}));

vi.mock("@/server/trpc-client", () => ({
  getServerTrpcClient: vi.fn(),
  getPublicTrpcClient: vi.fn(),
}));

vi.mock("@/server/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/events")>()),
  fetchEventGateState: async () => mocks.gateState,
  resolveEventSlug: async () => ({ currentSlug: "secret", redirect: false }),
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";

const call = () =>
  POST(
    new NextRequest(
      `http://localhost:3000/api/events/${EVENT_ID}/unlocked-view`,
      { method: "POST", headers: { origin: "http://localhost:3000" } },
    ),
    { params: Promise.resolve({ eventId: EVENT_ID }) },
  );

const gate = (overrides: Record<string, unknown>) => ({
  eventId: EVENT_ID,
  gateType: "APPLICATION",
  passwordRequired: false,
  applicationRequired: true,
  viewerCanBypass: false,
  viewerIsUnlocked: false,
  viewerHasApplicationGrant: false,
  viewerHasInviteGrant: false,
  viewerRemovedByInviteReset: false,
  waitlistOpen: false,
  waitlistDescription: null,
  ...overrides,
});

beforeEach(() => {
  mocks.passwordCookieValid = false;
  mocks.loadUnlocked.mockReset();
  mocks.loadUnlocked.mockResolvedValue({ event: { id: EVENT_ID } });
});

describe("POST /api/events/[eventId]/unlocked-view — APPLICATION gate", () => {
  it("unlocks when the API honoured the viewer's application grant", async () => {
    mocks.gateState = gate({
      applicationRequired: false,
      viewerHasApplicationGrant: true,
    });

    const res = await call();

    await expect(res.json()).resolves.toMatchObject({ access: "unlocked" });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(mocks.loadUnlocked).toHaveBeenCalledWith(EVENT_ID, "secret");
  });

  it("stays locked when the API did not honour a grant (revoked / forged / other event)", async () => {
    mocks.gateState = gate({ applicationRequired: true });

    const res = await call();

    await expect(res.json()).resolves.toEqual({ access: "locked" });
    expect(mocks.loadUnlocked).not.toHaveBeenCalled();
  });

  it("a valid PASSWORD cookie does not open an APPLICATION gate", async () => {
    mocks.gateState = gate({ applicationRequired: true });
    mocks.passwordCookieValid = true;

    const res = await call();

    await expect(res.json()).resolves.toEqual({ access: "locked" });
    expect(mocks.loadUnlocked).not.toHaveBeenCalled();
  });

  it("PASSWORD path unchanged: a valid password cookie opens a PASSWORD gate", async () => {
    mocks.gateState = gate({
      gateType: "PASSWORD",
      passwordRequired: true,
      applicationRequired: false,
    });
    mocks.passwordCookieValid = true;

    const res = await call();

    await expect(res.json()).resolves.toMatchObject({ access: "unlocked" });
  });
});

describe("POST /api/events/[eventId]/unlocked-view — invite grant", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "unlocks a %s gate when the API honoured the viewer's invite grant",
    async (gateType) => {
      // The forwarded `th_ei_` grant was judged by the API and folded into
      // the gate's *Required flag; no password cookie is involved.
      mocks.gateState = gate({
        gateType,
        passwordRequired: false,
        applicationRequired: false,
        viewerHasInviteGrant: true,
      });

      const res = await call();

      await expect(res.json()).resolves.toMatchObject({ access: "unlocked" });
      expect(res.headers.get("cache-control")).toContain("no-store");
    },
  );

  it("stays locked when the API did not honour the invite grant (revoked / event over)", async () => {
    mocks.gateState = gate({
      gateType: "PASSWORD",
      passwordRequired: true,
      applicationRequired: false,
      viewerHasInviteGrant: false,
    });

    const res = await call();

    await expect(res.json()).resolves.toEqual({ access: "locked" });
    expect(mocks.loadUnlocked).not.toHaveBeenCalled();
  });
});

describe("POST /api/events/[eventId]/unlocked-view — removed by an invite reset", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "a locked %s gate says the viewer was removed by \"Reset and remove everyone\"",
    async (gateType) => {
      mocks.gateState = gate({
        gateType,
        passwordRequired: gateType === "PASSWORD",
        applicationRequired: gateType === "APPLICATION",
        viewerRemovedByInviteReset: true,
      });

      const res = await call();

      await expect(res.json()).resolves.toEqual({
        access: "locked",
        removedByInviteReset: true,
      });
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(mocks.loadUnlocked).not.toHaveBeenCalled();
    },
  );

  it("no reason when the API gave none (plain reset, forged cookie, event over, stranger)", async () => {
    mocks.gateState = gate({ applicationRequired: true });

    const res = await call();

    await expect(res.json()).resolves.toEqual({ access: "locked" });
  });

  it("a valid password cookie still opens the gate, and says nothing about the reset", async () => {
    // A removed guest who then entered the password: the stale `th_ei_`
    // cookie still names the stamped invite, but they are in.
    mocks.gateState = gate({
      gateType: "PASSWORD",
      passwordRequired: true,
      applicationRequired: false,
      viewerRemovedByInviteReset: true,
    });
    mocks.passwordCookieValid = true;

    const res = await call();

    const body = await res.json();
    expect(body).toMatchObject({ access: "unlocked" });
    expect(body).not.toHaveProperty("removedByInviteReset");
  });
});
