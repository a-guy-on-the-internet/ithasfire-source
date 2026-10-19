/**
 * The tone-contrast guard.
 *
 * ## Why this file lives in `apps/scanner` and not in `packages/ui-native`
 *
 * The design says to port the contrast script into
 * `packages/ui-native/src/__tests__/`. That package has a `test` script and an
 * existing `palette.test.ts` — and **no workflow runs it**
 * `[VERIFIED: grep -rn "ui-native" .github/workflows/]` → no match, while
 * `ci.yml:268` and `deploy-dev.yml:420` both run `pnpm -F scanner exec vitest
 * --run`. A guard in a package no workflow runs is a phantom gate, which is
 * the exact failure mode `docs/…/gates-that-look-real` warns about, so it goes
 * where the runner actually reaches. (Adding a `@th/ui-native` CI step would be
 * better still, but this change is scoped out of `.github/**`.)
 *
 * ## Why it reads tokens instead of hex strings
 *
 * Every value comes from `@th/ui-native/palette` and every PAIRING comes from
 * `TONE_FILL_TOKENS` — the same map `ToneResultState` renders from. A guard
 * that re-declares the mapping guards a copy of the mapping: someone could
 * repoint FAIL at `accent` (which has no legal foreground in either polarity)
 * and this file would still be green. There is not one transcribed hex below.
 *
 * That matters more under the Design System's two tones than it did under four,
 * because the FAIL pair INVERTS between the palettes — ink on bright orange for
 * Ember, white on deep flame for Stub. A transcribed expectation would be right
 * on one theme and wrong on the other, and whichever theme the author had open
 * is the one that would look fine.
 *
 * ## Positives AND negatives
 *
 * Group B asserts the banned pairs still FAIL. A guard that only checks the
 * good pairs does not stop anyone reintroducing a bad one — and the single
 * worst class of bug in this palette's history is a pairing that measures
 * 1.00:1 because two tokens happen to hold the same value on one theme
 * (`color` and `surfaceStrong` are both `#211C16` on Stub).
 */
import { describe, expect, it } from "vitest";

import { FIXED, palettes, type NativeThemeName } from "@th/ui-native/palette";
import { TONE_FILL_TOKENS, VERDICT_TONES } from "@th/ui-native/tone";

// ── WCAG 2.x relative luminance, with alpha compositing ─────────────────────

const THEMES: readonly NativeThemeName[] = ["ember", "stub"];

/** AA floors (WCAG 1.4.3 text / 1.4.11 non-text). */
const TEXT = 4.5;
const GRAPHIC = 3.0;

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

/** Resolve a token name (or a literal) against a theme's palette + FIXED. */
const resolve = (theme: NativeThemeName, token: string): string => {
  if (token.startsWith("#") || token.startsWith("rgb")) return token;
  const pal = palettes[theme] as unknown as Record<string, string>;
  const value =
    pal[token] ?? (FIXED as unknown as Record<string, string>)[token];
  if (!value) throw new Error(`missing token ${token} on ${theme}`);
  return value;
};

/**
 * Contrast of `fg` on `bg`, both token names. `bgBase` composites a
 * translucent background over its real backdrop (a tint over `surface`).
 */
