import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { BUTTON_VARIANT_STYLES } from "../components/forms/Button";
import { intentVisualConfigs } from "../components/shared";
import { getThemeTokenKeys, colorTokens, themes } from "../index";

// ─────────────────────────────────────────────────────────────────────────────
// Guards for the "fill and foreground drifted apart" bug class.
//
// The canonical failure: `$surfaceStrong` IS the ink on Stub (#211C16 ===
// `$color`), so any `$surfaceStrong` fill left carrying a fixed-ink foreground
// renders at 1.00:1 — an invisible label. It is not Stub-only: on Swiss the same
// pair is 2.55:1. Only Ember happened to be safe, which is exactly why it kept
// shipping. `$onStructure` is the near-white in every theme and is the correct
// foreground for that fill (16.2 / 7.0 / 9.5).
//
// A sibling failure is a foreground that names a token which does not exist
// ($colorContrast, $blue10): it resolves to nothing and silently inherits,
// which on an ink fill also lands at ~1:1.
// ─────────────────────────────────────────────────────────────────────────────

const themeNames = Object.keys(themes) as Array<keyof typeof themes>;

// ── WCAG 2.x relative luminance / contrast ──────────────────────────────────
const parse = (c: string): { rgb: [number, number, number]; a: number } => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((s) => parseFloat(s.trim()));
    return { rgb: [p[0], p[1], p[2]], a: p[3] ?? 1 };
  }
  let h = c.replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((x) => x + x)
      .join("");
  return {
    rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ],
    a: 1,
  };
};

const over = (
  fg: string,
  bg: [number, number, number],
): [number, number, number] => {
  const f = parse(fg);
  return f.rgb.map((v, i) => v * f.a + bg[i] * (1 - f.a)) as [
    number,
    number,
    number,
  ];
};

