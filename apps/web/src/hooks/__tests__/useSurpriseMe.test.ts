import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        getRandomEvent: {
          fetch: fetchMock,
        },
      },
    }),
  },
}));

// Imported after the mocks so the hook picks up the mocked modules.
import { useSurpriseMe } from "../useSurpriseMe";

const eventFixture = (overrides?: Partial<{ id: string; slug: string }>) => ({
  id: overrides?.id ?? "evt-1",
  slug: overrides?.slug ?? "neon-nights",
  title: "Neon Nights",
  startsAt: new Date("2026-07-01T20:00:00.000Z"),
  endsAt: null,
  status: "PUBLISHED" as const,
  org: null,
  place: null,
  location: { lat: null, lng: null, addressText: null, distanceKm: null },
  source: "fallback" as const,
  algo: {
    radiusKm: null,
    windowFrom: new Date(),
    windowTo: new Date(),
    qPresent: false,
    hadGeoIndex: false,
  },
});

describe("useSurpriseMe", () => {
  beforeEach(() => {
    pushMock.mockReset();
    fetchMock.mockReset();
  });

  it("always sends publishedOnly: true and navigates to the event slug", async () => {
    fetchMock.mockResolvedValueOnce(eventFixture({ slug: "neon-nights" }));

    const { result } = renderHook(() => useSurpriseMe());

    let outcome: Awaited<ReturnType<typeof result.current.roll>> | undefined;
    await act(async () => {
      outcome = await result.current.roll();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toEqual({ publishedOnly: true });
    // Every roll must bypass the QueryClient's staleTime so it hits the server.
    expect(fetchMock.mock.calls[0][1]).toEqual({ staleTime: 0, gcTime: 0 });
    expect(pushMock).toHaveBeenCalledWith("/events/neon-nights");
    expect(outcome).toEqual({
      status: "navigated",
      eventId: "evt-1",
      slug: "neon-nights",
    });
  });

  it("maps friendly filters onto the getRandomEvent input", async () => {
    fetchMock.mockResolvedValueOnce(eventFixture());

    const { result } = renderHook(() => useSurpriseMe());

    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-07T23:59:59.999Z");
    await act(async () => {
      await result.current.roll({
        near: { lat: 40.7, lng: -74, radiusKm: 25 },
        q: "  jazz  ",
        window: { from, to },
      });
    });

    expect(fetchMock.mock.calls[0][0]).toEqual({
      publishedOnly: true,
      near: { lat: 40.7, lng: -74, radiusKm: 25 },
      q: "jazz",
      window: { from, to },
    });
  });

  it("excludes the previously shown event on a re-roll", async () => {
    fetchMock
      .mockResolvedValueOnce(eventFixture({ id: "evt-1", slug: "first" }))
      .mockResolvedValueOnce(eventFixture({ id: "evt-2", slug: "second" }));

    const { result } = renderHook(() => useSurpriseMe());

    await act(async () => {
      await result.current.roll();
    });
    await act(async () => {
      await result.current.roll();
    });

    // First roll has no exclusions; second excludes the first event id.
    expect(fetchMock.mock.calls[0][0]).toEqual({ publishedOnly: true });
    expect(fetchMock.mock.calls[1][0]).toEqual({
      publishedOnly: true,
      excludeEventIds: ["evt-1"],
    });
    expect(pushMock).toHaveBeenLastCalledWith("/events/second");
  });

  it("returns no-event (without navigating) when the event has no slug", async () => {
    fetchMock.mockResolvedValueOnce({ ...eventFixture(), slug: null });

    const { result } = renderHook(() => useSurpriseMe());

    let outcome: Awaited<ReturnType<typeof result.current.roll>> | undefined;
    await act(async () => {
      outcome = await result.current.roll();
    });

    expect(outcome).toEqual({ status: "no-event" });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("maps a NO_RANDOM_EVENT_AVAILABLE error to the no-event outcome", async () => {
    fetchMock.mockRejectedValueOnce({
      message: "NO_RANDOM_EVENT_AVAILABLE",
      data: { code: "NOT_FOUND" },
    });

    const { result } = renderHook(() => useSurpriseMe());

    let outcome: Awaited<ReturnType<typeof result.current.roll>> | undefined;
    await act(async () => {
      outcome = await result.current.roll();
    });

    expect(outcome).toEqual({ status: "no-event" });
    expect(pushMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("surfaces unexpected errors via the error outcome and state", async () => {
    const boom = new Error("network down");
    fetchMock.mockRejectedValueOnce(boom);

    const { result } = renderHook(() => useSurpriseMe());

    let outcome: Awaited<ReturnType<typeof result.current.roll>> | undefined;
    await act(async () => {
      outcome = await result.current.roll();
    });

    expect(outcome).toEqual({ status: "error", error: boom });
    expect(result.current.error).toBe(boom);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("resetHistory clears the remembered exclusion and still hits the server", async () => {
    fetchMock
      .mockResolvedValueOnce(eventFixture({ id: "evt-1", slug: "first" }))
      .mockResolvedValueOnce(eventFixture({ id: "evt-9", slug: "ninth" }));

    const { result } = renderHook(() => useSurpriseMe());

    await act(async () => {
      await result.current.roll();
    });
    act(() => {
      result.current.resetHistory();
    });
    await act(async () => {
      await result.current.roll();
    });

    // After reset, the second roll carries no exclusions — and crucially still
    // performs a fresh, cache-busting fetch rather than replaying the cached
    // event (the bug this guards against: a repeated query key served stale).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toEqual({ publishedOnly: true });
    expect(fetchMock.mock.calls[1][1]).toEqual({ staleTime: 0, gcTime: 0 });
  });
});
