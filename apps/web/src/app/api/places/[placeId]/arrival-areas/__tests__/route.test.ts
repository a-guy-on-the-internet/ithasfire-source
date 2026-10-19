// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cache and fail-closed contract of the place page's per-viewer
 * arrival-areas endpoint (arrival-areas FR-008, NFR-001), the same contract
 * as `POST /api/events/[eventId]/viewer-state`:
 *  · every response, thrown ones included, is `private, no-store`;
 *  · a cross-origin caller, a bad id and any failure get `{ areas: null }`,
 *    which leaves the page's anonymous list standing.
 *
 * WHAT THIS CANNOT SEE: who may see which area. That is the API's
 * `listArrivalAreasForViewer`, and the loader's own tests
 * (`src/server/__tests__/arrival-areas.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  loadViewerPlaceArrivalAreas: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("@/server/arrival-areas", () => ({
  loadViewerPlaceArrivalAreas: mocks.loadViewerPlaceArrivalAreas,
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) =>
    mocks.trace(label, err),
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const PLACE_ID = "00000000-0000-4000-8000-00000000a001";
const NO_STORE = "private, no-store, max-age=0";

const MANAGER_AREAS = [
  { id: "00000000-0000-4000-8000-00000000a002", kind: "LOAD_IN", label: "Alley door" },
];

function request(
  placeId = PLACE_ID,
  headers: Record<string, string> = { origin: "http://localhost:3000" },
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/places/${placeId}/arrival-areas`,
    { method: "POST", headers },
  );
}

const call = (placeId = PLACE_ID, headers?: Record<string, string>) =>
  POST(request(placeId, headers), { params: Promise.resolve({ placeId }) });

beforeEach(() => {
  mocks.loadViewerPlaceArrivalAreas.mockReset();
  mocks.trace.mockReset();
  mocks.loadViewerPlaceArrivalAreas.mockResolvedValue(MANAGER_AREAS);
});

describe("POST /api/places/[placeId]/arrival-areas", () => {
  it("returns this viewer's areas for a same-origin caller, no-store", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    await expect(res.json()).resolves.toEqual({ areas: MANAGER_AREAS });
    expect(mocks.loadViewerPlaceArrivalAreas).toHaveBeenCalledWith(PLACE_ID);
  });

  it("passes the loader's null (nothing to add) straight through", async () => {
    mocks.loadViewerPlaceArrivalAreas.mockResolvedValueOnce(null);
    const res = await call();
    await expect(res.json()).resolves.toEqual({ areas: null });
  });

  it("stamps `private, no-store` on EVERY failure path too", async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ["cross-origin", () => call(PLACE_ID, { origin: "https://evil.test" })],
      ["bad uuid", () => call("not-a-uuid")],
      [
        "loader throw",
        async () => {
          mocks.loadViewerPlaceArrivalAreas.mockRejectedValueOnce(
            new Error("api down"),
          );
          return call();
        },
      ],
    ];
    for (const [label, run] of cases) {
      const res = await run();
      expect(res.headers.get("Cache-Control"), `${label} was storable`).toBe(
        NO_STORE,
      );
      await expect(res.json(), label).resolves.toEqual({ areas: null });
    }
  });

  it("refuses a cross-origin POST before reading anything", async () => {
    const res = await call(PLACE_ID, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(mocks.loadViewerPlaceArrivalAreas).not.toHaveBeenCalled();
  });

  it("allows a caller that sends no Origin header", async () => {
    const res = await call(PLACE_ID, {});
    expect(res.status).toBe(200);
  });

  it("rejects a non-UUID place id before touching the loader", async () => {
    const res = await call("../../etc/passwd");
    expect(res.status).toBe(400);
    expect(mocks.loadViewerPlaceArrivalAreas).not.toHaveBeenCalled();
  });

  it("fails CLOSED and reports when the loader throws", async () => {
    mocks.loadViewerPlaceArrivalAreas.mockRejectedValueOnce(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ areas: null });
    expect(mocks.trace).toHaveBeenCalledWith(
      "place.arrivalAreas.route",
      expect.any(Error),
    );
  });
});
