import { describe, expect, it } from "vitest";
import { stubTheme } from "@th/ui/colors";

import {
  buildEmbedWidgetUrl,
  buildTicketsIframeSnippet,
  buildTicketsSdkSnippet,
} from "@/lib/embed-snippets";
import { embedKnobDefaults } from "@/app/embed/[embedId]/_components/embed-theme";

import { contrast } from "@/app/embed/[embedId]/_components/embed-host-vars";

import {
  DARK_SITE_OVERRIDES,
  backgroundSeed,
  chooseSiteType,
  previewHostOnEnteringCustom,
  displayedSiteType,
  effectiveKnobColors,
  overridesForSiteType,
  siteTypeForEntries,
  themeEntriesFor,
  type ThemeOverrides,
} from "../embed-site-type.helpers";

// What the configurator seeds from with no active preset: plain Stub.
const DEFAULTS = embedKnobDefaults({});
const PAPER = stubTheme.onStructure.slice(1).toUpperCase();

const answerFor = (o: ThemeOverrides) =>
  siteTypeForEntries(themeEntriesFor(o, DEFAULTS));

describe("answer → params (what each template writes)", () => {
  it("Light writes no theme params at all", () => {
    expect(overridesForSiteType("light")).toEqual({});
    expect(themeEntriesFor(overridesForSiteType("light"), DEFAULTS)).toEqual([]);
  });

  it("Dark writes ONLY fontColor, the platform paper (from stubTheme)", () => {
    expect(overridesForSiteType("dark")).toEqual({ fontColor: PAPER });
    expect(themeEntriesFor(overridesForSiteType("dark"), DEFAULTS)).toEqual([
      ["fontColor", PAPER],
    ]);
  });

  it("returns a fresh object, so a caller can't mutate the template", () => {
    const a = overridesForSiteType("dark");
    a.brandColor = "123456";
    expect(DARK_SITE_OVERRIDES).toEqual({ fontColor: PAPER });
  });
});

describe("params → answer (derived, never stored)", () => {
  it("no params → Light", () => {
    expect(answerFor({})).toBe("light");
  });

  it("knobs left at the platform default emit nothing, so they still read as Light", () => {
    expect(
      answerFor({
        brandColor: DEFAULTS.brandColor,
        fontColor: DEFAULTS.fontColor,
        accentColor: DEFAULTS.accentColor,
      }),
    ).toBe("light");
  });

  it("exactly Dark's params → Dark", () => {
    expect(answerFor({ fontColor: PAPER })).toBe("dark");
  });

  it("round-trips: each template's params read back as that template", () => {
    for (const type of ["light", "dark"] as const) {
      expect(answerFor(overridesForSiteType(type))).toBe(type);
    }
  });

  it("anything else → Custom (existing embeds with overrides open as Custom)", () => {
    expect(answerFor({ fontColor: "FFFFFF" })).toBe("custom");
    expect(answerFor({ bg: "111111" })).toBe("custom");
    expect(answerFor({ brandColor: "1D4ED8" })).toBe("custom");
  });

  it("a chosen background always counts, even at the picker's starting colour", () => {
    // bg's default is TRANSPARENT, so its starting swatch is still a choice.
    expect(answerFor({ bg: DEFAULTS.bg })).toBe("custom");
  });
});

describe("editing a swatch flips the answer to Custom by itself", () => {
  it.each([
    ["brandColor", "1D4ED8"],
    ["bg", "111111"],
    ["accentColor", "123456"],
    ["fontColor", "FFFFFF"],
  ] as const)("Dark + %s edit → Custom", (knob, value) => {
    const edited = { ...overridesForSiteType("dark"), [knob]: value };
    expect(answerFor(edited)).toBe("custom");
  });

  it("Light + any real edit → Custom", () => {
    expect(answerFor({ brandColor: "1D4ED8" })).toBe("custom");
  });

  it("choosing Light or Dark from Custom replaces the params outright", () => {
    // The page calls setThemeOverrides(overridesForSiteType(next)) — no merge.
    expect(answerFor(overridesForSiteType("light"))).toBe("light");
    expect(answerFor(overridesForSiteType("dark"))).toBe("dark");
  });
});

describe("displayedSiteType", () => {
  it("shows the derived answer unless the organiser picked Custom", () => {
    expect(displayedSiteType([], false)).toBe("light");
    expect(displayedSiteType([["fontColor", PAPER]], false)).toBe("dark");
  });

  it("picking Custom can only widen to Custom — never claims Light/Dark over other params", () => {
    expect(displayedSiteType([], true)).toBe("custom");
    expect(displayedSiteType([["brandColor", "1D4ED8"]], false)).toBe("custom");
  });
});

