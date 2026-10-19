/**
 * NFR-002 — the tone-contrast guard for the web scan verdicts.
 *
 * ## Why it lives here
 *
 * CI runs `apps/web`'s suite (`.github/workflows/ci.yml` → "Run web unit
 * tests" → `pnpm -F web run test:ci`, and `deploy-dev.yml`'s quality gate calls
 * the same script), and `vitest.config.ts` includes `src/**\/__tests__/**`. A
 * guard in a package no workflow runs is a phantom gate.
 *
 * ## Why it reads tokens instead of hex strings
 *
 * Every colour comes from `@th/ui/colors` — the real theme objects, imported
 * from source via the package's `./colors` export, so no build step can serve a
 * stale copy — and every PAIRING comes from `TONE_FILL_TOKENS`, the same map
 * `ToneResultState` renders from. A guard that re-declares the mapping guards a
 * copy of the mapping: someone could repoint PASS at `$accent` (which has no
 * legal foreground in either polarity) and a transcribed test would still be
 * green. There is not one transcribed hex below.
 *
 * ## Positives AND negatives
 *
 * Group B asserts the banned pairs still FAIL. A guard that only checks the
 * good pairs does not stop anyone reintroducing a bad one — and the single
 * worst class of bug in this palette's history is a pairing that measures
 * 1.00:1 because two tokens happen to hold the same value on one theme
 * (`color` and `surfaceStrong` are both `#211C16` on Stub).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { VERDICT_TONES } from "@th/types";
import { describe, expect, it } from "vitest";

import {
  darkTheme,
  lightTheme,
  stubTheme,
  type ThemeTokenKey,
} from "@th/ui/colors";

import { TONE_FILL_TOKENS } from "../scan-tone";

/** All three shipped themes. Keys are `swiss` / `ember` / `stub`, never light/dark. */
const THEMES = {
  swiss: lightTheme,
  ember: darkTheme,
  stub: stubTheme,
} as const;

type ThemeName = keyof typeof THEMES;
const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/** WCAG 1.4.3 text floor / 1.4.11 non-text floor. */
const TEXT = 4.5;
const GRAPHIC = 3.0;

/**
 * How far apart the two verdict FILLS must stay.
 *
 * Not a WCAG number — 1.4.11 governs a graphic against its own backdrop, and
 * these two are never on screen together. This is the "could an operator
 * glancing up tell which one this is" floor, and it is the measured value of
 * the pinned pair (amber `support` 0.439 luminance against flame `verdictFail`
 * 0.127 = 2.76:1) with a hair of slack.
 *
 * It exists because the obvious "simplification" — theming the FAIL fill onto
 * the brand accent ladder — costs it outright: `#F59E0B` against Ember's
 * `#FF5721` measures **1.47:1**, i.e. two verdicts that are the same colour at
 * a glance, in the dark-venue theme, which is the one condition this surface
 * exists for. Anyone who tries it fails this test rather than shipping it.
 */
const FILL_SEPARATION = 2.7;

type Rgb = [number, number, number];

const hexToRgb = (h: string): Rgb => {
  let s = h.replace("#", "");
  if (s.length === 3) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as Rgb;
};

const parseColor = (v: string): [number, number, number, number] => {
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return [...hexToRgb(v), 1];
  const p = m[1]!.split(",").map((x) => Number.parseFloat(x.trim()));
  return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
};

/** Composite a possibly-translucent colour over an OPAQUE backdrop. */
const over = (fg: string, bg: Rgb): Rgb => {
  const [r, g, b, a] = parseColor(fg);
  return [
    Math.round(r * a + bg[0] * (1 - a)),
    Math.round(g * a + bg[1] * (1 - a)),
    Math.round(b * a + bg[2] * (1 - a)),
  ];
};

const luminance = ([r, g, b]: Rgb): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
};

