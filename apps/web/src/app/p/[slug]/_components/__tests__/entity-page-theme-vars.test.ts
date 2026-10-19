import { describe, expect, it } from "vitest";

import {
  buildEntityPageThemeVars,
  resolveEntityPageSurfaceTone,
} from "../entity-page-theme-vars";

/**
 * Theme colours become inline CSS custom properties on the public page. Rows
 * saved before the write side checked colour syntax can hold CSS injection
 * (`url(…)` beacons, `red;position:fixed;…` overlays), so the read side drops
 * any colour that is not CSS colour syntax and keeps the rest.
 */

type Theme = NonNullable<Parameters<typeof buildEntityPageThemeVars>[0]>;

function theme(colors: Partial<Theme>): Theme {
  return {
    id: "theme-1",
    pageId: "page-1",
    colorPrimary: null,
    colorBg: null,
    colorText: null,
    fontKey: null,
    layoutKey: null,
    ...colors,
  };
}

const HOSTILE = [
  "url(https://evil.example/p.gif)",
  "red;position:fixed;inset:0;z-index:2147483647",
  "var(--x)",
  "red}body{display:none",
  'red" onmouseover="alert(1)',
  "expression(alert(1))",
  "\\72 ed",
  "rgb(0 0 0);background:url(x)",
  "</style><script>alert(1)</script>",
];

describe("buildEntityPageThemeVars", () => {
  it("returns no vars for a missing theme", () => {
    expect(buildEntityPageThemeVars(null)).toEqual({});
  });

  it("keeps valid colours", () => {
    expect(
      buildEntityPageThemeVars(
        theme({
          colorPrimary: "#6366f1",
          colorBg: "rgb(10 20 30 / 50%)",
          colorText: "rebeccapurple",
        }),
      ),
    ).toEqual({
      "--th-color-primary": "#6366f1",
      "--th-color-bg": "rgb(10 20 30 / 50%)",
      "--th-color-text": "rebeccapurple",
    });
  });

  it("trims a stored colour before checking and emitting it", () => {
    expect(
      buildEntityPageThemeVars(theme({ colorBg: "  #fff ", colorText: " #111 " })),
    ).toEqual({
      "--th-color-bg": "#fff",
      "--th-color-text": "#111",
    });
  });

  it.each(HOSTILE)("drops the hostile stored colour %s", (value) => {
    expect(
      buildEntityPageThemeVars(
        theme({ colorPrimary: value, colorBg: value, colorText: value }),
      ),
    ).toEqual({});
  });

  it("drops only the hostile colour and keeps its valid neighbours", () => {
    expect(
      buildEntityPageThemeVars(
        theme({
          colorPrimary: "red;position:fixed;inset:0;z-index:2147483647",
          colorBg: "url(https://evil.example/p.gif)",
          colorText: "#F6F0E4",
        }),
      ),
    ).toEqual({
      "--th-color-text": "#F6F0E4",
      // the dropped background is replaced by a partner for the light text
      "--th-color-bg": "#211C16",
    });
  });

  /**
   * The theme editor saves background and text independently. A lone half
   * would otherwise meet a root fallback chosen for a different surface:
   * the Stub ink on the owner's dark background, or the owner's light text
   * on the Stub cream (and on Ember navy, on a freeform page).
   */
  describe("a half-set theme still paints a readable pair", () => {
    it("a lone dark background gets light ink", () => {
      expect(buildEntityPageThemeVars(theme({ colorBg: "#0F1B33" }))).toEqual({
        "--th-color-bg": "#0F1B33",
        "--th-color-text": "#F6F0E4",
      });
    });

    it("a lone light background gets dark ink", () => {
      expect(buildEntityPageThemeVars(theme({ colorBg: "#fff" }))).toEqual({
        "--th-color-bg": "#fff",
        "--th-color-text": "#211C16",
      });
    });

    it("lone light text gets a dark surface", () => {
      expect(buildEntityPageThemeVars(theme({ colorText: "#f5f5f5" }))).toEqual({
        "--th-color-bg": "#211C16",
        "--th-color-text": "#f5f5f5",
      });
    });

    it("lone dark text gets a light surface", () => {
      expect(buildEntityPageThemeVars(theme({ colorText: "#222" }))).toEqual({
        "--th-color-bg": "#F6F0E4",
        "--th-color-text": "#222",
      });
    });

    /**
     * Ink and paper give equal contrast near luminance 0.19, so a 0.5 "is it
     * light?" cutoff hands mid-tone brand colours the worse partner (cream on
     * #3B82F6 is 3.2:1; the Stub ink is 4.6:1). The partner is the one with
     * the higher WCAG contrast ratio.
     */
    it.each([
      ["#3B82F6", "#211C16"],
      ["#E2481D", "#211C16"],
      ["#888", "#211C16"],
      ["#0F1B33", "#F6F0E4"],
      ["#1e3a8a", "#F6F0E4"],
    ])("a lone background %s gets the partner that contrasts more (%s)", (bg, text) => {
      expect(buildEntityPageThemeVars(theme({ colorBg: bg }))).toEqual({
        "--th-color-bg": bg,
        "--th-color-text": text,
      });
    });

    it("lone mid-tone text gets the surface that contrasts more", () => {
      expect(buildEntityPageThemeVars(theme({ colorText: "#3B82F6" }))).toEqual({
        "--th-color-bg": "#211C16",
        "--th-color-text": "#3B82F6",
      });
      expect(buildEntityPageThemeVars(theme({ colorText: "#E2481D" }))).toEqual({
        "--th-color-bg": "#211C16",
        "--th-color-text": "#E2481D",
      });
    });

    it.each([
      ["#3b82f6cc"],
      ["#38f8"],
      ["rgb(59,130,246)"],
      ["rgba(59 130 246 / 50%)"],
      ["rgb(23% 51% 96%)"],
      ["hsl(217deg 91% 60%)"],
      ["hsla(217, 91%, 60%, 0.5)"],
    ])("measures a lone %s (alpha ignored) and pairs it", (bg) => {
      expect(buildEntityPageThemeVars(theme({ colorBg: bg }))).toEqual({
        "--th-color-bg": bg,
        "--th-color-text": "#211C16",
      });
    });

    it("measures a lone dark rgb()/hsl() colour too", () => {
      expect(buildEntityPageThemeVars(theme({ colorBg: "rgb(10 20 30)" }))).toEqual({
        "--th-color-bg": "rgb(10 20 30)",
        "--th-color-text": "#F6F0E4",
      });
      expect(buildEntityPageThemeVars(theme({ colorText: "hsl(0 0% 100%)" }))).toEqual({
        "--th-color-bg": "#211C16",
        "--th-color-text": "hsl(0 0% 100%)",
      });
    });

    it("a lone colour name it cannot measure is dropped, so the root's fallback pair applies", () => {
      expect(
        buildEntityPageThemeVars(theme({ colorPrimary: "#6366f1", colorBg: "rebeccapurple" })),
      ).toEqual({ "--th-color-primary": "#6366f1" });
      expect(buildEntityPageThemeVars(theme({ colorText: "white" }))).toEqual({});
    });
  });
});

