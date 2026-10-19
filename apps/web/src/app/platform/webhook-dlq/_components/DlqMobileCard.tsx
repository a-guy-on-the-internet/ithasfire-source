"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text } from "@th/ui";

import { truncateProviderId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface DlqMobileCardRow {
  stripeEventId: string;
  eventType: string;
  error: string;
  receivedAt: string;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for the webhook DLQ table on phones. Composition: Stripe
 * event id in mono (matching the table's mono id column), then the event
 * type badge (same neutral tone as the table), then the error and received
 * time. Pressing the card expands DlqDetail, which carries the Stripe link,
 * copy, full payload, and the remove action.
 */
export function DlqMobileCard({ row }: { row: DlqMobileCardRow }) {
  return (
    <YStack gap="$2" minWidth={0}>
      <Text
        variant="code"
        fontSize={12}
        weight="bold"
        minWidth={0}
        style={ELLIPSIS_STYLE}
      >
        {truncateProviderId(row.stripeEventId)}
      </Text>

      <XStack minWidth={0}>
        <Badge tone="neutral" size="sm">
          {row.eventType}
        </Badge>
      </XStack>

      <Text
        variant="caption"
        color="$danger"
        minWidth={0}
        style={ELLIPSIS_STYLE}
      >
        {row.error}
      </Text>

      <Text variant="caption" tone="muted">
        {new Date(row.receivedAt).toLocaleString()}
      </Text>
    </YStack>
  );
}
