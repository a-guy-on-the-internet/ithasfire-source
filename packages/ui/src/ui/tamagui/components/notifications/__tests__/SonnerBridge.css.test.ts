import { ITHASFIRE_TOAST_CSS, sonnerThemeForThemeName } from "../SonnerBridge";

/** Body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(
    // Drop block comments so a selector or declaration quoted in prose
    // cannot satisfy (or break) a match.
    ITHASFIRE_TOAST_CSS.replace(/\/\*[\s\S]*?\*\//g, ""),
  );
  if (!match) throw new Error(`No rule for selector: ${selector}`);
  return match[1] ?? "";
}

describe("ITHASFIRE_TOAST_CSS", () => {
  // Sonner paints [data-description] #e8e8e8 under its dark theme, which was
  // ~1.1:1 on the cream stub surface when theme="system" followed the OS.
  it("makes the description inherit the toast's own text colour", () => {
    expect(
      ruleBody(".th-toaster [data-sonner-toast] [data-description]"),
    ).toMatch(/color:\s*inherit\s*!important/);
  });

  // Sonner's [data-sonner-toaster][data-sonner-theme=dark] sets the same
  // --normal-* vars at (0,2,0); ours must outrank it, not out-order it.
  it("sets the toast colour vars above Sonner's theme specificity", () => {
    const body = ruleBody(".th-toaster.th-toaster[data-sonner-toaster]");
    expect(body).toMatch(/--normal-text:\s*var\(--color/);
    expect(body).toMatch(/--normal-bg:\s*var\(--surfaceRaised/);
  });

  // --onBrandSecondary is dark ink in ember/swiss, where --accentHard is
  // steel blue: 1.9:1.
  it("labels the action button with the token paired with accentHard", () => {
    const body = ruleBody(".th-toaster [data-sonner-toast] [data-button]");
    expect(body).toMatch(/background:\s*var\(--accentHard/);
    expect(body).toMatch(/color:\s*var\(--onStructure/);
  });

  // The lighter --accent fill drops the 11px label below 4.5:1 (ember 3.2:1),
  // so hover must not swap the fill.
  it("keeps the action button fill on hover", () => {
    expect(
      ruleBody(".th-toaster [data-sonner-toast] [data-button]:hover"),
    ).not.toMatch(/background/);
  });

  // The ember fill (#2A4578) is 1.5:1 against the ember frame (#1A2847), so
  // the button needs its own edge, and it must outrank Sonner's border:none.
  it("draws the action button's edge in the toast's ink", () => {
    expect(
      ruleBody(".th-toaster [data-sonner-toast] [data-button]"),
    ).toMatch(/border:\s*1px solid var\(--color[^;]*!important/);
  });
});

describe("sonnerThemeForThemeName", () => {
  it.each([
    ["ember", "dark"],
    ["ember_Button", "dark"],
    ["dark", "dark"],
    ["dark_accent", "dark"],
    ["stub", "light"],
    ["stub_Button", "light"],
    ["swiss", "light"],
    ["light", "light"],
    ["", "light"],
    [undefined, "light"],
    [null, "light"],
    // A name that merely starts with the letters is not the ember base.
    ["embers", "light"],
  ] as const)("maps %s to %s", (name, expected) => {
    expect(sonnerThemeForThemeName(name)).toBe(expected);
  });
});
