import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stashSignInAmounts } from "./checkout-url-state";
import { useCheckoutUrlSync } from "./useCheckoutUrlSync";

// ── Mocks ─────────────────────────────────────────────────────────────────
// `useRouter` is spied rather than removed: the point of the first test is
// that this hook no longer reaches for the router at all. vitest.setup.ts
// already aliases `@bprogress/next/app` (the app-wide progress-bar router) to
// `next/navigation`, so mocking this one module covers both import paths.
const useRouterSpy = vi.fn(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

// Mutable so the read-path case can arrive with a sign-in redirect's `a=`.
const urlState = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/events/checkout/austin/us/general/comedy-night",
  useSearchParams: () => new URLSearchParams(urlState.search),
  useRouter: () => useRouterSpy(),
}));

const BASE_ARGS = {
  phase: "held" as const,
  quantities: { "tt-1": 2 },
  promoCodes: [] as readonly string[],
  validTicketTypeIds: ["tt-1"],
  onSeedQuantity: () => {},
};

// Typed off the factory, not `ReturnType<typeof vi.spyOn>` — the bare form
// resolves to `MockInstance<unknown[], unknown>`, which a concrete
// `History["replaceState"]` spy is not assignable to. `apps/web`'s tsconfig
// DOES typecheck test files, so this is a real gate here.
const spyOnReplaceState = () =>
  vi.spyOn(window.history, "replaceState").mockImplementation(() => {});

describe("useCheckoutUrlSync — write path", () => {
  let replaceStateSpy: ReturnType<typeof spyOnReplaceState>;

  beforeEach(() => {
    vi.useFakeTimers();
    useRouterSpy.mockClear();
    // Seed history with NEXT-SHAPED state BEFORE spying, using the real
    // implementation. Without this the test is vacuous: jsdom's
    // `window.history.state` is already `null`, so passing it through is
    // indistinguishable from passing a literal `null` and the regression this
    // file exists to catch sails past. Verified by mutation.
    window.history.replaceState(
      { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"] },
      "",
    );
    expect(window.history.state).not.toBeNull();

    replaceStateSpy = spyOnReplaceState();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    replaceStateSpy.mockRestore();
  });

  it("writes the URL through history.replaceState, never the router", () => {
    renderHook(() => useCheckoutUrlSync(BASE_ARGS));
    vi.advanceTimersByTime(250);

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    // Not a navigation: engaging the App Router here costs a full RSC
    // round-trip on this dynamic route (measured 797ms on Slow 4G) purely to
    // write `?step=…` into the address bar.
    expect(useRouterSpy).not.toHaveBeenCalled();
  });

  it("passes null as the history state, not window.history.state", () => {
    // LOAD-BEARING, and invisible to a reader who does not know Next's
    // internals: `app-router.js` patches `replaceState` and short-circuits to
    // the UNPATCHED implementation when the state handed to it already carries
    // `__NA`. Passing `window.history.state` through — the "obvious" tidy-up —
    // silently leaves usePathname/useSearchParams on a stale URL, with no
    // error and nothing else to catch it.
    renderHook(() => useCheckoutUrlSync(BASE_ARGS));
    vi.advanceTimersByTime(250);

    const [state, unused, url] = replaceStateSpy.mock.calls[0]!;
    expect(state).toBeNull();
    expect(unused).toBe("");
    expect(String(url)).toContain("step=details");
    expect(String(url)).toContain("tt-1");
  });

  it("debounces, and does not rewrite an unchanged URL", () => {
    const { rerender } = renderHook(
      (args: Parameters<typeof useCheckoutUrlSync>[0]) =>
        useCheckoutUrlSync(args),
      { initialProps: BASE_ARGS },
    );

    // Nothing written before the debounce elapses.
    vi.advanceTimersByTime(100);
    expect(replaceStateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);

    // Re-rendering with an equivalent cart must not write again.
    rerender({ ...BASE_ARGS, quantities: { "tt-1": 2 } });
    vi.advanceTimersByTime(250);
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows a history-write failure instead of throwing out of the timer", () => {
    // Safari throws SecurityError past ~100 history writes per 30s. An
    // uncaught throw inside the debounce timer is Sentry noise, and would skip
    // the `lastWritten` bookkeeping on the next line.
    replaceStateSpy.mockImplementation(() => {
      throw new DOMException("rate limited", "SecurityError");
    });

    renderHook(() => useCheckoutUrlSync(BASE_ARGS));
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  });
});

describe("useCheckoutUrlSync — PWYW amounts from the sign-in redirect", () => {
  afterEach(() => {
    urlState.search = "";
    vi.useRealTimers();
  });

  it("seeds amounts this tab stashed, once, for tiers `t=` also selects", () => {
    const token = stashSignInAmounts({ "tt-1": 5000, ghost: 100 })!;
    urlState.search = `t=tt-1%3A1&a=${token}`;
    const onSeedDonationAmount = vi.fn();
    const { rerender } = renderHook(() =>
      useCheckoutUrlSync({ ...BASE_ARGS, onSeedDonationAmount }),
    );
    rerender();
    expect(onSeedDonationAmount).toHaveBeenCalledTimes(1);
    expect(onSeedDonationAmount).toHaveBeenCalledWith("tt-1", 5000);
  });

  it("regression: a crafted `a=` link does NOT pre-fill an amount", () => {
    // Round-1 wire format (amounts in the URL) — used to seed $9,999.99.
    urlState.search = "t=tt-1%3A1&a=tt-1%3A999999";
    const onSeedDonationAmount = vi.fn();
    renderHook(() => useCheckoutUrlSync({ ...BASE_ARGS, onSeedDonationAmount }));
    expect(onSeedDonationAmount).not.toHaveBeenCalled();
  });

  it("a stashed amount for a tier `t=` does not select is ignored", () => {
    const token = stashSignInAmounts({ "tt-1": 5000 })!;
    urlState.search = `a=${token}`;
    const onSeedDonationAmount = vi.fn();
    renderHook(() => useCheckoutUrlSync({ ...BASE_ARGS, onSeedDonationAmount }));
    expect(onSeedDonationAmount).not.toHaveBeenCalled();
  });

  it("the write path strips `a` — nothing lingers in the address bar", () => {
    vi.useFakeTimers();
    urlState.search = "t=tt-1%3A1&a=some-token";
    const spy = spyOnReplaceState();
    renderHook(() => useCheckoutUrlSync(BASE_ARGS));
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![2])).not.toContain("a=");
    spy.mockRestore();
  });
});

