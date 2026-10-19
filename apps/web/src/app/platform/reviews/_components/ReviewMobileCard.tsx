"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Button, Text, useTranslations } from "@th/ui";
import { Eye, EyeOff } from "lucide-react";

import { formatDateShort } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper — used by both the reviews table status column and the mobile
// card so badge tones and labels stay identical in table and card modes.
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewModerationTone = "danger" | "warning" | "success";

/** Hidden wins, then flagged, then visible — same precedence as the table. */
export function getReviewModerationStatus(row: {
  hidden: boolean;
  flagged: boolean;
}): { labelKey: string; tone: ReviewModerationTone } {
  if (row.hidden) return { labelKey: "admin.rmHidden", tone: "danger" };
  if (row.flagged) return { labelKey: "admin.rmFlagged", tone: "warning" };
  return { labelKey: "admin.rmVisible", tone: "success" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewMobileCardRow {
  placeName: string;
  anonymousName: string | null;
  comment: string | null;
  hidden: boolean;
  flagged: boolean;
  createdAt: string;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for the platform reviews table on phones. Composition:
 * venue + moderation badge, then the comment, then reviewer + date.
 *
 * Card mode does not render the table's rowActions, so the hide/unhide
 * moderation action is surfaced directly on the card (44px target). The
 * wrapper stops propagation so pressing it never triggers the card's
 * onRowPress (which opens the detail panel).
 */
export function ReviewMobileCard({
  row,
  onToggleHidden,
  isMutating,
}: {
  row: ReviewMobileCardRow;
  onToggleHidden: () => void;
  isMutating: boolean;
}) {
  const t = useTranslations();
  const status = getReviewModerationStatus(row);

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="bodySmall"
          weight="bold"
          flex={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.placeName}
        </Text>
        <XStack flexShrink={0}>
          <Badge tone={status.tone} size="sm">
            {String(t(status.labelKey))}
          </Badge>
        </XStack>
      </XStack>

      <Text variant="caption" tone="muted" minWidth={0} style={ELLIPSIS_STYLE}>
        {row.comment ?? String(t("admin.rmNoComment"))}
      </Text>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {row.anonymousName ?? String(t("admin.rmAnonymous"))}
        </Text>
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        <Text variant="caption" tone="muted">
          {formatDateShort(row.createdAt)}
        </Text>
      </XStack>

      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{ alignSelf: "flex-start" }}
      >
        <Button
          variant="secondary"
          size="$2"
          minHeight={44}
          onPress={onToggleHidden}
          disabled={isMutating}
        >
          {row.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          {row.hidden ? String(t("admin.rmUnhide")) : String(t("admin.rmHide"))}
        </Button>
      </div>
    </YStack>
  );
}
