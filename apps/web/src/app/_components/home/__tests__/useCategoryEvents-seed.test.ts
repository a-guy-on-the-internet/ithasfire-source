import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The category page's server read seeds the two first-page queries, so the
 * client hydrates from the HTML's events instead of fetching page one again.
 */

const mocks = vi.hoisted(() => ({
  searchUseQuery: vi.fn(),
  dbUseQuery: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    search: { discoverEventsByCategory: { useQuery: mocks.searchUseQuery } },
    categories: {
      eventsByCategory: { useQuery: mocks.dbUseQuery },
      list: { useQuery: vi.fn(() => ({})) },
    },
  },
}));

import {
  useCategoryEvents,
  type CategoryEventsSeed,
} from "../useCategoryBrowse";

const event = { id: "e1", title: "Open Mic", date: "Sat", venue: "Room" };

const seed = {
  search: { events: [event], latencyMs: 2 },
  db: { events: [event], total: 1 },
  fetchedAt: "2026-10-13T12:00:00.000Z",
} as unknown as CategoryEventsSeed;

beforeEach(() => {
  mocks.searchUseQuery.mockReset();
  mocks.dbUseQuery.mockReset();
  // What react-query returns for a query that has initialData.
  mocks.searchUseQuery.mockImplementation((_input, opts) => ({
    data: opts?.initialData,
    isLoading: !opts?.initialData,
    isError: false,
  }));
  mocks.dbUseQuery.mockImplementation((_input, opts) => ({
    data: opts?.initialData,
    isLoading: !opts?.initialData,
    isError: false,
  }));
});

describe("useCategoryEvents seed", () => {
  it("seeds both queries with the server answer and its read time", () => {
    const { result } = renderHook(() =>
      useCategoryEvents("open-mics", 40, null, seed),
    );

    expect(mocks.searchUseQuery).toHaveBeenCalledWith(
      { categorySlug: "open-mics", limit: 40 },
      expect.objectContaining({
        initialData: seed.search,
        initialDataUpdatedAt: Date.parse(seed.fetchedAt),
      }),
    );
    expect(mocks.dbUseQuery).toHaveBeenCalledWith(
      { categorySlug: "open-mics", limit: 40, offset: 0 },
      expect.objectContaining({
        initialData: seed.db,
        initialDataUpdatedAt: Date.parse(seed.fetchedAt),
      }),
    );
    // First render already has the events: no loading pass, no refetch flash.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("leaves search unseeded when the server's search read failed", () => {
    renderHook(() =>
      useCategoryEvents("open-mics", 40, null, { ...seed, search: null }),
    );

    expect(mocks.searchUseQuery.mock.calls[0]?.[1]).not.toHaveProperty(
      "initialData",
    );
    expect(mocks.dbUseQuery.mock.calls[0]?.[1]).toHaveProperty(
      "initialData",
      seed.db,
    );
  });

  it("does not seed a coords query, whose input the server never read", () => {
    renderHook(() =>
      useCategoryEvents("open-mics", 40, { lat: 44.9, lng: -93.2 }, seed),
    );

    expect(mocks.searchUseQuery.mock.calls[0]?.[1]).not.toHaveProperty(
      "initialData",
    );
  });

  it("issues unseeded queries without a seed (home sections)", () => {
    renderHook(() => useCategoryEvents("open-mics", 12));

    expect(mocks.searchUseQuery.mock.calls[0]?.[1]).not.toHaveProperty(
      "initialData",
    );
    expect(mocks.dbUseQuery.mock.calls[0]?.[1]).not.toHaveProperty(
      "initialData",
    );
  });
});
