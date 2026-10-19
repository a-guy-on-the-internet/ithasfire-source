import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryOpts = { staleTime?: number; retry?: boolean; refetchOnWindowFocus?: boolean };
type QueryResult = {
  data?: { count: number };
  isLoading: boolean;
};

const calls: Array<{ input: Record<string, unknown>; opts: QueryOpts }> = [];
let result: QueryResult = { data: undefined, isLoading: false };

vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      countDirectory: {
        useQuery: (input: Record<string, unknown>, opts: QueryOpts) => {
          calls.push({ input, opts });
          return result;
        },
      },
    },
  },
}));

import { useDirectoryPlaceCount } from "../useDirectoryPlaceCount";
import { NEARBY_RADIUS_KM } from "../useHeroEvents";

const COORDS = { lat: 36.16, lng: -86.78 };

describe("useDirectoryPlaceCount", () => {
  beforeEach(() => {
    calls.length = 0;
    result = { data: undefined, isLoading: false };
  });

  // ── Scope ────────────────────────────────────────────────────────────────

  it("asks for the whole directory when coords are unknown", () => {
    renderHook(() => useDirectoryPlaceCount(null));

    expect(calls.at(-1)?.input).toEqual({});
  });

  it("scopes to the visitor's coords on the SAME circle the events count uses", () => {
    renderHook(() => useDirectoryPlaceCount(COORDS));

    expect(calls.at(-1)?.input).toEqual({
      near: { lat: COORDS.lat, lng: COORDS.lng, radiusKm: NEARBY_RADIUS_KM },
    });
    // The events query sends metres; this one sends kilometres. One number,
    // two units — the kicker reads "M venues · N events" as one scope.
    expect(NEARBY_RADIUS_KM).toBe(120);
  });

  it("stays inside the procedure's 500 km ceiling", () => {
    // countDirectoryPlacesInputSchema caps radiusKm at 500; a larger shared
    // radius would 400 this query (and blank the segment) while the events
    // query kept working.
    expect(NEARBY_RADIUS_KM).toBeLessThanOrEqual(500);
  });

  // ── Fetch policy ─────────────────────────────────────────────────────────

  it("mirrors the events hook's fetch policy", () => {
    renderHook(() => useDirectoryPlaceCount(null));

    expect(calls.at(-1)?.opts).toEqual({
      staleTime: 120_000,
      retry: false,
      refetchOnWindowFocus: false,
    });
  });

  // ── Shape ────────────────────────────────────────────────────────────────

  it("returns the count once data lands", () => {
    result = { data: { count: 447 }, isLoading: false };

    const { result: hook } = renderHook(() => useDirectoryPlaceCount(COORDS));

    expect(hook.current).toEqual({ count: 447, isLoading: false });
  });

  it("reports a count of 0 (not undefined) before data arrives, and passes loading through", () => {
    result = { data: undefined, isLoading: true };

    const { result: hook } = renderHook(() => useDirectoryPlaceCount(null));

    expect(hook.current).toEqual({ count: 0, isLoading: true });
  });

  it("resolves to a 0 count (never undefined/NaN) when the query errored", () => {
    // retry: false — a failed request settles as status "error" with no data
    // and isLoading false. The kicker must then HIDE the segment, which it
    // does only if this hook hands it a real 0, not undefined.
    result = { data: undefined, isLoading: false };

    const { result: hook } = renderHook(() => useDirectoryPlaceCount(null));

    expect(hook.current).toEqual({ count: 0, isLoading: false });
    expect(Number.isNaN(hook.current.count)).toBe(false);
  });

  it("exposes only count and isLoading — nothing else leaks out", () => {
    result = { data: { count: 5 }, isLoading: false };

    const { result: hook } = renderHook(() => useDirectoryPlaceCount(null));

    expect(Object.keys(hook.current).sort()).toEqual(["count", "isLoading"]);
  });
});
