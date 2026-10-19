import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  colorTokens,
  elevationTokens,
  getShadowOverflowPx,
  getThemeTokenKeys,
  THEME_TOKEN_GROUPS,
  themes,
  tokens,
} from "../index";
import {
  labelIdioms,
  monoScale,
  typographyTokens,
} from "../tokens/typography";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");

const themeNames = Object.keys(themes) as Array<keyof typeof themes>;

describe("Design System v2 token invariants", () => {
  // ── Doc ↔ code sync ────────────────────────────────────────────────────────
  // These are the EXACT values published in the mapping table of
  // `docs/design/design-system-v2.md` (§2), which every UI agent and contributor
  // reads as the source of truth. If you change a token value here, update that
  // table in the same PR — a design doc that lies about the code is worse than no
  // doc (see the retired steel-blue/navy claims in docs/design/style-guide.md,
  // which silently misled UI work for months).
  const DOCUMENTED = {
    stub: {
      background: "#F6F0E4",
      surface: "#FDFAF3",
      surfaceRaised: "#EFE7D6",
      color: "#211C16",
      colorMuted: "#5C544A",
      borderColor: "#211C16",
      borderColorSoft: "rgba(33, 28, 22, 0.3)",
      accent: "#E2481D",
      structure: "#211C16",
      structurePress: "#000000",
      support: "#F59E0B",
      onSupport: "#211C16",
    },
    ember: {
      background: "#0F1B33",
      surface: "#162240",
      surfaceRaised: "#1A2847",
      color: "#FFFFFF",
      colorMuted: "#A0B0CC",
      borderColor: "#5A78A6",
      borderColorSoft: "rgba(90, 120, 166, 0.4)",
      accent: "#FF5721",
      structure: "#35589A",
      structurePress: "#2A4578",
      support: "#F59E0B",
      onSupport: "#0F1B33",
    },
  } as const;

  it("matches the token values documented in docs/design/design-system-v2.md", () => {
    for (const [themeName, expected] of Object.entries(DOCUMENTED)) {
      const theme = themes[themeName as keyof typeof themes];
      expect(
        theme,
        `theme "${themeName}" is missing from the themes map`,
      ).toBeDefined();
      for (const [key, value] of Object.entries(expected)) {
        expect(
          theme[key as keyof typeof theme],
          `${themeName}.${key} drifted from docs/design/design-system-v2.md — update the doc's mapping table (§2) or revert the token`,
        ).toBe(value);
      }
    }
  });

  it("keeps the theme keys the design system documents (stub/swiss/ember, never light/dark)", () => {
    // Theme keys deliberately avoid `light`/`dark` prefixes: Tamagui emits prefix-matched
    // themes into a `@media (prefers-color-scheme)` :root rule, which caused a first-paint
    // flash. Renaming these silently breaks `useThemeName() === "ember"` dark detection.
    expect([...themeNames].sort()).toEqual(["ember", "stub", "swiss"]);
  });

  it("every theme carries exactly the same key set as lightTheme", () => {
    // getThemeTokenKeys() derives from lightTheme; ActiveThemeInjector,
    // snapshots, and the theme editor all assume key-set parity across themes.
    const expected = [...getThemeTokenKeys()].sort();
    for (const name of themeNames) {
      const keys = Object.keys(themes[name])
        .filter((k) => k !== "name")
        .sort();
      expect(keys).toEqual(expected);
    }
  });

  it("includes the v2 semantic keys in every theme", () => {
    const v2Keys = [
      "support",
      "onSupport",
      "structure",
      "structurePress",
      "borderColorSoft",
    ] as const;
    for (const name of themeNames) {
      for (const key of v2Keys) {
        expect(themes[name]).toHaveProperty(key);
      }
    }
  });

  it("exposes a roles entry for every theme in the themes map", () => {
    // `colorTokens.roles` is the SEPARATE badge/notification contrast system,
    // keyed by the "light"/"dark"/"stub" scheme vocabulary — deliberately NOT
    // the Tamagui theme keys (swiss/ember/stub), which are class-only to avoid
    // the prefers-color-scheme flash. Map each Tamagui theme to its role scheme.
    const themeToRole = {
      swiss: "light",
      ember: "dark",
      stub: "stub",
    } as const;
    for (const name of themeNames) {
      const roleKey = themeToRole[name];
      expect(colorTokens.roles).toHaveProperty(roleKey);
      // Role adapter must surface the v2 additions too.
      expect(colorTokens.roles[roleKey].support).toBe(themes[name].support);
      expect(colorTokens.roles[roleKey].borderSoft).toBe(
        themes[name].borderColorSoft,
      );
    }
  });

  it("covers every theme token key in THEME_TOKEN_GROUPS", () => {
    // The theme editor enumerates tokens via these groups; a key added to the
    // themes without a group entry silently disappears from the editor.
    const grouped = THEME_TOKEN_GROUPS.flatMap((g) => [...g.tokens]).sort();
    expect(grouped).toEqual([...getThemeTokenKeys()].sort());
  });

  it("keeps every radius token at 0 (strictly rectangular)", () => {
    for (const value of Object.values(tokens.radius)) {
      expect(value).toBe(0);
    }
  });

  it("exposes elevation tokens for every theme in the themes map", () => {
    for (const name of themeNames) {
      expect(elevationTokens).toHaveProperty(name);
      expect(typeof elevationTokens[name].card).toBe("string");
      expect(typeof elevationTokens[name].pop).toBe("string");
    }
  });

  // ── The two brand fonts ────────────────────────────────────────────────────
  // Product decision (2026-08-26): Montserrat + IBM Plex Mono. This REVERSES
  // the 2026-07-28 "Montserrat is the only brand font" decision and the sweep
  // that moved every decorative mono site onto Montserrat + tabular-nums.
  //
  // Plex carries the tracked-uppercase label idiom the design system calls its
  // most identifying mark. The guard therefore flipped direction: it used to
  // keep Plex OUT, and now it keeps Plex correctly WIRED. That distinction
  // matters because the failure mode is silent — if the woff2 files vanish or
  // the font variable stops reaching `<html>`, every label in the product
  // quietly falls back to the platform monospace and nothing goes red.
  describe("Montserrat + IBM Plex Mono are both wired", () => {
    it("routes the mono token through --font-mono with a monospace fallback", () => {
      // The token must NOT hardcode a family: the CSS var is the swap seam, and
      // it is what lets the web self-host while native falls back cleanly.
      expect(typographyTokens.mono.fontFamily).toContain("var(--font-mono");
      expect(typographyTokens.mono.fontFamily).toMatch(/monospace/);
    });

    it("keeps the sans tokens on Montserrat, not Plex", () => {
      for (const name of ["display", "heading", "body"] as const) {
        expect(
          typographyTokens[name].fontFamily,
          `typographyTokens.${name} must stay on the body/heading sans var`,
        ).not.toMatch(/ibm[\s-]?plex|plex\s?mono/i);
      }
    });

    it("self-hosts every Plex weight the label idiom uses", () => {
      // Static instances — IBM ships Plex Mono as discrete weights, not a
      // variable font. 400/500/600/700 are the four the design system's mono
      // ladder and label idioms reference.
      for (const weight of [400, 500, 600, 700]) {
        const rel = `apps/web/public/fonts/IBMPlexMono-${weight}.woff2`;
        expect(
          existsSync(join(REPO_ROOT, rel)),
          `${rel} is missing — the mono label idiom would silently fall back ` +
            "to the platform monospace on every surface",
        ).toBe(true);
      }
    });

    it("declares Plex in the font pipeline and reaches <html> with it", () => {
      const layout = readFileSync(
        join(REPO_ROOT, "apps/web/src/app/layout.tsx"),
        "utf8",
      );
      expect(layout).toMatch(/IBMPlexMono-\d{3}\.woff2/);
      expect(layout).toContain('variable: "--th-font-mono"');
      // Declaring the font is half of it — the generated class has to land on
      // the element or the custom property never exists at paint time.
      expect(
        layout,
        "plexMono.variable must be applied to <html> alongside montserrat",
      ).toMatch(/className=\{`\$\{montserrat\.variable\} \$\{plexMono\.variable\}`\}/);
    });

    it("chains --font-mono through the self-hosted face before the system stack", () => {
      const globals = readFileSync(
        join(REPO_ROOT, "apps/web/src/app/globals.css"),
        "utf8",
      );
      const decl = globals.match(/--font-mono:\s*([^;]+);/);
      expect(decl, "--font-mono must be declared in globals.css").toBeTruthy();
      const value = decl![1].replace(/\s+/g, " ");
      expect(
        value,
        "--font-mono must start at --th-font-mono (the self-hosted Plex) so " +
          "the system stack is only ever a fallback",
      ).toContain("var(--th-font-mono)");
      expect(value).toMatch(/monospace/);
    });

    it("pairs every mono step with its tracking", () => {
      // Tracked uppercase is the idiom; a size without its letterSpacing is
      // just small monospace text. Neither half is optional.
      for (const [step, spec] of Object.entries(monoScale)) {
        expect(typeof spec.fontSize, `monoScale.${step} needs a fontSize`).toBe(
          "number",
        );
        expect(
          typeof spec.letterSpacing,
          `monoScale.${step} needs its paired letterSpacing`,
        ).toBe("number");
      }
    });

    it("keeps both label idioms uppercase and on the mono face", () => {
      for (const [name, spec] of Object.entries(labelIdioms)) {
        expect(spec.fontFamily, `${name} must use the mono var`).toContain(
          "var(--font-mono",
        );
        expect(
          spec.textTransform,
          `${name} carries its own uppercase so callers cannot apply half the idiom`,
        ).toBe("uppercase");
        expect(spec.letterSpacing).toBeGreaterThan(0);
      }
    });
  });

  // Box shadows never contribute to scrollable overflow, so every `overflow`
  // container holding a shadowed card has to reserve this much room or it clips
  // the shadow (the event carousel did exactly that). Keep this honest against
  // the real token strings — a wrong answer here is an invisible clip.
  describe("getShadowOverflowPx", () => {
    it("measures the Stub card shadow's overflow from the token itself", () => {
      expect(getShadowOverflowPx(elevationTokens.stub.card)).toBe(4);
      expect(getShadowOverflowPx(elevationTokens.stub.pop)).toBe(6);
    });

    it("reserves nothing for the flat themes", () => {
      expect(getShadowOverflowPx(elevationTokens.swiss.card)).toBe(0);
      expect(getShadowOverflowPx(elevationTokens.ember.card)).toBe(0);
    });

    it("accounts for blur and spread, and rounds up", () => {
      expect(getShadowOverflowPx("2px 2px 6px rgba(0,0,0,.2)")).toBe(8);
      expect(getShadowOverflowPx("0 2px 4px 1px #000")).toBe(7);
      expect(getShadowOverflowPx("1.5px 1.5px 0 #000")).toBe(2);
    });

    it("returns 0 rather than guessing at an unparseable shadow", () => {
      expect(getShadowOverflowPx("")).toBe(0);
      expect(getShadowOverflowPx("inset 0 0 0 2px #000")).toBe(0);
    });
  });
});
