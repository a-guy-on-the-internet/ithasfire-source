import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("suggestion lookups time out", () => {
  const originalKey = process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY;
  let fetchMode: "hang" | "genericAbort" | "ok" = "hang";
  let features: unknown[] = [];
  beforeEach(() => {
    fetchMode = "hang";
    features = [];
    vi.useFakeTimers();
    vi.resetModules();
    process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY = "test-key";
    // A fetch that never answers, and honours its signal like the real one.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            if (fetchMode === "ok") {
              resolve({ ok: true, json: async () => ({ features }) });
              return;
            }
            const s = init?.signal;
            const fail = () =>
              reject(
                fetchMode === "genericAbort"
                  ? new DOMException("The operation was aborted.", "AbortError")
                  : (s!.reason as DOMException),
              );
            if (s?.aborted) fail();
            else s?.addEventListener("abort", fail);
          }),
      ),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY;
    else process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY = originalKey;
  });

  it("rejects with a TimeoutError (not an AbortError) when the provider hangs", async () => {
    const { forwardGeocode } = await import("./geocoding");
    const p = forwardGeocode("Corner Bar Nashville TN");
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8000);
    const err = (await settled) as DOMException;
    expect(err.name).toBe("TimeoutError");
  });

  it("still rejects with an AbortError when the caller aborts first", async () => {
    const { autocompleteAddress } = await import("./geocoding");
    const ctl = new AbortController();
    const settled = autocompleteAddress("12 Main", { signal: ctl.signal }).catch(
      (e: unknown) => e,
    );
    ctl.abort();
    const err = (await settled) as DOMException;
    expect(err.name).toBe("AbortError");
  });

  it("reads a generic AbortError after the deadline as a TimeoutError", async () => {
    fetchMode = "genericAbort";
    const { forwardGeocode } = await import("./geocoding");
    const settled = forwardGeocode("Corner Bar").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8000);
    expect(((await settled) as DOMException).name).toBe("TimeoutError");
  });

  it("rejects with AbortError for a caller signal that is already aborted", async () => {
    const { forwardGeocode } = await import("./geocoding");
    const ctl = new AbortController();
    ctl.abort();
    const err = (await forwardGeocode("x", { signal: ctl.signal }).catch(
      (e: unknown) => e,
    )) as DOMException;
    expect(err.name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind after a successful lookup", async () => {
    fetchMode = "ok";
    const { forwardGeocode } = await import("./geocoding");
    await expect(forwardGeocode("12 Main")).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a provider name that only repeats the street, street line or city", async () => {
    fetchMode = "ok";
    const f = (props: Record<string, unknown>) => ({ properties: props });
    features = [
      f({ name: "Broadway", street: "Broadway", city: "Nashville", formatted: "a" }),
      f({ name: "2190 nolensville pike", street: "Nolensville Pike", housenumber: "2190", formatted: "b" }),
      f({ name: "NASHVILLE", city: "Nashville", formatted: "c" }),
      f({ name: "Red Bicycle", street: "Nolensville Pike", housenumber: "2190", city: "Nashville", formatted: "d" }),
    ];
    const { forwardGeocode } = await import("./geocoding");
    const out = await forwardGeocode("x");
    expect(out.map((r) => r.name)).toEqual([null, null, null, "Red Bicycle"]);
  });
});
