import { afterEach, describe, expect, it } from "vitest";
import { stubTheme } from "@th/ui/colors";

import * as embedTheme from "./embed-theme";
import { deriveHostVars } from "./embed-host-vars";
import { calendarThemeBridgeStyle } from "./embed-calendar-helpers";
import {
  BRAND_ORANGE,
  BRAND_ORANGE_HOVER,
  STEEL_BLUE,
  SURFACE,
  SURFACE_OPAQUE,
  TEXT,
  TEXT_MUTED,
  TEXT_ON_BRAND,
  TEXT_INVERTED,
  embedKnobDefaults,
  embedThemeBridgeStyle,
  sectionNumStyle,
  getResolvedEmbedStripeColors,
} from "./embed-theme";

/**
 * The embed palette is NOT a palette: every value resolves through the
 * platform theme (Stub + the active preset), with the organiser's `--hf-*`
 * host override layered on top. These tests pin that chain — the regression
 * they guard is the file drifting back into a hand-copied set of hexes that no
 * token edit or preset can reach.
 */

// A minimal CSS `var()` resolver, so the tests can assert what a declaration
// RESOLVES to under a given set of custom properties (jsdom resolves none).
function resolve(value: string, vars: Record<string, string>): string {
  const m = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(value.trim());
  if (!m) return value.trim();
  const [, name, fallback] = m;
  if (vars[name!] !== undefined) return vars[name!]!;
  return fallback === undefined ? "<invalid>" : resolve(fallback, vars);
}

const colourConstants = Object.entries(embedTheme).filter(
  ([name, v]) =>
    typeof v === "string" && /^[A-Z_]+$/.test(name) && name !== "SURFACE",
) as Array<[string, string]>;

