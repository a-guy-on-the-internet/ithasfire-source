import { createElement, forwardRef, type PropsWithChildren } from "react";

/**
 * Stand-in for `@th/ui`'s Tamagui `Text`.
 *
 * The real one needs a Tamagui provider, a font config and a compiled theme —
 * none of which is what these tests are about. What matters at this boundary
 * is that `@th/ui-native`'s `Text` forwards the right COLOUR and the right
 * line clamp, so the stub surfaces both as attributes. Typography itself is
 * `@th/ui`'s to test.
 *
 * ## ⚠️ WHAT THIS STUB DOES AND DOES NOT SURFACE — read before asserting
 *
 * Surfaced, as `data-*` attributes: `testID`, `variant`, `weight`, `color`,
 * `numberOfLines`, `emphasis`, `textTransform`, `accessibilityRole`, and
 * `opacity` flattened out of `style`.
 *
 * **Everything else in `style` is DROPPED.** Font size, line height, letter
 * spacing, margin, padding, flex — none of it reaches the DOM. An assertion
 * about any of those passes no matter what the component does. That is not
 * hypothetical: the full-opacity guard on the scan verdict was written against
 * `element.style.opacity`, stayed green with `opacity: 0.85` planted directly
 * in the stylesheet, and only became real once `opacity` was surfaced here.
 * A guard that cannot fail is worse than no guard.
 *
 * So: if you need to assert a style property, **plant a violation first and
 * watch it go red**. If it does not, add the property to the attribute list
 * below rather than writing the assertion anyway. Layout itself is untestable
 * here regardless — Yoga is not running.
 *
 * `opacity` earns its place because alpha on a verdict tone fill is the bug
 * class this surface already shipped once (a 70% foreground measuring 4.40:1,
 * missing AA by a tenth), and the token-pair contrast test measures TOKENS —
 * it cannot see an alpha applied at a call site.
 */
export type TextProps = PropsWithChildren<{
  variant?: string;
  weight?: string;
  tone?: string;
  emphasis?: "normal" | "muted" | "subtle";
  color?: string;
  letterSpacing?: number;
  textTransform?: string;
  textAlign?: string;
  truncate?: boolean;
  numberOfLines?: number;
  ellipsizeMode?: string;
  style?: unknown;
  accessibilityRole?: string;
  testID?: string;
}>;

/** Flatten an RN style prop (object, array, or nested array) far enough to read `opacity`. */
const styleOpacity = (style: unknown): number | undefined => {
  if (Array.isArray(style)) {
    for (let i = style.length - 1; i >= 0; i -= 1) {
      const found = styleOpacity(style[i]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (style && typeof style === "object") {
    const value = (style as { opacity?: unknown }).opacity;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
};

export const Text = forwardRef<HTMLSpanElement, TextProps>((props, ref) =>
  createElement(
    "span",
    {
      ref,
      "data-testid": props.testID,
      "data-opacity": styleOpacity(props.style),
      "data-variant": props.variant,
      "data-weight": props.weight,
      "data-color": props.color,
      "data-lines": props.numberOfLines,
      "data-emphasis": props.emphasis,
      "data-transform": props.textTransform,
      role: props.accessibilityRole === "header" ? "heading" : undefined,
    },
    props.children,
  ),
);
Text.displayName = "UiTextStub";
