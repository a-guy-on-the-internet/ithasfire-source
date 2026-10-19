"use client";

import { XStack, Stack, styled } from "tamagui";
import { Text, useTranslations } from "@th/ui";
import type { DisputeStatus, OrderStatus } from "@th/types";

// ─────────────────────────────────────────────────────────────────────────────
// Status palette — semantic intent tokens (Design System v2)
//
// Same design language as EventStatusBadge: replaces the retired purple gradient
// (dead #370665 brand) that washed out on the Stub warm-paper canvas. Colour
// carries INTENT only; the translated label carries identity, so statuses that
// share an intent may share a hue — never distinguished by colour alone.
//
// One neutral chip surface ($surfaceMuted), intent in the ink + the edge bar.
//
// Accessibility — fg on $surfaceMuted (Stub #EFE7D6), WCAG AA (4.5:1 min):
//   PENDING         $warningSoft  #92400E   6.3 : 1
//   PROCESSING      $color        #211C16  13.7 : 1
//   SUCCEEDED       $success      #166534   5.8 : 1
//   PART_REFUNDED   $warningSoft  #92400E   6.3 : 1
//   REFUNDED        $colorMuted   #5C544A   6.1 : 1
//   DISPUTED        $dangerSoft   #B91C1C   5.3 : 1
//   CANCELLED       $colorMuted   #5C544A   6.9 : 1  (on the cream page, no chip)
// ─────────────────────────────────────────────────────────────────────────────

interface StatusStyle {
  fg: string;
  bg: string;
  bar: string;
}

const STATUS_STYLES: Record<OrderStatus, StatusStyle> = {
  // Money not in yet — amber support bar reads "waiting" at a glance.
  PENDING: {
    fg: "$warningSoft",
    bg: "$surfaceMuted",
    bar: "$support",
  },
  // In flight — neutral, no action needed.
  PROCESSING: {
    fg: "$color",
    bg: "$surfaceMuted",
    bar: "$colorMuted",
  },
  // Paid.
  SUCCEEDED: {
    fg: "$success",
    bg: "$surfaceMuted",
    bar: "$success",
  },
  // Money partly back — worth a look.
  PART_REFUNDED: {
    fg: "$warningSoft",
    bg: "$surfaceMuted",
    bar: "$warning",
  },
  // Closed out, money returned — terminal but not an error.
  REFUNDED: {
    fg: "$colorMuted",
    bg: "$surfaceMuted",
    bar: "$colorMuted",
  },
  // Bad — needs action.
  DISPUTED: {
    fg: "$dangerSoft",
    bg: "$surfaceMuted",
    bar: "$danger",
  },
  // Never happened — a ghost: no chip fill, hairline bar.
  CANCELLED: {
    fg: "$colorMuted",
    bg: "transparent",
    bar: "$borderColorSoft",
  },
};

const ORDER_STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
  PENDING: "admin.statusPending",
  PROCESSING: "admin.statusProcessing",
  SUCCEEDED: "admin.statusSucceeded",
  PART_REFUNDED: "admin.statusPartialRefund",
  REFUNDED: "admin.statusRefunded",
  DISPUTED: "admin.statusDisputed",
  CANCELLED: "admin.statusCancelled",
};

const BadgeFrame = styled(XStack, {
  name: "OrderStatusBadge",
  alignItems: "center",
  alignSelf: "flex-start",
  // Degradation guard: in a tight flex context the pill may shrink
  // (flexShrink 1 + minWidth 0) — the label then ellipsizes instead of
  // hard-clipping glyphs. Callers that must never squeeze the pill wrap it
  // in `<XStack flexShrink={0}>` (the mobile cards already do).
  flexShrink: 1,
  minWidth: 0,
  maxWidth: "100%",
  borderRadius: 0,
  overflow: "hidden",
  gap: "$2",
  paddingVertical: 3,
  paddingRight: 8,
  paddingLeft: 0,
});

const BarIndicator = styled(Stack, {
  name: "OrderStatusBar",
  width: 3,
  flexShrink: 0,
  alignSelf: "stretch",
});

interface OrderStatusBadgeProps {
  status: OrderStatus;
  /**
   * Mirror of the order's Dispute row. `Order.status` is NEVER set to
   * `DISPUTED` by the dispute lifecycle (`markDisputeStatus` writes only
   * `disputeStatus`), so an open / lost dispute has to be read from here or
   * the badge keeps saying "Succeeded" on a charged-back order. WON and the
   * WARNING_* early-warning states fall through to the order status.
   */
  disputeStatus?: DisputeStatus | null;
}

/** The dispute states the badge overrides the order status for. */
type DisputeBadgeVariant = "disputed" | "lost" | null;

function disputeBadgeVariant(
  disputeStatus: DisputeStatus | null | undefined,
): DisputeBadgeVariant {
  switch (disputeStatus) {
    case "OPEN":
    case "UNDER_REVIEW":
      return "disputed";
    case "LOST":
      return "lost";
    default:
      return null;
  }
}

// i18n: key pending — admin.statusDisputeLost
const DISPUTE_LOST_LABEL = "Dispute lost";

export function OrderStatusBadge({
  status,
  disputeStatus,
}: OrderStatusBadgeProps) {
  const t = useTranslations();
  const variant = disputeBadgeVariant(disputeStatus);
  const style = variant
    ? STATUS_STYLES.DISPUTED
    : (STATUS_STYLES[status] ?? STATUS_STYLES.PENDING);
  const label =
    variant === "lost"
      ? DISPUTE_LOST_LABEL
      : String(
          t(
            variant === "disputed"
              ? ORDER_STATUS_LABEL_KEYS.DISPUTED
              : (ORDER_STATUS_LABEL_KEYS[status] ??
                  ORDER_STATUS_LABEL_KEYS.PENDING),
          ),
        );

  return (
    <BadgeFrame backgroundColor={style.bg} aria-label={`Status: ${label}`}>
      <BarIndicator backgroundColor={style.bar} />
      <Text
        variant="overline"
        weight="bold"
        fontSize={11}
        letterSpacing={0.6}
        color={style.fg}
        flexShrink={1}
        minWidth={0}
        style={{
          paddingLeft: 4,
          whiteSpace: "nowrap",
          wordBreak: "keep-all",
          // When the frame shrinks, show "SUCCEE…" — never a silent
          // glyph slice.
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </Text>
    </BadgeFrame>
  );
}

OrderStatusBadge.displayName = "OrderStatusBadge";
