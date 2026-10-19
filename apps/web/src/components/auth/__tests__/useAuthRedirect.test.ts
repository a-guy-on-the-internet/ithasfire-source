import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useAuthRedirect } from "../useAuthRedirect";

describe("useAuthRedirect", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("reads the canonical redirect_url query param from the current URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/sign-in?redirect_url=%2Faccount%2Fbilling",
    );

    const { result } = renderHook(() => useAuthRedirect());

    expect(result.current.destination).toBe("/account/billing");
    expect(result.current.oauthCallbackUrl).toContain("/account/billing");
  });

  it("defaults both redirect outputs to the homepage when no redirect is present", () => {
    const { result } = renderHook(() => useAuthRedirect());

    expect(result.current.destination).toBe("/");
    expect(result.current.oauthCallbackUrl).toBe(`${window.location.origin}/`);
  });

  it("ignores an unsafe redirectOverride and falls back to a safe query redirect", () => {
    window.history.replaceState(
      {},
      "",
      "/sign-in?redirect=%2Fevents%2Fsafe-show",
    );

    const { result } = renderHook(() => useAuthRedirect("//evil.example"));

    expect(result.current.destination).toBe("/events/safe-show");
    expect(result.current.oauthCallbackUrl).toContain("/events/safe-show");
  });
});
