import { describe, expect, it } from "vitest";

import {
  CATEGORY_SLUG_REGEX,
  categoryNameIssue,
  categorySlugIssue,
  categorySlugNameIssue,
  deriveCategorySlug,
  normalizeCategoryName,
} from "../category-name-rules";

// The one copy of the category name rules. Core wraps them in its boundary
// schema and typed error; the web checks them before a round trip. Both sides'
// boundary tests stay with them; the rules are pinned here.

describe("normalizeCategoryName", () => {
  it("applies NFKC, collapses inner space and trims", () => {
    expect(normalizeCategoryName("  Live \t\n Jazz  ")).toBe("Live Jazz");
    expect(normalizeCategoryName("ﬁddle")).toBe("fiddle");
    expect(normalizeCategoryName("Live Jazz")).toBe("Live Jazz");
  });
});

describe("categoryNameIssue", () => {
  it("accepts a translated name in any script, up to 80 characters", () => {
    expect(categoryNameIssue("Música en vivo")).toBeNull();
    expect(categoryNameIssue("音楽")).toBeNull();
    expect(categoryNameIssue("abcdefgh".repeat(10))).toBeNull();
    expect(categoryNameIssue("Rock & Roll's B-Sides + More")).toBeNull();
  });

  it("refuses what the server refuses", () => {
    expect(categoryNameIssue("é")).toBe("too_short");
    expect(categoryNameIssue("- -")).toBe("too_short");
    expect(categoryNameIssue("x".repeat(81))).toBe("too_long");
    expect(categoryNameIssue("Jazz!")).toBe("unsupported_characters");
    expect(categoryNameIssue("www.jazz")).toBe("unsupported_characters");
    expect(categoryNameIssue("@jazz")).toBe("unsupported_characters");
    expect(categoryNameIssue("aaaaaaaa")).toBe("repeated_characters");
    expect(categoryNameIssue("aaaaaaa")).toBeNull();
  });

  it("checks the normalised name, so outer space does not count", () => {
    expect(categoryNameIssue(`  ${"abcdefgh".repeat(10)}  `)).toBeNull();
  });
});

describe("categorySlugNameIssue", () => {
  it("holds an English name to the slug's 2 to 40 characters too", () => {
    expect(categorySlugNameIssue("Live Jazz")).toBeNull();
    // Fine as a translation, but it slugs to nothing.
    expect(categoryNameIssue("音楽")).toBeNull();
    expect(categorySlugNameIssue("音楽")).toBe("too_short");
    expect(categorySlugNameIssue("word ".repeat(10))).toBe("too_long");
  });

  it("reports a word-rule issue before a slug issue", () => {
    expect(categorySlugNameIssue("aaaaaaaa")).toBe("repeated_characters");
  });
});

describe("deriveCategorySlug", () => {
  it("strips accents when it makes a slug", () => {
    expect(deriveCategorySlug("Música en vivo")).toBe("musica-en-vivo");
  });

  it("turns every other run into one hyphen, none at the ends", () => {
    expect(deriveCategorySlug(" -Rock & Roll- ")).toBe("rock-roll");
    expect(deriveCategorySlug("音楽")).toBe("");
  });

  it("strips a combining mark at the top of the range (U+036F)", () => {
    expect(deriveCategorySlug("aͯb cd")).toBe("ab-cd");
  });

  it("strips a combining mark at the bottom of the range (U+0300)", () => {
    expect(deriveCategorySlug("àb cd")).toBe("ab-cd");
  });

  it("does not treat U+0370 as a combining mark: it separates like any non a-z0-9 char", () => {
    expect(deriveCategorySlug("aͰb cd")).toBe("a-b-cd");
  });

  it("always derives a slug the slug pattern accepts, or nothing", () => {
    for (const name of ["Live Jazz", "Música", "A+B", "Hip-Hop & R&B", "x"]) {
      const slug = deriveCategorySlug(name);
      expect(slug === "" || CATEGORY_SLUG_REGEX.test(slug)).toBe(true);
    }
  });
});

describe("categorySlugIssue", () => {
  it("bounds a slug to 2 to 40 characters of the pattern", () => {
    expect(categorySlugIssue("jazz")).toBeNull();
    expect(categorySlugIssue("j")).toBe("too_short");
    expect(categorySlugIssue("a".repeat(40))).toBeNull();
    expect(categorySlugIssue("a".repeat(41))).toBe("too_long");
    expect(categorySlugIssue("Jazz")).toBe("unsupported_characters");
    expect(categorySlugIssue("jazz--funk")).toBe("unsupported_characters");
  });
});
