"use client";

import { useTheme, XStack, YStack } from "tamagui";
import { Badge, Button, Text, useTranslations } from "@th/ui";
import {
  CheckCircle2,
  History,
  Play,
  ToggleLeft,
  ToggleRight,
  XCircle,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Shared formatters — used by both the jobs table columns and the mobile card
// so durations and relative times stay identical in table and card modes.
// ─────────────────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface JobMobileCardRow {
  name: string;
  description: string | null;
  enabled: boolean;
  schedule: {
    cron: string;
    cronDescription: string;
  } | null;
  lastRun: {
    status: "success" | "error";
    finishedAt: string;
    durationMs: number;
  } | null;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for platform jobs rows on phones. Composition: job name +
 * enabled badge (same tone/labels as the table column), then description,
 * then schedule + last run, then the run/toggle/history actions.
 *
 * The table keeps Run/Enable/History in a plain "actions" column, which card
 * mode does not render — the card surfaces the same actions as 44px-tall
 * buttons so every job control stays reachable on phones. The History button
 * toggles the same expanded row (run history + DLQ) the table uses.
 */
export function JobMobileCard({
  row,
  isRunning,
  historyOpen,
  onRun,
  onToggleEnabled,
  onToggleHistory,
}: {
  row: JobMobileCardRow;
  isRunning: boolean;
  historyOpen: boolean;
  onRun: () => void;
  onToggleEnabled: () => void;
  onToggleHistory: () => void;
}) {
  const t = useTranslations();
  const theme = useTheme();

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
          {row.name}
        </Text>
        <XStack flexShrink={0}>
          <Badge tone={row.enabled ? "success" : "neutral"} size="sm">
            {row.enabled
              ? String(t("admin.jobsEnabled"))
              : String(t("admin.jobsDisabled"))}
          </Badge>
        </XStack>
      </XStack>

      {row.description ? (
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.description}
        </Text>
      ) : null}

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {row.schedule
            ? row.schedule.cronDescription
            : String(t("admin.jobsOnDemand"))}
        </Text>
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        {row.lastRun ? (
          <XStack gap="$1" alignItems="center">
            {row.lastRun.status === "success" ? (
              <CheckCircle2 size={12} color={theme.success?.val} />
            ) : (
              <XCircle size={12} color={theme.dangerText?.val} />
            )}
            <Text variant="caption" tone="muted">
              {timeAgo(row.lastRun.finishedAt)} (
              {formatDuration(row.lastRun.durationMs)})
            </Text>
          </XStack>
        ) : (
          <Text variant="caption" tone="muted">
            {String(t("admin.jobsNever"))}
          </Text>
        )}
      </XStack>

      <XStack gap="$2" flexWrap="wrap" marginTop="$1">
        <Button size="$2" minHeight={44} onPress={onRun} disabled={isRunning}>
          <Play size={14} />
          {String(t("admin.jobsRunNow"))}
        </Button>
        <Button
          size="$2"
          minHeight={44}
          variant="secondary"
          onPress={onToggleEnabled}
        >
          {row.enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
          {row.enabled
            ? String(t("admin.jobsDisable"))
            : String(t("admin.jobsEnable"))}
        </Button>
        <Button
          size="$2"
          minHeight={44}
          variant={historyOpen ? "primary" : "secondary"}
          onPress={onToggleHistory}
        >
          <History size={14} />
          {String(t("admin.jobsHistory"))}
        </Button>
      </XStack>
    </YStack>
  );
}
