import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCyclingPlaceholder } from "../useCyclingPlaceholder";

// ── matchMedia mock ────────────────────────────────────────────────────────
// jsdom has no matchMedia. We install a controllable stub so we can flip the
// reduced-motion preference per test.

function installMatchMedia(reducedMotion: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: reducedMotion,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    // Legacy API (unused here, present for completeness).
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return mql;
}

const VALUES = ["Search events…", "Search venues…", "Search people…"];

describe("useCyclingPlaceholder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts on the first value and advances on the interval, looping", () => {
    installMatchMedia(false);
    const { result } = renderHook(() =>
      useCyclingPlaceholder(VALUES, { intervalMs: 2200 }),
    );

    // First client render is deterministic — index 0, no hydration mismatch.
    expect(result.current).toBe("Search events…");

    act(() => { vi.advanceTimersByTime(2200); });
    expect(result.current).toBe("Search venues…");

    act(() => { vi.advanceTimersByTime(2200); });
    expect(result.current).toBe("Search people…");

    // Loops back to the start.
    act(() => { vi.advanceTimersByTime(2200); });
    expect(result.current).toBe("Search events…");
  });

  it("defaults to a 2200ms interval when no options are passed", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useCyclingPlaceholder(VALUES));

    expect(result.current).toBe("Search events…");
    // Just short of the default interval — no advance yet.
    act(() => { vi.advanceTimersByTime(2199); });
    expect(result.current).toBe("Search events…");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe("Search venues…");
  });

  it("stays put when there is a single value", () => {
    installMatchMedia(false);
    const { result } = renderHook(() =>
      useCyclingPlaceholder(["Search events…"], { intervalMs: 100 }),
    );

    expect(result.current).toBe("Search events…");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe("Search events…");
  });

  it("returns an empty string for an empty array", () => {
    installMatchMedia(false);
    const { result } = renderHook(() =>
      useCyclingPlaceholder([], { intervalMs: 100 }),
    );

    expect(result.current).toBe("");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe("");
  });

  it("does not animate under reduced motion — parks on the first value", () => {
    installMatchMedia(true);
    const { result } = renderHook(() =>
      useCyclingPlaceholder(VALUES, { intervalMs: 100 }),
    );

    expect(result.current).toBe("Search events…");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe("Search events…");
  });

  it("clears the interval on unmount (no post-unmount timers)", () => {
    installMatchMedia(false);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const { unmount } = renderHook(() =>
      useCyclingPlaceholder(VALUES, { intervalMs: 100 }),
    );

    unmount();
    expect(clearSpy).toHaveBeenCalled();

    // Advancing timers after unmount must not throw / update state.
    expect(() => act(() => { vi.advanceTimersByTime(1000); })).not.toThrow();
  });
});
