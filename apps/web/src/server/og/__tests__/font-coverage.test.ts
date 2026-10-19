import { describe, expect, it } from "vitest";

import { hasRenderableGlyph } from "../font-coverage";
import { loadOgFonts } from "../render";

/**
 * Runs against the REAL vendored TTFs. A hand-rolled cmap fixture would only
 * prove the parser parses itself; the question that matters is what the faces
 * we actually ship can draw.
 */
describe("hasRenderableGlyph", () => {
  it.each([
    ["plain Latin", "Sunset Session Vol. 03"],
    ["accented Latin", "Café Münster Soirée"],
    // PARTIALLY unrenderable is deliberately fine — losing the emoji is a good
    // share card, and shipping a megabyte of emoji font to keep it is not.
    ["Latin plus an emoji", "Comedy Night 🎤"],
    ["Latin plus CJK", "Tokyo Night 夏祭り"],
    ["digits and punctuation only", "2026 — 09/20"],
    // Montserrat ships Cyrillic, so this needs no fallback at all. Measured:
    // rendering it triggers ZERO outbound font fetches.
    ["Cyrillic", "Вечер джаза"],
  ])("renders %s", async (_label, title) => {
    expect(hasRenderableGlyph(title, await loadOgFonts())).toBe(true);
  });

  it.each([
    ["Japanese", "夏祭りナイト"],
    ["Simplified Chinese", "音乐之夜"],
    ["Devanagari", "संगीत की रात"],
    ["emoji only", "🎤🎸🥁"],
  ])("reports %s as undrawable by the Latin faces", async (_label, title) => {
    expect(hasRenderableGlyph(title, await loadOgFonts())).toBe(false);
  });

  it("treats empty / whitespace titles as renderable (the stub has its own placeholder)", async () => {
    const fonts = await loadOgFonts();
    expect(hasRenderableGlyph("", fonts)).toBe(true);
    expect(hasRenderableGlyph("   \n ", fonts)).toBe(true);
    expect(hasRenderableGlyph(null, fonts)).toBe(true);
  });

  /**
   * FAIL OPEN. An unreadable cmap is not evidence that a title is undrawable,
   * and treating it as such would swap the stub for the static poster across
   * the board the first time a font format changed.
   */
  it("fails open when no cmap can be read", () => {
    const junk = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(hasRenderableGlyph("夏祭りナイト", [{ data: junk }])).toBe(true);
    expect(hasRenderableGlyph("夏祭りナイト", [])).toBe(true);
  });
});
