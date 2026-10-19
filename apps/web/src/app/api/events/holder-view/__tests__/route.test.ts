// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cache and fail-closed contract of the holder-view endpoint (ban that
 * sticks — ticket holders keep a banned owner's event page on the web).
 *
 * Every response must be unstorable by a shared cache, and every refusal —
 * stranger, anonymous, bad input, outage, a read the API then refuses — must
 * be the same `{ access: "none" }`, so the 404 stands.
 */

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  loadUnlockedEventPageData: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));
vi.mock("@/server/trpc-client", () => ({
  getServerTrpcClient: () => ({
    events: { getBannedOwnerHolderAccess: { query: mocks.access } },
  }),
}));
vi.mock("@/server/event-page-data", () => ({
  loadUnlockedEventPageData: mocks.loadUnlockedEventPageData,
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) =>
    mocks.trace(label, err),
}));

import { NextRequest } from "next/server";
import superjson from "superjson";

import { POST } from "../route";

const SLUG = "event/us/nashville/show--abc";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown, origin = "http://localhost:3000") {
  return POST(
    new NextRequest("http://localhost:3000/api/events/holder-view", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    }),
  );
}

function expectNoStore(res: Response) {
  expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
}

describe("POST /api/events/holder-view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands a holder the page payload, uncached", async () => {
    mocks.access.mockResolvedValue({ eventId: EVENT_ID, currentSlug: SLUG });
    const data = {
      event: { id: EVENT_ID, startsAt: new Date("2026-10-10") },
      hideTicketCta: false,
      sellabilityReason: "ok",
      waitlistOpen: true,
    };
    mocks.loadUnlockedEventPageData.mockResolvedValue(data);

    const res = await post({ slug: SLUG });

    expectNoStore(res);
    const body = (await res.json()) as {
      access: string;
      data: ReturnType<typeof superjson.serialize>;
    };
    expect(body.access).toBe("holder");
    // Purchase is never offered: the payload is forced into the page's
    // neutral holder-view state, server-side (no sales_closed borrowed).
    expect(superjson.deserialize(body.data)).toEqual({
      ...data,
      hideTicketCta: true,
      holderView: true,
      waitlistOpen: false,
    });
    expect(mocks.access).toHaveBeenCalledWith({ slug: SLUG });
    expect(mocks.loadUnlockedEventPageData).toHaveBeenCalledWith(
      EVENT_ID,
      SLUG,
    );
  });

  it("a non-holder (or anonymous) gets { access: none } and no page read", async () => {
    mocks.access.mockResolvedValue(null);
    const res = await post({ slug: SLUG });
    expectNoStore(res);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access: "none" });
    expect(mocks.loadUnlockedEventPageData).not.toHaveBeenCalled();
  });

  it("an API outage or a refused page read degrades to none, still uncached", async () => {
    mocks.access.mockRejectedValue(new Error("api down"));
    const res = await post({ slug: SLUG });
    expectNoStore(res);
    expect(await res.json()).toEqual({ access: "none" });
    expect(mocks.trace).toHaveBeenCalledWith(
      "event.holderView.failed",
      expect.any(Error),
    );

    mocks.access.mockResolvedValue({ eventId: EVENT_ID, currentSlug: SLUG });
    mocks.loadUnlockedEventPageData.mockRejectedValue(new Error("FORBIDDEN"));
    const res2 = await post({ slug: SLUG });
    expectNoStore(res2);
    expect(await res2.json()).toEqual({ access: "none" });
  });

  it("refuses a cross-origin caller and bad input, uncached", async () => {
    const cross = await post({ slug: SLUG }, "https://evil.example");
    expectNoStore(cross);
    expect(cross.status).toBe(403);
    const bad = await post({ slug: "", extra: 1 });
    expectNoStore(bad);
    expect(bad.status).toBe(400);
    expect(mocks.access).not.toHaveBeenCalled();
  });
});
