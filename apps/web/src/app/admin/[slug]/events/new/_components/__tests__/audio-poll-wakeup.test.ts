/**
 * The `resolveAudio` polling LIFECYCLE, driven through a real React Query
 * observer rather than the pure interval helper.
 *
 * `audio-poll-interval.test.ts` pins the ramp arithmetic. What it cannot see
 * — and what actually shipped broken — is React Query's own semantics around
 * a `refetchInterval` callback that returns `false`: the interval is only
 * recomputed on a query STATE change (`QueryObserver#onQueryUpdate` →
 * `#updateTimers`), so a query that parks with nothing pending stays parked
 * no matter how much wall time passes. That is why inserting an audio node
 * client-side is not enough, and why `useEventAudioUpload` must invalidate.
 *
 * This spec walks the whole arc against the shipped `nextAudioPollInterval`:
 *   parked with no audio → invalidate wakes it → ramps while pending →
 *   parks again, for good, once everything is terminal.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/trpc", () => ({ trpc: {} }));

const { nextAudioPollInterval } = await import("../useEventMediaMaps");

type Item = { status: string; createdAt: Date };

const QUERY_KEY = [
  ["events", "resolveAudio"],
  { input: { eventId: "evt_1" }, type: "query" },
] as const;

let queryClient: QueryClient;
let unsubscribe: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
});

afterEach(() => {
  unsubscribe?.();
  queryClient?.clear();
  vi.useRealTimers();
});

/**
 * Stands up the same observer shape `useEventMediaMaps` creates: one query,
 * `refetchInterval` delegated to the shipped ramp helper.
 */
function startPolling(readItems: () => Item[]) {
  const fetchSpy = vi.fn(() => Promise.resolve({ items: readItems() }));

  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  const observer = new QueryObserver(queryClient, {
    queryKey: QUERY_KEY as unknown as unknown[],
    queryFn: fetchSpy,
    refetchInterval: (query) =>
      nextAudioPollInterval(
        query.state.data as { items: Item[] } | undefined,
        Date.now(),
      ),
  });

  unsubscribe = observer.subscribe(() => {});
  return { fetchSpy };
}

describe("resolveAudio polling lifecycle", () => {
  it("parks with no audio, wakes on invalidate, ramps, then parks for good", async () => {
    let items: Item[] = [];
    const { fetchSpy } = startPolling(() => items);

    // ─── Mount: no audio at all ───────────────────────────────────────────
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Parked. Five minutes of wall time buys exactly nothing — this is the
    // measured defect: 379s after an upload, zero further requests.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // ─── An upload finalizes; the hook invalidates ────────────────────────
    items = [{ status: "UPLOADED", createdAt: new Date() }];
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY as never });
    await vi.advanceTimersByTimeAsync(0);

    // The invalidation is the state change that restarts the timer.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // ─── Ramp: 2s while the pending item is young ─────────────────────────
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // ─── Terminal: the transcode settles (FAILED is terminal too) ─────────
    items = [{ status: "FAILED", createdAt: new Date() }];
    await vi.advanceTimersByTimeAsync(2_000);
    const callsAtTerminal = fetchSpy.mock.calls.length;
    expect(callsAtTerminal).toBe(5);

    // …and stays parked. The wake-up must not become unbounded polling.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchSpy).toHaveBeenCalledTimes(callsAtTerminal);
  });

  it("parks after a READY transcode and does not resume on its own", async () => {
    let items: Item[] = [{ status: "TRANSCODING", createdAt: new Date() }];
    const { fetchSpy } = startPolling(() => items);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    items = [{ status: "READY", createdAt: new Date() }];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
