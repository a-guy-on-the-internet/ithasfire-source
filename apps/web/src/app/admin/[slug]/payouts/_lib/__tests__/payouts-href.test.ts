import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminPaymentsRedirect from "../../../payments/page";
import { payoutsHref } from "../payouts-href";

// `redirect()` throws in Next to unwind the render; the stand-in records the
// target and throws the same way, so a route that forgot to redirect (or
// redirected twice) fails here.
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

describe("payoutsHref", () => {
  it("points at the payouts route", () => {
    expect(payoutsHref({ slug: "acme-co" })).toBe("/admin/acme-co/payouts");
  });

  it("keeps every query parameter, repeated ones included", () => {
    expect(
      payoutsHref({
        slug: "acme-co",
        searchParams: { tab: "stripe", ref: ["a", "b"], empty: undefined },
      }),
    ).toBe("/admin/acme-co/payouts?tab=stripe&ref=a&ref=b");
  });

  it("appends a section as the fragment, after the query", () => {
    expect(
      payoutsHref({ slug: "acme-co", searchParams: { x: "1" }, section: "stripe" }),
    ).toBe("/admin/acme-co/payouts?x=1#stripe");
  });

  it("leaves a personal-workspace slug exactly as routed", () => {
    expect(payoutsHref({ slug: "@steve" })).toBe("/admin/@steve/payouts");
  });
});

describe("/payments redirects to /payouts", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("preserves the query a pre-merge Stripe onboarding return carries", async () => {
    await expect(
      AdminPaymentsRedirect({
        params: Promise.resolve({ slug: "acme-co" }),
        searchParams: Promise.resolve({ tab: "stripe", refresh: "1" }),
      }),
    ).rejects.toThrow("REDIRECT:/admin/acme-co/payouts?tab=stripe&refresh=1");
    expect(redirectMock).toHaveBeenCalledTimes(1);
  });

  it("with no query, lands on the bare route (the browser keeps any fragment)", async () => {
    await expect(
      AdminPaymentsRedirect({
        params: Promise.resolve({ slug: "@steve" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("REDIRECT:/admin/@steve/payouts");
  });
});
