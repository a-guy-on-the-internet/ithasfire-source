import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHasPassed } from "./useHasPassed";

/**
 * The clock behind "this reservation is over": on time when the page is
 * awake, and on the page's first chance when it was not.
 */

const NOW = new Date("2026-10-10T18:00:00.000Z");
const IN_TEN = "2026-10-10T18:10:00.000Z";
const TEN_MINUTES = 10 * 60_000;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** The clock moves and no timer runs: a device asleep. */
const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);
const wake = (how: "visibilitychange" | "focus") =>
  act(() => {
    (how === "focus" ? window : document).dispatchEvent(new Event(how));
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useHasPassed", () => {
  it("turns true when the time is due, not a moment before", async () => {
    const { result } = renderHook(() => useHasPassed(IN_TEN));
    expect(result.current).toBe(false);

    await advance(TEN_MINUTES - 1);
    expect(result.current).toBe(false);

    await advance(1);
    expect(result.current).toBe(true);
  });

  it.each(["visibilitychange", "focus"] as const)(
    "slept through the time: true on %s, without waiting for the timer",
    (how) => {
      const { result } = renderHook(() => useHasPassed(IN_TEN));

      sleep(TEN_MINUTES + 30_000);
      expect(result.current).toBe(false);

      wake(how);
      expect(result.current).toBe(true);
    },
  );

  it("woken early: still false, and still on time afterwards", async () => {
    const { result } = renderHook(() => useHasPassed(IN_TEN));

    sleep(4 * 60_000);
    wake("visibilitychange");
    expect(result.current).toBe(false);

    await advance(6 * 60_000 - 1);
    expect(result.current).toBe(false);
    await advance(1);
    expect(result.current).toBe(true);
  });

  it("a time already behind is passed as soon as the hook has run", async () => {
    const { result } = renderHook(() =>
      useHasPassed("2026-10-10T17:59:00.000Z"),
    );
    await advance(0);
    expect(result.current).toBe(true);
  });

  it("a new time starts unpassed, whatever the last one was", async () => {
    const { result, rerender } = renderHook(
      ({ until }: { until: string | null }) => useHasPassed(until),
      { initialProps: { until: IN_TEN as string | null } },
    );
    await advance(TEN_MINUTES);
    expect(result.current).toBe(true);

    rerender({ until: "2026-10-10T18:25:00.000Z" });
    expect(result.current).toBe(false);

    rerender({ until: null });
    expect(result.current).toBe(false);
  });

  it("no time, or one that cannot be read, never passes", async () => {
    const none = renderHook(() => useHasPassed(null));
    const unreadable = renderHook(() => useHasPassed("not a date"));

    await advance(60 * 60_000);
    wake("focus");

    expect(none.result.current).toBe(false);
    expect(unreadable.result.current).toBe(false);
  });

  it("stops listening when it is gone", () => {
    const { result, unmount } = renderHook(() => useHasPassed(IN_TEN));
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    sleep(TEN_MINUTES * 2);
    wake("visibilitychange");
    expect(result.current).toBe(false);
  });
});
