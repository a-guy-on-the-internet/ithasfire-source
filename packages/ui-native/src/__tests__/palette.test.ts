import { describe, expect, it } from "vitest";

import {
  DEFAULT_NATIVE_THEME,
  emberPalette,
  FIXED,
  palettes,
  stubPalette,
} from "../palette";

/**
 * Guard tests for the shared two-theme native palette.
 *
 * These exist because the failure modes here are silent. A key present in Ember
 * but missing from Stub does not throw — it resolves to `undefined`, which React
 * Native treats as "no colour", so the element paints transparent and the bug
 * ships looking like a layout problem. Likewise a colour pair that fails WCAG
 * renders perfectly; it is simply unreadable.
 *
 * The contrast expectations encode the DS v2 divergences that have bitten this
 * codebase before (see docs/design/design-system-v2.md §3), so a well-meaning
 * "simplify the CTA to use `accent` in both themes" change fails here rather
 * than in an operator's hands at a door.
 */

// ── WCAG 2.1 relative luminance / contrast ratio ─────────────────────────────

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
};

const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

/** WCAG AA floors. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3; // 1.4.11 — borders, icons, graphical objects

describe("native palette — structure", () => {
  it("exposes an identical key set in both themes", () => {
    // Checked in BOTH directions: the type only catches Stub missing an Ember
    // key, not Stub carrying a key Ember never defined (which would be a token
    // that silently works in one theme and vanishes in the other).
    expect(Object.keys(stubPalette).sort()).toEqual(
      Object.keys(emberPalette).sort(),
    );
  });

  it("has no undefined or empty values", () => {
    for (const [themeName, palette] of Object.entries(palettes)) {
      for (const [key, value] of Object.entries(palette)) {
        expect(value, `${themeName}.${key}`).toBeTruthy();
        expect(typeof value, `${themeName}.${key}`).toBe("string");
      }
    }
  });

  it("names each theme consistently with its registry key", () => {
    expect(palettes.ember.name).toBe("ember");
    expect(palettes.stub.name).toBe("stub");
  });

  it("defaults to Stub — matching the web app's shipped default theme", () => {
    expect(DEFAULT_NATIVE_THEME).toBe("stub");
  });
});

describe("native palette — contrast floors", () => {
  // Only opaque hex pairs are asserted; rgba tokens (hairlines, scrims,
  // decorative geometry) composite against an unknown backdrop and are covered
  // by the non-text floor on their opaque equivalents instead.
  const themes = [
    ["ember", emberPalette],
    ["stub", stubPalette],
  ] as const;

  for (const [name, c] of themes) {
    describe(name, () => {
      it("body text clears AA on the canvas and on both raised surfaces", () => {
        for (const surface of [c.background, c.surface, c.surfaceRaised]) {
          expect(contrast(c.color, surface)).toBeGreaterThanOrEqual(AA_TEXT);
          expect(contrast(c.colorMuted, surface)).toBeGreaterThanOrEqual(
            AA_TEXT,
          );
        }
      });

      it("the primary CTA's label clears AA on its own fill", () => {
        // The regression this locks: Stub's `ctaFill` must stay at #B93312.
        // White on `accent` (#E2481D) is 4.06:1 — the DS calls #E2481D the one
        // value with no AA foreground in either polarity.
        expect(contrast(c.onCta, c.ctaFill)).toBeGreaterThanOrEqual(AA_TEXT);
      });

      it("the pressed CTA label clears AA on the inverted surface", () => {
        expect(contrast(c.accentText, c.surface)).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      });

      it("the secondary button's border clears the non-text floor", () => {
        // Was steel #35589A at 2.46:1 on navy — under floor on both the border
        // AND the label, on every secondary button in the app.
        expect(contrast(c.borderColor, c.background)).toBeGreaterThanOrEqual(
          AA_NON_TEXT,
        );
        expect(contrast(c.borderColor, c.surface)).toBeGreaterThanOrEqual(
          AA_NON_TEXT,
        );
      });

      it("the secondary button's label clears AA in rest and pressed states", () => {
        expect(contrast(c.color, c.background)).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrast(c.onStructure, c.structure)).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      });

      it("the platform-admin banner's label clears AA on the amber fill", () => {
        // Was white-on-#F59E0B at 2.15:1 — the worst defect in the app, on the
        // one banner whose job is to be impossible to miss.
        expect(contrast(c.onSupport, c.support)).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      });

      it("the token disabled/inert state clears AA", () => {
        // The app's disabled affordance is `colorMuted` on `surfaceMuted`, NOT
        // `opacity`. Opacity blends both the fill and its label toward the
        // canvas, so the pair collapses — a white-on-`ctaFill` button at 0.5
        // measures 2.38:1 on Stub and 2.20:1 on Ember, and the on-device
        // reading for the sign-in CTA was 1.64:1. If you are about to add
        // `opacity: 0.5` to express "disabled", use these tokens instead.
        expect(contrast(c.colorMuted, c.surfaceMuted)).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      });

      it("status GRAPHICS clear the non-text floor on a card surface", () => {
        for (const tone of [c.success, c.danger, c.accent]) {
          expect(contrast(tone, c.surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
        }
      });

      it("status COPY clears the AA text floor on a card surface", () => {
        // Why the `*Soft` rungs exist: the `danger` fill is ~4.0:1 as text.
        for (const tone of [c.dangerSoft, c.warningSoft]) {
          expect(contrast(tone, c.surface)).toBeGreaterThanOrEqual(AA_TEXT);
        }
      });
    });
  }
});

describe("FIXED — theme-invariant surfaces", () => {
  it("keeps camera-overlay controls legible on the black video feed", () => {
    // These must NOT follow the theme: the camera feed is black in Stub exactly
    // as in Ember, so a themed light treatment would vanish in daylight mode.
    for (const value of [
      FIXED.viewfinderStroke,
      FIXED.viewfinderLocked,
      FIXED.cameraControlMuted,
    ]) {
      expect(contrast(value, FIXED.cameraBackdrop)).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it("keeps the JS splash pixel-identical to the native splash", () => {
    // app.config.ts carries its own literals (it is resolved outside the RN
    // runtime), so this coupling is manual — see the note in palette.ts.
    expect(FIXED.splashBackground).toBe("#000000");
    expect(FIXED.splashTint).toBe("#FFFFFF");
  });

  it("keeps the ticket QR at maximum decode contrast in both themes", () => {
    // The QR is read by a camera under venue lighting, not by a human, so it
    // must stay pure black-on-white rather than following the theme. Anything
    // softer eats the decoder's margin — this asserts the full 21:1 so a
    // well-meaning "tone it down to match the surface" change fails loudly.
    expect(FIXED.qrModule).toBe("#000000");
    expect(FIXED.qrQuietZone).toBe("#FFFFFF");
    expect(contrast(FIXED.qrModule, FIXED.qrQuietZone)).toBeGreaterThanOrEqual(
      21,
    );
  });
});
