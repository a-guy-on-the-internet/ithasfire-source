"use client";

import type { CSSProperties } from "react";
import { styled, YStack } from "tamagui";
import { Text } from "@th/ui";

/**
 * Section chrome for the Access Gate invite panel. These repeat the values of
 * EventGateSettings' own (file-local) `Section` / `SectionTitle` /
 * `ApplicationSection`, so "Invite link" and "Invited guests" sit in the same
 * rhythm as the Access Gate and Application form sections around them.
 */

export const InviteSection = styled(YStack, { gap: 12 });

export const InviteSectionTitle = styled(Text, {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "$color",
});

export const InvitePanel = styled(YStack, {
  padding: 16,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  gap: 16,
  minWidth: 0,
});

/** The mono meta line ("Used 23 times · works until the event ends"). */
export const MONO_META_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono-md, 11.5px)",
  lineHeight: 1.5,
  letterSpacing: "var(--tr-mono-md, 1.4px)",
  textTransform: "uppercase",
};

/** Off-screen but announced: the live regions for copy / send results. */
export const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Props that let a long-label Button wrap instead of overflowing a narrow
 * column ("INVITAR A UNA LISTA DE CONTACTOS" in a ~200px panel at 320px).
 * Same recipe as AvailabilitySetupBanner's wrapping link button: auto height
 * over the size's min height, and `whiteSpace` on the label only.
 */
export function wrappingButtonProps(minHeight: number) {
  return {
    height: "auto" as const,
    minHeight,
    maxWidth: "100%" as const,
    flexShrink: 1,
    minWidth: 0,
    paddingVertical: 8,
    textProps: { whiteSpace: "normal" as const },
  };
}
