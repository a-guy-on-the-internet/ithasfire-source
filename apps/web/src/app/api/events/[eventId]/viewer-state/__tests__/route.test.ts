// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cache and fail-closed contract of the viewer-state endpoint.
 *
 * This route is the ONLY place the event page may ask a question about the
 * viewer, because `/events/[...slug]` is edge-cached with no `Cookie` in its
 * `Vary`. Two properties have to hold on every path, including the ones that
 * throw: the response must be unstorable by a shared cache, and a failure must
 * degrade to the REDACTED state rather than to a reveal.
 *
 * WHAT THIS CANNOT SEE: whether `loadEventViewerState` resolves the reveal
 * correctly — that is stubbed here and has its own tests
 * (`src/server/__tests__/event-viewer-state.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  loadEventViewerState: vi.fn(),
  resolveEventSlug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("@/server/event-viewer-state", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/event-viewer-state")
  >("@/server/event-viewer-state");
  return {
    EMPTY_EVENT_VIEWER_STATE: actual.EMPTY_EVENT_VIEWER_STATE,
    loadEventViewerState: mocks.loadEventViewerState,
  };
});

vi.mock("@/server/events", () => ({
  resolveEventSlug: mocks.resolveEventSlug,
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) =>
    mocks.trace(label, err),
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const EVENT_ID = "00000000-0000-4000-8000-00000000d030";

const REVEALED = {
  editHref: "/admin/demo/events/evt-1",
  viewerHasTicket: true,
  location: { addressLine1: "411 Hidden Barn Rd", isExact: true },
  viewerRsvped: true,
  dateRsvps: { d1: true },
  // An act's load-in: per-viewer, so it may only ever leave through here.
  viewerArrivalAreas: [{ id: "load-in", kind: "LOAD_IN", label: "Alley door" }],
};

const EMPTY = {
  editHref: null,
  viewerHasTicket: false,
  location: null,
  viewerRsvped: null,
  dateRsvps: {},
  viewerArrivalAreas: null,
};

function request(
  eventId = EVENT_ID,
  headers: Record<string, string> = { origin: "http://localhost:3000" },
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/events/${eventId}/viewer-state`,
    { method: "POST", headers },
  );
}

const call = (eventId = EVENT_ID, headers?: Record<string, string>) =>
  POST(request(eventId, headers), {
    params: Promise.resolve({ eventId }),
  });

beforeEach(() => {
  mocks.loadEventViewerState.mockReset();
  mocks.resolveEventSlug.mockReset();
  mocks.trace.mockReset();
  mocks.resolveEventSlug.mockResolvedValue({
    eventId: EVENT_ID,
    currentSlug: "great-show",
    redirect: false,
  });
  mocks.loadEventViewerState.mockResolvedValue(REVEALED);
});

describe("POST /api/events/[eventId]/viewer-state", () => {
  it("returns the viewer state for a same-origin caller", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(REVEALED);
  });

  it("stamps `private, no-store` on a successful response", async () => {
    const res = await call();
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("stamps `private, no-store` on EVERY failure path too", async () => {
    // The single-exit invariant. A 403/400/404 that a shared cache could store
    // is a different bug of the same family as the one this route exists to
    // fix, so each is checked rather than assumed.
    const cases: Array<[string, () => Promise<Response>]> = [
      ["cross-origin", () => call(EVENT_ID, { origin: "https://evil.test" })],
      ["bad uuid", () => call("not-a-uuid")],
      [
        "unknown event",
        async () => {
          mocks.resolveEventSlug.mockResolvedValueOnce(null);
          return call();
        },
      ],
      [
        "upstream throw",
        async () => {
          mocks.resolveEventSlug.mockRejectedValueOnce(new Error("api down"));
          return call();
        },
      ],
    ];
    for (const [label, run] of cases) {
      const res = await run();
      expect(
        res.headers.get("Cache-Control"),
        `${label} was storable`,
      ).toBe("private, no-store, max-age=0");
    }
  });

  it("refuses a cross-origin POST and answers with the REDACTED state", async () => {
    const res = await call(EVENT_ID, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(EMPTY);
    expect(mocks.loadEventViewerState).not.toHaveBeenCalled();
  });

  it("carries the viewer's arrival areas only on a no-store response", async () => {
    const res = await call();
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    const body = (await res.json()) as typeof REVEALED;
    expect(body.viewerArrivalAreas).toEqual(REVEALED.viewerArrivalAreas);
  });

  it("allows a caller that sends no Origin header at all", async () => {
    // Same posture as ../unlock: only a MISMATCHED origin is refused.
    const res = await call(EVENT_ID, {});
    expect(res.status).toBe(200);
  });

  it("rejects a non-UUID event id before touching any loader", async () => {
    const res = await call("../../etc/passwd");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(EMPTY);
    expect(mocks.resolveEventSlug).not.toHaveBeenCalled();
  });

  it("404s an unknown event with the redacted state", async () => {
    mocks.resolveEventSlug.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual(EMPTY);
  });

  it("fails CLOSED and reports when an upstream throws", async () => {
    mocks.loadEventViewerState.mockRejectedValueOnce(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(EMPTY);
    expect(mocks.trace).toHaveBeenCalledWith(
      "event.viewerState.failed",
      expect.any(Error),
    );
  });

  it("resolves the slug from the EVENT ID, never from the caller", async () => {
    await call();
    expect(mocks.resolveEventSlug).toHaveBeenCalledWith(EVENT_ID);
    expect(mocks.loadEventViewerState).toHaveBeenCalledWith(
      EVENT_ID,
      "great-show",
    );
  });
});
