"use client";

import { XStack, YStack } from "tamagui";
import { Button, Text, useFormatters } from "@th/ui";
import { X } from "lucide-react";

import { fmtDate } from "@/lib/format";

type DateFmt = ReturnType<typeof useFormatters>;

// ─────────────────────────────────────────────────────────────────────────────
// Types (shared with parent page)
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: string;
  entity: string;
  entityId: string | null;
  action: string;
  data: unknown;
  actorHumanId: string | null;
  at: Date;
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <XStack
      justifyContent="space-between"
      alignItems="flex-start"
      paddingVertical={4}
      gap="$2"
    >
      <Text variant="caption" tone="muted" fontSize={12} minWidth={90}>
        {label}
      </Text>
      {typeof children === "string" ? (
        <Text
          variant="body"
          fontSize={13}
          style={{ textAlign: "right", wordBreak: "break-all" }}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </XStack>
  );
}

/** Pretty-print the raw `data` JSON blob. Never hand-formatted per entity. */
function formatDataBlob(data: unknown): string {
  try {
    return JSON.stringify(data ?? {}, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * Read-only expanded-row detail for a single audit-log row: entity/action/
 * entityId/actor/timestamp, plus the raw `data` JSON blob pretty-printed
 * (never hand-formatted — see the /platform/audit-log page's doc comment for
 * why per-entity sentence formatting is out of scope for v1).
 */
export function AuditLogDetail({
  row,
  onClose,
  fmt,
}: {
  row: AuditLogRow;
  onClose: () => void;
  fmt: DateFmt;
}) {
  return (
    <YStack
      padding={20}
      gap={16}
      backgroundColor="$backgroundStrong"
      borderTopWidth={1}
      borderBottomWidth={1}
      borderColor="$borderColor"
      data-testid="audit-log-detail"
    >
      <XStack justifyContent="space-between" alignItems="center">
        <Text variant="h4" fontSize={16} weight="bold">
          Audit Entry Detail
        </Text>
        <Button
          variant="ghost"
          size="$1"
          onPress={onClose}
          aria-label="Close detail"
        >
          <X size={16} />
        </Button>
      </XStack>

      <YStack gap={2}>
        <DetailRow label="Entity">{row.entity}</DetailRow>
        <DetailRow label="Action">{row.action}</DetailRow>
        <DetailRow label="Entity ID">{row.entityId ?? "—"}</DetailRow>
        <DetailRow label="Actor">{row.actorHumanId ?? "—"}</DetailRow>
        <DetailRow label="At">{fmtDate(fmt, row.at)}</DetailRow>
      </YStack>

      <YStack gap={4}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Raw Data
        </Text>
        <YStack
          backgroundColor="$background"
          borderRadius={0}
          padding={12}
          maxHeight={400}
          overflow="scroll"
        >
          <Text variant="code" fontSize={11} whiteSpace="pre-wrap">
            {formatDataBlob(row.data)}
          </Text>
        </YStack>
      </YStack>
    </YStack>
  );
}
