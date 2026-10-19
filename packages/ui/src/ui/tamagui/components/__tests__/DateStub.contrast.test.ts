import {
  darkTheme,
  lightTheme,
  stubTheme,
} from "../../tokens/colors";

/**
 * The Date Stub's colour contract, guarded per theme.
 *
 * The whole reason the in-app stub exists rather than an <img> of the Open
 * Graph PNG is that it FOLLOWS THE VIEWER'S THEME. That makes its legibility a
 * three-way obligation rather than a one-off measurement: the column is a large
 * fill carrying small tracked labels, and `colors.ts` is emphatic that some
 * accent fills in this product have NO WCAG-AA small-text foreground in either
 * polarity. `structure` / `onStructure` is the pairing that does, and this test
 * is what keeps it that way — retune either side of it in any theme and the
 * stub's labels go illegible silently, because nothing else in the product
 * pairs those two tokens at label size.
 */

const THEMES = {
  // `stub` (warm paper) is the shipped default.
  stub: stubTheme,
  // `swiss` — the legacy white theme the embeds depend on.
  swiss: lightTheme,
  // `ember` — the navy dark theme.
  ember: darkTheme,
} as const;

const AA_SMALL_TEXT = 4.5;

/** `.dow{opacity}` — the `Text` atom's `muted` emphasis rung. */
const WEEKDAY_OPACITY = 0.8;

const toRgb = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
};

const relativeLuminance = (hex: string): number => {
  const [r, g, b] = toRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

/** Composite a foreground over a background at a given alpha. */
const composite = (fg: string, bg: string, alpha: number): string => {
  const f = toRgb(fg);
  const b = toRgb(bg);
  return `#${f
    .map((channel, i) =>
      Math.round(channel * alpha + (b[i] as number) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

describe("DateStub colour pairing", () => {
  describe.each(Object.entries(THEMES))("%s", (_name, theme) => {
    it("clears WCAG AA for the day numeral and the mono labels on the stub column", () => {
      expect(
        contrastRatio(theme.onStructure, theme.structure),
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    });

    it("clears WCAG AA for the weekday even at its muted emphasis", () => {
      const weekday = composite(
        theme.onStructure,
        theme.structure,
        WEEKDAY_OPACITY,
      );
      expect(contrastRatio(weekday, theme.structure)).toBeGreaterThanOrEqual(
        AA_SMALL_TEXT,
      );
    });

    it("clears WCAG AA for the title and the place line on the body panel", () => {
      // `.t` is `$color` on `$surface`; `.v` is `$colorMuted` on the same, and
      // so is the note — on a posterless card the ONLY sign it is gated.
      expect(contrastRatio(theme.color, theme.surface)).toBeGreaterThanOrEqual(
        AA_SMALL_TEXT,
      );
      expect(
        contrastRatio(theme.colorMuted, theme.surface),
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    });

    it("does NOT pair the accent fill with a label, in either polarity", () => {
      // The guard rail, stated as a test rather than only as a comment: if
      // someone "brand-ifies" the column by swapping `structure` for `accent`,
      // this records that neither white nor ink would be legal on it in the
      // default theme. `stubTheme.accent` #E2481D is white 4.06 / ink 4.38.
      if (theme !== stubTheme) return;
      expect(contrastRatio("#FFFFFF", theme.accent)).toBeLessThan(
        AA_SMALL_TEXT,
      );
      expect(contrastRatio(theme.color, theme.accent)).toBeLessThan(
        AA_SMALL_TEXT,
      );
    });
  });

  it("records the measured ratios so a retune shows up in the diff", () => {
    const measured = Object.fromEntries(
      Object.entries(THEMES).map(([name, theme]) => [
        name,
        {
          label: Number(
            contrastRatio(theme.onStructure, theme.structure).toFixed(2),
          ),
          weekday: Number(
            contrastRatio(
              composite(theme.onStructure, theme.structure, WEEKDAY_OPACITY),
              theme.structure,
            ).toFixed(2),
          ),
        },
      ]),
    );

    expect(measured).toEqual({
      stub: { label: 16.22, weekday: 10.76 },
      swiss: { label: 6.97, weekday: 5.16 },
      ember: { label: 6.97, weekday: 5.16 },
    });
  });
});
