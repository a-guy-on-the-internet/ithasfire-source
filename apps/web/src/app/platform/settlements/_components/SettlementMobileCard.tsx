"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtCurrency, fmtDateShort, truncateId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Status badge — shared by the platform settlements table column, the detail
// panel, and the mobile card so tones and labels stay identical everywhere.
// ─────────────────────────────────────────────────────────────────────────────

export const SETTLEMENT_STATUS_LABEL_KEY: Record<string, string> = {
  pending: "admin.pstStatusPending",
  transferred: "admin.pstStatusTransferred",
  failed: "admin.pstStatusFailed",
};

export function SettlementStatusBadge({ status }: { status: string }) {
  const t = useTranslations();
  const tone =
    status === "transferred"
      ? "success"
      : status === "failed"
        ? "danger"
        : "warning";
  return (
    <Badge tone={tone} size="sm">
      {String(t(SETTLEMENT_STATUS_LABEL_KEY[status] ?? status))}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface SettlementMobileCardRow {
  id: string;
  payeeLabel: string | null;
  payeeSubjectId: string;
  eventTitle: string | null;
  amountCents: number;
  currency: string;
  status: string;
  scheduledPayoutDate: Date;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for the platform settlements table on phones. Composition:
 * payee + status badge, then amount + scheduled payout date, then the event
 * title, then the settlement id in mono (matching the table's mono columns).
 */
export function SettlementMobileCard({
  row,
}: {
  row: SettlementMobileCardRow;
}) {
  const fmt = useFormatters();

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
          {row.payeeLabel || truncateId(row.payeeSubjectId)}
        </Text>
        <XStack flexShrink={0}>
          <SettlementStatusBadge status={row.status} />
        </XStack>
      </XStack>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="bodySmall" weight="bold">
          {fmtCurrency(fmt, row.amountCents, row.currency)}
        </Text>
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        <Text variant="caption" tone="muted">
          {fmtDateShort(fmt, row.scheduledPayoutDate)}
        </Text>
      </XStack>

      {row.eventTitle ? (
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.eventTitle}
        </Text>
      ) : null}

      <Text variant="code" fontSize={11} tone="muted">
        {truncateId(row.id)}
      </Text>
    </YStack>
  );
}
