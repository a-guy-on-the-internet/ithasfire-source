/**
 * The map's data: the layout read and its glyph file.
 * - an expired glyph link recovers on Retry, through a freshly signed link;
 * - a file with entries but none readable is "failed" and reported, never
 *   "no saved positions";
 * - parsed glyphs survive a List/Map switch and a re-signed link.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  seatPriceRead,
  seatRead,
  sectionRead,
} from "../__fixtures__/seat-price-read";
import { buildSeatPriceModel } from "../seat-price-model";
import { useSeatPriceMapData } from "../useSeatPriceMapData";

const LAYOUT_ID = "layout-1";
const FILE = "https://storage.example.com/layouts/place-1/abc.json";
const expiredUrl = `${FILE}?X-Goog-Signature=old`;
const freshUrl = `${FILE}?X-Goog-Signature=new`;

const layoutRead = vi.hoisted(() => ({
  url: "" as string | null,
  refetch: vi.fn(),
  capture: vi.fn(),
}));

function layoutData() {
  return {
    layout: {
      id: "layout-1",
      name: "Main room",
      seatCount: 1,
      sectionCount: 1,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 100, maxY: 40 },
      sections: [
        {
          sectionId: "A",
          label: "A",
          color: null,
          capacity: 1,
          geometry: {
            polygons: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }]],
          },
          stageAnchor: null,
        },
      ],
      stage: null,
      glyphBlobUrl: layoutRead.url,
    },
  };
}

vi.mock("@/trpc", () => ({
  trpc: {
    placeLayouts: {
      getPublicPlaceLayout: {
        useQuery: () => ({
          data: layoutData(),
          isError: false,
          isFetching: false,
          refetch: layoutRead.refetch,
        }),
      },
    },
  },
}));

vi.mock("@sentry/nextjs", () => ({ captureException: layoutRead.capture }));

const GLYPH = { seatId: "g1", sectionId: "A", label: "A1", position: { x: 10, y: 10 } };

function model() {
  return buildSeatPriceModel(
    seatPriceRead({
      sections: [
        sectionRead({
          seatSectionId: "event-a",
          layoutSectionId: "A",
          placeLayoutId: LAYOUT_ID,
          seats: [seatRead({ id: "seat-1", label: "A1", glyphKey: "g1" })],
        }),
      ],
    }),
  );
}

function respond(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

let queryClient: QueryClient;
const fetchMock = vi.fn<[url: string], Promise<Response>>();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient = new QueryClient();
  fetchMock.mockReset();
  layoutRead.capture.mockReset();
  layoutRead.refetch.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("useSeatPriceMapData", () => {
  it("recovers an expired glyph link on Retry by reading the layout again", async () => {
    layoutRead.url = expiredUrl;
    fetchMock.mockImplementation((url) =>
      url === expiredUrl ? respond({ error: "expired" }, 403) : respond([GLYPH]),
    );
    layoutRead.refetch.mockImplementation(() => {
      layoutRead.url = freshUrl; // the read signs a new link
      return Promise.resolve({ data: layoutData() });
    });

    const m = model();
    const { result } = renderHook(() => useSeatPriceMapData(m), { wrapper });
    await waitFor(() => {
      expect(result.current.status === "ready" && result.current.positions).toBe("failed");
    });
    expect(layoutRead.capture).toHaveBeenCalledTimes(1);

    act(() => {
      if (result.current.status === "ready") result.current.retryPositions();
    });

    await waitFor(() => {
      expect(result.current.status === "ready" && result.current.positions).toBe("exact");
    });
    expect(layoutRead.refetch).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([expiredUrl, freshUrl]);
    // The dead link is not fetched (or reported) again.
    expect(layoutRead.capture).toHaveBeenCalledTimes(1);
    if (result.current.status === "ready") {
      expect(result.current.seats.map((s) => s.seat?.id)).toEqual(["seat-1"]);
    }
  });

  it("calls a file whose entries are all unreadable failed, and reports how many", async () => {
    layoutRead.url = freshUrl;
    fetchMock.mockImplementation(() => respond([{ seatId: 1 }, { nope: true }]));

    const m = model();
    const { result } = renderHook(() => useSeatPriceMapData(m), { wrapper });
    await waitFor(() => {
      expect(result.current.status === "ready" && result.current.positions).toBe("failed");
    });
    expect(layoutRead.capture).toHaveBeenCalledTimes(1);
    expect(layoutRead.capture.mock.calls[0]![1]).toMatchObject({
      extra: { placeLayoutId: LAYOUT_ID, entries: 2 },
    });
  });

  it("calls an empty file 'no saved positions' and reports nothing", async () => {
    layoutRead.url = freshUrl;
    fetchMock.mockImplementation(() => respond([]));

    const m = model();
    const { result } = renderHook(() => useSeatPriceMapData(m), { wrapper });
    await waitFor(() => {
      expect(result.current.status === "ready" && result.current.positions).toBe("none");
    });
    expect(layoutRead.capture).not.toHaveBeenCalled();
  });

  it("keeps the parsed glyphs across an unmount and a re-signed link", async () => {
    layoutRead.url = expiredUrl.replace("old", "first");
    fetchMock.mockImplementation(() => respond([GLYPH]));

    const m = model();
    const first = renderHook(() => useSeatPriceMapData(m), { wrapper });
    await waitFor(() => {
      expect(first.result.current.status === "ready" && first.result.current.positions).toBe(
        "exact",
      );
    });
    first.unmount(); // the organizer switches to the List

    layoutRead.url = freshUrl; // same file, newly signed
    const second = renderHook(() => useSeatPriceMapData(m), { wrapper });
    expect(second.result.current.status === "ready" && second.result.current.positions).toBe(
      "exact",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
