import { describe, expect, it } from "vitest";

import { clipUtf16, clipUtf16WithEllipsis } from "../clip-utf16";

describe("clipUtf16", () => {
  it("leaves short text alone", () => {
    expect(clipUtf16("hello", 10)).toBe("hello");
    expect(clipUtf16WithEllipsis("hello", 5)).toBe("hello");
  });

  it("cuts to the unit bound", () => {
    expect(clipUtf16("abcdef", 3)).toBe("abc");
    expect(clipUtf16WithEllipsis("abcdef", 4)).toBe("abc…");
  });

  it("never leaves a lone leading surrogate", () => {
    // "a" + 🎸 (2 units): a cut at 2 lands inside the pair.
    expect(clipUtf16("a🎸b", 2)).toBe("a");
    expect(clipUtf16("a🎸b", 3)).toBe("a🎸");
    const long = "🎸".repeat(300);
    const clipped = clipUtf16WithEllipsis(long, 240);
    expect(clipped.length).toBeLessThanOrEqual(240);
    expect(clipped.endsWith("🎸…")).toBe(true);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});
