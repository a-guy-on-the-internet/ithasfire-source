import { describe, expect, it } from "vitest";

import {
  slugSegment,
  sanitizeText,
  sanitizeCountryCode,
  truncate,
  deriveShortIdFromUuid,
  sanitizeShortId,
  parseShortId,
} from "../slug-utils";

describe("sanitizeText", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(sanitizeText("Hello World")).toBe("hello-world");
  });

  it("strips accents", () => {
    expect(sanitizeText("café résumé")).toBe("cafe-resume");
  });

  it("strips non-letter/number characters", () => {
    expect(sanitizeText("Rock & Roll! #1")).toBe("rock-roll-1");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeText("a - - - b")).toBe("a-b");
  });

  it("returns null for empty string", () => {
    expect(sanitizeText("")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(sanitizeText(null)).toBeNull();
    expect(sanitizeText(undefined)).toBeNull();
  });

  it("returns null for emoji-only strings", () => {
    expect(sanitizeText("🎵🎶")).toBeNull();
  });

  it("preserves unicode letters", () => {
    expect(sanitizeText("日本語")).toBe("日本語");
  });
});

describe("sanitizeCountryCode", () => {
  it("lowercases a valid 2-letter code", () => {
    expect(sanitizeCountryCode("US")).toBe("us");
  });

  it("returns 'xx' for null", () => {
    expect(sanitizeCountryCode(null)).toBe("xx");
  });

  it("returns 'xx' for undefined", () => {
    expect(sanitizeCountryCode(undefined)).toBe("xx");
  });

  it("strips non-alpha characters", () => {
    expect(sanitizeCountryCode("U-S")).toBe("us");
  });

  it("truncates to 3 characters", () => {
    expect(sanitizeCountryCode("ABCD")).toBe("abc");
  });
});

describe("slugSegment", () => {
  it("returns sanitized value when present", () => {
    expect(slugSegment("New York", "fallback", 64)).toBe("new-york");
  });

  it("returns fallback when value is null", () => {
    expect(slugSegment(null, "fallback", 64)).toBe("fallback");
  });

  it("returns fallback when value is empty", () => {
    expect(slugSegment("", "fallback", 64)).toBe("fallback");
  });

  it("truncates long values", () => {
    const long = "a".repeat(100);
    expect(slugSegment(long, "fallback", 10)).toBe("aaaaaaaaaa");
  });
});

describe("truncate", () => {
  it("returns the value unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("cuts at maxLength and strips trailing hyphens", () => {
    expect(truncate("hello-world", 6)).toBe("hello");
  });
});

describe("deriveShortIdFromUuid", () => {
  it("returns a 10-char base-36 string from a UUID", () => {
    const result = deriveShortIdFromUuid(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result).toHaveLength(10);
    expect(result).toMatch(/^[a-z0-9]{10}$/);
  });

  it("produces deterministic output for the same UUID", () => {
    const uuid = "deadbeef-0000-0000-0000-000000000000";
    expect(deriveShortIdFromUuid(uuid)).toBe(deriveShortIdFromUuid(uuid));
  });

  it("produces different output for different UUIDs", () => {
    const a = deriveShortIdFromUuid("11111111-1111-1111-1111-111111111111");
    const b = deriveShortIdFromUuid("22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
  });
});

describe("sanitizeShortId", () => {
  it("normalizes and truncates a valid shortId to 10 chars", () => {
    expect(sanitizeShortId("ABC123xyzWWW")).toBe("abc123xyzw");
  });

  it("returns null for empty-after-sanitize input", () => {
    expect(sanitizeShortId("---")).toBeNull();
  });

  it("pads short results to 10 characters", () => {
    expect(sanitizeShortId("ab")).toBe("ab00000000");
  });
});

describe("parseShortId", () => {
  it("accepts exactly 10 base-36 characters", () => {
    expect(parseShortId("wqsdk6pxzi")).toBe("wqsdk6pxzi");
  });

  it("lowercases an uppercase ID", () => {
    expect(parseShortId("WQSDK6PXZI")).toBe("wqsdk6pxzi");
  });

  it("rejects what sanitizeShortId would have to repair", () => {
    expect(parseShortId("ab")).toBeNull(); // would pad
    expect(parseShortId("wqsdk6pxzi1")).toBeNull(); // would truncate
    expect(parseShortId("wqsdk-pxzi")).toBeNull(); // would strip
    expect(parseShortId("wqsdk6pxz!")).toBeNull();
    expect(parseShortId("")).toBeNull();
    expect(parseShortId(" wqsdk6pxzi")).toBeNull();
  });
});