/** Resolve a token name (or a literal colour) against a theme. */
const resolve = (theme: ThemeName, token: string): string => {
  if (token.startsWith("#") || token.startsWith("rgb")) return token;
  const value = (THEMES[theme] as unknown as Record<string, string>)[token];
  if (!value) {
    // The sibling failure mode: a token that does not exist resolves to
    // nothing and silently inherits, which on an ink fill lands at ~1:1.
    throw new Error(`token "${token}" is not defined in theme "${theme}"`);
  }
  return value;
};

const check = (theme: ThemeName, fgToken: string, bgToken: string): number => {
  const bgRgb = hexToRgb(resolve(theme, bgToken));
  const fgRaw = resolve(theme, fgToken);
  const fgRgb = /rgba?\(/.test(fgRaw) ? over(fgRaw, bgRgb) : hexToRgb(fgRaw);
  return ratio(fgRgb, bgRgb);
};

const round = (n: number) => Math.round(n * 100) / 100;

// ── A — the pairs the verdict states actually render ────────────────────────

describe("A — verdict tone fills (read straight from TONE_FILL_TOKENS)", () => {
  it("has exactly the two tones the Design System specifies", () => {
    // Two, not four. The WORD carries the instruction (DS D-123); the fill
    // carries pass/fail and nothing else. A fifth family reintroduces the
    // green/red vocabulary that was never in this brand's palette.
    expect(Object.keys(TONE_FILL_TOKENS).sort()).toEqual([...VERDICT_TONES].sort());
    expect(VERDICT_TONES).toHaveLength(2);
  });

  for (const tone of VERDICT_TONES) {
    const { fill, on } = TONE_FILL_TOKENS[tone];

    for (const theme of THEME_NAMES) {
      it(`${tone}: $${on} on $${fill} clears the TEXT floor on ${theme}`, () => {
        const r = check(theme, on, fill);
        expect(
          r,
          `${tone} ${on}/${fill} on ${theme} = ${round(r)}:1`,
        ).toBeGreaterThanOrEqual(TEXT);
      });
    }
  }

  it("every tone token exists in all three themes", () => {
    for (const tone of VERDICT_TONES) {
      for (const token of Object.values(TONE_FILL_TOKENS[tone])) {
        for (const theme of THEME_NAMES) {
          expect(() => resolve(theme, token)).not.toThrow();
        }
      }
    }
  });

  it("keeps the two fills far enough apart to tell at a glance", () => {
    // The colour channel itself. Two tones can only carry nineteen outcomes if
    // the two are unmistakable — see FILL_SEPARATION for why the themed
    // alternative fails this outright on Ember.
    for (const theme of THEME_NAMES) {
      const r = check(theme, TONE_FILL_TOKENS.pass.fill, TONE_FILL_TOKENS.fail.fill);
      expect(
        r,
        `pass/fail fills on ${theme} = ${round(r)}:1`,
      ).toBeGreaterThanOrEqual(FILL_SEPARATION);
    }
  });

  it("PASS is the LIGHT fill — lightness is a channel of its own", () => {
    // At arm's length, in a dark room, "the bright one" is a decision before
    // hue, before glyph, before reading. If a palette change flips this, that
    // channel silently disappears.
    for (const theme of THEME_NAMES) {
      const lum = (tone: (typeof VERDICT_TONES)[number]) =>
        luminance(hexToRgb(resolve(theme, TONE_FILL_TOKENS[tone].fill)));
      expect(lum("pass"), `pass on ${theme}`).toBeGreaterThan(0.3);
      expect(lum("fail"), `fail on ${theme}`).toBeLessThan(0.3);
    }
  });

  it("the FAIL pair is theme-INVARIANT, by design", () => {
    // A door verdict must read identically whichever theme the device is on,
    // and the fill ships with the one foreground that is legal on it. If a
    // theme ever forks these, the per-theme guard above still passes while the
    // two surfaces stop agreeing — so pin the invariance itself.
    //
    // It also matches the value `packages/ui-native/src/palette.ts` pins, so
    // the native scanner and this page paint the same flame.
    const invariant: ThemeTokenKey[] = [
      TONE_FILL_TOKENS.fail.fill,
      TONE_FILL_TOKENS.fail.on,
      // The PASS *fill* is invariant too; its foreground is deliberately NOT
      // (each theme carries its own ink on amber), which is why it is measured
      // per theme above rather than pinned here.
      TONE_FILL_TOKENS.pass.fill,
    ];
    for (const token of invariant) {
      const values = new Set(THEME_NAMES.map((t) => resolve(t, token)));
      expect(values.size, `${token} differs across themes: ${[...values]}`).toBe(1);
    }
  });

  it("never paints a verdict on $accent", () => {
    // `$accent` (#E2481D) is the one brand value with NO legal foreground in
    // either polarity — white 4.06:1, ink 4.38:1. As a full-bleed verdict fill
    // it produces a state whose word cannot be made readable, and the measured
    // guards above would not object if someone also picked a foreground that
    // happens to clear 4.5 on one theme.
    for (const tone of VERDICT_TONES) {
      expect(TONE_FILL_TOKENS[tone].fill).not.toBe("accent");
      expect(TONE_FILL_TOKENS[tone].fill).not.toBe("brandSecondary");
    }
  });
});

// ── B — banned pairings. These must STAY unreachable. ───────────────────────

describe("B — banned pairings still fail (negatives)", () => {
  const BANNED: Array<{ label: string; fg: string; bg: string; floor: number }> =
    [
      // The known failure class: on Stub, `surfaceStrong` IS `color` (#211C16).
      {
        label: "$color on $surfaceStrong",
        fg: "color",
        bg: "surfaceStrong",
        floor: TEXT,
      },
      // Same collapse, same cause.
      { label: "$color on $structure", fg: "color", bg: "structure", floor: TEXT },
      // The documented worst defect in this palette's history. The PASS fill
      // carries ink, never white.
      { label: "white on $support", fg: "#FFFFFF", bg: "support", floor: TEXT },
      // The raw status fills are bright on swiss/ember and have NO legal
      // foreground as a full-bleed fill.
      { label: "white on $danger", fg: "#FFFFFF", bg: "danger", floor: TEXT },
      {
        label: "$colorInverted on $danger",
        fg: "colorInverted",
        bg: "danger",
        floor: TEXT,
      },
      { label: "white on $success", fg: "#FFFFFF", bg: "success", floor: TEXT },
      // The reflex for "a secondary line on the verdict".
      {
        label: "$colorMuted on $verdictFail",
        fg: "colorMuted",
        bg: "verdictFail",
        floor: TEXT,
      },
      {
        label: "$colorMuted on $support",
        fg: "colorMuted",
        bg: "support",
        floor: TEXT,
      },
      {
        label: "70% white on $verdictFail",
        fg: "rgba(255,255,255,0.7)",
        bg: "verdictFail",
        floor: TEXT,
      },
      // Tone-on-tone.
      {
        label: "$accent as text on $verdictFail",
        fg: "accent",
        bg: "verdictFail",
        floor: TEXT,
      },
      // DS v2 §9 — `$accent` is a fill/graphic value, never a label.
      { label: "$accent as text on $background", fg: "accent", bg: "background", floor: TEXT },
      /**
       * Every themed candidate that was considered for the FAIL fill and
       * rejected. Each is measured, not asserted from memory, so "let's just
       * theme it like everything else" fails here with the number attached.
       */
      {
        label: "white on $brandSecondary (themed FAIL candidate)",
        fg: "#FFFFFF",
        bg: "brandSecondary",
        floor: TEXT,
      },
      {
        label: "$onSupport on $accentHard (themed FAIL candidate)",
        fg: "onSupport",
        bg: "accentHard",
        floor: TEXT,
      },
      /**
       * The one that actually shipped on this page. `$colorInverted` reads like
       * "the light one" and is DARK on Ember (#181818), so the active half of
       * the camera/search toggle rendered near-invisible ink on the near-black
       * `$backgroundStrong` — 1.22:1. Same trap as `$color` on `$surfaceStrong`:
       * a token whose NAME implies a polarity it does not carry on every theme.
       */
      {
        label: "$colorInverted on $backgroundStrong",
        fg: "colorInverted",
        bg: "backgroundStrong",
        floor: TEXT,
      },
      /**
       * The session tally's previous plate. Its comment measured Stub only
       * (5.68:1) and it is 3.85:1 on swiss against a 4.5 floor — a 12px bold
       * numeral is not large text.
       */
      {
        label: "$colorInverted on $brandSecondaryHover",
        fg: "colorInverted",
        bg: "brandSecondaryHover",
        floor: TEXT,
      },
    ];

  for (const b of BANNED) {
    it(`${b.label} still fails on at least one theme`, () => {
      const measured = THEME_NAMES.map((t) => ({
        theme: t,
        r: check(t, b.fg, b.bg),
      }));
      const failing = measured.filter((m) => m.r < b.floor);
      expect(
        failing.length,
        `${b.label} measured ${measured
          .map((m) => `${m.theme} ${round(m.r)}:1`)
          .join(", ")} — if this now PASSES everywhere, the pairing is no ` +
          `longer banned and this negative needs re-deciding, not deleting`,
      ).toBeGreaterThan(0);
    });
  }

  /**
   * The DS's own `.if-verdict__state { opacity: .85 }`, measured on OUR tokens
   * rather than assumed. It is NOT in the list above because on the pinned FAIL
   * pair it technically CLEARS AA — by 0.17 — and a negative that expects a
   * failure it does not get is a guard that lies.
   *
   * That thin margin is the whole argument for dropping it: this is the same
   * bug class that shipped here once already (70% white on the old green fill
   * measured 4.40:1 and missed AA by a tenth, which nobody catches by eye), and
   * on the state line — the one line that NAMES the outcome. Full opacity costs
   * nothing and removes the question; hierarchy comes from size and weight. The
   * ban is enforced at the SOURCE, in C1.
   */
  it("the DS's opacity: .85 eats most of the FAIL pair's headroom", () => {
    for (const theme of THEME_NAMES) {
      const full = check(theme, TONE_FILL_TOKENS.fail.on, TONE_FILL_TOKENS.fail.fill);
      const muted = check(theme, "rgba(255,255,255,0.85)", TONE_FILL_TOKENS.fail.fill);
      expect(round(full), theme).toBe(5.92);
      expect(round(muted), theme).toBe(4.67);
      expect(muted, `${theme}: ${round(muted)}:1 is barely over the ${TEXT} floor`)
        .toBeLessThan(5);
    }
  });

  it("no shipped tone pair is one of the banned pairs", () => {
    // Belt and braces: the positives above would catch a bad pair by measuring
    // it, but only if the bad pair happens to fail. This catches the exact
    // token combinations by name.
    const banned = new Set([
      "color/surfaceStrong",
      "color/structure",
      "colorMuted/verdictFail",
      "colorMuted/support",
      "accent/verdictFail",
      "colorInverted/backgroundStrong",
    ]);
    for (const tone of VERDICT_TONES) {
      const { fill, on } = TONE_FILL_TOKENS[tone];
      expect(banned.has(`${on}/${fill}`), `${tone} uses a banned pair`).toBe(
        false,
      );
    }
  });
});

// ── C0 — the page chrome around the verdict ─────────────────────────────────

/**
 * Everything on this page that is NOT a tone fill but IS a foreground on a
 * strong fill. These are the pairs the banned list above replaces, asserted as
 * positives so a future edit that reverts one fails here as well as there.
 */
describe("C0 — chrome pairs the scan page renders", () => {
  const CHROME: Array<{ label: string; fg: string; bg: string; floor: number }> =
    [
      // Active half of the camera/search toggle — fill + label AND glyph.
      {
        label: "$onStructure on $backgroundStrong (mode toggle)",
        fg: "onStructure",
        bg: "backgroundStrong",
        floor: TEXT,
      },
      // The session-tally numeral plate.
      {
        label: "$onStructure on $structure (session tally)",
        fg: "onStructure",
        bg: "structure",
        floor: TEXT,
      },
      /**
       * The in-flight camera scrim. It paints on the CAMERA FEED — dark in
       * every theme — so it is judged against black, not against a theme
       * surface. `$onStructure` is the only foreground token that is light on
       * all three (#FFFFFF / #FFFFFF / #FDFAF3); measuring it against `#000000`
       * is the honest test, and it is why `$colorInverted` (dark on Ember)
       * cannot be used here either.
       */
      {
        label: "$onStructure on the camera scrim",
        fg: "onStructure",
        bg: "#000000",
        floor: TEXT,
      },
    ];

  for (const c of CHROME) {
    for (const theme of THEME_NAMES) {
      it(`${c.label} clears its floor on ${theme}`, () => {
        const r = check(theme, c.fg, c.bg);
        expect(r, `${c.label} on ${theme} = ${round(r)}:1`).toBeGreaterThanOrEqual(
          c.floor,
        );
      });
    }
  }
});

// ── C1 — the banned token, banned at the SOURCE ─────────────────────────────

/**
 * The measurements above are facts about the PALETTE. They stay green whether
 * or not this page uses a bad pair, which is precisely how `$colorInverted`
 * shipped on the active mode-toggle label (1.22:1 on Ember, invisible) while a
 * comment two lines above it named the right token. A contrast suite that never
 * looks at the code cannot catch a code defect.
 *
 * So this one reads the source. `$colorInverted` is banned outright on this
 * surface: it reads like "the light foreground" and is DARK on Ember, and every
 * place this page wants a light foreground already has a correct token
 * (`$onStructure`, or the tone pair's own `on…`). Same class as `$color` on
 * `$surfaceStrong` — a token whose name implies a polarity it does not carry on
 * every theme.
 */
describe("C1 — no banned token names in the scan surface source", () => {
  // Vitest runs with `apps/web` as the project root (`pnpm -F web run test:ci`,
  // and `vitest.config.ts` lives there). The "finds the files" assertion below
  // is the tripwire if that ever stops being true — a source guard that reads
  // an empty directory is a permanently-green step that looks like coverage.
  const componentsDir = join(
    process.cwd(),
    "src/app/admin/[slug]/scan/_components",
  );

  const sourceFiles = readdirSync(componentsDir)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(componentsDir, f), "utf8") }));

  it("finds the files it is supposed to be guarding", () => {
    // A guard that silently reads zero files is worse than no guard.
    expect(sourceFiles.map((f) => f.name)).toContain("UnifiedScanView.tsx");
    expect(sourceFiles.map((f) => f.name)).toContain("ToneResultState.tsx");
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  /**
   * Prose may name the token — the docblocks explain WHY it is banned — so
   * comments are stripped before searching. Matching on `color=` prop shapes
   * was tried first and missed `color={active ? "$colorInverted" : "$color"}`,
   * which is the exact line the defect shipped on. Any non-comment occurrence
   * counts.
   */
  const codeLines = (text: string): Array<{ line: string; n: number }> => {
    let inBlock = false;
    return text.split("\n").flatMap((raw, i) => {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) return [];
        line = line.slice(end + 2);
        inBlock = false;
      }
      const start = line.indexOf("/*");
      if (start !== -1) {
        const end = line.indexOf("*/", start + 2);
        if (end === -1) {
          inBlock = true;
          line = line.slice(0, start);
        } else {
          line = line.slice(0, start) + line.slice(end + 2);
        }
      }
      const lineComment = line.indexOf("//");
      if (lineComment !== -1) line = line.slice(0, lineComment);
      return line.trim() ? [{ line, n: i + 1 }] : [];
    });
  };

  it("the comment stripper does not swallow real code", () => {
    // Otherwise this whole guard degrades into "no files contain anything".
    const sample = [
      "/* $colorInverted in prose */",
      "// $colorInverted in prose",
      "/**",
      " * $colorInverted in a docblock",
      " */",
      'color={active ? "$colorInverted" : "$color"}',
    ].join("\n");
    expect(codeLines(sample).filter((l) => l.line.includes("$colorInverted"))).toHaveLength(
      1,
    );
  });

  for (const file of sourceFiles) {
    it(`${file.name} never renders with $colorInverted`, () => {
      const uses = codeLines(file.text).filter((l) =>
        l.line.includes("$colorInverted"),
      );
      expect(
        uses,
        `${file.name} renders $colorInverted at ${uses
          .map((u) => `line ${u.n}`)
          .join(", ")} — it is DARK on Ember (1.22:1 on $backgroundStrong). Use ` +
          `$onStructure, or the tone pair's own on… token.`,
      ).toEqual([]);
    });

    it(`${file.name} never sets an opacity on the verdict fill`, () => {
      // The DS ships `opacity: .85` on the state line and we drop it — an alpha
      // foreground on a tone fill is the bug class this surface shipped once.
      // Only `ToneResultState` paints on the fill, so only it is checked.
      if (file.name !== "ToneResultState.tsx") return;
      const uses = codeLines(file.text).filter((l) =>
        /\bopacity\b|emphasis=/.test(l.line),
      );
      expect(
        uses.map((u) => `line ${u.n}: ${u.line.trim()}`),
        "hierarchy on a tone fill is size and weight, never opacity",
      ).toEqual([]);
    });
  }
});

