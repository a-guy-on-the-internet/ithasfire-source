"use client";

import type { ReactNode } from "react";
import { NextLinkAnchor, Text, type TextProps } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// A link that LOOKS like a link on this page. A class on `NextLinkAnchor`
// loses to Tamagui's own atomic colour classes (measured: the From / Place /
// Notification settings links rendered as plain ink), so the colour and the
// underline ride a Tamagui `Text` INSIDE the anchor — the same pattern as
// `BookingSystemEntryRow` / `HoldDatePicker`.
//   tone "link" — accentText + underline (board `--link`), for prose links
//   tone "name" — ink + underline, for act names on the bill (board: ink)
// ─────────────────────────────────────────────────────────────────────────────

type InlineLinkProps = {
  href: string;
  children: ReactNode;
  tone?: "link" | "name";
  testId?: string;
} & Pick<TextProps, "variant" | "weight" | "className">;

export function InlineLink({
  href,
  children,
  tone = "link",
  variant = "body",
  weight,
  className,
  testId,
}: InlineLinkProps) {
  return (
    <NextLinkAnchor href={href} {...(testId ? { "data-testid": testId } : {})}>
      <Text
        tag="span"
        variant={variant}
        {...(weight ? { weight } : {})}
        {...(className ? { className } : {})}
        color={tone === "link" ? "$accentText" : "$color"}
        textDecorationLine="underline"
        hoverStyle={{
          color: tone === "link" ? "$accentTextPress" : "$accentText",
        }}
        cursor="pointer"
      >
        {children}
      </Text>
    </NextLinkAnchor>
  );
}
