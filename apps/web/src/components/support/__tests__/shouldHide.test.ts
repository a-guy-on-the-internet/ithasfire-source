import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/trpc", () => ({ trpc: {} }));
vi.mock("@/lib/auth/auth-client", () => ({ authClient: {} }));

import { shouldHide } from "../SupportWidget";

describe("SupportWidget shouldHide", () => {
  it.each([
    "/events/checkout/some-event",
    "/events/checkout/us/nashville/gig",
    "/events/checkout",
    "/sign-in",
    "/sign-in/foo",
    "/sign-up",
    "/login",
    "/auth/callback",
    "/embed/e/1",
    "/access-denied",
    "/qr-test",
    "/platform",
    "/platform/support",
    "/admin/acme",
  ])("hides on %s", (p) => {
    expect(shouldHide(p)).toBe(true);
  });

  it.each([
    "/",
    "/events/checkout-night",
    "/events/checkout-collective/us/nashville/gig",
    "/events/resale/abc",
    "/sign-inx",
    "/loginhelp",
    "/authors",
    "/administrators",
    "/platformer",
  ])("shows on %s", (p) => {
    expect(shouldHide(p)).toBe(false);
  });

  it("shows when pathname is unknown", () => {
    expect(shouldHide(null)).toBe(false);
  });
});
