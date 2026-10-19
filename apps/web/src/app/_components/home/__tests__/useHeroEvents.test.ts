import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryOpts = { enabled?: boolean; staleTime?: number; retry?: boolean };
type QueryResult = {
  data?: { events: unknown[] };
  isLoading: boolean;
};

const nearbyCalls: Array<{ input: Record<string, unknown>; opts: QueryOpts }> =
  [];
const overviewCalls: Array<{
  input: Record<string, unknown>;
  opts: QueryOpts;
}> = [];

let nearbyResult: QueryResult = { data: undefined, isLoading: false };
let overviewResult: QueryResult = { data: undefined, isLoading: false };

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      nearbyEventsForMap: {
        useQuery: (input: Record<string, unknown>, opts: QueryOpts) => {
          nearbyCalls.push({ input, opts });
          return nearbyResult;
        },
      },
      eventsForMapOverview: {
        useQuery: (input: Record<string, unknown>, opts: QueryOpts) => {
          overviewCalls.push({ input, opts });
          return overviewResult;
        },
      },
    },
  },
}));

import { buildHeroDateRange, useHeroEvents } from "../useHeroEvents";

const COORDS = { lat: 36.16, lng: -86.78 };

const makeEvent = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "evt-1",
  title: "Basement Show",
  lat: 36.16,
  lng: -86.78,
  venue: "The End",
  slug: "basement-show",
  ...over,
});

describe("useHeroEvents", () => {
  beforeEach(() => {
    nearbyCalls.length = 0;
    overviewCalls.length = 0;
    nearbyResult = { data: undefined, isLoading: false };
    overviewResult = { data: undefined, isLoading: false };
  });

  // ── The isMapEnabled trap ────────────────────────────────────────────────
  // The queries used to be gated on `enabled: isMapEnabled && …`, which is
  // `Boolean(NEXT_PUBLIC_TILESERVER_URL)`. That gates the TILE SERVER, not the
  // event data — inheriting it would blank the count whenever the tileserver
  // is unconfigured or down. `NEXT_PUBLIC_TILESERVER_URL` is unset under
  // vitest, so `isMapEnabled` is false here: if anyone re-adds the gate, these
  // two fail.
  it("enables the overview query even when the tile server is unconfigured", () => {
    renderHook(() => useHeroEvents(null));

    expect(overviewCalls.at(-1)?.opts.enabled).toBe(true);
  });

  it("enables the nearby query even when the tile server is unconfigured", () => {
    renderHook(() => useHeroEvents(COORDS));

    expect(nearbyCalls.at(-1)?.opts.enabled).toBe(true);
  });

  it("carries over the map's fetch policy", () => {
    renderHook(() => useHeroEvents(null));

    expect(overviewCalls.at(-1)?.opts).toMatchObject({
      staleTime: 120_000,
      retry: false,
      refetchOnWindowFocus: false,
    });
  });

  // ── Branching ────────────────────────────────────────────────────────────
  it("uses the overview query and disables the nearby one without coords", () => {
    overviewResult = { data: { events: [makeEvent()] }, isLoading: false };

    const { result } = renderHook(() => useHeroEvents(null));

    expect(nearbyCalls.at(-1)?.opts.enabled).toBe(false);
    expect(result.current.hasCoords).toBe(false);
    expect(result.current.count).toBe(1);
  });

  it("uses the nearby query and disables the overview one with coords", () => {
    nearbyResult = {
      data: { events: [makeEvent(), makeEvent({ id: "e2" })] },
      isLoading: false,
    };

    const { result } = renderHook(() => useHeroEvents(COORDS));

    expect(overviewCalls.at(-1)?.opts.enabled).toBe(false);
    expect(result.current.hasCoords).toBe(true);
    expect(result.current.count).toBe(2);
    expect(nearbyCalls.at(-1)?.input).toMatchObject({
      lat: COORDS.lat,
      lng: COORDS.lng,
      radiusM: 120_000,
    });
  });

  it("reports loading from the ACTIVE query only", () => {
    overviewResult = { data: undefined, isLoading: true };
    nearbyResult = { data: undefined, isLoading: false };

    const { result } = renderHook(() => useHeroEvents(null));
    expect(result.current.isLoading).toBe(true);

    overviewResult = { data: undefined, isLoading: true };
    nearbyResult = { data: { events: [] }, isLoading: false };
    const withCoords = renderHook(() => useHeroEvents(COORDS));
    expect(withCoords.result.current.isLoading).toBe(false);
  });

  // ── Shape ────────────────────────────────────────────────────────────────
  it("returns only the count — no event shapes leak out of the hook", () => {
    overviewResult = {
      data: { events: [makeEvent({ obscured: true }), makeEvent({ id: "e2" })] },
      isLoading: false,
    };

    const { result } = renderHook(() => useHeroEvents(null));

    expect(result.current).toEqual({
      count: 2,
      isCapped: false,
      isLoading: false,
      hasCoords: false,
    });
    expect(result.current).not.toHaveProperty("events");
  });

  // ── The cap ──────────────────────────────────────────────────────────────
  // Both queries are capped at HERO_LIMIT (50), so `count` can never exceed it
  // and a busier week is indistinguishable from exactly 50. The hook says so.
  it("reports isCapped once the count reaches the 50-event query ceiling", () => {
    overviewResult = {
      data: { events: Array.from({ length: 50 }, (_, i) => makeEvent({ id: `e${i}` })) },
      isLoading: false,
    };

    const { result } = renderHook(() => useHeroEvents(null));

    expect(result.current.count).toBe(50);
    expect(result.current.isCapped).toBe(true);
  });

  it("does not report isCapped one below the ceiling", () => {
    nearbyResult = {
      data: { events: Array.from({ length: 49 }, (_, i) => makeEvent({ id: `e${i}` })) },
      isLoading: false,
    };

    const { result } = renderHook(() => useHeroEvents(COORDS));

    expect(result.current.count).toBe(49);
    expect(result.current.isCapped).toBe(false);
  });

  it("reports a count of 0 (not undefined) before data arrives", () => {
    const { result } = renderHook(() => useHeroEvents(null));

    expect(result.current.count).toBe(0);
  });

  it("keeps a stable date range across re-renders so the query key can't churn", () => {
    const { rerender } = renderHook(() => useHeroEvents(null));
    const first = overviewCalls.at(-1)?.input;
    rerender();
    const second = overviewCalls.at(-1)?.input;

    expect(second?.startsAfter).toBe(first?.startsAfter);
    expect(second?.startsBefore).toBe(first?.startsBefore);
  });
});

describe("buildHeroDateRange", () => {
  it("spans exactly one week from the given instant", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");

    expect(buildHeroDateRange(now)).toEqual({
      startsAfter: "2026-07-16T12:00:00.000Z",
      startsBefore: "2026-07-23T12:00:00.000Z",
    });
  });
});
