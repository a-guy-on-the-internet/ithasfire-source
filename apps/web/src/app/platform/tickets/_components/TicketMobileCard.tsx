"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtDate } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Shared status maps — used by the tickets table columns, the detail panel,
// and the mobile card so badge tones and labels stay identical everywhere.
// ─────────────────────────────────────────────────────────────────────────────

export type TicketStatus =
  | "VALID"
  | "SCANNED"
  | "INVALID"
  | "REFUNDED"
  | "LISTED";

export const TICKET_STATUS_LABEL_KEY: Record<TicketStatus, string> = {
  VALID: "admin.ptStatusValid",
  SCANNED: "admin.ptStatusScanned",
  INVALID: "admin.ptStatusInvalid",
  REFUNDED: "admin.ptStatusRefunded",
  LISTED: "admin.ptStatusListed",
};

export const TICKET_STATUS_TONE_MAP: Record<
  TicketStatus,
  "success" | "info" | "danger" | "neutral" | "warning"
> = {
  VALID: "success",
  SCANNED: "info",
  INVALID: "danger",
  REFUNDED: "neutral",
  LISTED: "warning",
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const t = useTranslations();
  return (
    <Badge tone={TICKET_STATUS_TONE_MAP[status]} size="sm">
      {String(t(TICKET_STATUS_LABEL_KEY[status]))}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface TicketMobileCardRow {
  code: string;
  status: TicketStatus;
  ownerName: string | null;
  eventTitle: string;
  issuedAt: Date;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for the platform tickets table on phones. Composition:
 * ticket code in mono (matching the table's mono code column) + status badge,
 * then owner, then event + issued date.
 */
export function TicketMobileCard({ row }: { row: TicketMobileCardRow }) {
  const t = useTranslations();
  const fmt = useFormatters();

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="code"
          fontSize={12}
          weight="bold"
          flex={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.code}
        </Text>
        <XStack flexShrink={0}>
          <TicketStatusBadge status={row.status} />
        </XStack>
      </XStack>

      <Text
        variant="caption"
        tone="muted"
        minWidth={0}
        style={ELLIPSIS_STYLE}
      >
        {row.ownerName || String(t("admin.ptUnknownOwner"))}
      </Text>

      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="caption"
          tone="muted"
          flexShrink={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.eventTitle}
        </Text>
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        <Text variant="caption" tone="muted" flexShrink={0}>
          {fmtDate(fmt, row.issuedAt)}
        </Text>
      </XStack>
    </YStack>
  );
}
