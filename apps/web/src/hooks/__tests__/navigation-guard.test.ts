import { describe, expect, it, vi } from "vitest";

import { guardedNavigate, registerNavigationGuard } from "../navigation-guard";

describe("navigation-guard", () => {
  it("navigates at once with no guard registered", () => {
    const go = vi.fn();
    guardedNavigate(go);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("hands the navigation to the live guard instead of running it", () => {
    const guard = vi.fn();
    const unregister = registerNavigationGuard(guard);
    const go = vi.fn();
    guardedNavigate(go);
    expect(go).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledWith(go);
    unregister();
    guardedNavigate(go);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("A mounted, B mounted, B unmounted: A is live again", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregisterA = registerNavigationGuard(a);
    const unregisterB = registerNavigationGuard(b);
    guardedNavigate(() => {});
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    unregisterB();
    guardedNavigate(() => {});
    expect(a).toHaveBeenCalledTimes(1);
    unregisterA();
  });

  it("A unmounting after B mounted leaves B live (page swap order)", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregisterA = registerNavigationGuard(a);
    const unregisterB = registerNavigationGuard(b);
    unregisterA();
    guardedNavigate(() => {});
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    unregisterB();
  });

  it("unregistering twice, or the same guard registered twice, stays exact", () => {
    const g = vi.fn();
    const first = registerNavigationGuard(g);
    const second = registerNavigationGuard(g);
    first();
    first();
    guardedNavigate(() => {});
    expect(g).toHaveBeenCalledTimes(1);
    second();
    const go = vi.fn();
    guardedNavigate(go);
    expect(go).toHaveBeenCalledTimes(1);
  });
});
