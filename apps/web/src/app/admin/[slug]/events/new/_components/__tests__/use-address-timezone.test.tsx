/**
 * The plumbing around the freeform-address zone lookup: when it asks, when it
 * refuses to, and that simply LOADING an event asks nothing.
 *
 * The adoption rule itself is pure and pinned in `event-timezone.test.ts`;
 * what can only be caught here is the ordering — priming, debouncing, and the
 * per-point gate that keeps one map drag from becoming two requests.
 *
 * MOCKS (enumerated deliberately; a catch-all Proxy that answers `then` turns
 * the module namespace into a thenable and hangs vitest):
 *   - `@/trpc`: `trpc.useUtils()` → an object with exactly the one procedure
 *     this hook calls, backed by a `vi.fn`. Nothing else is stubbed —
 *     `event-timezone.ts` runs for real, so the "unknown zone is refused" and
 *     "null keeps the zone" paths are the shipped ones.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveTimezoneFetch = vi.fn<
  [{ lat: number; lng: number }, unknown?],
  Promise<{ timezone: string | null }>
>();

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: { resolveTimezone: { fetch: resolveTimezoneFetch } },
    }),
  },
}));

const { useAddressTimezoneAdoption, ADDRESS_TIMEZONE_DEBOUNCE_MS } =
  await import("../use-address-timezone");
const { coordinateKey } = await import("../event-timezone");

const NASHVILLE = { lat: 36.1627, lng: -86.7816 };
const BROOKLYN = { lat: 40.7182, lng: -73.9884 };

type Props = {
  enabled: boolean;
  coordinates: { lat: number; lng: number } | null;
  currentTimezone: string;
};

/** Advance past the debounce and let the fetch promise settle. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(ADDRESS_TIMEZONE_DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setup(initial: Props) {
  const onAdopt = vi.fn();
  const view = renderHook(
    (props: Props) =>
      useAddressTimezoneAdoption({
        enabled: props.enabled,
        coordinates: props.coordinates,
        currentTimezone: props.currentTimezone,
        onAdopt,
      }),
    { initialProps: initial },
  );
  return { ...view, onAdopt };
}

beforeEach(() => {
  vi.useFakeTimers();
  resolveTimezoneFetch.mockReset();
  resolveTimezoneFetch.mockResolvedValue({ timezone: "America/New_York" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAddressTimezoneAdoption", () => {
  it("adopts the zone once a freeform address acquires coordinates", async () => {
    const { rerender, onAdopt } = setup({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/Chicago",
    });

    rerender({
      enabled: true,
      coordinates: BROOKLYN,
      currentTimezone: "America/Chicago",
    });
    await settle();

    expect(resolveTimezoneFetch).toHaveBeenCalledTimes(1);
    expect(resolveTimezoneFetch.mock.calls[0]?.[0]).toEqual(BROOKLYN);
    expect(onAdopt).toHaveBeenCalledWith({
      source: { kind: "address" },
      timezone: "America/New_York",
      previousTimezone: "America/Chicago",
    });
  });

  it("asks nothing when a SAVED event hydrates with coordinates already in place", async () => {
    // The regression that matters: the stored `timezone` is authoritative on a
    // saved event, and re-deriving one from its address would move the show.
    // The caller keeps `enabled` false until hydration lands, so the first
    // enabled render is the BASELINE, not a change.
    const { onAdopt } = setup({
      enabled: false,
      coordinates: BROOKLYN,
      currentTimezone: "America/Chicago",
    });

    await settle();

    expect(resolveTimezoneFetch).not.toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("asks nothing when hydration flips enabled on with coordinates in the same commit", async () => {
    const { rerender, onAdopt } = setup({
      enabled: false,
      coordinates: BROOKLYN,
      currentTimezone: "America/Chicago",
    });

    rerender({
      enabled: true,
      coordinates: BROOKLYN,
      currentTimezone: "America/Chicago",
    });
    await settle();

    expect(resolveTimezoneFetch).not.toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("does NOT re-request when the same coordinates arrive again", async () => {
    // One map drag calls back twice with the same point: once so the pin
    // tracks, once when the reverse-geocoded address lands.
    const { rerender, onAdopt } = setup({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/Chicago",
    });

    rerender({
      enabled: true,
      coordinates: BROOKLYN,
      currentTimezone: "America/Chicago",
    });
    await settle();
    expect(resolveTimezoneFetch).toHaveBeenCalledTimes(1);

    // Same point, fresh object identity — exactly what the geocode callback
    // produces.
    rerender({
      enabled: true,
      coordinates: { ...BROOKLYN },
      currentTimezone: "America/New_York",
    });
    await settle();

    expect(resolveTimezoneFetch).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of coordinate changes into ONE request for the point that stuck", async () => {
    const { rerender } = setup({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/Chicago",
    });

    // Three settles of the pin inside the debounce window.
    for (const next of [
      { lat: 40.7, lng: -73.9 },
      { lat: 40.71, lng: -73.98 },
      BROOKLYN,
    ]) {
      rerender({
        enabled: true,
        coordinates: next,
        currentTimezone: "America/Chicago",
      });
      act(() => {
        vi.advanceTimersByTime(ADDRESS_TIMEZONE_DEBOUNCE_MS - 50);
      });
    }
    await settle();

    expect(resolveTimezoneFetch).toHaveBeenCalledTimes(1);
    expect(resolveTimezoneFetch.mock.calls[0]?.[0]).toEqual(BROOKLYN);
  });

  it("keeps the zone when the lookup reports it does not know one", async () => {
    resolveTimezoneFetch.mockResolvedValue({ timezone: null });
    const { rerender, onAdopt } = setup({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/Chicago",
    });

    rerender({
      enabled: true,
      coordinates: { lat: 0, lng: -160 },
      currentTimezone: "America/Chicago",
    });
    await settle();

    expect(resolveTimezoneFetch).toHaveBeenCalledTimes(1);
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("keeps the zone when the lookup fails outright", async () => {
    resolveTimezoneFetch.mockRejectedValue(new Error("offline"));
    const { rerender, onAdopt } = setup({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/Chicago",
    });

    rerender({
      enabled: true,
      coordinates: BROOKLYN,
      currentTimezone: "America/Chicago",
    });
    await settle();

    // Nothing the organiser did went wrong, and the server re-derives its own
    // zone on save — so this is silent, not an error banner.
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("keeps the zone when the organiser CLEARS the address", async () => {
    const { rerender, onAdopt } = setup({
      enabled: true,
      coordinates: BROOKLYN,
      currentTimezone: "America/New_York",
    });
    // Baseline primed; now clear it.
    rerender({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/New_York",
    });
    await settle();

    expect(resolveTimezoneFetch).not.toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("re-primes rather than adopting when the organiser switches back from a venue to the stashed address", async () => {
    // EventBuilder restores the stashed freeform address on mode change. The
    // zone the venue supplied must survive that: clearing a venue never
    // reverts.
    const { rerender, onAdopt } = setup({
      enabled: true,
      coordinates: NASHVILLE,
      currentTimezone: "America/Chicago",
    });

    // → venue mode (hook parks), then back to the SAME stashed address.
    rerender({
      enabled: false,
      coordinates: null,
      currentTimezone: "America/New_York",
    });
    rerender({
      enabled: true,
      coordinates: NASHVILLE,
      currentTimezone: "America/New_York",
    });
    await settle();

    expect(resolveTimezoneFetch).not.toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("asks nothing for coordinates the endpoint would reject", async () => {
    const { rerender } = setup({
      enabled: true,
      coordinates: null,
      currentTimezone: "America/Chicago",
    });

    rerender({
      enabled: true,
      coordinates: { lat: 991, lng: -73.9884 },
      currentTimezone: "America/Chicago",
    });
    await settle();

    expect(coordinateKey({ lat: 991, lng: -73.9884 })).toBeNull();
    expect(resolveTimezoneFetch).not.toHaveBeenCalled();
  });
});
