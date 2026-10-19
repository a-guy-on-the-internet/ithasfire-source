import { describe, expect, it } from "vitest";

import { isUnderPath } from "../path-match";

describe("isUnderPath", () => {
  it("matches the prefix itself and anything beneath it", () => {
    expect(isUnderPath("/events/checkout", "/events/checkout")).toBe(true);
    expect(isUnderPath("/events/checkout/x", "/events/checkout")).toBe(true);
    expect(isUnderPath("/events/checkout/a/b", "/events/checkout")).toBe(true);
  });

  it("does not match a sibling that merely starts with the prefix", () => {
    expect(isUnderPath("/events/checkout-night", "/events/checkout")).toBe(
      false,
    );
    expect(isUnderPath("/authors", "/auth")).toBe(false);
  });

  it("does not match when the prefix appears mid-path", () => {
    expect(
      isUnderPath("/events/checkout-collective/us/x", "/events/checkout"),
    ).toBe(false);
    expect(isUnderPath("/x/events/checkout/y", "/events/checkout")).toBe(
      false,
    );
  });
});
