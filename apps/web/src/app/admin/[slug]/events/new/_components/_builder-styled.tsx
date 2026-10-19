"use client";

import { styled, XStack, YStack } from "tamagui";

/**
 * Layout primitives shared by the event-builder shell and its extracted
 * sections (`BuilderEssentialsSection`, `BuilderDetailsSection`,
 * `BuilderSettingsSections`). Module-scope `styled()` constants: defining them
 * once here keeps each section file focused on its own markup and keeps
 * EventBuilder's module small.
 *
 * Section-private styled components (date row, the "Hide the address?" link,
 * the publish-dialog frames, the header bar) live next to the component that
 * owns them, not here.
 */

export const Container = styled(YStack, {
  backgroundColor: "$surface",
  width: "100%",
  minHeight: "100vh",
  paddingBottom: 100,
});

export const FormSection = styled(YStack, {
  paddingVertical: 16,
  paddingHorizontal: 32,
  gap: 10,
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
  // 32px padding on each side eats 64px of a 393px phone viewport — way too
  // much. Tighten to 16px on phones so form inputs get usable width.
  $xs: { paddingHorizontal: 16 },
});

export const BlocksSection = styled(YStack, {
  width: "100%",
  paddingVertical: 16,
  paddingHorizontal: 32,
  maxWidth: 960,
  marginHorizontal: "auto",
  $xs: { paddingHorizontal: 16 },
});

/**
 * Full-bleed divider.  When used _inside_ a padded container like
 * `FormSection` (32 px padding), add `marginHorizontal={-32}` and
 * `width="auto"` on the instance so the line spans the full
 * max-width instead of being inset by the padding.
 *
 * When used _outside_ (direct child of `Container`), the default
 * `maxWidth: 960 + marginHorizontal: auto` centres the line
 * exactly like `FormSection`.
 */
export const SectionDivider = styled(XStack, {
  height: 1,
  backgroundColor: "$borderColor",
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

export const BlocksSectionHeader = styled(XStack, {
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 16,
});

/**
 * Container for the named settings accordion groups (FR-102). Shares the
 * 960px centered column with the form sections; each group's header carries
 * its own 2px bottom border, so the container only closes the top edge.
 */
export const SettingsGroupsStack = styled(YStack, {
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
});

/**
 * The inset-divider instance props used inside `FormSection` (32px gutters,
 * 16px on phones). Hoisted so the sections don't mint a fresh `$xs` object per
 * render.
 */
export const INSET_DIVIDER_XS = { marginHorizontal: -16 } as never;
