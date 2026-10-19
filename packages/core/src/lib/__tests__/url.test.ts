import { describe, it, expect } from "vitest";

import { trimTrailingSlash } from "../url";

describe("trimTrailingSlash", () => {
  it("removes a single trailing slash", () => {
    expect(trimTrailingSlash("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("removes multiple trailing slashes", () => {
    expect(trimTrailingSlash("https://example.com///")).toBe(
      "https://example.com",
    );
  });

  it("leaves a URL without trailing slash unchanged", () => {
    expect(trimTrailingSlash("https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("handles a URL with a path and trailing slash", () => {
    expect(trimTrailingSlash("https://example.com/app/")).toBe(
      "https://example.com/app",
    );
  });

  it("handles an empty string", () => {
    expect(trimTrailingSlash("")).toBe("");
  });

  it("does not remove slashes from the middle of a URL", () => {
    expect(trimTrailingSlash("https://example.com/a/b/c")).toBe(
      "https://example.com/a/b/c",
    );
  });
});
