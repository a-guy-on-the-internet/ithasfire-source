"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters } from "@th/ui";

import { fmtDate, truncateId } from "@/lib/format";
import type { AuditLogRow } from "./AuditLogDetail";

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for /platform/audit-log rows on phones (<600px, DataTable's
 * card-mode breakpoint). Composition: entity + action badge, actor (if
 * present), and the timestamp. Tapping the card reveals AuditLogDetail
 * (entity/action/entityId/actor/at + the pretty-printed raw `data` blob),
 * same mechanism as the desktop table's row-expand chevron.
 */
export function AuditLogMobileCard({ row }: { row: AuditLogRow }) {
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
          {row.entity}
        </Text>
        <Badge tone="neutral" size="sm">
          {row.action}
        </Badge>
      </XStack>

      {row.actorHumanId ? (
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {`Actor: ${truncateId(row.actorHumanId)}`}
        </Text>
      ) : null}

      <Text variant="caption" tone="muted">
        {fmtDate(fmt, row.at)}
      </Text>

      <Text variant="code" fontSize={11} tone="muted">
        {truncateId(row.id)}
      </Text>
    </YStack>
  );
}
