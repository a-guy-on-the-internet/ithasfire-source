import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth-client", () => ({ authClient: {} }));
vi.mock("@/config/env.public", () => ({
  publicRuntimeEnv: { apiBaseUrl: "https://api.example.test" },
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => {},
}));
vi.mock("@/trpc", () => ({ trpc: {} }));

import { useCartHoldRelease } from "../useCartRecovery";

/**
 * The unload release. It used to fire on EVERY leave: a redirect payment
 * method (Amazon Pay, Cash App) navigates away mid-confirm, and the release
 * cancelled its PaymentIntent; it also fired for PAID orders.
 */
describe("useCartHoldRelease — what leaving the page releases", () => {
  const sendBeacon = vi.fn(() => true);
  beforeEach(() => {
    vi.useFakeTimers();
    sendBeacon.mockClear();
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const leave = () => window.dispatchEvent(new Event("beforeunload"));
  // The beacon touches no React state: no act() needed.
  const flushUnmountRelease = () => vi.runOnlyPendingTimers();

  it("a held order is released on beforeunload and on unmount", () => {
    const { unmount } = renderHook(() =>
      useCartHoldRelease({ orderId: "order-1", eventId: "event-1" }),
    );
    leave();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledWith(
      "https://api.example.test/api/cart/release",
      JSON.stringify({ orderId: "order-1", eventId: "event-1" }),
    );
    unmount();
    // The unmount release goes out a tick later (see the next test).
    flushUnmountRelease();
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it("regression: Strict Mode's mount → unmount → mount releases nothing (a resumed cart was cancelled on arrival)", () => {
    // `?resumeOrderId=` starts the page with the cart's id; React re-runs
    // every effect once on mount in development, and its cleanup sent the
    // unmount beacon for the cart the page was opening.
    const { unmount } = renderHook(
      () => useCartHoldRelease({ orderId: "order-1", eventId: "event-1" }),
      { reactStrictMode: true },
    );
    flushUnmountRelease();
    expect(sendBeacon).not.toHaveBeenCalled();

    // A real leave still releases it, once.
    unmount();
    flushUnmountRelease();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledWith(
      "https://api.example.test/api/cart/release",
      JSON.stringify({ orderId: "order-1", eventId: "event-1" }),
    );
  });

  it("the unmount release names the order and the gate as they were at the moment of leaving", () => {
    const { rerender, unmount } = renderHook(
      ({ orderId, suppressRelease }: { orderId: string; suppressRelease: boolean }) =>
        useCartHoldRelease({ orderId, eventId: "event-1", suppressRelease }),
      { initialProps: { orderId: "order-1", suppressRelease: true } },
    );
    rerender({ orderId: "order-2", suppressRelease: false });
    unmount();
    flushUnmountRelease();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledWith(
      "https://api.example.test/api/cart/release",
      JSON.stringify({ orderId: "order-2", eventId: "event-1" }),
    );
  });

  it("a pending release for a different event still goes out when the same hook re-runs with a new eventId", () => {
    const { rerender } = renderHook(
      ({ eventId }: { eventId: string }) =>
        useCartHoldRelease({
          orderId: "order-1",
          eventId,
          suppressRelease: false,
        }),
      { initialProps: { eventId: "event-1" } },
    );
    rerender({ eventId: "event-2" });
    flushUnmountRelease();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledWith(
      "https://api.example.test/api/cart/release",
      JSON.stringify({ orderId: "order-1", eventId: "event-1" }),
    );
  });

  it("regression: suppressed (a payment submitting / a redirect pending / confirming / paid) → beforeunload releases nothing", () => {
    renderHook(() =>
      useCartHoldRelease({
        orderId: "order-1",
        eventId: "event-1",
        suppressRelease: true,
      }),
    );
    leave();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("regression: suppressed → unmount (client-side navigation) releases nothing", () => {
    const { unmount } = renderHook(() =>
      useCartHoldRelease({
        orderId: "order-1",
        eventId: "event-1",
        suppressRelease: true,
      }),
    );
    unmount();
    flushUnmountRelease();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("the gate is read at the moment of leaving: suppression lifted → release again", () => {
    const { rerender } = renderHook(
      ({ suppressRelease }: { suppressRelease: boolean }) =>
        useCartHoldRelease({ orderId: "order-1", eventId: "event-1", suppressRelease }),
      { initialProps: { suppressRelease: true } },
    );
    leave();
    expect(sendBeacon).not.toHaveBeenCalled();
    rerender({ suppressRelease: false });
    leave();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });
});
