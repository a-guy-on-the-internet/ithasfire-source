import { createElement, forwardRef } from "react";
import type { ReactElement } from "react";

import {
  iconRegistry,
  type IconGlyph,
  type IconName,
} from "./icon-registry";

/**
 * The only way to render an icon.
 *
 * Three things this centralizes, each of which was previously decided per call
 * site (and decided inconsistently — a sweep of `apps/web` found `size={15}`,
 * `size={16}` and `size={18}` all meaning "inside a control"):
 *
 * 1. **Size.** Four steps, matched to the control ladder. Not a free number.
 * 2. **Colour.** Icons inherit `currentColor`, always. There is no `color`
 *    prop — an icon that carries its own colour is either a status signal
 *    doing it wrong (status is never colour alone, D-074) or a decoration
 *    that has escaped the accent budget.
 * 3. **Accessibility.** An icon is decorative unless it is given a `label`.
 *    Getting this wrong in either direction is the common bug: a decorative
 *    glyph announced to a screen reader, or an icon-only button with no
 *    accessible name at all.
 *
 * It also exists so the Material Symbols Sharp swap stays a one-file change —
 * see `icon-registry.ts`.
 */

/** 16 · 18 (the default, and what sits inside an md control) · 20 · 24 */
export type IconSize = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<IconSize, number> = {
  sm: 16,
  md: 18,
  lg: 20,
  xl: 24,
};

export interface IconProps {
  /**
   * A registered glyph name. Names describe the thing, not the drawing, so
   * they survive an icon-set swap. See `icon-registry.ts`.
   */
  name?: IconName;
  /**
   * Escape hatch: a glyph component this registry does not name yet.
   *
   * Legitimate during the migration off direct `lucide-react` imports, and for
   * genuinely one-off glyphs. If you reach for it twice for the same icon, add
   * a name to the registry instead — an `as` call site is invisible to the set
   * swap and will be missed when it happens.
   */
  as?: IconGlyph;
  /** Defaults to `md` (18px), which is what belongs inside an md control. */
  size?: IconSize;
  /**
   * The accessible name. Supply it when the icon carries meaning on its own —
   * an icon-only button, a status mark with no adjacent text. Omit it when a
   * visible label already says the same thing, and the icon is hidden from
   * assistive tech instead of announcing the label twice.
   */
  label?: string;
  /**
   * Filled rather than outlined — the selected state. Mirrors the Material
   * Symbols `FILL` axis, so the treatment survives the set swap.
   */
  filled?: boolean;
  /**
   * Stroke weight. Defaults to 2, which is what sits correctly on the 2px
   * structural border. Arrows are drawn at 2.5 by convention.
   */
  strokeWidth?: number;
  className?: string;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  {
    name,
    as,
    size = "md",
    label,
    filled = false,
    strokeWidth = 2,
    className,
  },
  ref,
): ReactElement | null {
  const Glyph = as ?? (name ? iconRegistry[name] : undefined);

  if (!Glyph) {
    // A missing glyph must not take the page down, and must not render an
    // empty box either — at the door, in the scanner, a silent gap is worse
    // than an obvious one. Dev gets told; production renders nothing.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error(
        `[Icon] No glyph for name="${String(name)}". Register it in ` +
          "icon-registry.ts, or pass one via the `as` prop.",
      );
    }
    return null;
  }

  const px = SIZE_PX[size];
  const decorative = label === undefined;

  return createElement(Glyph as IconGlyph, {
    // @ts-expect-error — ref is forwarded to the underlying SVG; the shared
    // IconGlyph shape stays minimal so a non-Lucide set can satisfy it.
    ref,
    size: px,
    strokeWidth,
    // `currentColor` is not passed — it is the Lucide default, and stating it
    // here would invite someone to parameterize it.
    fill: filled ? "currentColor" : "none",
    className,
    ...(decorative
      ? { "aria-hidden": true, focusable: false }
      : { role: "img", "aria-label": label }),
  });
});

/** The pixel value for a size step, for callers that must reserve space. */
export const iconSizePx = (size: IconSize = "md"): number => SIZE_PX[size];

export { type IconName, iconNames } from "./icon-registry";