describe("embed palette resolves through the platform theme", () => {
  it("every colour constant reads a platform token (no literal copies)", () => {
    const tokenKeys = new Set(Object.keys(stubTheme));
    expect(colourConstants.length).toBeGreaterThan(10);
    for (const [name, value] of colourConstants) {
      const tokens = [...value.matchAll(/var\(--(?!hf-)([\w]+)/g)].map(
        (m) => m[1]!,
      );
      expect(tokens.length, `${name} = ${value}`).toBeGreaterThan(0);
      for (const t of tokens) {
        expect(tokenKeys.has(t), `${name} reads unknown token --${t}`).toBe(
          true,
        );
      }
    }
  });

  it("carries none of the retired pre-v2 embed palette", () => {
    const retired = /#(35589A|FF5721|E04A18|2A4578|181818|707070|A0A0A0|C5CEE0|D8DEE9|F0F3F9)\b/i;
    for (const [name, value] of colourConstants) {
      expect(value, name).not.toMatch(retired);
    }
  });

  it("falls back to the Stub value, sourced from stubTheme", () => {
    expect(TEXT).toBe(`var(--hf-text, var(--color, ${stubTheme.color}))`);
    expect(resolve(TEXT, {})).toBe(stubTheme.color);
    expect(resolve(TEXT_MUTED, {})).toBe(stubTheme.colorMuted);
    expect(resolve(STEEL_BLUE, {})).toBe(stubTheme.structure);
    expect(resolve(SURFACE_OPAQUE, {})).toBe(stubTheme.surface);
  });

  it("follows a platform token change / active preset with no embed edit", () => {
    // What ActiveThemeInjector mirrors onto <body> when a preset is active.
    const preset = { "--color": "#102030", "--brandSecondaryHover": "#0A5F38" };
    expect(resolve(TEXT, preset)).toBe("#102030");
    expect(resolve(BRAND_ORANGE, preset)).toBe("#0A5F38");
  });

  it("lets a host --hf-* override win over the platform theme", () => {
    const platform = { "--color": "#211C16", "--brandSecondaryHover": "#B93312" };
    expect(resolve(TEXT, { ...platform, "--hf-text": "#FFFFFF" })).toBe(
      "#FFFFFF",
    );
    expect(
      resolve(BRAND_ORANGE, { ...platform, "--hf-brand": "#1D4ED8" }),
    ).toBe("#1D4ED8");
    expect(
      resolve(TEXT_ON_BRAND, { "--hf-on-brand": "#FFFFFF" }),
    ).toBe("#FFFFFF");
  });

  it("section numerals are text-safe accent, host brand still wins", () => {
    expect(resolve(String(sectionNumStyle.color), {})).toBe(stubTheme.accentText);
    expect(
      resolve(String(sectionNumStyle.color), { "--hf-brand": "#1D4ED8" }),
    ).toBe("#1D4ED8");
  });

  it("with a host text colour, section numerals take the derived link colour", () => {
    const vars = deriveHostVars({
      brandColor: null,
      bg: null,
      fontColor: "FDFAF3",
      accentColor: null,
    });
    expect(resolve(String(sectionNumStyle.color), vars)).toBe(vars["--hf-link"]);
    // …over a host brand too: the link is that brand, made readable.
    expect(
      resolve(String(sectionNumStyle.color), { ...vars, "--hf-brand": "#1D4ED8" }),
    ).toBe(vars["--hf-link"]);
  });

  it("the label on a STEEL_BLUE fill follows the host accent's luminance", () => {
    expect(resolve(TEXT_INVERTED, {})).toBe(stubTheme.onStructure);
    expect(resolve(TEXT_INVERTED, { "--hf-on-accent": "#211C16" })).toBe(
      "#211C16",
    );
  });

  it("with only fontColor set, structure and its label follow the text knob", () => {
    // ?bg=111111&fontColor=FFFFFF: the hook sets --hf-text and --hf-on-text.
    const host = { "--hf-text": "#FFFFFF", "--hf-on-text": "#181818" };
    expect(resolve(STEEL_BLUE, host)).toBe("#FFFFFF");
    expect(resolve(TEXT_INVERTED, host)).toBe("#181818");
    // An explicit accent still outranks the text knob.
    expect(
      resolve(STEEL_BLUE, { ...host, "--hf-accent": "#123456" }),
    ).toBe("#123456");
  });

  it("keeps the host page showing through", () => {
    expect(SURFACE).toBe("transparent");
  });
});

describe("CTA follows the design-system fill ladder", () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => {
      const s = parseInt(hex.slice(i, i + 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("rests on brandSecondaryHover with onBrandSecondary, not the raw accent", () => {
    expect(resolve(BRAND_ORANGE, {})).toBe(stubTheme.brandSecondaryHover);
    expect(resolve(BRAND_ORANGE_HOVER, {})).toBe(stubTheme.brandSecondaryStrong);
    expect(resolve(TEXT_ON_BRAND, {})).toBe(stubTheme.onBrandSecondary);
    expect(resolve(BRAND_ORANGE, {})).not.toBe(stubTheme.brandSecondary);
  });

  it("clears AA for the label at rest and on hover", () => {
    const label = resolve(TEXT_ON_BRAND, {});
    expect(ratio(label, resolve(BRAND_ORANGE, {}))).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(label, resolve(BRAND_ORANGE_HOVER, {})),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("embedThemeBridgeStyle", () => {
  const none = { brandColor: null, bg: null, fontColor: null, accentColor: null };

  it("declares nothing without overrides, so shared components inherit the platform", () => {
    expect(embedThemeBridgeStyle(none)).toEqual({});
  });

  const GROUND = {
    "--background": "var(--hf-ground)",
    "--surface": "var(--hf-ground)",
    "--surfaceMuted": "var(--hf-ground-muted)",
    "--surfaceRaised": "var(--hf-ground-muted)",
    "--mutedSurface": "var(--hf-ground-muted)",
    "--backgroundHover": "var(--hf-ground-muted)",
    "--backgroundFocus": "var(--hf-ground-muted)",
  };

  it("routes only the ACTIVE host knobs onto platform token names", () => {
    // fontColor alone moves the text AND the grounds it sits on — a panel and
    // its text are one unit (the admin's recommended dark-site setup).
    expect(embedThemeBridgeStyle({ ...none, fontColor: "FFFFFF" })).toEqual({
      "--color": "var(--hf-text)",
      "--foreground": "var(--hf-text)",
      "--colorMuted": "var(--hf-text-muted)",
      "--muted": "var(--hf-text-muted)",
      // structure is the ink on Stub; fill and label travel as a unit.
      "--structure": "var(--hf-text)",
      "--surfaceStrong": "var(--hf-text)",
      "--structurePress": "var(--hf-text)",
      "--onStructure": "var(--hf-on-text)",
      "--borderColorSoft": "var(--hf-border)",
      // The hard rule is the ink on Stub; it rides the text like --structure.
      "--borderColor": "var(--hf-text)",
      // Link text re-derived against the text colour's ground.
      "--accentText": "var(--hf-link)",
      ...GROUND,
    });
    expect(embedThemeBridgeStyle({ ...none, bg: "111111" })).toEqual(GROUND);
    // Brand drives the CTA fill LADDER + its luminance-picked label…
    expect(embedThemeBridgeStyle({ ...none, brandColor: "1D4ED8" })).toEqual({
      "--brandSecondaryHover": "var(--hf-brand)",
      "--brandSecondaryStrong": "var(--hf-brand-hover)",
      "--brandSecondaryPress": "var(--hf-brand-hover)",
      "--onBrandSecondary": "var(--hf-on-brand)",
    });
  });

  /**
   * Tag chips paint `$surfaceStrong` under an `$onStructure` label, and the
   * secondary button ("Add to calendar") presses to `$structurePress` under
   * the same label. Bridging `--onStructure` alone turned `?fontColor=FFFFFF`
   * into ink #181818 on the Stub ink fill #211C16 — every tag invisible. A
   * fill and its label travel as a unit, so neither can be bridged without
   * the other, and each fill rides the colour the label was picked against.
   */
  it("bridges every $onStructure fill WITH --onStructure — never one without the other", () => {
    const FILLS = ["--structure", "--surfaceStrong", "--structurePress"];
    for (const fontColor of ["FFFFFF", "222222", null]) {
      for (const bg of ["111111", null]) {
        for (const brandColor of ["1A1A2E", null]) {
          const style = embedThemeBridgeStyle({ ...none, fontColor, bg, brandColor });
          for (const fill of FILLS) {
            expect(fill in style, `${fill} fontColor=${fontColor} bg=${bg}`).toBe(
              "--onStructure" in style,
            );
          }
        }
      }
    }
    const white = embedThemeBridgeStyle({ ...none, fontColor: "FFFFFF" });
    // --hf-on-text is picked against --hf-text, so every fill rides --hf-text.
    expect(white["--onStructure" as keyof typeof white]).toBe("var(--hf-on-text)");
    for (const fill of FILLS) {
      expect(white[fill as keyof typeof white], fill).toBe("var(--hf-text)");
    }
  });

  /**
   * Link text and the ground it was derived against travel together: the
   * link is bridged exactly when the text knob (which moves the grounds) is,
   * in both the widget bridge and the calendar's.
   */
  it("bridges --accentText iff the text knob is set, and only to --hf-link", () => {
    for (const fontColor of ["FDFAF3", "222222", null]) {
      for (const bg of ["111111", null]) {
        for (const brandColor of ["1A1A2E", null]) {
          const o = { ...none, fontColor, bg, brandColor };
          for (const style of [
            embedThemeBridgeStyle(o),
            calendarThemeBridgeStyle(o),
          ] as Array<Record<string, string>>) {
            expect("--accentText" in style).toBe(Boolean(fontColor));
            if (fontColor) expect(style["--accentText"]).toBe("var(--hf-link)");
          }
        }
      }
    }
  });

  it("never repaints the platform's accent GRAPHICS with host colours", () => {
    const all = embedThemeBridgeStyle({
      brandColor: "1D4ED8",
      bg: "111111",
      fontColor: "FFFFFF",
      accentColor: "123456",
    }) as Record<string, string>;
    // The poster rule on the ink scrim and the flame index bars stay platform:
    // a dark host colour would vanish against the scrim.
    expect(all).not.toHaveProperty("--accent");
    expect(all).not.toHaveProperty("--brandSecondary");
    // accentColor alone emits nothing widget-wide (the tier card bridges it).
    expect(embedThemeBridgeStyle({ ...none, accentColor: "123456" })).toEqual({});
  });
});

describe("embedKnobDefaults (admin colour pickers)", () => {
  it("reads the Stub values with no preset", () => {
    expect(embedKnobDefaults({})).toEqual({
      brandColor: stubTheme.brandSecondaryHover.slice(1).toUpperCase(),
      bg: stubTheme.surface.slice(1).toUpperCase(),
      fontColor: stubTheme.color.slice(1).toUpperCase(),
      accentColor: stubTheme.structure.slice(1).toUpperCase(),
    });
  });

  it("follows an active preset, falling back to Stub for non-hex values", () => {
    const d = embedKnobDefaults({
      brandSecondaryHover: "#0a5f38",
      color: "rgba(0, 0, 0, 0.9)",
    });
    expect(d.brandColor).toBe("0A5F38");
    expect(d.fontColor).toBe(stubTheme.color.slice(1).toUpperCase());
  });
});

describe("getResolvedEmbedStripeColors", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("a dark host (bg + fontColor) gets its own input ground, not cream", () => {
    // Exactly what useEmbedThemeOverrides sets for ?bg=111111&fontColor=FFFFFF.
    const vars = deriveHostVars({
      brandColor: null,
      accentColor: null,
      bg: "111111",
      fontColor: "FFFFFF",
    });
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty(k, v);
    }
    document.body.style.setProperty("--background", stubTheme.background);
    const c = getResolvedEmbedStripeColors();
    expect(c.text).toBe("#FFFFFF");
    expect(c.inputBackground).toBe("#111111");
    expect(c.border).toBe("rgba(255, 255, 255, 0.3)");
  });

  it("walks host override → platform body var → Stub", () => {
    document.body.style.setProperty("--color", "#102030");
    document.documentElement.style.setProperty("--hf-brand", "#1D4ED8");
    const c = getResolvedEmbedStripeColors();
    expect(c.brand).toBe("#1D4ED8");
    expect(c.text).toBe("#102030");
    expect(c.textMuted).toBe(stubTheme.colorMuted);
    expect(c.inputBackground).toBe(stubTheme.background);
  });
});
