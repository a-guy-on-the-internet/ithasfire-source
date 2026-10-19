import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two arrival-area reads behind the place and event pages (arrival-areas
 * FR-008, NFR-001, NFR-002).
 *
 *  · The PUBLIC loaders feed the edge-cached document, so they must use the
 *    de-identified client and keep an answer only when the API marks it
 *    `cacheablePublic`.
 *  · The VIEWER loaders feed the no-store POST routes; they hand back `null`
 *    ("keep the cached list") for anything that adds nothing, and on every
 *    failure.
 *  · Nothing traced may quote a geometry or a Directions point.
 */

const mocks = vi.hoisted(() => ({
  publicPlace: vi.fn(),
  publicEvent: vi.fn(),
  viewerPlace: vi.fn(),
  viewerEvent: vi.fn(),
  trace: vi.fn(),
  cookie: { value: "better-auth.session_token=abc" as string | null },
}));

// The viewer event loader skips the API for a request that carries neither a
// session nor one of the event's gate cookies.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name === "cookie" ? mocks.cookie.value : null),
    }),
}));

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => ({
    arrivalAreas: {
      listForPlace: { query: mocks.publicPlace },
      listForEvent: { query: mocks.publicEvent },
    },
  }),
  getServerTrpcClient: () => ({
    arrivalAreas: {
      listForPlace: { query: mocks.viewerPlace },
      listForEvent: { query: mocks.viewerEvent },
    },
  }),
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) =>
    mocks.trace(label, err),
}));

import {
  loadPublicEventArrivalAreas,
  loadPublicPlaceArrivalAreas,
  loadViewerEventArrivalAreas,
  loadViewerPlaceArrivalAreas,
} from "../arrival-areas";

const PLACE_ID = "00000000-0000-4000-8000-0000000000aa";
const EVENT_ID = "00000000-0000-4000-8000-0000000000bb";

/** Coordinates no other fixture uses, so a leak is greppable. */
const SECRET_LNG = -86.7712345;
const SECRET_LAT = 36.1712345;

const AREA = {
  id: "00000000-0000-4000-8000-0000000000cc",
  source: "PLACE" as const,
  kind: "PARKING" as const,
  label: "Church lot across Linden",
  cost: "FREE" as const,
  priceText: null,
  note: "Free after 6pm.",
  accessibleSpots: true,
  geometry: {
    type: "LineString" as const,
    coordinates: [
      [SECRET_LNG, SECRET_LAT],
      [SECRET_LNG + 0.001, SECRET_LAT],
    ],
  },
  directions: { lat: SECRET_LAT, lng: SECRET_LNG + 0.0005 },
};

beforeEach(() => {
  mocks.publicPlace.mockReset();
  mocks.publicEvent.mockReset();
  mocks.viewerPlace.mockReset();
  mocks.viewerEvent.mockReset();
  mocks.trace.mockReset();
  mocks.cookie.value = "better-auth.session_token=abc";
});

describe("public loaders (edge-cached document)", () => {
  it("keep an answer the API marks cacheablePublic, read anonymously", async () => {
    mocks.publicPlace.mockResolvedValue({ areas: [AREA], cacheablePublic: true });
    mocks.publicEvent.mockResolvedValue({ areas: [AREA], cacheablePublic: true });

    await expect(loadPublicPlaceArrivalAreas(PLACE_ID)).resolves.toEqual([AREA]);
    await expect(loadPublicEventArrivalAreas(EVENT_ID)).resolves.toEqual([AREA]);
    expect(mocks.publicPlace).toHaveBeenCalledWith({ placeId: PLACE_ID });
    expect(mocks.publicEvent).toHaveBeenCalledWith({ eventId: EVENT_ID });
    // The identity client is never touched for the cached document.
    expect(mocks.viewerPlace).not.toHaveBeenCalled();
    expect(mocks.viewerEvent).not.toHaveBeenCalled();
  });

  it("drop everything when the answer is not cacheablePublic", async () => {
    mocks.publicPlace.mockResolvedValue({ areas: [AREA], cacheablePublic: false });
    mocks.publicEvent.mockResolvedValue({ areas: [AREA], cacheablePublic: false });

    await expect(loadPublicPlaceArrivalAreas(PLACE_ID)).resolves.toEqual([]);
    await expect(loadPublicEventArrivalAreas(EVENT_ID)).resolves.toEqual([]);
  });

  it("fail closed to an empty list on a throw", async () => {
    mocks.publicPlace.mockRejectedValue(new Error("api down"));
    mocks.publicEvent.mockRejectedValue(new Error("api down"));

    await expect(loadPublicPlaceArrivalAreas(PLACE_ID)).resolves.toEqual([]);
    await expect(loadPublicEventArrivalAreas(EVENT_ID)).resolves.toEqual([]);
  });

  it("drop a response that does not match the strict schema", async () => {
    mocks.publicPlace.mockResolvedValue({
      areas: [{ ...AREA, ownerEmail: "x@y.test" }],
      cacheablePublic: true,
    });
    await expect(loadPublicPlaceArrivalAreas(PLACE_ID)).resolves.toEqual([]);
  });
});

