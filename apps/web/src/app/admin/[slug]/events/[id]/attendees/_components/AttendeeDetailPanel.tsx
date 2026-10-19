"use client";

import { useMemo } from "react";
import { XStack, YStack, styled } from "tamagui";

const Separator = styled(YStack, {
  name: "StructuralLine",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
});
import {
  Text,
  Spinner,
  Badge,
  OverflowTooltip,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Package } from "lucide-react";

import { trpc } from "@/trpc";
import { fmtCurrency } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AttendeeDetailPanelProps {
  orderId: string;
  orgId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function AttendeeDetailPanel({
  orderId,
  orgId,
}: AttendeeDetailPanelProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const {
    data: order,
    isLoading,
    error,
  } = trpc.orders.getOrgOrder.useQuery(
    { orgId, orderId },
    { staleTime: 15_000 },
  );

  // Group items by ticket type for a clean summary
  const ticketSummary = useMemo(() => {
    if (!order) return [];
    const grouped = new Map<
      string,
      {
        name: string;
        qty: number;
        unitPriceCents: number;
        totalCents: number;
        activeCount: number;
        refundedCount: number;
      }
    >();

    for (const item of order.items) {
      const ttId = item.ticketTypeId ?? "__unknown";
      const name = item.ticketTypeId
        ? (order.ticketTypeNames[item.ticketTypeId] ?? "Unknown ticket")
        : item.kind;
      const existing = grouped.get(ttId);
      if (existing) {
        existing.qty += item.qty;
        existing.totalCents += item.amountCents;
        if (item.status === "active") existing.activeCount += item.qty;
        if (item.status === "refunded") existing.refundedCount += item.qty;
      } else {
        grouped.set(ttId, {
          name,
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
          totalCents: item.amountCents,
          activeCount: item.status === "active" ? item.qty : 0,
          refundedCount: item.status === "refunded" ? item.qty : 0,
        });
      }
    }

    return Array.from(grouped.values());
  }, [order]);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <XStack padding="$3" justifyContent="center">
        <Spinner size="sm" />
      </XStack>
    );
  }

  if (error || !order) {
    return (
      <XStack padding="$3" justifyContent="center">
        <Text variant="caption" tone="muted">
          {String(t("admin.failedToLoadDetails"))}
        </Text>
      </XStack>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <YStack paddingVertical="$2" paddingHorizontal="$4" gap="$2">
      {/* Buyer / order reference for quick verification */}
      {/* `maxWidth="100%"` on every field block, not just decoration: these are
          wrap items and RNW/Tamagui defaults them to `flexShrink: 0`, so their
          base size is MAX-CONTENT. A 36-char order UUID and a long email
          therefore sized the block past the container and out of the viewport
          (live-measured at 320px: right=360 for the id, 331 for the email).

          The minWidths must stay BELOW the panel's content box or they defeat
          this outright — CSS resolves used width as
          `max(min-width, min(max-width, width))`, so min-width wins and
          maxWidth cannot bind. The panel content box is ~166px at a 320px
          viewport (198px card less `paddingHorizontal="$4"` a side), which is
          why the email block's old 180 is now 140: at 180 the ellipsis
          engaged ~14px outside the visible edge and the overrun was merely
          HIDDEN by ExpandRevealFrame's `overflow: hidden`, not prevented. */}
      <XStack gap="$4" flexWrap="wrap" paddingVertical="$1">
        <YStack gap="$1" minWidth={140} maxWidth="100%">
          <Text variant="overline" tone="muted">
            {String(t("admin.orderId"))}
          </Text>
          <OverflowTooltip
            variant="body"
            style={{ fontFamily: "monospace", fontSize: 13 }}
            text={orderId}
          />
        </YStack>
        {order.buyerName && (
          <YStack gap="$1" minWidth={140} maxWidth="100%">
            <Text variant="overline" tone="muted">
              {String(t("admin.buyer"))}
            </Text>
            <OverflowTooltip
              variant="body"
              style={{ fontWeight: 700 }}
              text={order.buyerName}
            />
          </YStack>
        )}
        {order.buyerEmail && (
          <YStack gap="$1" minWidth={140} maxWidth="100%">
            <Text variant="overline" tone="muted">
              {String(t("admin.emailColumn"))}
            </Text>
            <OverflowTooltip variant="body" text={order.buyerEmail} />
          </YStack>
        )}
        <YStack gap="$1" minWidth={100} maxWidth="100%">
          <Text variant="overline" tone="muted">
            {String(t("admin.status"))}
          </Text>
          <Badge
            tone={
              order.status === "SUCCEEDED"
                ? "success"
                : order.status === "REFUNDED" || order.status === "CANCELLED"
                  ? "danger"
                  : order.status === "PART_REFUNDED" ||
                      order.status === "DISPUTED"
                    ? "warning"
                    : "info"
            }
            size="sm"
          >
            {order.status.replace("_", " ")}
          </Badge>
        </YStack>
      </XStack>

      <Separator marginVertical="$1" />

      {/* Tickets header */}
      <XStack alignItems="center" gap="$2">
        <Package size={14} color="var(--colorMuted, #5C544A)" />
        <Text variant="overline" tone="muted">
          {String(t("admin.ticketsPurchased"))}
        </Text>
      </XStack>

      <Separator marginVertical="$1" />

      {/* Ticket type rows */}
      {/* `flexWrap="wrap"`: the three numeric cells are fixed at 40+80+80 with
          $3 gaps — 236px of hard minimum against ~216px of card width at
          320px, so the order total was measured hanging 82px outside the
          viewport. Wrapping moves the trailing figure to a second line
          instead. The name keeps `flex: 1` (basis 0), so it contributes
          nothing to the line-break calculation and simply shrinks. */}
      {ticketSummary.map((tt, idx) => (
        <XStack
          key={idx}
          gap="$3"
          alignItems="center"
          paddingVertical="$1"
          flexWrap="wrap"
        >
          {/* NOT `flex: 1` on the text. That is basis 0%, so on a phone the
              name shrank to whatever the three fixed numeric cells left over —
              live-measured at 320px, "General Admission" rendered as "G..".
              A real minimum makes the row WRAP instead of annihilating the one
              field that says what was bought.

              The flex props live on a WRAPPER, and the value goes through
              `OverflowTooltip` (as orderId / buyer / email already do above),
              because a hand-rolled `overflow/textOverflow/whiteSpace` clamp is
              NOT a no-op on desktop: the DS `Text` opts into truncation via
              `truncate` and defaults to wrapping, so clamping here would clip
              a long ticket-type name at EVERY width with no tooltip and no way
              to read the rest. OverflowTooltip clips only when the value
              actually overflows, and surfaces the full string when it does. */}
          <YStack flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={120}>
            <OverflowTooltip
              variant="body"
              style={{ fontWeight: 700 }}
              text={tt.name}
            />
          </YStack>
          <Text
            variant="body"
            style={{
              fontVariantNumeric: "tabular-nums",
              minWidth: 40,
              textAlign: "right",
            }}
          >
            {tt.qty > 1 ? `${tt.qty}x` : "1x"}
          </Text>
          <Text
            variant="body"
            tone="muted"
            style={{
              fontVariantNumeric: "tabular-nums",
              minWidth: 80,
              textAlign: "right",
            }}
          >
            {fmtCurrency(fmt, tt.unitPriceCents, order.currency)}
            {tt.qty > 1 ? ` ea` : ""}
          </Text>
          <Text
            variant="body"
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: 700,
              minWidth: 80,
              textAlign: "right",
            }}
          >
            {fmtCurrency(fmt, tt.totalCents, order.currency)}
          </Text>
          {tt.refundedCount > 0 && (
            <Badge tone="danger" size="sm">
              {tt.refundedCount} refunded
            </Badge>
          )}
        </XStack>
      ))}

      {/* Total */}
      <Separator marginVertical="$1" />
      <XStack justifyContent="flex-end" gap="$3" alignItems="center">
        <Text variant="caption" tone="muted">
          {String(t("admin.orderTotal"))}
        </Text>
        <Text
          variant="body"
          style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
        >
          {fmtCurrency(fmt, order.amountGrossCents, order.currency)}
        </Text>
      </XStack>
    </YStack>
  );
}
