import { describe, expect, it } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { isRedundantAboutBlock } from "../about-block-dedupe";

function block(kind: string, data: unknown): PageBlockRecord {
  return {
    id: `block-${kind}`,
    pageId: "page-1",
    kind,
    orderIndex: 0,
    data,
    visible: true,
  };
}

describe("isRedundantAboutBlock", () => {
  it("flags an about block whose content equals the hero bio", () => {
    expect(
      isRedundantAboutBlock(
        block("about", { content: "We are a DIY venue in Nashville." }),
        "We are a DIY venue in Nashville.",
      ),
    ).toBe(true);
  });

  it("normalises whitespace before comparing", () => {
    expect(
      isRedundantAboutBlock(
        block("about", { content: "  We are a DIY\n\nvenue   in Nashville. " }),
        "We are a DIY venue in Nashville.",
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isRedundantAboutBlock(
        block("about", { content: "WE ARE A DIY VENUE IN NASHVILLE." }),
        "We are a DIY venue in Nashville.",
      ),
    ).toBe(true);
  });

  it("keeps an about block that contains the bio PLUS more text", () => {
    // Bio is a truncation of the about content — the about paragraph carries
    // extra text that renders nowhere else, so it must NOT be suppressed.
    expect(
      isRedundantAboutBlock(
        block("about", {
          content: "We are a DIY venue in Nashville. Est. 2019, all ages.",
        }),
        "We are a DIY venue in Nashville.",
      ),
    ).toBe(false);
  });

  it("flags an about block fully contained in the bio (adds nothing)", () => {
    // About is a truncation of the bio — everything it says is already in the
    // hero, so it is redundant.
    expect(
      isRedundantAboutBlock(
        block("about", { content: "We are a DIY venue in Nashville." }),
        "We are a DIY venue in Nashville. Est. 2019, all ages.",
      ),
    ).toBe(true);
  });

  it("keeps genuinely different about content", () => {
    expect(
      isRedundantAboutBlock(
        block("about", { content: "Founded by three friends over tacos." }),
        "We are a DIY venue in Nashville.",
      ),
    ).toBe(false);
  });

  it("never flags when the hero bio is missing or empty", () => {
    const about = block("about", { content: "We are a DIY venue." });
    expect(isRedundantAboutBlock(about, null)).toBe(false);
    expect(isRedundantAboutBlock(about, undefined)).toBe(false);
    expect(isRedundantAboutBlock(about, "   ")).toBe(false);
  });

  it("never flags when the about block has no text content", () => {
    expect(isRedundantAboutBlock(block("about", {}), "A bio")).toBe(false);
    expect(isRedundantAboutBlock(block("about", { content: "" }), "A bio")).toBe(
      false,
    );
    expect(isRedundantAboutBlock(block("about", null), "A bio")).toBe(false);
    expect(
      isRedundantAboutBlock(block("about", { content: 42 }), "A bio"),
    ).toBe(false);
  });

  it("only applies to `about` blocks", () => {
    expect(
      isRedundantAboutBlock(
        block("mission", { content: "Same text" }),
        "Same text",
      ),
    ).toBe(false);
    expect(
      isRedundantAboutBlock(block("press", { content: "Same text" }), "Same text"),
    ).toBe(false);
  });
});
