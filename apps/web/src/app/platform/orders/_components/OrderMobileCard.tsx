"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";
import type { OrderSource, OrderStatus } from "@th/types";

import { formatOrderCode } from "@th/types/order-identifier";

import { fmtCurrency, fmtDate } from "@/lib/format";
import { OrderStatusBadge } from "../../../admin/[slug]/orders/_components/OrderStatusBadge";
import { SOURCE_LABEL_KEY } from "./OrderDetailPanel";

// ─────────────────────────────────────────────────────────────────────────────
// Mobile card (DataTable card mode, <600px)
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderMobileCardRow {
  id: string;
  buyerName: string | null;
  eventTitle: string | null;
  amountGrossCents: number;
  currency: string;
  status: OrderStatus;
  source: OrderSource;
  occurredAt: Date | string;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for platform orders rows on phones. Composition: buyer +
 * status badge, then event title, then date + gross amount (+ resale badge
 * when applicable), then the order code in mono (matching the table's mono id
 * column). Badge tones/labels reuse the table's exact components and maps.
 *
 * The code is `formatOrderCode` — the 8-hex TAIL uppercased — identical to the
 * desktop column and to the detail panel this card opens. It carries a leading
 * `#` because in card mode there is no column header to label it; the desktop
 * cell is bare under its "Order ID" header. Both forms round-trip through
 * `orderIdentifierFromQuery`, which strips one leading `#`.
 */
export function OrderMobileCard({ row }: { row: OrderMobileCardRow }) {
  const t = useTranslations();
  const fmt = useFormatters();

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="bodySmall"
          weight="bold"
          tone={row.buyerName ? "default" : "muted"}
          flex={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.buyerName || String(t("admin.unknownBuyer"))}
        </Text>
        <XStack flexShrink={0}>
          <OrderStatusBadge status={row.status} />
        </XStack>
      </XStack>

      <Text variant="caption" tone="muted" minWidth={0} style={ELLIPSIS_STYLE}>
        {row.eventTitle ?? "Membership" /* i18n: key pending */}
      </Text>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text variant="caption" tone="muted">
          {fmtDate(fmt, row.occurredAt)}
        </Text>
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        <Text variant="bodySmall" weight="bold">
          {fmtCurrency(fmt, row.amountGrossCents, row.currency)}
        </Text>
        {row.source === "RESALE" ? (
          <Badge tone="info" size="sm">
            {String(t(SOURCE_LABEL_KEY[row.source]))}
          </Badge>
        ) : null}
      </XStack>

      <Text variant="code" fontSize={11} tone="muted">
        #{formatOrderCode(row.id)}
      </Text>
    </YStack>
  );
}
