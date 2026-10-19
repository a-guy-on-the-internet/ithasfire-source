import { describe, it, expect } from "vitest";

import {
  geoCategoryPageRobots,
  truncateMetaDescription,
} from "../buildGeoCategorySeo";

describe("geoCategoryPageRobots", () => {
  it("indexes when the ungated count meets the threshold", () => {
    expect(geoCategoryPageRobots({ indexableCount: 3, minEvents: 3 })).toEqual({
      index: true,
      follow: true,
    });
  });

  it("noindexes, still follows, below the threshold", () => {
    expect(geoCategoryPageRobots({ indexableCount: 2, minEvents: 3 })).toEqual({
      index: false,
      follow: true,
    });
  });

  it("noindexes an empty page", () => {
    expect(
      geoCategoryPageRobots({ indexableCount: 0, minEvents: 3 }).index,
    ).toBe(false);
  });
});

describe("truncateMetaDescription", () => {
  it("keeps a short description as is", () => {
    expect(truncateMetaDescription("Descubre 4 eventos.")).toBe(
      "Descubre 4 eventos.",
    );
  });

  it("clips a long one on a word boundary with an ellipsis, within 160", () => {
    const long = `${"palabra ".repeat(30)}fin`;
    const out = truncateMetaDescription(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("palabra…")).toBe(true);
  });
});
