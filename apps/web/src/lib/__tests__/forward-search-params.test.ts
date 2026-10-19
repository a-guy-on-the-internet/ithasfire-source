import { describe, expect, it } from "vitest";

import { forwardSearchParams } from "../forward-search-params";

describe("forwardSearchParams", () => {
  it("returns an empty string when there are no params", () => {
    expect(forwardSearchParams(undefined)).toBe("");
    expect(forwardSearchParams(null)).toBe("");
    expect(forwardSearchParams({})).toBe("");
    expect(forwardSearchParams({ token: undefined })).toBe("");
  });

  it("keeps every key — token AND ref AND anything else", () => {
    expect(
      forwardSearchParams({ token: "abc", ref: "ig-story", utm_source: "x" }),
    ).toBe("?token=abc&ref=ig-story&utm_source=x");
  });

  it("keeps resumeOrderId for the checkout redirect", () => {
    expect(forwardSearchParams({ resumeOrderId: "ord_123" })).toBe(
      "?resumeOrderId=ord_123",
    );
  });

  it("keeps repeated keys, in order", () => {
    expect(forwardSearchParams({ tag: ["a", "b"] })).toBe("?tag=a&tag=b");
  });

  it("URL-encodes values so a param cannot break out of the query", () => {
    expect(forwardSearchParams({ ref: "a&b=c#frag", token: "x/y+z" })).toBe(
      "?ref=a%26b%3Dc%23frag&token=x%2Fy%2Bz",
    );
  });
});