const lum = (rgb: [number, number, number]) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (fg: string, bg: string, canvas: string) => {
  const canvasRgb = parse(canvas).rgb;
  const bgRgb = over(bg, canvasRgb);
  const fgRgb = over(fg, bgRgb);
  const [hi, lo] = [lum(fgRgb), lum(bgRgb)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

/** Resolve a `$token` against a theme. */
const resolve = (token: string, theme: keyof typeof themes): string => {
  const key = token.replace(/^\$/, "");
  const t = themes[theme] as Record<string, string>;
  if (key in t) return t[key];
  const bag = colorTokens.color as Record<string, string>;
  if (key in bag) return bag[key];
  throw new Error(`token ${token} is not defined in theme "${theme}"`);
};

describe("solid intent surfaces: fill and foreground stay a legible pair", () => {
  // success/warning/danger/error are a KNOWN, documented gap: unlike every other
  // token their FILLS are not theme-stable (Stub darkens them for the cream
  // canvas; swiss/ember keep the bright originals), so no single existing token
  // clears AA on all three. Closing it needs a new `onStatus` theme token. These
  // tones currently have zero `variant="filled"` / `variant="solid"` consumers,
  // so the gap is latent. Remove from this list when `onStatus` lands.
  const KNOWN_STATUS_GAP = new Set(["success", "warning", "danger", "error"]);

  const tones = Object.keys(intentVisualConfigs) as Array<
    keyof typeof intentVisualConfigs
  >;

  for (const tone of tones) {
    if (KNOWN_STATUS_GAP.has(tone)) continue;
    for (const theme of themeNames) {
      it(`${tone}/solid clears WCAG AA on ${theme}`, () => {
        const visual = intentVisualConfigs[tone];
        const fill = resolve(visual.solidBackground, theme);
        const fg = resolve(visual.onSolidText, theme);
        const canvas = (themes[theme] as Record<string, string>).background;
        const ratio = contrast(fg, fill, canvas);
        // Solid intent surfaces carry small text (the Chip label is 13px), so
        // the 4.5:1 floor applies — NOT the 3:1 AA-large allowance.
        expect(
          ratio,
          `${tone}/solid on ${theme}: ${visual.onSolidText} (${fg}) on ${visual.solidBackground} (${fill}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("never pairs a foreground with `$surfaceStrong` that collapses on any theme", () => {
    // Direct regression on the original defect: `$color` on `$surfaceStrong`.
    for (const theme of themeNames) {
      const t = themes[theme] as Record<string, string>;
      const inkOnStrong = contrast(t.color, t.surfaceStrong, t.background);
      const onStructureOnStrong = contrast(
        t.onStructure,
        t.surfaceStrong,
        t.background,
      );
      // The whole point: `$color` is NOT a safe foreground here...
      if (theme !== "ember") {
        expect(
          inkOnStrong,
          `${theme}: $color on $surfaceStrong should be known-bad`,
        ).toBeLessThan(4.5);
      }
      // ...but `$onStructure` always is.
      expect(
        onStructureOnStrong,
        `${theme}: $onStructure on $surfaceStrong = ${onStructureOnStrong.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The poster's scrim trio — `$scrim` and the things drawn on it.
//
// The bug this pins: the poster used `$structure` as its ground and
// `$onStructure` / `$colorMutedInverted` as its two type rungs. `structure` is
// the ink only on Stub; on Swiss and Ember it is a mid steel-blue, and
// `colorMutedInverted` is muted against a DIFFERENT surface entirely
// (`backgroundInverted`), which on Ember is white. Measured on the rendered
// card in dark mode: a dimmed tier row at 1.22:1 and the accent rule at
// 1.81:1. Both invisible, both green on every test that existed.
//
// `$scrim` is dark in all three themes and its two foregrounds travel with it.
// ─────────────────────────────────────────────────────────────────────────────
describe("the scrim trio stays legible on every theme", () => {
  for (const theme of themeNames) {
    const t = () => themes[theme] as Record<string, string>;

    it(`$onScrim clears AA on $scrim (${theme})`, () => {
      const r = contrast(t().onScrim, t().scrim, t().background);
      expect(r, `${theme}: $onScrim on $scrim = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    it(`$onScrimMuted clears AA on $scrim AND is visibly dimmer (${theme})`, () => {
      const r = contrast(t().onScrimMuted, t().scrim, t().background);
      expect(
        r,
        `${theme}: $onScrimMuted on $scrim = ${r.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
      // "Dimmed" has to read as a step down, not as a second full-strength
      // rung — otherwise the sold-out / not-yet-on-sale distinction is carried
      // by nothing at all.
      const full = contrast(t().onScrim, t().scrim, t().background);
      expect(
        full / r,
        `${theme}: $onScrim (${full.toFixed(2)}:1) vs $onScrimMuted (${r.toFixed(2)}:1) — not a visible step`,
      ).toBeGreaterThanOrEqual(1.4);
    });

    it(`the flame rule clears the 3:1 non-text floor on $scrim (${theme})`, () => {
      // A 2px rule is non-text, so 3:1 (WCAG 1.4.11), not 4.5:1. It is
      // `$brandSecondary` rather than `$accent` precisely because Swiss's
      // `accent` IS the steel-blue and would land at 2.55:1 here.
      const r = contrast(t().brandSecondary, t().scrim, t().background);
      expect(
        r,
        `${theme}: $brandSecondary on $scrim = ${r.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    });

    it(`$structure is NOT a safe stand-in for $scrim (${theme})`, () => {
      // Documents why the trio exists rather than reusing `structure`: on two
      // of three themes the old ground cannot carry the rule at all.
      const onScrim = contrast(t().brandSecondary, t().scrim, t().background);
      const onStructure = contrast(
        t().brandSecondary,
        t().structure,
        t().background,
      );
      if (theme === "stub") {
        // Stub is the one theme where they coincide — by construction.
        expect(t().scrim).toBe(t().structure);
      } else {
        expect(
          onStructure,
          `${theme}: $brandSecondary on $structure should be known-bad`,
        ).toBeLessThan(3);
        expect(onScrim).toBeGreaterThan(onStructure);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Button primary — the CTA fill ladder.
//
// Two failure modes are guarded here, and they PULL AGAINST EACH OTHER, which
// is why both must be pinned at once:
//
//  1. Contrast. Button labels are 11-13px bold => the 4.5:1 small-text floor
//     applies, NOT the 3:1 AA-large floor. Stub's `$brandSecondary` (#E2481D)
//     famously fails it (white 4.06:1) — and cannot be rescued by flipping the
//     label, because ink on it is only 4.38:1. So the CTA rests one rung deeper.
//  2. Affordance. The naive fix ("rest on the hover value") silently collapses
//     rest === hover and the button loses its hover entirely. That is a real
//     regression, just not one a contrast checker can see — so the ladder's
//     rung-to-rung distinctness is asserted too.
// ─────────────────────────────────────────────────────────────────────────────
describe("Button primary: the CTA fill ladder stays legible AND interactive", () => {
  const primary = BUTTON_VARIANT_STYLES.primary;

  /** rest / hover / press, read off the REAL variant styles (not restated). */
  const rungs = [
    {
      name: "rest",
      fill: primary.backgroundColor,
      border: primary.borderColor,
      fg: primary.color,
    },
    {
      name: "hover",
      fill: primary.hoverStyle.backgroundColor,
      border: primary.hoverStyle.borderColor,
      fg: primary.hoverStyle.color ?? primary.color,
    },
    {
      name: "press",
      fill: primary.pressStyle.backgroundColor,
      border: primary.pressStyle.borderColor,
      fg: primary.pressStyle.color ?? primary.color,
    },
  ] as const;

  for (const theme of themeNames) {
    const canvas = () => (themes[theme] as Record<string, string>).background;

    for (const rung of rungs) {
      it(`${rung.name} label clears WCAG AA (4.5:1) on ${theme}`, () => {
        const fill = resolve(rung.fill, theme);
        const fg = resolve(rung.fg, theme);
        const ratio = contrast(fg, fill, canvas());
        expect(
          ratio,
          `primary/${rung.name} on ${theme}: ${rung.fg} (${fg}) on ${rung.fill} (${fill}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`each rung is visibly distinct from the previous one on ${theme}`, () => {
      // The affordance guard. A collapsed ladder (rest === hover) scores
      // exactly 1.00:1 here. The floor is calibrated against state steps this
      // codebase already ships: the subtlest accepted one is
      // background -> backgroundHover (1.07-1.14:1), the boldest is
      // structure -> structurePress (1.24-1.36:1). 1.15 sits above the
      // subtlest, so a rung that clears it is at least as perceptible as a
      // hover the design system already considers legible.
      for (let i = 1; i < rungs.length; i++) {
        const prev = resolve(rungs[i - 1].fill, theme);
        const cur = resolve(rungs[i].fill, theme);
        const step = contrast(prev, cur, canvas());
        expect(
          step,
          `${theme}: primary ${rungs[i - 1].name} (${prev}) -> ${rungs[i].name} (${cur}) = ${step.toFixed(2)}:1 — the ladder collapsed, so this state has no affordance`,
        ).toBeGreaterThanOrEqual(1.15);
      }
    });

    it(`label contrast never drops as the ladder climbs on ${theme}`, () => {
      // The RULE the ladder encodes: every rung moves the fill AWAY from the
      // label, so contrast rises monotonically. Stub (white label) deepens;
      // Swiss/Ember (ink label) brighten. A rung that moves TOWARD the label
      // is the bug class this whole file exists to catch — it can still pass
      // the 4.5 floor above while walking the ladder back toward #E2481D.
      const ratios = rungs.map((r) =>
        contrast(resolve(r.fg, theme), resolve(r.fill, theme), canvas()),
      );
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i],
          `${theme}: primary ${rungs[i].name} (${ratios[i].toFixed(2)}:1) is LESS legible than ${rungs[i - 1].name} (${ratios[i - 1].toFixed(2)}:1)`,
        ).toBeGreaterThan(ratios[i - 1]);
      }
    });

    it(`fill and border stay the same value on every rung on ${theme}`, () => {
      // A 2px border in the old fill is a visible halo of the previous rung.
      for (const rung of rungs) {
        expect(
          resolve(rung.border, theme),
          `${theme}: primary/${rung.name} border ${rung.border} != fill ${rung.fill}`,
        ).toBe(resolve(rung.fill, theme));
      }
    });
  }

  it("never rests the CTA on a fill that has no AA foreground at all", () => {
    // Stub's #E2481D is the reason this ladder exists: it is the one accent
    // value where BOTH polarities fail, so "just flip the label to ink" is not
    // a fix. Pinned so nobody "simplifies" the rest fill back to $brandSecondary.
    const stub = themes.stub as Record<string, string>;
    const white = contrast("#FFFFFF", stub.brandSecondary, stub.background);
    const ink = contrast(stub.color, stub.brandSecondary, stub.background);
    expect(white).toBeLessThan(4.5);
    expect(ink).toBeLessThan(4.5);

    // ...and the resting fill the Button actually uses is NOT that value.
    for (const theme of themeNames) {
      expect(
        resolve(primary.backgroundColor, theme),
        `${theme}: primary rests on $brandSecondary, which is accent-for-large-surfaces only`,
      ).not.toBe((themes[theme] as Record<string, string>).brandSecondary);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Button outlined — accent AS TEXT.
//
// The mirror image of the primary ladder above, and the SAME failing pair
// inverted: primary was cream-on-accent, this is accent-on-cream. Stub's
// `$accent` #E2481D is 3.57:1 on the page canvas and 3.89:1 on `$surface` — a
// button label is 11-13px bold, so the 4.5:1 floor applies and both fail.
//
// Three failure modes are pinned, and (as with primary) they pull against each
// other:
//   1. Contrast, at every rung, on both substrates a button can sit on.
//   2. Monotonicity — Ember shipped a press rung at 1.88:1 because `$accentHard`
//      is steel-blue there while `$colorInverted` is dark ink. It cleared no
//      floor and no checker was looking.
//   3. Ladder distinctness — the tempting one-token fix (press reuses the rest
//      value) collapses hover === press on Stub, where `$accentHard` IS the
//      rest rung. That costs the press affordance without failing any ratio.
// ─────────────────────────────────────────────────────────────────────────────
describe("Button outlined: accent-as-text is legible at every rung", () => {
  const outlined = BUTTON_VARIANT_STYLES.outlined;

  // The substrates an outlined button actually sits on. Both are asserted
  // because the variant is used on either: `AuthCardShell` is transparent, so
  // the auth cards that own the live instances of this variant ("Create
  // account" on /sign-in, "Sign in" on /sign-up) render on `$background`, not
  // `$surface` — verified in Chrome, the painted pixel behind them is #F6F0E4.
  const SUBSTRATES = ["background", "surface"] as const;

  for (const theme of themeNames) {
    const t = () => themes[theme] as Record<string, string>;

    for (const substrate of SUBSTRATES) {
      it(`rest label clears WCAG AA (4.5:1) on ${theme} $${substrate}`, () => {
        // Rest is `backgroundColor: "transparent"`, so the label sits directly
        // on the substrate — there is no fill to measure against.
        expect(outlined.backgroundColor).toBe("transparent");
        const fg = resolve(outlined.color, theme);
        const bg = t()[substrate];
        const ratio = contrast(fg, bg, t().background);
        expect(
          ratio,
          `outlined/rest on ${theme}: ${outlined.color} (${fg}) on $${substrate} (${bg}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`rest border stays >=3:1 on ${theme} (WCAG 1.4.11, non-text)`, () => {
      // The border is a graphic, so it only owes 3:1 — but it must still be
      // legible, and it must be the SAME value as the label (asserted below).
      const border = resolve(outlined.borderColor, theme);
      for (const substrate of SUBSTRATES) {
        const ratio = contrast(border, t()[substrate], t().background);
        expect(
          ratio,
          `outlined border on ${theme} $${substrate} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it(`label and border are one value at rest on ${theme}`, () => {
      // Two different oranges on one small control reads as a rendering bug.
      expect(resolve(outlined.borderColor, theme)).toBe(
        resolve(outlined.color, theme),
      );
    });

    for (const state of ["hoverStyle", "pressStyle"] as const) {
      it(`${state.replace("Style", "")} label clears WCAG AA (4.5:1) on ${theme}`, () => {
        const style = outlined[state];
        const fill = resolve(style.backgroundColor, theme);
        const fg = resolve(style.color ?? outlined.color, theme);
        const ratio = contrast(fg, fill, t().background);
        expect(
          ratio,
          `outlined/${state} on ${theme}: ${style.color} (${fg}) on ${style.backgroundColor} (${fill}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });

      it(`${state.replace("Style", "")} fill and border stay the same value on ${theme}`, () => {
        // A 2px border left on the previous rung is a visible halo.
        const style = outlined[state];
        expect(
          resolve(style.borderColor, theme),
          `outlined/${state} border ${style.borderColor} != fill ${style.backgroundColor}`,
        ).toBe(resolve(style.backgroundColor, theme));
      });
    }

    it(`hover inverts around the resting label token on ${theme}`, () => {
      // The variant's whole grammar: one token is the resting label AND the
      // hover fill, so hover is a true colour inversion rather than two
      // loosely-related accents.
      expect(outlined.hoverStyle.backgroundColor).toBe(outlined.color);
      expect(outlined.hoverStyle.color).toBe("$colorInverted");
    });

    it(`label contrast rises from hover to press on ${theme}`, () => {
      // The rung → rung rule, identical to primary's: the press fill moves AWAY
      // from `$colorInverted`. Stub/Swiss deepen (paper/white label), Ember
      // brightens (ink label). Ember's pre-fix `$accentHard` press moved the
      // fill to steel-blue — toward the ink — and cratered to 1.88:1.
      const at = (style: { backgroundColor: string; color?: string }) =>
        contrast(
          resolve(style.color ?? outlined.color, theme),
          resolve(style.backgroundColor, theme),
          t().background,
        );
      const hover = at(outlined.hoverStyle);
      const press = at(outlined.pressStyle);
      expect(
        press,
        `${theme}: outlined press (${press.toFixed(2)}:1) is LESS legible than hover (${hover.toFixed(2)}:1)`,
      ).toBeGreaterThan(hover);
    });

    it(`the hover -> press fill step stays perceptible on ${theme}`, () => {
      // Same 1.15 floor the primary ladder uses (calibrated against the
      // subtlest state step this codebase already ships, background ->
      // backgroundHover at 1.07-1.14). Guards the one-token "fix": on Stub
      // `$accentHard` IS the rest rung, so reusing it scores exactly 1.00 here.
      const hover = resolve(outlined.hoverStyle.backgroundColor, theme);
      const press = resolve(outlined.pressStyle.backgroundColor, theme);
      const step = contrast(hover, press, t().background);
      expect(
        step,
        `${theme}: outlined hover (${hover}) -> press (${press}) = ${step.toFixed(2)}:1 — the ladder collapsed, so press has no affordance`,
      ).toBeGreaterThanOrEqual(1.15);
    });
  }

  it("never labels the control with `$accent` on a theme where that fails", () => {
    // Pins the premise. Stub's accent is a large-surface value: legal for the
    // fills, 2px borders and rules it was tuned for (>=3:1), illegal as a
    // label. Nobody should "simplify" the variant back onto it.
    const stub = themes.stub as Record<string, string>;
    for (const substrate of ["background", "surface"] as const) {
      const ratio = contrast(stub.accent, stub[substrate], stub.background);
      expect(
        ratio,
        `stub: $accent (${stub.accent}) on $${substrate} = ${ratio.toFixed(2)}:1 should be known-bad as small text`,
      ).toBeLessThan(4.5);
    }
    expect(
      resolve(outlined.color, "stub"),
      "outlined labels with $accent on stub, which fails AA as small text",
    ).not.toBe(stub.accent);
  });

  it("leaves DECORATIVE accent text on `$accent` — this is not a global ban", () => {
    // Guards the SCOPE of the fix as much as the fix. The v2 system uses
    // `$accent` for ornament (the mono kicker, tags, index numerals, prices) —
    // largely aria-hidden, and a review already accepted the hero's 01/02/03
    // indices at 3.89:1 on exactly that basis. Only an interactive control's
    // accessible LABEL was moved. If a later change deepens `$accent` itself to
    // "finish the job", this fails and the product-wide visual shift gets a
    // decision instead of a drive-by.
    expect((themes.stub as Record<string, string>).accent).toBe("#E2481D");
    expect((themes.ember as Record<string, string>).accent).toBe("#FF5721");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event-card price-reveal panel — ink-on-paper, no accent (accent budget ≤5%).
//
// The panel fills `$surface` and prints two kinds of row: a normal tier
// (name + price on `$color`) and a sold-out tier (dimmed + struck through on
// `$colorMuted`). The whole point of the sold-out treatment is that it stays
// LEGIBLE — dimming to illegibility is not "struck through", it is hidden — so
// the dimmed pair must still clear the 4.5:1 small-text floor in every theme.
// ─────────────────────────────────────────────────────────────────────────────
describe("EventCard price-reveal panel: every row stays legible on $surface", () => {
  const ROWS = [
    { name: "normal tier", fg: "$color" },
    { name: "sold-out (dimmed + struck)", fg: "$colorMuted" },
  ] as const;

  for (const theme of themeNames) {
    for (const row of ROWS) {
      it(`${row.name} clears WCAG AA (4.5:1) on ${theme}`, () => {
        const t = themes[theme] as Record<string, string>;
        const fg = resolve(row.fg, theme);
        const ratio = contrast(fg, t.surface, t.background);
        expect(
          ratio,
          `${row.name} on ${theme}: ${row.fg} (${fg}) on $surface (${t.surface}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`the sold-out row is visibly dimmer than a normal row on ${theme}`, () => {
      // Sold-out must READ as a demoted state, not just a struck normal row —
      // so `$colorMuted` has to be a perceptible step off `$color`, while still
      // clearing the floor above.
      const t = themes[theme] as Record<string, string>;
      const ink = contrast(t.color, t.surface, t.background);
      const muted = contrast(t.colorMuted, t.surface, t.background);
      expect(
        ink,
        `${theme}: $color (${ink.toFixed(2)}:1) should out-contrast $colorMuted (${muted.toFixed(2)}:1)`,
      ).toBeGreaterThan(muted);
    });
  }
});

describe("color tokens referenced by components actually exist", () => {
  // Pre-existing undefined tokens OUTSIDE the scope of the contrast sweep that
  // introduced this test. Each resolves to nothing at runtime and should be
  // mapped to a real token; they are quarantined here (rather than silently
  // passing) so the list can only shrink. Do NOT add to this list — a new entry
  // means a component is painting with a token that does not exist.
  const KNOWN_UNDEFINED = new Set([
    "$brandPrimaryMuted", // -> ?              (EventListCard)
    // $yellow10 / $red10 / $green10 left with the EventApplicationGate
    // status redesign (2026-09-30): the timeline paints with real tokens.
  ]);

  const defined = new Set<string>([
    ...getThemeTokenKeys(),
    ...Object.keys(colorTokens.color),
  ]);

  const COLOR_PROP =
    /(?:backgroundColor|borderColor|borderLeftColor|borderTopColor|borderBottomColor|borderRightColor|outlineColor|indicatorColor|iconColor|textColor|shadowColor|color)\s*[:=]\s*["'{]?\s*["']?(\$[a-zA-Z][a-zA-Z0-9]*)["']?/g;

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (!/node_modules|dist|__tests__/.test(p)) walk(p);
      } else if (/\.tsx?$/.test(p) && !/\.test\.|\.stories\./.test(p)) {
        files.push(p);
      }
    }
  };
  walk(join(__dirname, "..", "components"));

  it("finds component files to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("every $token used in a color prop is defined in all themes", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(COLOR_PROP)) {
            const token = m[1];
            if (/^\$(true|false|undefined)$/.test(token)) continue;
            if (KNOWN_UNDEFINED.has(token)) continue;
            if (!defined.has(token.slice(1))) {
              offenders.push(
                `${file.split("/components/")[1]}:${i + 1} -> ${token}`,
              );
            }
          }
        });
    }
    expect(
      offenders,
      `These color props reference tokens that do not exist, so they resolve to nothing and silently inherit:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("autocomplete option rows never paint the ink fill", () => {
  // The active/highlighted option renders fixed-ink foregrounds ($color titles,
  // $colorMuted subtitles) that cannot invert per-row, so its fill must stay
  // light. `$surfaceStrong` here = an invisible highlighted row on Stub.
  const AUTOCOMPLETE_FILES = [
    "forms/AutocompleteField.tsx",
    "location/LocationAutocomplete.tsx",
    "location/PlacesAutocomplete.tsx",
    "events/UnifiedSearchAutocomplete.tsx",
    "events/EventSearchAutocomplete.tsx",
  ];

  const read = (rel: string) =>
    readFileSync(join(__dirname, "..", "components", rel), "utf8");

  it.each(AUTOCOMPLETE_FILES)(
    "%s uses no `backgroundColor: $surfaceStrong` on a row state",
    (rel) => {
      const src = read(rel);
      const hits = src
        .split("\n")
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /backgroundColor:\s*"\$surfaceStrong"/.test(l));
      // UnifiedSearchAutocomplete legitimately keeps ONE strong fill: the type
      // icon tile, which hands its glyph $onStructure (see the note there).
      const allowed = rel.includes("UnifiedSearch") ? 1 : 0;
      expect(
        hits.length,
        `${rel} lines ${hits.map((h) => h.i + 1).join(",")}`,
      ).toBe(allowed);
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // The rule above is only half the contract, and on its own it hands out FALSE
  // CONFIDENCE: it asserts the ABSENCE of one bad token, so a file that paints
  // NO active cue at all passes it cleanly. That is exactly how
  // PlacesAutocomplete shipped an unusable keyboard-active row — it dropped
  // `$surfaceStrong` (good) and gained nothing in its place (bad).
  //
  // So assert the PROPERTY instead: a file whose active row is only a soft wash
  // must ALSO carry a >=3:1 non-colour-alone cue. `$surfaceMuted` over
  // `$surface` is 1.18 (Stub) / 1.09 (Swiss) / 1.17 (Ember) — nowhere near
  // WCAG 1.4.11's 3:1 floor for identifying a state, so the wash can NEVER be
  // the signal. The 3px `$accent` left rule is (3.89 / 6.97 / 4.96 against
  // `$surface`; 3.30 / 6.39 / 4.23 against the active row's own
  // `$surfaceMuted` fill — clears 3:1 on both substrates in all three themes),
  // and being a position cue it doesn't rely on colour alone either.
  //
  // `AutocompleteField.moveActive` sets `activeSuggestionId` WITHOUT moving DOM
  // focus, so `focusVisibleStyle` never fires during arrow-key navigation. A
  // focus outline therefore does NOT satisfy this contract.
  const ROW_CONSUMERS = AUTOCOMPLETE_FILES.filter(
    // AutocompleteField is the FRAME: it owns the wash + threads `active` to
    // renderRow, but the row itself (and so the rule) is the consumer's job.
    (rel) => !rel.includes("AutocompleteField"),
  );

  it("the soft active wash is never a legible cue on its own", () => {
    // Pins the premise the rule below exists for. If someone ever makes
    // $surfaceMuted a 3:1 step from $surface, this fails loudly and the
    // accent-rule requirement can be revisited — rather than silently
    // over-constraining.
    for (const theme of themeNames) {
      const t = themes[theme] as Record<string, string>;
      const wash = contrast(t.surfaceMuted, t.surface, t.background);
      expect(
        wash,
        `${theme}: $surfaceMuted on $surface = ${wash.toFixed(2)}:1`,
      ).toBeLessThan(3);
    }
  });

  it.each(ROW_CONSUMERS)(
    "%s pairs its soft active fill with a >=3:1 accent left rule",
    (rel) => {
      const src = read(rel);

      // 1. It must HAVE an `active` variant that paints the soft wash...
      const activeVariant = /active:\s*\{\s*true:\s*\{([\s\S]*?)\}/.exec(src);
      expect(
        activeVariant,
        `${rel} has no \`active: { true: … }\` variant, so the row cannot show which option is keyboard-selected at all`,
      ).not.toBeNull();

      const activeBody = activeVariant![1];
      expect(
        /backgroundColor:\s*"\$surfaceMuted"/.test(activeBody),
        `${rel}: the active variant should paint the \`$surfaceMuted\` wash`,
      ).toBe(true);

      // 2. ...AND back it with the accent left rule, since the wash alone is
      //    sub-3:1 (asserted above).
      expect(
        /borderLeftColor:\s*"\$accent"/.test(activeBody),
        `${rel}: the active variant paints a soft \`$surfaceMuted\` wash with NO \`borderLeftColor: "$accent"\` rule. The wash is ~1.1-1.2:1 — below WCAG 1.4.11's 3:1 — so the active option is unidentifiable during arrow-key navigation (moveActive does not move DOM focus, so focusVisibleStyle never fires).`,
      ).toBe(true);

      // 3. And the rule needs a width to be visible at all — a 3px rule that
      //    only ever exists in the `true` branch would have nothing to
      //    transition from, and `borderLeftWidth: 0` makes the colour moot.
      const width = /borderLeftWidth:\s*(\d+)/.exec(src);
      expect(
        width,
        `${rel}: declares \`borderLeftColor: "$accent"\` but never sets \`borderLeftWidth\`, so the rule paints nothing`,
      ).not.toBeNull();
      expect(Number(width![1])).toBeGreaterThanOrEqual(3);

      // 4. And the row must actually RECEIVE `active` from AutocompleteField —
      //    a variant nothing ever passes is dead style.
      expect(
        /renderRow=\{\(\{[^}]*\bactive\b[^}]*\}\)/.test(src),
        `${rel}: never destructures \`active\` in renderRow, so the active variant is never applied`,
      ).toBe(true);
      expect(
        /\bactive=\{active\}/.test(src),
        `${rel}: never forwards \`active={active}\` to the suggestion row`,
      ).toBe(true);
    },
  );

  it("the accent left rule clears 3:1 on both substrates it can sit on", () => {
    // The rule above is only load-bearing if `$accent` is actually legible
    // against BOTH the resting `$surface` and the active row's own
    // `$surfaceMuted` fill. Guards the token values, not the source text.
    for (const theme of themeNames) {
      const t = themes[theme] as Record<string, string>;
      for (const substrate of ["surface", "surfaceMuted"] as const) {
        const ratio = contrast(t.accent, t[substrate], t.background);
        expect(
          ratio,
          `${theme}: $accent (${t.accent}) on $${substrate} (${t[substrate]}) = ${ratio.toFixed(2)}:1 — the active-row rule no longer clears WCAG 1.4.11`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
