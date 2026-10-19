"use client";

import { Text, useTranslations } from "@th/ui";
import { XStack, styled, YStack } from "tamagui";

/**
 * A HAIRLINE at 40% of the panel's foreground (26% measured 2.31:1 on ink
 * and vanished; see AUTH_FOOTER_RULE for the same correction), not the 2px full-strength rule
 * this replaces.
 *
 * The two rules flanking "or continue with" sit directly above a stack of 2px
 * outlined buttons. At full weight they drew harder than the controls they
 * were introducing — a divider outranking the thing it divides. 26% keeps the
 * line legible while stepping behind the buttons.
 *
 * `--color` is the panel's foreground, so on the ink auth card this is PAPER
 * at 26% over ink rather than ink over paper — it inverts with the surface
 * for free. `color-mix` rather than an alpha suffix on the var: concatenating
 * one produces invalid CSS (v2 §4). Stub's unrebound value is the fallback.
 */
const Separator = styled(YStack, {
  name: "AuthDividerRule",
  height: 1,
  backgroundColor: "color-mix(in srgb, var(--color, #211C16) 40%, transparent)",
  width: "100%",
});

/** Full-width "— Or continue with —" divider between OAuth and email form. */
export const OrDivider = () => {
  const t = useTranslations();
  return (
    <XStack alignItems="center" gap="$3" width="100%">
      <Separator flex={1} />
      {/* The label idiom, not a hand-rolled imitation of it: `overline` IS
          IBM Plex Mono 11/2px/600 uppercase, which is what the three
          hand-set props here were reaching for. */}
      <Text
        variant="overline"
        color="$colorMuted"
        flexShrink={0}
        whiteSpace="nowrap"
      >
        {String(t("auth.lcOrContinueWith"))}
      </Text>
      <Separator flex={1} />
    </XStack>
  );
};
