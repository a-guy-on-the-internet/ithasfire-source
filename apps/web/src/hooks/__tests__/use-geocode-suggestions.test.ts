import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGeocodeSuggestions } from "../use-geocode-suggestions";
import type { GeocodingResult } from "@/lib/maps/geocoding";

/**
 * The debounce/stale-response machinery behind every address suggestion box in
 * the app (checkout billing, embed checkout, the admin place editor).
 *
 * These are timing and ordering assertions, so they run on fake timers and
 * resolve the provider promises by hand — a `waitFor` here would only prove
 * "eventually", which is exactly the property a race bug still satisfies.
 */
const mocks = vi.hoisted(() => ({
  forwardGeocode: vi.fn(),
  autocompleteAddress: vi.fn(),
}));

vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: mocks.forwardGeocode,
  autocompleteAddress: mocks.autocompleteAddress,
}));

const result = (label: string): GeocodingResult => ({
  lat: 1,
  lng: 2,
  formattedAddress: label,
  name: null,
  streetLine: label,
  locality: "City",
  region: "State",
  regionCode: "ST",
  countryCode: "US",
  postalCode: "00000",
});

describe("useGeocodeSuggestions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.forwardGeocode.mockReset().mockResolvedValue([]);
    mocks.autocompleteAddress.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Debounce (NFR-002) ──────────────────────────────────────────────────

  it("fires ONE request for a burst of keystrokes, and only after the window", async () => {
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );

    act(() => {
      for (const q of ["12", "123", "123 ", "123 M", "123 Ma", "123 Mai"]) {
        hook.current.feed(q);
      }
    });

    // Mid-window: nothing has gone out yet.
    await flushAfter(299);
    expect(mocks.forwardGeocode).not.toHaveBeenCalled();

    await flushAfter(1);
    expect(mocks.forwardGeocode).toHaveBeenCalledTimes(1);
    expect(mocks.forwardGeocode.mock.calls[0]![0]).toBe("123 Mai");
  });

  it("never fires below the minimum query length", async () => {
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 4, debounceMs: 300 }),
    );

    act(() => hook.current.feed("6 A"));
    await flushAfter(1000);

    expect(mocks.forwardGeocode).not.toHaveBeenCalled();
    expect(hook.current.showDropdown).toBe(false);
  });

  // ── Stale-response race ─────────────────────────────────────────────────

  it("ignores a SLOW earlier response that lands after a newer one", async () => {
    let resolveFirst: (v: GeocodingResult[]) => void = () => {};
    let resolveSecond: (v: GeocodingResult[]) => void = () => {};
    mocks.forwardGeocode
      .mockImplementationOnce(
        () => new Promise((res) => (resolveFirst = res)),
      )
      .mockImplementationOnce(
        () => new Promise((res) => (resolveSecond = res)),
      );

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );

    act(() => hook.current.feed("first query"));
    await flushAfter(300);

    act(() => hook.current.feed("second query"));
    await flushAfter(300);

    expect(mocks.forwardGeocode).toHaveBeenCalledTimes(2);

    // The NEWER request answers first…
    await act(async () => {
      resolveSecond([result("SECOND")]);
      await Promise.resolve();
    });
    expect(hook.current.suggestions.map((s) => s.formattedAddress)).toEqual([
      "SECOND",
    ]);

    // …and the older one, arriving late, must not clobber it.
    await act(async () => {
      resolveFirst([result("FIRST")]);
      await Promise.resolve();
    });
    expect(hook.current.suggestions.map((s) => s.formattedAddress)).toEqual([
      "SECOND",
    ]);
    expect(hook.current.settledQuery).toBe("second query");
  });

  it("aborts the superseded request rather than only ignoring it", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    mocks.forwardGeocode.mockImplementation(
      (_q: string, opts?: { signal?: AbortSignal }) => {
        signals.push(opts?.signal);
        return new Promise(() => {});
      },
    );

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );

    act(() => hook.current.feed("one"));
    await flushAfter(300);
    act(() => hook.current.feed("two"));
    await flushAfter(300);

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it("does not let an in-flight response repopulate a query cleared below the minimum", async () => {
    // The regression: deleting back to an empty field cleared `suggestions`,
    // but the already-dispatched request still matched the live request id, so
    // its late response reopened the listbox over an emptied input.
    let resolveFirst: (v: GeocodingResult[]) => void = () => {};
    mocks.forwardGeocode.mockImplementationOnce(
      () => new Promise((res) => (resolveFirst = res)),
    );

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 3, debounceMs: 300 }),
    );

    act(() => hook.current.feed("123 Main"));
    await flushAfter(300);

    act(() => hook.current.feed(""));
    expect(hook.current.showDropdown).toBe(false);

    await act(async () => {
      resolveFirst([result("LATE")]);
      await Promise.resolve();
    });

    expect(hook.current.suggestions).toEqual([]);
    expect(hook.current.showDropdown).toBe(false);
  });

  // ── Endpoint selection ──────────────────────────────────────────────────

  it("defaults to the forward-geocode endpoint (existing callers unchanged)", async () => {
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2 }),
    );
    act(() => hook.current.feed("123 Main"));
    await flushAfter(350);

    expect(mocks.forwardGeocode).toHaveBeenCalledTimes(1);
    expect(mocks.autocompleteAddress).not.toHaveBeenCalled();
  });

  it("routes to the autocomplete endpoint when asked", async () => {
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ mode: "autocomplete", minQueryLength: 2 }),
    );
    act(() => hook.current.feed("123 Main"));
    await flushAfter(350);

    expect(mocks.autocompleteAddress).toHaveBeenCalledTimes(1);
    expect(mocks.forwardGeocode).not.toHaveBeenCalled();
  });

  // ── Failure surface ─────────────────────────────────────────────────────

  it("reports a provider failure distinctly from an empty result set", async () => {
    mocks.forwardGeocode.mockRejectedValueOnce(new Error("503"));

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("123 Main"));
    await flushAfter(300);

    expect(hook.current.error).toBe(true);
    expect(hook.current.suggestions).toEqual([]);
    expect(hook.current.settledQuery).toBe("123 Main");
  });

  it("does NOT report an error for our own abort", async () => {
    // A real DOMException, because that is what an aborted `fetch` throws and
    // what `isAbortError` narrows on. A hand-rolled `Error` with the same
    // `name` would test a shape the runtime never produces.
    mocks.forwardGeocode.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("123 Main"));
    await flushAfter(300);

    expect(hook.current.error).toBe(false);
  });

  it("DOES report an error when the provider times out (TimeoutError is not our abort)", async () => {
    mocks.forwardGeocode.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError"),
    );

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("Corner Bar Nashville TN"));
    await flushAfter(300);

    expect(hook.current.error).toBe(true);
    expect(hook.current.isFetching).toBe(false);
    expect(hook.current.settledQuery).toBe("Corner Bar Nashville TN");
  });

  it("Escape closes a status-only popup and is consumed", async () => {
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("nowhere at all"));
    await flushAfter(300);
    expect(hook.current.suggestions).toEqual([]);
    expect(hook.current.showDropdown).toBe(true);

    let handled = false;
    act(() => {
      handled = hook.current.handleKeyDown(
        { key: "Escape", preventDefault: () => {} } as never,
        () => {},
      );
    });
    expect(handled).toBe(true);
    expect(hook.current.showDropdown).toBe(false);
  });

  it("keeps the no-results status through the next keystroke's re-fetch, clears on results", async () => {
    mocks.forwardGeocode.mockResolvedValueOnce([]);
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("nowhere"));
    await flushAfter(300);
    expect(hook.current.status).toBe("no-results");

    // Next keystroke: request pending, hint must NOT blink out.
    mocks.forwardGeocode.mockReturnValueOnce(new Promise(() => {}));
    act(() => hook.current.feed("nowhere 1"));
    expect(hook.current.isFetching).toBe(true);
    expect(hook.current.status).toBe("no-results");
    await flushAfter(300);
    expect(hook.current.status).toBe("no-results");

    mocks.forwardGeocode.mockResolvedValueOnce([result("1 Main")]);
    act(() => hook.current.feed("1 Main"));
    await flushAfter(300);
    expect(hook.current.status).toBeNull();
  });

  it("keeps the error status while re-fetching; clears on close and below min length", async () => {
    mocks.forwardGeocode.mockRejectedValueOnce(new Error("503"));
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("abc"));
    await flushAfter(300);
    expect(hook.current.status).toBe("error");
    act(() => hook.current.feed("abcd"));
    expect(hook.current.status).toBe("error");
    act(() => hook.current.close());
    expect(hook.current.status).toBeNull();

    mocks.forwardGeocode.mockResolvedValueOnce([]);
    act(() => hook.current.feed("abc"));
    await flushAfter(300);
    expect(hook.current.status).toBe("no-results");
    act(() => hook.current.feed("a"));
    expect(hook.current.status).toBeNull();
  });

  it("Tab with no rows closes the popup but is not consumed", async () => {
    mocks.forwardGeocode.mockReturnValueOnce(new Promise(() => {}));
    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("slow query"));
    await flushAfter(300);
    expect(hook.current.showDropdown).toBe(true);
    let handled = true;
    act(() => {
      handled = hook.current.handleKeyDown(
        { key: "Tab", preventDefault: () => {} } as never,
        () => {},
      );
    });
    expect(handled).toBe(false);
    expect(hook.current.showDropdown).toBe(false);
  });

  it("settles a zero-result response as searched-but-empty, not an error", async () => {
    mocks.forwardGeocode.mockResolvedValueOnce([]);

    const { result: hook } = renderHook(() =>
      useGeocodeSuggestions({ minQueryLength: 2, debounceMs: 300 }),
    );
    act(() => hook.current.feed("nowhere at all"));
    await flushAfter(300);

    expect(hook.current.settledQuery).toBe("nowhere at all");
    expect(hook.current.error).toBe(false);
    expect(hook.current.suggestions).toEqual([]);
  });
});

/**
 * Advance the fake clock past the debounce and drain the promise chain.
 *
 * `waitFor` is unusable here: it schedules its own timers, which the fake
 * clock owns, so it never gets a chance to re-check and just times out. The
 * chain is `then → catch → finally`, so a handful of microtask turns settles
 * it deterministically.
 */
async function flushAfter(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
