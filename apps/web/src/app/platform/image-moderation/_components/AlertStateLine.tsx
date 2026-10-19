"use client";

import type { CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import { Text } from "@th/ui";
import { BellOff, BellRing, ShieldQuestion } from "lucide-react";

import {
  describeAlertState,
  type AlertStateTone,
  type ModerationAlertState,
} from "./image-moderation-ops.helpers";

/**
 * Has Discord already been paged about this, or is it news?
 *
 * The hourly alert is EDGE-TRIGGERED: it fires once per distinct problem
 * picture and then goes quiet until the picture changes. So "7 awaiting review"
 * looks identical whether somebody is already sitting on it or nobody has been
 * told — and that is the first thing an operator needs to know, before they
 * decide whether to act or to go find whoever is already acting.
 *
 * FOUR STATES, RENDERED DISTINCTLY. `never_paged` and `cleared` both mean
 * nothing is currently paging and both read calm. `paged` is the only one that
 * earns chrome. `unreadable` MUST NOT LOOK LIKE `cleared`: both carry a null
 * fingerprint, and only one of them means "nothing is wrong" — so it borrows
 * the provider band's no-answer idiom (dashed hairline, question mark) rather
 * than the quiet one.
 *
 * The read is READ-ONLY server-side and that is load-bearing: the procedure
 * that would otherwise answer this question WRITES the fingerprint as part of
 * its gate, so polling it here would reset the suppression window on every page
 * load and re-arm an alert that had already fired.
 */

const ICON: CSSProperties = { flexShrink: 0 };
/** Signal names come from a stored fingerprint and are not enum-validated. */
const BREAK_ANYWHERE: CSSProperties = { overflowWrap: "anywhere" };

/**
 * Cap on rendered signal names. A fingerprint is a pipe-joined string written
 * by whatever deploy was live at the time; five is the real maximum today, and
 * a malformed row must not be able to paint an unbounded list.
 */
const MAX_SIGNALS = 6;

type Chrome = {
  borderColor: string;
  borderStyle: "solid" | "dashed";
  borderWidth: number;
  backgroundColor: string;
  iconColor: string;
};

const CHROME: Record<AlertStateTone, Chrome> = {
  // Calm is a hairline, not a box: nothing paging is the healthy state and the
  // loudest things on this page stay the tiles and the provider band.
  calm: {
    borderColor: "$borderColorSoft",
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: "transparent",
    iconColor: "var(--colorMuted, #5C544A)",
  },
  warning: {
    borderColor: "$warning",
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: "$surfaceMuted",
    iconColor: "var(--warning, #92400E)",
  },
  unknown: {
    borderColor: "$borderColorSoft",
    borderStyle: "dashed",
    borderWidth: 1,
    backgroundColor: "$surfaceMuted",
    iconColor: "var(--colorMuted, #5C544A)",
  },
};

export type AlertStateLineProps = {
  state: ModerationAlertState | undefined;
  firingSignals: readonly string[] | undefined;
  lastPagedAt: Date | null | undefined;
  isLoading: boolean;
  /** Set when the read itself failed — distinct from `unreadable`. */
  errorMessage?: string;
  /** The page's single "now", so the paged age matches every other age. */
  now: Date;
};

export function AlertStateLine({
  state,
  firingSignals,
  lastPagedAt,
  isLoading,
  errorMessage,
  now,
}: AlertStateLineProps) {
  // A FAILED READ IS NOT `unreadable`. `unreadable` is a corrupt stored value —
  // a bookkeeping defect the page can describe. This is "the query did not come
  // back", which says nothing about the alert at all. Both render as a
  // no-answer, and neither is allowed to render as an all-clear.
  const copy = errorMessage
    ? {
        tone: "unknown" as const,
        headline: "Alert state is unavailable",
        detail: `${errorMessage} This page cannot say whether anyone has been paged.`,
        signals: [] as string[],
      }
    : state
      ? describeAlertState({
          state,
          firingSignals: firingSignals ?? [],
          lastPagedAt: lastPagedAt ?? null,
          now,
        })
      : null;

  if (!copy) {
    return (
      <Text variant="caption" tone="muted">
        {isLoading
          ? "Checking whether Discord has paged…"
          : "Alert state not read."}
      </Text>
    );
  }

  const chrome = CHROME[copy.tone];
  const Icon =
    copy.tone === "warning"
      ? BellRing
      : copy.tone === "unknown"
        ? ShieldQuestion
        : BellOff;

  const shown = copy.signals.slice(0, MAX_SIGNALS);
  const overflow = copy.signals.length - shown.length;

  return (
    <XStack
      gap="$2"
      paddingVertical="$2"
      paddingHorizontal="$3"
      alignItems="flex-start"
      borderWidth={chrome.borderWidth}
      borderRadius={0}
      borderColor={chrome.borderColor}
      borderStyle={chrome.borderStyle}
      backgroundColor={chrome.backgroundColor}
      flexWrap="wrap"
      flexShrink={1}
      minWidth={0}
    >
      <Icon size={14} color={chrome.iconColor} style={ICON} aria-hidden />
      <YStack gap="$1" flex={1} flexShrink={1} minWidth={0}>
        <Text variant="caption" weight="bold">
          {copy.headline}
        </Text>
        {shown.length > 0 ? (
          <Text variant="caption" tone="muted" style={BREAK_ANYWHERE}>
            Firing: {shown.join(" · ")}
            {overflow > 0 ? ` · +${overflow} more` : ""}
          </Text>
        ) : null}
        <Text variant="caption" tone="muted">
          {copy.detail}
        </Text>
      </YStack>
    </XStack>
  );
}