const check = (
  theme: NativeThemeName,
  fgToken: string,
  bgToken: string,
  bgBaseToken?: string,
): number => {
  const bgRaw = resolve(theme, bgToken);
  const bgRgb = bgBaseToken
    ? over(bgRaw, hexToRgb(resolve(theme, bgBaseToken)))
    : hexToRgb(bgRaw);
  const fgRaw = resolve(theme, fgToken);
  const fgRgb = /rgba?\(/.test(fgRaw) ? over(fgRaw, bgRgb) : hexToRgb(fgRaw);
  return ratio(fgRgb, bgRgb);
};

const round = (n: number) => Math.round(n * 100) / 100;

// ── A — full-bleed tone fills, straight from the map the app renders ────────

describe("A — tone fills (the pairs ToneResultState actually renders)", () => {
  for (const tone of VERDICT_TONES) {
    const { fill, on } = TONE_FILL_TOKENS[tone];
    for (const theme of THEMES) {
      it(`${tone}: ${on} on ${fill} clears the TEXT floor on ${theme}`, () => {
        const r = check(theme, on, fill);
        expect(
          r,
          `${tone} ${on}/${fill} on ${theme} = ${round(r)}:1`,
        ).toBeGreaterThanOrEqual(TEXT);
      });

      // The inverted chip is the tone pair REVERSED, so it is the same number.
      // Asserted anyway: if someone ever gives the inverted chip its own
      // tokens, this is where that stops being free.
      it(`${tone}: inverted chip (${fill} on ${on}) clears TEXT on ${theme}`, () => {
        const r = check(theme, fill, on);
        expect(
          r,
          `inverted ${fill}/${on} = ${round(r)}:1`,
        ).toBeGreaterThanOrEqual(TEXT);
      });
    }
  }

  /**
   * The two fills must stay far enough apart to be two THINGS at a glance.
   *
   * This is why the FAIL fill is PINNED to flame-600 rather than following the
   * themed `ctaFill`. With `ctaFill`, amber #F59E0B against Ember's orange
   * #FF5721 measured **1.47:1** — the same colour at a distance, in the
   * dark-venue theme, which is the one condition the surface exists for.
   * Pinned, both themes sit at **2.76:1**.
   *
   * The floor is 2.7 rather than WCAG's 3:1 because 3:1 is not reachable
   * between two adjacent-hue brand fills and inventing an unmeetable floor is
   * how a guard gets deleted. 2.7 locks the measured value: any edit that
   * darkens amber, lightens flame, or repoints FAIL at a themed token trips it.
   */
  const MIN_FILL_SEPARATION = 2.7;

  it("keeps the two fills ≥2.7:1 apart on BOTH themes", () => {
    for (const theme of THEMES) {
      const r = check(
        theme,
        TONE_FILL_TOKENS.pass.fill,
        TONE_FILL_TOKENS.fail.fill,
      );
      expect(
        r,
        `pass/fail fills on ${theme} = ${round(r)}:1 — if this dropped, check ` +
          `whether FAIL was repointed at the themed \`ctaFill\` (1.47:1 on Ember)`,
      ).toBeGreaterThanOrEqual(MIN_FILL_SEPARATION);
    }
  });

  it("keeps PASS the LIGHT fill — 'the bright one' is a decision before hue", () => {
    for (const theme of THEMES) {
      const lum = (tone: (typeof VERDICT_TONES)[number]) =>
        luminance(hexToRgb(resolve(theme, TONE_FILL_TOKENS[tone].fill)));
      expect(
        lum("pass"),
        `pass ${round(lum("pass"))} vs fail ${round(lum("fail"))} on ${theme}`,
      ).toBeGreaterThan(lum("fail"));
    }
  });

  it("keeps both verdict FILLS theme-invariant", () => {
    // The property that protects the separation above. A themed verdict fill
    // is exactly the change that cost 1.87× on Ember, and the failure is
    // invisible in whichever theme the author had open — `ctaFill` looks
    // perfectly reasonable on Stub.
    //
    // Only the FILLS. `onSupport` is legitimately two different inks (#0F1B33
    // navy on Ember, #211C16 on Stub) because each is tuned to its theme's
    // canvas; both clear AA on the same amber (7.98 / 7.87) and neither moves
    // the pass↔fail gap. `onVerdictFail` is white in both.
    for (const tone of VERDICT_TONES) {
      const { fill } = TONE_FILL_TOKENS[tone];
      expect(resolve("ember", fill), `${tone} fill`).toBe(resolve("stub", fill));
    }
  });
});

// ── B — banned pairings. These must STAY unreachable. ───────────────────────

describe("B — banned pairings still fail (negatives)", () => {
  const BANNED: Array<{
    label: string;
    fg: string;
    bg: string;
    bgBase?: string;
    floor: number;
  }> = [
    // The known failure class: on Stub, `surfaceStrong` IS `color` (#211C16).
    {
      label: "color on surfaceStrong",
      fg: "color",
      bg: "surfaceStrong",
      floor: TEXT,
    },
    { label: "color on structure", fg: "color", bg: "structure", floor: TEXT },
    // The documented worst defect in the app's history, and `support` is now
    // the PASS verdict fill — so this is the one that must never come back.
    { label: "#FFFFFF on support", fg: "#FFFFFF", bg: "support", floor: TEXT },
    { label: "#FFFFFF on accent", fg: "#FFFFFF", bg: "accent", floor: TEXT },
    { label: "color on accent", fg: "color", bg: "accent", floor: TEXT },
    // The reflex for "a secondary line on the verdict".
    {
      label: "colorMuted on the PASS fill",
      fg: "colorMuted",
      bg: "support",
      floor: TEXT,
    },
    {
      label: "colorMuted on the FAIL fill",
      fg: "colorMuted",
      bg: "verdictFail",
      floor: TEXT,
    },
    /**
     * THE crossed-pair trap, and the reason `toneColors()` takes a tone rather
     * than a colour. FAIL's foreground inverts between the palettes, so reading
     * one side of a pair and pairing it with the other tone's fill measures
     * fine on ONE theme and fails on the other. Whichever theme the author had
     * open is the one that would have looked correct.
     */
    {
      label: "the PASS foreground on the FAIL fill",
      fg: "onSupport",
      bg: "verdictFail",
      floor: TEXT,
    },
    {
      // With FAIL pinned, this IS the historic white-on-amber defect: 2.15:1.
      label: "the FAIL foreground on the PASS fill",
      fg: "onVerdictFail",
      bg: "support",
      floor: TEXT,
    },
    // Alpha-muting a foreground to make a hierarchy. `emphasis="subtle"` is
    // 0.65, and on the FAIL pair that is ~3.3:1 — NOT obvious by eye. No alpha
    // foregrounds on tone fills, ever; hierarchy comes from size and weight.
    {
      label: "the FAIL foreground at 65% alpha on the FAIL fill",
      fg: "rgba(255,255,255,0.65)",
      bg: "verdictFail",
      floor: TEXT,
    },
    // Tone-on-tone.
    {
      label: "the PASS fill as text on the FAIL fill",
      fg: "support",
      bg: "verdictFail",
      floor: TEXT,
    },
    {
      label: "warningSoft as text on the PASS fill",
      fg: "warningSoft",
      bg: "support",
      floor: TEXT,
    },
    // DS v2 §9 — `accent` is a fill/graphic value, never a label.
    {
      label: "accent as text on background",
      fg: "accent",
      bg: "background",
      floor: TEXT,
    },
    // The pre-existing Home defect this pass fixes (§8 H).
    {
      label: "support as a RULE on surfaceRaised",
      fg: "support",
      bg: "surfaceRaised",
      floor: GRAPHIC,
    },
    {
      label: "support as a RULE on surface",
      fg: "support",
      bg: "surface",
      floor: GRAPHIC,
    },
  ];

  for (const b of BANNED) {
    it(`${b.label} still fails on at least one theme`, () => {
      const measured = THEMES.map((t) => ({
        theme: t,
        r: check(t, b.fg, b.bg, b.bgBase),
      }));
      const failing = measured.filter((m) => m.r < b.floor);
      expect(
        failing.length,
        `${b.label} measured ${measured
          .map((m) => `${m.theme} ${round(m.r)}:1`)
          .join(
            ", ",
          )} — if this now PASSES everywhere the pairing is no longer ` +
          `a trap and should be removed from the banned list deliberately, not ` +
          `by a palette edit nobody noticed.`,
      ).toBeGreaterThan(0);
    });
  }
});

// ── C — below-the-fold detail block, on `surface` ───────────────────────────

describe("C — detail block on surface", () => {
  const PAIRS: Array<[string, string, number]> = [
    ["color", "surface", TEXT],
    ["colorMuted", "surface", TEXT],
    ["success", "surface", GRAPHIC],
    ["danger", "surface", GRAPHIC],
    ["accent", "surface", GRAPHIC],
    ["borderColor", "surface", GRAPHIC],
    ["accentText", "surface", TEXT],
  ];
  for (const [fg, bg, floor] of PAIRS) {
    for (const theme of THEMES) {
      it(`${fg} on ${bg} — ${theme}`, () => {
        const r = check(theme, fg, bg);
        expect(r, `${round(r)}:1`).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});

// ── D — stats strip (the FR-005 surface, including the contrast FIX) ────────

describe("D — stats strip", () => {
  const PAIRS: Array<[string, string, string | undefined, number]> = [
    ["color", "surface", undefined, TEXT],
    ["color", "supportTint", "surface", TEXT],
    ["color", "dangerTint", "surface", TEXT],
    // The fix: warningSoft, not support, carries the 90% rule.
    ["warningSoft", "surface", undefined, GRAPHIC],
    ["warningSoft", "supportTint", "surface", GRAPHIC],
    ["danger", "surface", undefined, GRAPHIC],
    ["danger", "dangerTint", "surface", GRAPHIC],
    ["colorMuted", "surface", undefined, TEXT],
    ["dangerSoft", "dangerTint", "surface", TEXT],
    ["accentText", "accentTint", "surface", TEXT],
    // Deliberately NOT asserted: `borderColorSoft` on `surface` (1.62 Ember /
    // 1.91 Stub). It is the NORMAL band's hairline — a decorative divider
    // between two chrome regions, not a "graphical object required to
    // understand the content" (WCAG 1.4.11). The two rules that DO carry
    // meaning are the capacity bands, and both are asserted above at the 3:1
    // floor. If the normal hairline ever starts encoding state, it needs a
    // real token, not an exemption.
  ];
  for (const [fg, bg, base, floor] of PAIRS) {
    for (const theme of THEMES) {
      it(`${fg} on ${bg}${base ? ` over ${base}` : ""} — ${theme}`, () => {
        const r = check(theme, fg, bg, base);
        expect(r, `${round(r)}:1`).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});

// ── E — control rail (FR-007), including the themed torch ───────────────────

describe("E — control rail", () => {
  const PAIRS: Array<[string, string, number]> = [
    ["color", "background", TEXT],
    ["borderColor", "background", GRAPHIC],
    ["color", "surface", GRAPHIC],
    // Torch OFF.
    ["colorMuted", "surface", GRAPHIC],
    ["borderColor", "surface", GRAPHIC],
    // Torch ON — icon + border only. The rejected first draft put an
    // accentText LABEL on an accentSoft plate: 4.05:1 on Ember, a text fail.
    ["accentText", "surface", GRAPHIC],
    ["onCta", "ctaFill", TEXT],
  ];
  for (const [fg, bg, floor] of PAIRS) {
    for (const theme of THEMES) {
      it(`${fg} on ${bg} — ${theme}`, () => {
        const r = check(theme, fg, bg);
        expect(r, `${round(r)}:1`).toBeGreaterThanOrEqual(floor);
      });
    }
  }

  it("torch ON as a LABEL on an accentSoft plate is why it is icon-only", () => {
    // Documents the rejected alternative so nobody re-adds the label.
    const ember = check("ember", "accentText", "accentSoft", "surface");
    expect(ember).toBeLessThan(TEXT);
  });
});

// ── F — camera chrome (FIXED, must stay unchanged) ──────────────────────────

describe("F — camera chrome on the black feed", () => {
  const PAIRS: Array<[string, string]> = [
    ["viewfinderStroke", "cameraBackdrop"],
    ["viewfinderLocked", "cameraBackdrop"],
    ["cameraControlMuted", "cameraBackdrop"],
  ];
  for (const [fg, bg] of PAIRS) {
    it(`${fg} on ${bg}`, () => {
      // Theme-invariant; one theme is enough, but check both to prove it.
      for (const theme of THEMES) {
        expect(check(theme, fg, bg)).toBeGreaterThanOrEqual(GRAPHIC);
      }
    });
  }
});

// ── G — on-fill chrome (offline chip border + label) on EVERY tone ──────────

describe("G — on-fill chrome clears TEXT on every tone", () => {
  for (const tone of VERDICT_TONES) {
    const { fill, on } = TONE_FILL_TOKENS[tone];
    it(`offline provenance chip on ${tone}`, () => {
      for (const theme of THEMES) {
        expect(check(theme, on, fill)).toBeGreaterThanOrEqual(TEXT);
      }
    });
  }
});

// ── H — the Home capacity fix (§8 H), asserted as a positive ────────────────

describe("H — Home capacity sites after the support → warningSoft fix", () => {
  const SITES: Array<[string, string, string | undefined]> = [
    // counterCardWarning.borderColor, as rendered against its own tint fill.
    ["warningSoft", "supportTint", "surfaceRaised"],
    ["warningSoft", "surfaceRaised", undefined],
    // progressFillWarning, on the progress track over the warning card.
    ["warningSoft", "progressTrack", "surfaceRaised"],
  ];
  for (const [fg, bg, base] of SITES) {
    for (const theme of THEMES) {
      it(`${fg} on ${bg}${base ? ` over ${base}` : ""} — ${theme}`, () => {
        const r = check(theme, fg, bg, base);
        expect(r, `${round(r)}:1`).toBeGreaterThanOrEqual(GRAPHIC);
      });
    }
  }
});