describe("swatches show what the widget renders", () => {
  it("under Dark the accent follows the text colour, as STEEL_BLUE does", () => {
    const c = effectiveKnobColors(overridesForSiteType("dark"), DEFAULTS);
    expect(c).toEqual({
      brandColor: DEFAULTS.brandColor,
      bg: null,
      fontColor: PAPER,
      accentColor: PAPER,
    });
  });

  it("an accent equal to what the embed falls back to emits nothing", () => {
    expect(
      themeEntriesFor({ fontColor: PAPER, accentColor: PAPER }, DEFAULTS),
    ).toEqual([["fontColor", PAPER]]);
  });

  it("an accent set to the platform default under Dark DOES emit (the embed would otherwise use the text)", () => {
    expect(
      themeEntriesFor(
        { fontColor: PAPER, accentColor: DEFAULTS.accentColor },
        DEFAULTS,
      ),
    ).toEqual([
      ["fontColor", PAPER],
      ["accentColor", DEFAULTS.accentColor],
    ]);
  });
});

describe("snippet and preview carry the same params", () => {
  const siteUrl = "https://ithasfire.com";
  const embedId = "e1";
  const paramsOf = (url: string) =>
    [...new URL(url).searchParams.entries()].filter(([k]) =>
      ["brandColor", "bg", "fontColor", "accentColor"].includes(k),
    );

  it.each(["light", "dark"] as const)("%s", (type) => {
    const themeEntries = themeEntriesFor(overridesForSiteType(type), DEFAULTS);
    const options = { themeEntries, scope: null, view: null };
    const preview = buildEmbedWidgetUrl(siteUrl, embedId, options);
    const snippet = buildTicketsIframeSnippet({
      siteUrl,
      embedId,
      height: 600,
      options,
    });
    const snippetSrc = /src="([^"]+)"/.exec(snippet)![1]!.replace(/&amp;/g, "&");
    expect(paramsOf(snippetSrc)).toEqual(paramsOf(preview));
    expect(paramsOf(preview)).toEqual(
      type === "dark" ? [["fontColor", PAPER]] : [],
    );
    // The SDK snippet serialises the same entries (as a theme object).
    const sdk = buildTicketsSdkSnippet(siteUrl, embedId, options);
    if (type === "dark") expect(sdk).toContain(`fontColor: "${PAPER}"`);
    else expect(sdk).not.toMatch(/theme:/);
  });
});

describe("Set colour seeds a background that pairs with the text", () => {
  it("under Dark, Set colour (then cancel) keeps text on bg at AA", () => {
    const dark = overridesForSiteType("dark");
    const bg = backgroundSeed(dark, DEFAULTS);
    expect(bg).toMatch(/^[0-9A-F]{6}$/);
    expect(contrast(`#${PAPER}`, `#${bg}`)).toBeGreaterThanOrEqual(4.5);
    // The platform surface it used to seed is unreadable under paper text.
    expect(contrast(`#${PAPER}`, `#${DEFAULTS.bg}`)).toBeLessThan(1.5);
  });

  it("holds for any host text colour", () => {
    for (const fontColor of ["FFFFFF", "767676", "222222", "F5D90A", "1D4ED8"]) {
      const bg = backgroundSeed({ fontColor }, DEFAULTS);
      expect(contrast(`#${fontColor}`, `#${bg}`), fontColor).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("with no text colour it is the platform surface, as before", () => {
    expect(backgroundSeed({}, DEFAULTS)).toBe(DEFAULTS.bg);
    expect(backgroundSeed({ fontColor: DEFAULTS.fontColor }, DEFAULTS)).toBe(DEFAULTS.bg);
  });
});

describe("Custom colours survive a trip through the templates", () => {
  const custom: ThemeOverrides = { brandColor: "1D4ED8", bg: "0A0A0A", fontColor: "FFFFFF", accentColor: "F5D90A" };
  const start = { overrides: custom, customPicked: false, lastCustom: null };

  it("Custom → Dark → Custom restores all four colours", () => {
    const dark = chooseSiteType(start, "custom", "dark");
    expect(dark.overrides).toEqual({ fontColor: PAPER });
    expect(answerFor(dark.overrides)).toBe("dark");
    const back = chooseSiteType(dark, "dark", "custom");
    expect(back.overrides).toEqual(custom);
    expect(back.customPicked).toBe(true);
  });

  it("arrowing Custom → Light → Dark → Custom still restores them", () => {
    let s = chooseSiteType(start, "custom", "light");
    s = chooseSiteType(s, "light", "dark");
    s = chooseSiteType(s, "dark", "custom");
    expect(s.overrides).toEqual(custom);
  });

  it("with no Custom colours yet, Custom starts from the current answer's", () => {
    const fromDark = chooseSiteType(
      { overrides: { fontColor: PAPER }, customPicked: false, lastCustom: null },
      "dark",
      "custom",
    );
    expect(fromDark.overrides).toEqual({ fontColor: PAPER });
    expect(displayedSiteType(themeEntriesFor(fromDark.overrides, DEFAULTS), fromDark.customPicked)).toBe("custom");
  });
});

describe("the preview keeps the template's page when entering Custom", () => {
  it("from Dark → dark page, from Light → white page, otherwise untouched", () => {
    expect(previewHostOnEnteringCustom("dark", "custom")).toBe("dark");
    expect(previewHostOnEnteringCustom("light", "custom")).toBe("light");
    expect(previewHostOnEnteringCustom("custom", "custom")).toBeNull();
    expect(previewHostOnEnteringCustom("custom", "dark")).toBeNull();
  });
});
