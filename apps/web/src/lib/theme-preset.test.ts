import { describe, expect, it } from "vitest";

import { mergeActivePreset, type ActiveThemePresets } from "./theme-preset";

const base = {
  background: "#F6F0E4",
  color: "#211C16",
  accent: "#E2481D",
  backgroundInverted: "#211C16",
};

const withPreset = (
  tokens: Record<string, string>,
  activeSlug: string | null = "p",
): ActiveThemePresets => ({
  activeSlug,
  presets: [
    { slug: "default", tokens: {} },
    { slug: "p", tokens },
  ],
});

/**
 * The inline merge `ActiveThemeInjector` ran before it moved here, copied
 * verbatim from `git show HEAD:apps/web/src/components/theme/ActiveThemeInjector.tsx`
 * as a parity oracle — the extraction must not change what the app applies.
 */
function legacyMerge(b: Record<string, string>, data: ActiveThemePresets) {
  const activeSlug = data?.activeSlug ?? null;
  const preset = activeSlug
    ? data?.presets.find((p) => p.slug === activeSlug)
    : null;
  const hasOverrides = preset && Object.keys(preset.tokens).length > 0;
  const merged: Record<string, string> = hasOverrides
    ? { ...b, ...preset.tokens }
    : { ...b };
  if (hasOverrides && preset.tokens.accent && !preset.tokens.backgroundInverted) {
    merged.backgroundInverted = preset.tokens.accent;
  }
  const fontBody = hasOverrides ? (preset.tokens.fontBody ?? null) : null;
  return { merged, fontBody };
}

describe("mergeActivePreset", () => {
  it("no data / no active slug gives the base", () => {
    expect(mergeActivePreset(base, undefined)).toEqual({
      tokens: base,
      presetTokens: null,
    });
    expect(mergeActivePreset(base, withPreset({ color: "#000000" }, null)).tokens).toEqual(base);
  });

  it("an empty preset gives the base", () => {
    const r = mergeActivePreset(base, withPreset({}, "default"));
    expect(r.tokens).toEqual(base);
    expect(r.presetTokens).toBeNull();
  });

  it("an unknown activeSlug gives the base", () => {
    const r = mergeActivePreset(base, withPreset({ color: "#000000" }, "gone"));
    expect(r.tokens).toEqual(base);
    expect(r.presetTokens).toBeNull();
  });

  it("lays preset tokens over the base", () => {
    const r = mergeActivePreset(base, withPreset({ color: "#102030" }));
    expect(r.tokens).toEqual({ ...base, color: "#102030" });
    expect(r.presetTokens).toEqual({ color: "#102030" });
  });

  it("derives backgroundInverted from an accent-only preset", () => {
    const r = mergeActivePreset(base, withPreset({ accent: "#C41E3A" }));
    expect(r.tokens.backgroundInverted).toBe("#C41E3A");
  });

  it("an explicit backgroundInverted wins over the derivation", () => {
    const r = mergeActivePreset(
      base,
      withPreset({ accent: "#C41E3A", backgroundInverted: "#123456" }),
    );
    expect(r.tokens.backgroundInverted).toBe("#123456");
  });

  it("does not mutate the base snapshot", () => {
    const b = { ...base };
    mergeActivePreset(b, withPreset({ accent: "#C41E3A" }));
    expect(b).toEqual(base);
  });

  describe("parity with the injector's previous inline logic", () => {
    const cases: Array<[string, ActiveThemePresets]> = [
      ["undefined", undefined],
      ["null", null],
      ["no active", withPreset({ color: "#000000" }, null)],
      ["empty preset", withPreset({}, "default")],
      ["unknown slug", withPreset({ accent: "#C41E3A" }, "gone")],
      ["accent only", withPreset({ accent: "#C41E3A" })],
      ["accent + inverted", withPreset({ accent: "#C41E3A", backgroundInverted: "#123456" })],
      ["no accent", withPreset({ color: "#102030", fontBody: "Inter" })],
      ["fontBody", withPreset({ accent: "#C41E3A", fontBody: "Inter" })],
    ];
    it.each(cases)("%s", (_name, data) => {
      const legacy = legacyMerge(base, data);
      const next = mergeActivePreset(base, data);
      expect(next.tokens).toEqual(legacy.merged);
      // The injector sets --th-font-body from `presetTokens?.fontBody`.
      expect(next.presetTokens?.fontBody ?? null).toBe(legacy.fontBody);
    });
  });
});
