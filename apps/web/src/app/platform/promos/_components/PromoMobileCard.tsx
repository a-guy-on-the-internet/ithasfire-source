"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { formatCurrency } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — used by both the promos table columns and the mobile card
// so badge tones/labels and value formatting stay identical in both modes.
// ─────────────────────────────────────────────────────────────────────────────

export type PromoKind = "PERCENT" | "AMOUNT";

export function formatPromoValue(
  kind: PromoKind,
  value: number,
  currency = "usd",
): string {
  if (kind === "PERCENT") return `${value}%`;
  return formatCurrency(value, currency);
}

export type PromoStatusTone = "neutral" | "warning" | "success";

/**
 * Derive the displayed promo status. ARCHIVED wins, then end-date expiry,
 * then active. `now` is injectable for tests.
 */
export function getPromoStatus(
  status: string,
  endsAt: Date | null,
  now: Date = new Date(),
): { labelKey: string; tone: PromoStatusTone } {
  if (status === "ARCHIVED")
    return { labelKey: "admin.cpArchived", tone: "neutral" };
  if (endsAt && endsAt < now)
    return { labelKey: "admin.cpExpired", tone: "warning" };
  return { labelKey: "admin.cpActive", tone: "success" };
}

export function PromoStatusBadge({
  status,
  endsAt,
}: {
  status: string;
  endsAt: Date | null;
}) {
  const t = useTranslations();
  const { labelKey, tone } = getPromoStatus(status, endsAt);
  return <Badge tone={tone}>{String(t(labelKey))}</Badge>;
}

/**
 * Expiry caption shared by the promos table's expiry column and the mobile
 * card: "No expiry" when there is no end date, red "Expired" when the end
 * date has passed, otherwise the formatted date. `now` is injectable for
 * tests.
 */
export function PromoExpiry({
  endsAt,
  now,
}: {
  endsAt: Date | null;
  now?: Date;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  if (!endsAt) {
    return (
      <Text variant="caption" tone="muted">
        {String(t("admin.cpNoExpiry"))}
      </Text>
    );
  }

  const isExpired = endsAt < (now ?? new Date());
  return (
    <Text variant="caption" color={isExpired ? "$red10" : "$colorMuted"}>
      {isExpired
        ? String(t("admin.cpExpired"))
        : fmt.dateTime(endsAt, { dateStyle: "medium" })}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface PromoMobileCardRow {
  code: string;
  kind: PromoKind;
  value: number;
  currency: string;
  scope: string;
  status: string;
  endsAt: Date | null;
  maxRedemptions: number | null;
  totalRedemptions: number;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for the platform promos table on phones. Composition: promo
 * code (mono, matching the table's mono code column) + status badge, then
 * value + scope, then redemptions + expiry captions.
 */
export function PromoMobileCard({ row }: { row: PromoMobileCardRow }) {
  const t = useTranslations();

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
          <PromoStatusBadge status={row.status} endsAt={row.endsAt} />
        </XStack>
      </XStack>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="bodySmall" weight="bold">
          {formatPromoValue(row.kind, row.value, row.currency)}
        </Text>
        <Badge tone="neutral" size="sm">
          {row.scope}
        </Badge>
      </XStack>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {String(t("admin.cpRedemptionsColumn"))}: {row.totalRedemptions}
          {row.maxRedemptions != null ? ` / ${row.maxRedemptions}` : ""}
        </Text>
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        <PromoExpiry endsAt={row.endsAt} />
      </XStack>
    </YStack>
  );
}