describe("useCheckoutUrlSync — the confirmed order", () => {
  const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  afterEach(() => {
    urlState.search = "";
    vi.useRealTimers();
  });

  it("a confirmed phase writes step=confirmed&order=… with no t/p", () => {
    vi.useFakeTimers();
    // The bug: the cart's quantities and codes outlived the purchase, so a
    // reload showed the picker one click from buying again.
    urlState.search = "step=payment&t=tt-1%3A2&p=EARLYBIRD";
    const spy = spyOnReplaceState();
    renderHook(() =>
      useCheckoutUrlSync({
        ...BASE_ARGS,
        phase: "confirmed",
        orderId: ORDER_ID,
        promoCodes: ["EARLYBIRD"],
      }),
    );
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(1);
    const [state, , url] = spy.mock.calls[0]!;
    expect(state).toBeNull();
    const params = new URL(String(url), "https://x.test").searchParams;
    expect(params.get("step")).toBe("confirmed");
    expect(params.get("order")).toBe(ORDER_ID);
    expect(params.has("t")).toBe(false);
    expect(params.has("p")).toBe(false);
    spy.mockRestore();
  });

  it("a mount on step=confirmed&order= does NOT seed quantities", () => {
    const token = stashSignInAmounts({ "tt-1": 5000 })!;
    urlState.search = `step=confirmed&order=${ORDER_ID}&t=tt-1%3A2&a=${token}`;
    const onSeedQuantity = vi.fn();
    const onSeedDonationAmount = vi.fn();
    renderHook(() =>
      useCheckoutUrlSync({
        ...BASE_ARGS,
        phase: "confirmed",
        orderId: ORDER_ID,
        onSeedQuantity,
        onSeedDonationAmount,
      }),
    );
    expect(onSeedQuantity).not.toHaveBeenCalled();
    expect(onSeedDonationAmount).not.toHaveBeenCalled();
  });

  it("a restore that falls back strips step=confirmed&order= from the URL", () => {
    vi.useFakeTimers();
    urlState.search = `step=confirmed&order=${ORDER_ID}&ref=abc`;
    const spy = spyOnReplaceState();
    const { rerender } = renderHook(
      (args: Parameters<typeof useCheckoutUrlSync>[0]) =>
        useCheckoutUrlSync(args),
      {
        initialProps: {
          ...BASE_ARGS,
          phase: "confirmed",
          orderId: ORDER_ID,
          quantities: {},
        } as Parameters<typeof useCheckoutUrlSync>[0],
      },
    );
    // The fallback: the empty picker, no order (RESTORED_CONFIRMATION_FAILED).
    rerender({ ...BASE_ARGS, phase: "selecting", orderId: null, quantities: {} });
    vi.advanceTimersByTime(250);
    const url = String(spy.mock.calls.at(-1)![2]);
    const params = new URL(url, "https://x.test").searchParams;
    expect(params.has("order")).toBe(false);
    expect(params.get("step")).toBe("selecting");
    expect(params.has("t")).toBe(false);
    expect(params.get("ref")).toBe("abc");
    spy.mockRestore();
  });

  it("step=confirmed with an invalid order id seeds the cart as usual", () => {
    urlState.search = "step=confirmed&order=nope&t=tt-1%3A2";
    const onSeedQuantity = vi.fn();
    renderHook(() => useCheckoutUrlSync({ ...BASE_ARGS, onSeedQuantity }));
    expect(onSeedQuantity).toHaveBeenCalledWith("tt-1", 2);
  });
});
