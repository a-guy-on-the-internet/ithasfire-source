"use client";

import { Text, monoScale, type MonoScaleName, type TextProps } from "@th/ui";

export type MonoProps = Omit<
  TextProps,
  "variant" | "fontSize" | "letterSpacing" | "lineHeight" | "size"
> & {
  /** A rung of the mono ladder — size and tracking travel together. */
  size?: MonoScaleName;
  /** Uppercase label idiom (`overline`); off for times, counts and prices. */
  upper?: boolean;
  /** Override only when the design names an off-ladder pair (range label 15/1.5). */
  fontSize?: number;
  letterSpacing?: number;
  lineHeight?: number;
};

/**
 * IBM Plex Mono text on the DS ladder. `upper` rides `Text variant="overline"`
 * (which owns the uppercase transform) so a caller never hand-rolls
 * uppercase + tracking; the plain form is the same face with the ladder's
 * size/tracking pair for times, counts and index numbers.
 */
export function Mono({
  size = "sm",
  upper = false,
  fontSize,
  letterSpacing,
  lineHeight,
  weight = "semibold",
  ...rest
}: MonoProps) {
  const rung = monoScale[size];
  const fs = fontSize ?? rung.fontSize;
  return (
    <Text
      variant={upper ? "overline" : "code"}
      tag="span"
      fontSize={fs}
      letterSpacing={letterSpacing ?? rung.letterSpacing}
      lineHeight={lineHeight ?? Math.round(fs * 1.3)}
      weight={weight}
      {...rest}
    />
  );
}
