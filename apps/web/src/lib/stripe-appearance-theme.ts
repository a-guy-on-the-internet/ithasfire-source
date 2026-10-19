"use client";

import { useEffect, useState } from "react";

/**
 * Shared Stripe Elements theming for the ticket checkout (`StripePaymentCard`)
 * and the membership checkout (`MembershipPaymentStep`).
 *
 * Stripe Elements' `appearance.variables`/`rules` is a plain JS object handed
 * to a third-party iframe — it cannot take a CSS `var()`, exactly like a
 * `<canvas>` fillStyle or a MapLibre paint expression (see the PERMANENT
 * section of `eslint-hex-allowlist.mjs`). So `useThemeColors` reads the live
 * `--color` / `--surface` custom properties (set by `ActiveThemeInjector`),
 * falling back to the Stub hex values for the server render — the same
 * fallback-hex convention as `var(--token, #stubHex)` elsewhere in raw-CSS
 * contexts.
 *
 * On the dark (Ember) theme the field labels and the "Secure, fast checkout
 * with Link" line rendered as near-invisible dark text: the colours were read
 * AFTER the first paint (an effect), the card froze its first options with
 * the Stub fallbacks, and the base `theme` stayed Stripe's light one. Now the
 * vars are read on the first client render, re-read when the theme changes
 * (the injector rewrites `<body>`'s inline vars), and a dark background picks
 * Stripe's `night` base theme.
 */

const FALLBACK_FG = "#211C16";
const FALLBACK_BG = "#FDFAF3";
const FALLBACK_PLACEHOLDER = "#71717a";
/** Stripe's own default `colorDanger` — not a design-system token. */
const STRIPE_DANGER = "#ef4444";

export type StripeThemeColors = {
  fg: string;
  bg: string;
  placeholder: string;
};

const FALLBACK_COLORS: StripeThemeColors = {
  fg: FALLBACK_FG,
  bg: FALLBACK_BG,
  placeholder: FALLBACK_PLACEHOLDER,
};

function readThemeColors(): StripeThemeColors {
  if (typeof document === "undefined" || !document.body) return FALLBACK_COLORS;
  const style = getComputedStyle(document.body);
  const fg = style.getPropertyValue("--color").trim() || FALLBACK_FG;
  const bg = style.getPropertyValue("--surface").trim() || FALLBACK_BG;
  return { fg, bg, placeholder: FALLBACK_PLACEHOLDER };
}

/**
 * Current theme colours for Stripe's iframes — read on the first client
 * render (so the first options Stripe gets are already right) and again
 * whenever the theme changes.
 */
export function useThemeColors(): StripeThemeColors {
  const [colors, setColors] = useState<StripeThemeColors>(readThemeColors);

  useEffect(() => {
    const update = () => {
      const next = readThemeColors();
      setColors((prev) =>
        prev.fg === next.fg && prev.bg === next.bg ? prev : next,
      );
    };
    update();
    // A light ↔ dark switch (or a preset) rewrites the inline vars on
    // <body>; a class / data-theme flip on <html> can change the cascade.
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}

/** `#rgb` / `#rrggbb` / `rgb[a](…)` → [r, g, b], or null if unparseable. */
function parseRgb(color: string): [number, number, number] | null {
  const c = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) {
    return [
      parseInt(short[1]! + short[1]!, 16),
      parseInt(short[2]! + short[2]!, 16),
      parseInt(short[3]! + short[3]!, 16),
    ];
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  if (long) {
    return [
      parseInt(long[1]!, 16),
      parseInt(long[2]!, 16),
      parseInt(long[3]!, 16),
    ];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

/** A dark background (relative luminance under 0.5) — the Ember theme. */
export function isDarkBackground(color: string): boolean {
  const rgb = parseRgb(color);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/**
 * `color` at an alpha, for Stripe's variables (no `var()`, no
 * `color-mix()`): a 6-digit hex gets the alpha byte; `#rgb` is expanded
 * first; anything else is returned opaque rather than made invalid.
 */
function withAlpha(color: string, alphaHex: string): string {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return `${c}${alphaHex}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}${alphaHex}`;
  }
  return c;
}

/**
 * Build the Stripe Elements `appearance` object from theme colors. Callers
 * should memoize this (e.g. `useMemo(() => buildStripeAppearance(themeColors),
 * [themeColors])`) since `<Elements>` treats a new `appearance` reference as
 * grounds to re-render.
 */
export function buildStripeAppearance(themeColors: StripeThemeColors) {
  const dark = isDarkBackground(themeColors.bg);
  return {
    // Stripe's base theme for whatever our variables don't set (the Link
    // line, icons, secondary chrome): `night` on a dark background.
    theme: dark ? ("night" as const) : ("stripe" as const),
    variables: {
      colorPrimary: themeColors.fg,
      colorBackground: themeColors.bg,
      colorText: themeColors.fg,
      // A light placeholder on dark, the muted grey on light.
      colorTextPlaceholder: dark
        ? withAlpha(themeColors.fg, "80")
        : themeColors.placeholder,
      colorTextSecondary: withAlpha(themeColors.fg, "B3"),
      colorDanger: STRIPE_DANGER,
      fontFamily: "system-ui, -apple-system, sans-serif",
      borderRadius: "0px",
      spacingUnit: "4px",
    },
    rules: {
      ".Input": {
        backgroundColor: themeColors.bg,
        border: `1px solid ${withAlpha(themeColors.fg, "1F")}`,
        boxShadow: "none",
        color: themeColors.fg,
      },
      ".Input:focus": {
        border: `1px solid ${withAlpha(themeColors.fg, "4D")}`,
        boxShadow: `0 0 0 2px ${withAlpha(themeColors.fg, "14")}`,
      },
      ".Tab": {
        backgroundColor: themeColors.bg,
        border: `1px solid ${withAlpha(themeColors.fg, "1F")}`,
        boxShadow: "none",
        color: themeColors.fg,
      },
      ".Tab:hover": {
        border: `1px solid ${withAlpha(themeColors.fg, "33")}`,
        color: themeColors.fg,
      },
      ".Tab--selected": {
        backgroundColor: themeColors.bg,
        border: `1px solid ${withAlpha(themeColors.fg, "4D")}`,
        boxShadow: `0 0 0 2px ${withAlpha(themeColors.fg, "14")}`,
        color: themeColors.fg,
      },
      ".TabIcon": {
        fill: themeColors.fg,
      },
      ".TabIcon--selected": {
        fill: themeColors.fg,
      },
      ".Label": {
        color: withAlpha(themeColors.fg, "CC"),
      },
    },
  };
}