// ── C — the surface the below-the-fold detail paints on ─────────────────────

describe("C — the detail band under the verdict", () => {
  for (const theme of THEME_NAMES) {
    it(`body and muted copy clear AA on $surface on ${theme}`, () => {
      for (const fg of ["color", "colorMuted"]) {
        const r = check(theme, fg, "surface");
        expect(r, `${fg} on surface (${theme}) = ${round(r)}:1`).toBeGreaterThanOrEqual(
          TEXT,
        );
      }
    });

    it(`the detail band's divider clears the graphic floor on ${theme}`, () => {
      const r = check(theme, "borderColor", "surface");
      expect(r, `borderColor on surface (${theme}) = ${round(r)}:1`).toBeGreaterThanOrEqual(
        GRAPHIC,
      );
    });
  }
});

// ── D — the measurements, printed ───────────────────────────────────────────

/**
 * Not an assertion so much as a receipt: the numbers the decision was made on,
 * recomputed from the real tokens on every run. If someone changes a token,
 * this prints the new reality next to the failures above.
 */
describe("D — measured, for the record", () => {
  it("reports both pairings and the fill separation on all three themes", () => {
    const rows = THEME_NAMES.map((theme) => ({
      theme,
      pass: round(check(theme, TONE_FILL_TOKENS.pass.on, TONE_FILL_TOKENS.pass.fill)),
      fail: round(check(theme, TONE_FILL_TOKENS.fail.on, TONE_FILL_TOKENS.fail.fill)),
      separation: round(
        check(theme, TONE_FILL_TOKENS.pass.fill, TONE_FILL_TOKENS.fail.fill),
      ),
    }));
    for (const row of rows) {
      expect(row.pass, JSON.stringify(row)).toBeGreaterThanOrEqual(TEXT);
      expect(row.fail, JSON.stringify(row)).toBeGreaterThanOrEqual(TEXT);
      expect(row.separation, JSON.stringify(row)).toBeGreaterThanOrEqual(
        FILL_SEPARATION,
      );
    }
    // The values this design was signed off on. A palette edit that moves them
    // fails here with the new numbers in the message, which is the point.
    expect(rows).toEqual([
      { theme: "swiss", pass: 8.27, fail: 5.92, separation: 2.76 },
      { theme: "ember", pass: 7.98, fail: 5.92, separation: 2.76 },
      { theme: "stub", pass: 7.87, fail: 5.92, separation: 2.76 },
    ]);
  });
});
