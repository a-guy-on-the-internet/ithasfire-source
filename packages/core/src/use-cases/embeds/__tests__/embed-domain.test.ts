import { describe, expect, it } from "vitest";

import { coerceEmbedDomainToHostname } from "../_shared/embed-domain";

describe("coerceEmbedDomainToHostname", () => {
  it.each([
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["https://Example.com/path", "example.com"],
    ["http://example.com", "example.com"],
    ["example.com/", "example.com"],
    ["shop.example.com/tickets/", "shop.example.com"],
    ["example.com:8080", "example.com"],
    ["www.example.com", "www.example.com"],
    ["localhost", "localhost"],
    ["  example.com  ", "example.com"],
  ])("coerces %p → %p", (raw, expected) => {
    expect(coerceEmbedDomainToHostname(raw)).toBe(expected);
  });

  it.each(["", "   ", "not a domain at all", "https://", "http:// /"])(
    "returns null for unparseable input %p",
    (raw) => {
      expect(coerceEmbedDomainToHostname(raw)).toBeNull();
    },
  );
});
