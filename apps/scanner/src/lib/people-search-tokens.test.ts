import { describe, expect, it } from "vitest";

import { buildFtsMatch } from "./people-search-tokens";

describe("buildFtsMatch", () => {
  it("returns null for empty / whitespace-only queries", () => {
    expect(buildFtsMatch("")).toBeNull();
    expect(buildFtsMatch("   ")).toBeNull();
    expect(buildFtsMatch("!!! ??")).toBeNull();
  });

  it("produces a single prefix token for one word", () => {
    expect(buildFtsMatch("alice")).toBe("alice*");
    expect(buildFtsMatch("Alice")).toBe("alice*");
  });

  it("produces all-prefix AND-match for multiple words", () => {
    expect(buildFtsMatch("alice ex")).toBe("alice* ex*");
    expect(buildFtsMatch("  Bob   Smith ")).toBe("bob* smith*");
  });

  it("preserves email-ish characters within a token", () => {
    expect(buildFtsMatch("a@b.co")).toBe("a@b.co*");
    expect(buildFtsMatch("first.last+tag")).toBe("first.last+tag*");
  });

  it("treats punctuation other than email chars as separators", () => {
    expect(buildFtsMatch("O'Brien")).toBe("o* brien*");
    expect(buildFtsMatch("foo, bar; baz")).toBe("foo* bar* baz*");
  });
});