describe("resolveEntityPageSurfaceTone", () => {
  it("an unthemed place root paints Stub cream, so it is light", () => {
    expect(resolveEntityPageSurfaceTone(null, true)).toBe("light");
    expect(resolveEntityPageSurfaceTone(theme({}), true)).toBe("light");
  });

  it("an unthemed freeform root is transparent, so it follows the app", () => {
    expect(resolveEntityPageSurfaceTone(theme({}), false)).toBeNull();
  });

  it("reads an owner's hex background", () => {
    expect(resolveEntityPageSurfaceTone(theme({ colorBg: "#F6F0E4" }), false)).toBe("light");
    expect(resolveEntityPageSurfaceTone(theme({ colorBg: "#fff" }), true)).toBe("light");
    expect(resolveEntityPageSurfaceTone(theme({ colorBg: "#0F1B33" }), true)).toBeNull();
  });

  it("a lone light text colour brings a dark surface, so it is not light", () => {
    expect(resolveEntityPageSurfaceTone(theme({ colorText: "#fff" }), true)).toBeNull();
    expect(resolveEntityPageSurfaceTone(theme({ colorText: "#222" }), false)).toBe("light");
  });

  it("reads rgb()/hsl() backgrounds by the same rule", () => {
    expect(
      resolveEntityPageSurfaceTone(theme({ colorBg: "rgb(255,255,255)", colorText: "#111" }), false),
    ).toBe("light");
    expect(resolveEntityPageSurfaceTone(theme({ colorBg: "hsl(220 60% 12%)" }), true)).toBeNull();
  });

  it("never guesses at a colour name or a hostile value", () => {
    expect(
      resolveEntityPageSurfaceTone(theme({ colorBg: "white", colorText: "#111" }), true),
    ).toBeNull();
    // a LONE unmeasurable background is dropped, so the root paints its cream
    expect(resolveEntityPageSurfaceTone(theme({ colorBg: "white" }), true)).toBe("light");
    expect(
      resolveEntityPageSurfaceTone(theme({ colorBg: "url(https://evil.example/p.gif)" }), true),
    ).toBe("light"); // dropped as unsafe, so the root paints its cream fallback
  });

  /**
   * The swatch palette must match the surface actually painted: a light tone
   * exactly when the page pairs the background with the Stub ink.
   */
  it.each(["#3B82F6", "#E2481D", "#888", "#0F1B33", "#1e3a8a", "#fff", "rgb(10 20 30)"])(
    "agrees with the partner chosen for a lone background %s",
    (bg) => {
      const vars = buildEntityPageThemeVars(theme({ colorBg: bg })) as Record<string, string>;
      const tone = resolveEntityPageSurfaceTone(theme({ colorBg: bg }), false);
      expect(tone === "light").toBe(vars["--th-color-text"] === "#211C16");
    },
  );
});
