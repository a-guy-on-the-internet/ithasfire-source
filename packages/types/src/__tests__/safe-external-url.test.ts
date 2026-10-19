import { describe, expect, it } from "vitest";

import { toSafeExternalUrl } from "../safe-external-url";

describe("toSafeExternalUrl", () => {
  it("accepts https URLs", () => {
    expect(toSafeExternalUrl("https://example.com/artist")).toBe(
      "https://example.com/artist",
    );
  });

  it("accepts http URLs", () => {
    expect(toSafeExternalUrl("http://example.com/artist")).toBe(
      "http://example.com/artist",
    );
  });

  it("rejects javascript URLs", () => {
    expect(toSafeExternalUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects mailto URLs", () => {
    expect(toSafeExternalUrl("mailto:test@example.com")).toBeNull();
  });

  it("rejects invalid URLs", () => {
    expect(toSafeExternalUrl("not-a-url")).toBeNull();
  });

  it("returns null for empty values", () => {
    expect(toSafeExternalUrl("")).toBeNull();
    expect(toSafeExternalUrl(null)).toBeNull();
    expect(toSafeExternalUrl(undefined)).toBeNull();
  });
});
