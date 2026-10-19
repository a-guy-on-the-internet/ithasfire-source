import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useSupportRouteContext } from "../support-context";

const mockPathname = vi.fn<[], string | null>();

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

const UUID = "11111111-2222-4333-8444-555555555555";

describe("useSupportRouteContext", () => {
  it("captures a UUID order id from the my-tickets route", () => {
    mockPathname.mockReturnValue(`/my-tickets/${UUID}`);
    const { result } = renderHook(() => useSupportRouteContext());
    expect(result.current).toEqual({ orderId: UUID });
  });

  it("ignores a non-UUID order segment", () => {
    mockPathname.mockReturnValue("/my-tickets/not-a-uuid");
    const { result } = renderHook(() => useSupportRouteContext());
    expect(result.current).toEqual({});
  });

  it("does not capture event slugs (slug-based, not UUID)", () => {
    mockPathname.mockReturnValue("/events/some-cool-show");
    const { result } = renderHook(() => useSupportRouteContext());
    expect(result.current).toEqual({});
  });

  it("returns empty context on unrelated routes", () => {
    mockPathname.mockReturnValue("/account/settings");
    const { result } = renderHook(() => useSupportRouteContext());
    expect(result.current).toEqual({});
  });

  it("handles a null pathname", () => {
    mockPathname.mockReturnValue(null);
    const { result } = renderHook(() => useSupportRouteContext());
    expect(result.current).toEqual({});
  });
});
