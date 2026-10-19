"use client";

import { XStack, Stack, styled } from "tamagui";
import { Text, useTranslations } from "@th/ui";

import {
  EVENT_STATUS_LABEL_KEYS,
  type EventStatus,
} from "./event-status-labels";

// ─────────────────────────────────────────────────────────────────────────────
// Status palette — semantic intent tokens (Design System v2)
//
// Replaces the retired purple gradient (derived from the dead #370665 brand),
// which washed out on the Stub warm-paper canvas. Colour now carries INTENT
// only; the translated label carries identity, so statuses that share an intent
// (DRAFT / ARCHIVED are both "not live") may share a hue — they're never
// distinguished by colour alone.
//
// One neutral chip surface ($surfaceMuted), intent in the ink + the edge bar.
// This is the Swiss reading: no pastel tint-per-status chips.
//
// Accessibility — fg on $surfaceMuted (Stub #EFE7D6), WCAG AA (4.5:1 min):
//   DRAFT       $colorMuted  #5C544A   6.1 : 1
//   PUBLISHED   $success     #166534   5.8 : 1
//   COMPLETED   $color       #211C16  13.7 : 1
//   CANCELLED   $dangerSoft  #B91C1C   5.3 : 1
//   ARCHIVED    $colorMuted  #5C544A   6.9 : 1  (on the cream page, no chip)
// ─────────────────────────────────────────────────────────────────────────────

interface StatusStyle {
  /** Text / icon foreground */
  fg: string;
  /** Badge background fill */
  bg: string;
  /** Subtle left-edge indicator bar */
  bar: string;
}

const STATUS_STYLES: Record<EventStatus, StatusStyle> = {
  // Not public yet — neutral, present.
  DRAFT: {
    fg: "$colorMuted",
    bg: "$surfaceMuted",
    bar: "$colorMuted",
  },
  // Live.
  PUBLISHED: {
    fg: "$success",
    bg: "$surfaceMuted",
    bar: "$success",
  },
  // Happened, factual — full ink, no alarm.
  COMPLETED: {
    fg: "$color",
    bg: "$surfaceMuted",
    bar: "$color",
  },
  // Bad terminal state.
  CANCELLED: {
    fg: "$dangerSoft",
    bg: "$surfaceMuted",
    bar: "$danger",
  },
  // Filed away — a ghost: no chip fill, hairline bar.
  ARCHIVED: {
    fg: "$colorMuted",
    bg: "transparent",
    bar: "$borderColorSoft",
  },
};

const BadgeFrame = styled(XStack, {
  name: "EventStatusBadge",
  alignItems: "center",
  borderRadius: 0,
  overflow: "hidden",
  gap: "$2",
  paddingVertical: 3,
  paddingRight: 8,
  paddingLeft: 0,
});

const BarIndicator = styled(Stack, {
  name: "EventStatusBar",
  width: 3,
  alignSelf: "stretch",
});

/**
 * The inline reading: no chip fill, no edge bar — an 8×8 square in the
 * status's bar colour and the mono overline label, sitting in a row of text.
 * For places where the status is a suffix to a title rather than a cell in a
 * table (the builder header), where a framed chip against the title read as
 * a control.
 */
const InlineFrame = styled(XStack, {
  name: "EventStatusInline",
  alignItems: "center",
  gap: "$2",
  flexShrink: 0,
});

const InlineSquare = styled(Stack, {
  name: "EventStatusSquare",
  width: 8,
  height: 8,
  borderRadius: 0,
  flexShrink: 0,
});

const INLINE_LABEL_STYLE = { whiteSpace: "nowrap" } as const;

// A one-word status must never split mid-word. The table sets
// `table-layout: fixed` + `word-break: break-word` on cells, so a label wider
// than its column would otherwise render "PUBLI / SHED". Keep it on one line
// (the frame clips rather than splits if a column is ever dragged too narrow).
const CHIP_LABEL_STYLE = { paddingLeft: 4, whiteSpace: "nowrap" } as const;

interface EventStatusBadgeProps {
  status: EventStatus;
  /**
   * `chip` (default) — the framed table/card badge: muted fill + edge bar.
   * `inline` — square + overline label, no fill, for running beside text.
   */
  appearance?: "chip" | "inline";
}

export function EventStatusBadge({
  status,
  appearance = "chip",
}: EventStatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.DRAFT;
  const t = useTranslations();
  const label = String(
    t(EVENT_STATUS_LABEL_KEYS[status] ?? EVENT_STATUS_LABEL_KEYS.DRAFT),
  );

  if (appearance === "inline") {
    return (
      <InlineFrame aria-label={`Status: ${label}`}>
        <InlineSquare backgroundColor={style.bar} aria-hidden />
        <Text
          variant="overline"
          weight="bold"
          color={style.fg}
          style={INLINE_LABEL_STYLE}
        >
          {label}
        </Text>
      </InlineFrame>
    );
  }

  return (
    <BadgeFrame backgroundColor={style.bg} aria-label={`Status: ${label}`}>
      <BarIndicator backgroundColor={style.bar} />
      <Text
        variant="overline"
        weight="bold"
        fontSize={11}
        letterSpacing={0.6}
        color={style.fg}
        style={CHIP_LABEL_STYLE}
      >
        {label}
      </Text>
    </BadgeFrame>
  );
}

EventStatusBadge.displayName = "EventStatusBadge";
