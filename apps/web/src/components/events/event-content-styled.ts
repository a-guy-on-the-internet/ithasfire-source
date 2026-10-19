import { styled, XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Styled components
// ─────────────────────────────────────────────────────────────────────────────

export const ContentStack = styled(YStack, {
  gap: 20,
});

export const HeroImage = styled(YStack, {
  width: "100%",
  backgroundColor: "transparent",
  justifyContent: "center",
  alignItems: "center",
  overflow: "hidden",
  borderRadius: 0,
});

/**
 * Re-exported so every existing import keeps working. It is a component, not a
 * `styled()`, because `tag` in a styled config never reaches `@th/ui`'s `Text`
 * — see `SectionTitle.tsx` for the measurement.
 */
export { SectionTitle } from "./SectionTitle";

/** Monospace section number prefix — orange accent per Swiss spec. */
export const EventSectionNum = styled(Text, {
  fontFamily: "$mono",
  fontSize: 14,
  letterSpacing: 1.6,
  color: "$brandSecondary",
  tag: "span",
  fontVariant: "tabular-nums" as never,
  marginRight: 6,
});

export const LineupItem = styled(XStack, {
  gap: 10,
  alignItems: "center",
  paddingVertical: 6,
});

export const RoleBadge = styled(XStack, {
  paddingHorizontal: 8,
  paddingVertical: 2,
  borderRadius: 0,
  backgroundColor: "transparent",
  borderWidth: 1,
  borderColor: "$borderColor",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const formatRole = (role: string) =>
  role.charAt(0) + role.slice(1).toLowerCase();
