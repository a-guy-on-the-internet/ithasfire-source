import { describe, expect, it } from "vitest";

import { BUTTON_SIZE_HEIGHTS, BUTTON_VARIANT_STYLES } from "../forms/Button";

/**
 * Regression tests to ensure Button variants retain their core styling.
 *
 * Design System v2 grammar:
 * - Primary: brandSecondary (orange) background, ink text, accent on press
 * - Secondary: structure outline — steel-blue border, fills structure on hover
 * - Ghost: transparent, hovers on the raised chrome fill
 * - Outlined (legacy): old accent outline, values frozen until cleanup
 */
describe("Button variant styles", () => {
  it("keeps primary variant readable across interactive states", () => {
    const primary = BUTTON_VARIANT_STYLES.primary;

    // Rest is `$brandSecondaryHover`, NOT `$brandSecondary`: labels are 11-13px
    // so the 4.5:1 small-text floor applies, and Stub's $brandSecondary
    // (#E2481D) has no AA foreground in either polarity (white 4.06, ink 4.38).
    // v2 §3; the primary CTA rests on the same fill.
    expect(primary.backgroundColor).toEqual("$brandSecondaryHover");
    expect(primary.color).toEqual("$onBrandSecondary");
    // Hover / press climb the same ladder, always AWAY from the label, so
    // contrast rises: Stub deepens, Swiss/Ember brighten. The label token is
    // constant across rungs — the FILL is what moves.
    expect(primary.hoverStyle?.backgroundColor).toEqual(
      "$brandSecondaryStrong",
    );
    expect(primary.hoverStyle?.color).toEqual("$onBrandSecondary");
    expect(primary.pressStyle?.backgroundColor).toEqual("$brandSecondaryPress");
    expect(primary.pressStyle?.color).toEqual("$onBrandSecondary");
    // Real WCAG ratios for every rung on every theme are asserted in
    // `__tests__/contrast-pairs.test.ts` — this test only pins the tokens.
  });

  it("keeps secondary variant as the v2 structure outline", () => {
    const secondary = BUTTON_VARIANT_STYLES.secondary;

    // Base: transparent with structure border and ink label
    expect(secondary.backgroundColor).toEqual("transparent");
    expect(secondary.borderColor).toEqual("$structure");
    expect(secondary.color).toEqual("$color");
    // Hover: fills with structure, label flips to onStructure
    expect(secondary.hoverStyle?.backgroundColor).toEqual("$structure");
    expect(secondary.hoverStyle?.color).toEqual("$onStructure");
    // Press: deepens to structurePress
    expect(secondary.pressStyle?.backgroundColor).toEqual("$structurePress");
    expect(secondary.pressStyle?.color).toEqual("$onStructure");
  });

  it("keeps ghost variant hovering on the raised chrome fill (v2)", () => {
    const ghost = BUTTON_VARIANT_STYLES.ghost;

    expect(ghost.backgroundColor).toEqual("transparent");
    expect(ghost.hoverStyle?.backgroundColor).toEqual("$surfaceRaised");
  });

  it("keeps legacy outlined variant on the legible accent ladder", () => {
    const outlined = BUTTON_VARIANT_STYLES.outlined;

    // Base: the accent hue at LABEL legibility — not `$accent`, which is a
    // large-surface/graphic value (3.57:1 as small text on Stub's canvas).
    expect(outlined.borderColor).toEqual("$accentText");
    expect(outlined.color).toEqual("$accentText");
    // Hover inverts around that same token: it becomes the fill.
    expect(outlined.hoverStyle?.backgroundColor).toEqual("$accentText");
    expect(outlined.hoverStyle?.color).toEqual("$colorInverted");
    // Press takes the next rung. NOT `$accentHard`: identical to the rest rung
    // on Stub (collapses hover === press) and steel-blue on Ember (1.88:1).
    expect(outlined.pressStyle?.backgroundColor).toEqual("$accentTextPress");
  });

  it("pins the v2 size scale (sm 36 / md 44 / lg 54 + compact escape hatches)", () => {
    expect(BUTTON_SIZE_HEIGHTS).toEqual({
      $1: 28,
      $2: 34,
      $3: 36,
      $4: 44,
      $5: 54,
    });
    // v2 "md" is the 44px minimum touch target — icon-only squares mirror
    // these heights as minWidth, so a drop below 44 here is an a11y break.
    expect(BUTTON_SIZE_HEIGHTS.$4).toBeGreaterThanOrEqual(44);
  });
});