describe("viewer loaders (no-store POST routes)", () => {
  it("return the viewer's list when it adds to the anonymous one", async () => {
    const loadIn = { ...AREA, id: "00000000-0000-4000-8000-0000000000dd", kind: "LOAD_IN" as const };
    mocks.viewerPlace.mockResolvedValue({ areas: [AREA, loadIn], cacheablePublic: false });
    mocks.viewerEvent.mockResolvedValue({ areas: [AREA, loadIn], cacheablePublic: false });

    await expect(loadViewerPlaceArrivalAreas(PLACE_ID)).resolves.toEqual([AREA, loadIn]);
    await expect(loadViewerEventArrivalAreas(EVENT_ID)).resolves.toEqual([AREA, loadIn]);
    expect(mocks.publicPlace).not.toHaveBeenCalled();
  });

  it("return null (keep the cached list) when there is nothing to add", async () => {
    // Same as anonymous…
    mocks.viewerPlace.mockResolvedValue({ areas: [AREA], cacheablePublic: true });
    await expect(loadViewerPlaceArrivalAreas(PLACE_ID)).resolves.toBeNull();
    // …or empty, which is also what the API's own fail-closed path answers.
    mocks.viewerEvent.mockResolvedValue({ areas: [], cacheablePublic: false });
    await expect(loadViewerEventArrivalAreas(EVENT_ID)).resolves.toBeNull();
  });

  it("return null on a throw and on a malformed response", async () => {
    mocks.viewerPlace.mockRejectedValue(new Error("api down"));
    await expect(loadViewerPlaceArrivalAreas(PLACE_ID)).resolves.toBeNull();
    mocks.viewerEvent.mockResolvedValue({ areas: "nope", cacheablePublic: false });
    await expect(loadViewerEventArrivalAreas(EVENT_ID)).resolves.toBeNull();
  });
});

describe("viewer event loader: strangers are not asked about", () => {
  const loadIn = {
    ...AREA,
    id: "00000000-0000-4000-8000-0000000000dd",
    kind: "LOAD_IN" as const,
  };

  it.each([
    ["no cookie at all", null],
    ["only unrelated cookies", "theme=ember; th_consent=1"],
    ["another event's gate grant", "th_eu_00000000-0000-4000-8000-0000000000ff=sig"],
  ])("skips the API read with %s", async (_label, cookie) => {
    mocks.cookie.value = cookie;
    mocks.viewerEvent.mockResolvedValue({ areas: [AREA, loadIn], cacheablePublic: false });
    await expect(loadViewerEventArrivalAreas(EVENT_ID)).resolves.toBeNull();
    expect(mocks.viewerEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a session cookie", "theme=ember; better-auth.session_token=abc"],
    ["a dev session cookie", "better-auth-dev.session_token=abc"],
    ["this event's password unlock", `th_eu_${EVENT_ID}=sig`],
    ["this event's application grant", `theme=stub; th_ea_${EVENT_ID}=sig`],
    ["this event's invite grant", `th_ei_${EVENT_ID}=sig`],
  ])("asks the API with %s", async (_label, cookie) => {
    mocks.cookie.value = cookie;
    mocks.viewerEvent.mockResolvedValue({ areas: [AREA, loadIn], cacheablePublic: false });
    await expect(loadViewerEventArrivalAreas(EVENT_ID)).resolves.toEqual([AREA, loadIn]);
    expect(mocks.viewerEvent).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });
});

describe("NFR-002: no geometry or Directions point in a trace", () => {
  it("a parse failure is traced with a fixed message, never the payload", async () => {
    mocks.publicPlace.mockResolvedValue({
      areas: [{ ...AREA, geometry: { type: "Polygon", coordinates: "bad" } }],
      cacheablePublic: true,
    });
    mocks.viewerEvent.mockResolvedValue({
      areas: [{ ...AREA, directions: { lat: SECRET_LAT, lng: "x" } }],
      cacheablePublic: false,
    });

    await loadPublicPlaceArrivalAreas(PLACE_ID);
    await loadViewerEventArrivalAreas(EVENT_ID);

    expect(mocks.trace).toHaveBeenCalledTimes(2);
    const traced = JSON.stringify(
      mocks.trace.mock.calls.map(([label, err]) => [
        label,
        String(err),
        (err as Error).message,
        (err as Error).stack,
      ]),
    );
    expect(traced).not.toContain(String(SECRET_LAT));
    expect(traced).not.toContain(String(SECRET_LNG));
    expect(traced).not.toContain(AREA.label);
  });
});
