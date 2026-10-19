import { describe, expect, it } from "vitest";

import { cartResumeHref } from "../cart-resume-href";

describe("cartResumeHref", () => {
  it("builds the slug-addressed checkout link, keeping slug slashes", () => {
    expect(
      cartResumeHref({ id: "ord_1", eventSlug: "org/us/minneapolis/show-ab12" }),
    ).toBe("/events/checkout/org/us/minneapolis/show-ab12?resumeOrderId=ord_1");
  });

  it("encodes the order id", () => {
    expect(cartResumeHref({ id: "a b&c", eventSlug: "x/y" })).toBe(
      "/events/checkout/x/y?resumeOrderId=a%20b%26c",
    );
  });

  it("returns null without a slug, never the nonexistent /checkout route", () => {
    for (const eventSlug of [null, ""]) {
      const href = cartResumeHref({ id: "ord_1", eventSlug });
      expect(href).toBeNull();
    }
  });
});
