"use client";

import type { CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import { Text } from "@th/ui";
import { AlertTriangle, Trash2 } from "lucide-react";

import {
  describeDeletionOutbox,
  type DeletionOutboxCounts,
  type DeletionOutboxTone,
} from "./image-moderation-ops.helpers";

/**
 * "Rejected" does not mean the bytes are gone.
 *
 * A moderator REJECT writes the decision and enqueues the R2 object into the
 * deletion outbox in ONE transaction — which makes the ENQUEUE reliable and
 * says nothing about the DRAIN. If the drain stalls or dead-letters, we told an
 * uploader their image was removed while the file is still being served from a
 * public CDN, and the moderation record reads REJECTED, which is true and
 * beside the point. Nothing surfaced this before.
 *
 * DELIBERATELY NOT A SIXTH TILE. The five above are the alert's signal set,
 * predicate for predicate, and this is not one of them — a sixth tile would
 * read as a sixth thing Discord pages on. It is one compact row instead: less
 * weight than a tile, its own rule, and copy that leads with the consequence
 * rather than the mechanism.
 */

const ICON: CSSProperties = { flexShrink: 0 };

type RowChrome = {
  borderLeftColor: string;
  iconColor: string;
};

const ROW_CHROME: Record<DeletionOutboxTone, RowChrome> = {
  // Zero stays calm. A healthy outbox is the common case and must not read as
  // an alarm — the same rule the tiles follow.
  calm: {
    borderLeftColor: "$borderColorSoft",
    iconColor: "var(--colorMuted, #5C544A)",
  },
  warning: {
    borderLeftColor: "$warning",
    iconColor: "var(--warning, #92400E)",
  },
  danger: {
    borderLeftColor: "$danger",
    iconColor: "var(--danger, #B91C1C)",
  },
};

export type DeletionOutboxRowProps = {
  outbox: DeletionOutboxCounts;
};

export function DeletionOutboxRow({ outbox }: DeletionOutboxRowProps) {
  const copy = describeDeletionOutbox(outbox);
  const chrome = ROW_CHROME[copy.tone];
  const Icon = copy.tone === "calm" ? Trash2 : AlertTriangle;

  return (
    <XStack
      gap="$3"
      paddingVertical="$3"
      paddingHorizontal="$4"
      alignItems="flex-start"
      borderWidth={1}
      borderRadius={0}
      borderColor="$borderColor"
      borderLeftWidth={3}
      borderLeftColor={chrome.borderLeftColor}
      backgroundColor="$surface"
      flexWrap="wrap"
      flexShrink={1}
      minWidth={0}
    >
      <Icon size={16} color={chrome.iconColor} style={ICON} aria-hidden />
      {/* minWidth 0, never a pixel floor: inside the platform rail at a 320px
          viewport this box is ~200px, and a floor wider than the box IS the
          overflow. Tamagui's web Stack also defaults to `flex-shrink: 0`. */}
      <YStack gap="$1" flex={1} flexShrink={1} minWidth={0}>
        <Text variant="bodySmall" weight="bold">
          {copy.headline}
        </Text>
        <Text variant="caption" tone="muted">
          {copy.detail}
        </Text>
      </YStack>
    </XStack>
  );
}
