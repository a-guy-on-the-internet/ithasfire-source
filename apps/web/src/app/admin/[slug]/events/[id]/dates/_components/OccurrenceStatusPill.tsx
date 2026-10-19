"use client";

import { Stack, styled, XStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import type { SeriesDateRowKind } from "./series-dates-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Occurrence status pill — mirrors EventStatusBadge's Swiss reading (one
// neutral chip surface, intent carried by the ink + edge bar; never colour
// alone) with the Dates page's two extra states.
//
// Accessibility — fg on $surfaceMuted (Stub #EFE7D6), WCAG AA (4.5:1 min):
//   PUBLISHED  $success      #166534   5.8 : 1
//   DRAFT      $warningSoft  #92400E   5.9 : 1
//   CANCELLED  $dangerSoft   #B91C1C   5.3 : 1
//   COMPLETED  $color        #211C16  13.7 : 1  (happened, factual — full ink)
//   PLANNED    $colorMuted   #5C544A   6.9 : 1  (outline chip on the page)
//   SKIPPED    $colorMuted             6.9 : 1  (ghost — the struck date
//   ARCHIVED   $colorMuted             6.9 : 1   carries the state)
//   DETACHED   $colorMuted             6.9 : 1
// ─────────────────────────────────────────────────────────────────────────────

type PillStyle = {
  fg: string;
  bg: string;
  bar: string | null;
  outlined?: boolean;
};

const PILL_STYLES: Record<SeriesDateRowKind, PillStyle> = {
  published: { fg: "$success", bg: "$surfaceMuted", bar: "$success" },
  "draft-ready": { fg: "$warningSoft", bg: "$surfaceMuted", bar: "$warningSoft" },
  "draft-unready": {
    fg: "$warningSoft",
    bg: "$surfaceMuted",
    bar: "$warningSoft",
  },
  // "Planned" is the outline state — no fill, hairline frame.
  planned: { fg: "$colorMuted", bg: "transparent", bar: null, outlined: true },
  skipped: { fg: "$colorMuted", bg: "transparent", bar: "$borderColorSoft" },
  cancelled: { fg: "$dangerSoft", bg: "$surfaceMuted", bar: "$danger" },
  // Happened, factual — full ink, no alarm (mirrors EventStatusBadge).
  completed: { fg: "$color", bg: "$surfaceMuted", bar: "$color" },
  archived: { fg: "$colorMuted", bg: "transparent", bar: "$borderColorSoft" },
  detached: { fg: "$colorMuted", bg: "transparent", bar: "$borderColorSoft" },
};

const LABEL_KEYS: Record<SeriesDateRowKind, string> = {
  published: "admin.sdStatusPublished",
  "draft-ready": "admin.sdStatusDraft",
  "draft-unready": "admin.sdStatusDraft",
  planned: "admin.sdStatusPlanned",
  skipped: "admin.sdStatusSkipped",
  cancelled: "admin.sdStatusCancelled",
  completed: "admin.sdStatusCompleted",
  archived: "admin.sdStatusArchived",
  detached: "admin.sdStatusDetached",
};

const PillFrame = styled(XStack, {
  name: "OccurrenceStatusPill",
  alignItems: "center",
  alignSelf: "flex-start",
  borderRadius: 0,
  overflow: "hidden",
  gap: "$2",
  paddingVertical: 3,
  paddingRight: 8,
  paddingLeft: 0,
});

const BarIndicator = styled(Stack, {
  name: "OccurrenceStatusBar",
  width: 3,
  alignSelf: "stretch",
});

export function OccurrenceStatusPill({ kind }: { kind: SeriesDateRowKind }) {
  const t = useTranslations();
  const style = PILL_STYLES[kind];
  const label = String(t(LABEL_KEYS[kind]));

  return (
    <PillFrame
      backgroundColor={style.bg}
      {...(style.outlined
        ? {
            borderWidth: 1,
            borderColor: "$borderColorSoft",
            paddingLeft: 8,
          }
        : {})}
      aria-label={String(t("admin.sdStatusAria", { label }))}
    >
      {style.bar ? <BarIndicator backgroundColor={style.bar} /> : null}
      <Text
        variant="overline"
        weight="bold"
        fontSize={11}
        letterSpacing={0.6}
        color={style.fg}
        style={{ paddingLeft: style.bar ? 4 : 0 }}
      >
        {label}
      </Text>
    </PillFrame>
  );
}

OccurrenceStatusPill.displayName = "OccurrenceStatusPill";
