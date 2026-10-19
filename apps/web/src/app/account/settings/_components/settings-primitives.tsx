"use client";

import { YStack, styled } from "tamagui";

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
//
// The flat `SETTINGS_SECTIONS` table and the private `SettingsSideRail` that
// consumed it are gone: sections are real routes now, and the grouped nav model
// lives in `../_lib/settings-sections.tsx` (built from `humans.getMyWorkSummary`
// and rendered by the shared `@/components/settings` `SettingsNav`).
// ─────────────────────────────────────────────────────────────────────────────

export const PageContainer = styled(YStack, {
  name: "SettingsPage",
  gap: "$4",
  padding: "$4",
  width: "100%",
  paddingBottom: "$8",
  $gtMd: { padding: "$6", paddingBottom: "$10" },
});

export const SectionCard = styled(YStack, {
  name: "SectionCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  // Swiss structural lines: top rule + left accent, not boxed in
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  borderLeftWidth: 3,
  borderLeftColor: "$accent",
  padding: "$4",
  gap: "$4",
  $gtMd: { padding: "$5" },
});

export const FieldRow = styled(YStack, {
  name: "FieldRow",
  gap: "$2",
});
