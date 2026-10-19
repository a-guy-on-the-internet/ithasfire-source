"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import { YStack, XStack, styled } from "tamagui";

const Separator = styled(YStack, {
  name: "StructuralLine",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
});
import {
  Button,
  Text,
  TextInput,
  Spinner,
  CardSurface,
  useTranslations,
  useFormatters,
} from "@th/ui";
import {
  X,
  ExternalLink,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  Banknote,
  Package,
  ShieldAlert,
  ArrowLeftRight,
  CreditCard,
  MapPin,
  Tag,
  ScanLine,
} from "lucide-react";

import { formatOrderCode } from "@th/types/order-identifier";
import type { DisputeStatus } from "@th/types";

import { trpc } from "@/trpc";
import {
  formatErrorMessage,
  ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE,
  ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE,
} from "@/lib/format-error-message";
import { fmtDate, fmtDateShort, fmtCurrency } from "@/lib/format";
import { ButtonOutline } from "@/components/layout/PagePrimitives/buttons";
import { OrderStatusBadge } from "./OrderStatusBadge";
import { cashRefundError } from "@/lib/cash-refund-error";
import { cashPaymentLabel, cashRefundAffordance } from "./cash-sale";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OrderDetailPanelProps {
  orderId: string;
  orgId: string;
  /**
   * Whether the current admin holds ORG_FINANCE (OWNER/ADMIN/FINANCE) on the
   * org. Gates the entire refund affordance — the server still enforces the
   * real authorization boundary, so hiding the UI never grants access.
   */
  canFinance: boolean;
  /**
   * Whether the current admin may refund a cash sale from this panel: Owner,
   * Admin or Finance, the roles that read Orders (ORG_FINANCE_ROLES), all of
   * which `orgRefundCashSale` accepts. An Editor cannot open Orders and
   * refunds cash from Sell → Cash taken tonight (owner ruling 2026-10-08).
   * Cosmetic, like `canFinance` — the server enforces.
   */
  canRefundCash?: boolean;
  onClose: () => void;
  /** Called after a successful refund so the parent list can re-fetch. */
  onRefundSuccess?: () => void;
}

type ItemStatus = "active" | "refunded" | "transferred";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ITEM_STATUS_KEYS: Record<ItemStatus, string> = {
  active: "admin.itemActive",
  refunded: "admin.itemRefunded",
  transferred: "admin.itemTransferred",
};

function itemStatusColor(status: ItemStatus): string {
  switch (status) {
    case "active":
      return "var(--success, #166534)";
    case "refunded":
      return "var(--danger, #B91C1C)";
    case "transferred":
      return "var(--info, #211C16)";
    default:
      return "var(--color)";
  }
}

function itemStatusBgColor(status: ItemStatus): string | undefined {
  switch (status) {
    case "refunded":
      return "var(--dangerMuted, rgba(220, 38, 38, 0.06))";
    default:
      return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Dispute banner copy
// ─────────────────────────────────────────────────────────────────────────────

type DisputeBannerCopy = {
  /** Existing catalog keys where the copy fits; literals otherwise. */
  titleKey?: string;
  title?: string;
  bodyKey?: string;
  body?: string;
  ariaLabel: string;
  color: string;
  background: string;
};

/**
 * OPEN / UNDER_REVIEW → "under dispute" (existing copy); LOST → dispute lost;
 * WON → dispute won, nothing further to do. WARNING_* (Radar early warnings)
 * and null render nothing — a warning is not a dispute. No link to the
 * platform dispute desk: this DTO does not carry the dispute id.
 */
function disputeBannerCopy(
  disputeStatus: DisputeStatus | null | undefined,
): DisputeBannerCopy | null {
  switch (disputeStatus) {
    case "OPEN":
    case "UNDER_REVIEW":
      return {
        titleKey: "admin.disputeBanner",
        bodyKey: "admin.disputeDescription",
        ariaLabel: "Order under dispute",
        color: "var(--warning, #92400E)",
        background: "var(--warningMuted, rgba(245, 158, 11, 0.08))",
      };
    case "LOST":
      return {
        // i18n: key pending — admin.disputeLostBanner / admin.disputeLostDescription
        title: "Dispute lost",
        // Ticketing disputes: the platform bears the card network's fee
        // (`debitDisputeLoss` runs with `debitFee: false`); only the disputed
        // amount comes out of the organiser's payouts.
        body: "The disputed amount has been deducted from your payouts. The card network's dispute fee is not passed on to you. This order can't be refunded.",
        ariaLabel: "Dispute lost",
        color: "var(--danger, #B91C1C)",
        background: "var(--dangerMuted, rgba(185, 28, 28, 0.08))",
      };
    case "WON":
      return {
        // i18n: key pending — admin.disputeWonBanner / admin.disputeWonDescription
        title: "Dispute won",
        body: "The buyer's card issuer ruled in your favour. No further action is needed; you can refund this order again if anything is still owed.",
        ariaLabel: "Dispute won",
        color: "var(--success, #166534)",
        background: "var(--successMuted, rgba(22, 101, 52, 0.08))",
      };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Money lines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One labelled figure in a money block. The label shrinks and wraps; the
 * figure never does, so a narrow panel (320px viewport) wraps words, not
 * digits, and never scrolls sideways.
 */
function MoneyLine({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <XStack justifyContent="space-between" alignItems="baseline" gap="$3">
      <Text
        variant={strong ? "body" : "bodySmall"}
        weight={strong ? "bold" : undefined}
        tone={strong ? undefined : "muted"}
        style={{ flexShrink: 1, minWidth: 0 }}
      >
        {label}
      </Text>
      <Text
        variant={strong ? "body" : "bodySmall"}
        weight={strong ? "bold" : undefined}
        style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </Text>
    </XStack>
  );
}

export function OrderDetailPanel({
  orderId,
  orgId,
  canFinance,
  canRefundCash = false,
  onClose,
  onRefundSuccess,
}: OrderDetailPanelProps) {
  // ── i18n ─────────────────────────────────────────────────────────────────
  const t = useTranslations();
  const fmt = useFormatters();

  // ── Data fetching ────────────────────────────────────────────────────────
  const {
    data: order,
    isLoading,
    error,
    refetch,
  } = trpc.orders.getOrgOrder.useQuery(
    { orgId, orderId },
    { staleTime: 15_000 },
  );

  // ── Refund state ─────────────────────────────────────────────────────────
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [refundStep, setRefundStep] = useState<
    "idle" | "quoting" | "confirm" | "processing"
  >("idle");
  const [refundNote, setRefundNote] = useState("");

  // Quote query — only fires when we're in quoting/confirm state.
  // Uses the org-finance-authorized procedure so org admins (not just the
  // buyer) can quote refunds. Gated on canFinance to avoid a guaranteed 403.
  const quoteQuery = trpc.orders.orgQuoteItemRefund.useQuery(
    {
      orgId,
      orderId,
      orderItemIds: Array.from(selectedItemIds),
    },
    {
      enabled:
        canFinance &&
        selectedItemIds.size > 0 &&
        (refundStep === "quoting" || refundStep === "confirm"),
      staleTime: 10_000,
    },
  );

  // Refund mutation (org-finance-authorized)
  const refundMutation = trpc.orders.orgRefundOrderItems.useMutation({
    onSuccess: () => {
      setRefundStep("idle");
      setSelectedItemIds(new Set());
      setRefundNote("");
      refetch();
      onRefundSuccess?.();
    },
  });

  // Whole-order refund (org-finance-authorized). The only org path for a
  // RESALE order: the item path refuses RESALE (`RESALE_ORDER_USE_FULL_REFUND`)
  // because only the full refund performs the resale unwind — ticket back to
  // the seller, listing reopened, seller credit reversed.
  const fullRefundMutation = trpc.orders.orgRefundFullOrder.useMutation({
    onSuccess: () => {
      setRefundStep("idle");
      setRefundNote("");
      void refetch();
      onRefundSuccess?.();
    },
    // Back to the confirm card with the note intact, so the error reads next
    // to the action it belongs to and a retry is one press away.
    onError: () => {
      setRefundStep("confirm");
    },
  });

  // ── Cash refund (door cash sales; door-sales step 9b) ─────────────────────
  // Its own state, apart from the card flow above: a CASH order never enters
  // the item or whole-order path (`orgRefundOrderItems` refuses an order with
  // no PaymentIntent), and a card order never enters this one.
  const [cashStep, setCashStep] = useState<"idle" | "confirm">("idle");
  const [cashNote, setCashNote] = useState("");
  // The window is judged against this clock, refreshed whenever the order is
  // re-read after a refusal, so a panel left open past the close flips to
  // the closed line instead of offering a refund the server will refuse.
  const [now, setNow] = useState(() => new Date());
  const [cashErrorMessage, setCashErrorMessage] = useState<string | null>(null);
  // `isPending` flips a render late, so two presses in one tick would both
  // reach `mutate`; the second answers alreadyRefunded. Set before the call,
  // cleared when it settles.
  const cashRefundInFlight = useRef(false);
  const cashRefundMutation = trpc.orders.orgRefundCashSale.useMutation({
    onSettled: () => {
      cashRefundInFlight.current = false;
    },
    onSuccess: () => {
      setCashStep("idle");
      setCashNote("");
      setCashErrorMessage(null);
      void refetch();
      onRefundSuccess?.();
    },
    onError: (err) => {
      const { message, refetch: stale } = cashRefundError(err, (key) =>
        String(t(key)),
      );
      setCashErrorMessage(message);
      if (stale) {
        setNow(new Date());
        void refetch();
      }
    },
  });

  // ── Derived data ─────────────────────────────────────────────────────────
  // Server-derived by the same rule the refund use cases apply: an OPEN /
  // UNDER_REVIEW / LOST dispute means Stripe will refuse the refund, so the
  // panel refuses up front instead of surfacing the server error later.
  const refundBlockedByDispute = order?.refundBlockedByDispute ?? false;

  // Dispute banner. Keyed on `disputeStatus` (the Dispute row's mirror), NOT
  // `order.status === "DISPUTED"`: the dispute lifecycle never writes that
  // status, so the old keying never rendered for a real dispute.
  const disputeBanner = disputeBannerCopy(order?.disputeStatus);

  // A RESALE order has no per-item path: the server refuses it whole, so the
  // panel offers the whole-order refund instead of a quote that can't load.
  const isResaleOrder = order?.source === "RESALE";

  const eligibleItemIds = useMemo(() => {
    // Only org-finance admins can act on refunds; without the capability the
    // selection affordances (checkboxes, select-all, row clicks) stay hidden.
    // A dispute-blocked order hides them too — nothing on it is refundable
    // until the dispute closes. A RESALE order hides them as well: its
    // tickets are refundable only as a whole (see `canRefundWholeOrder`).
    // A door cash sale (CASH) is refunded whole through the cash refund
    // below, never per item.
    if (
      !order ||
      !canFinance ||
      order.refundBlockedByDispute ||
      order.source === "RESALE" ||
      order.paymentChannel === "CASH"
    ) {
      return new Set<string>();
    }
    return new Set(
      order.items
        .filter((i) => i.status === "active" && !i.transferredAt)
        .map((i) => i.id),
    );
  }, [order, canFinance]);

  // refundFullOrder accepts SUCCEEDED only — REFUNDED / PART_REFUNDED throw
  // ORDER_ALREADY_REFUNDED, anything else ORDER_NOT_REFUNDABLE — so the
  // affordance is offered exactly where the server would take it.
  const canRefundWholeOrder =
    !!order &&
    canFinance &&
    isResaleOrder &&
    order.status === "SUCCEEDED" &&
    !order.refundBlockedByDispute;

  /** Item IDs whose funds have been paid out (transfer reversal will be needed). */
  const paidOutItemIds = useMemo(() => {
    if (!order) return new Set<string>();
    return new Set(
      order.items
        .filter((i) => i.status === "active" && !!i.paidOutAt)
        .map((i) => i.id),
    );
  }, [order]);

  const allEligibleSelected = useMemo(() => {
    if (eligibleItemIds.size === 0) return false;
    for (const id of eligibleItemIds) {
      if (!selectedItemIds.has(id)) return false;
    }
    return true;
  }, [eligibleItemIds, selectedItemIds]);

  // Held vs paid-out vs refunded summary. Not for a cash sale: the platform
  // never held its money, so "held" and "paid out" would both be untrue.
  const financialSummary = useMemo(() => {
    if (!order || order.paymentChannel === "CASH") return null;
    let heldCents = 0;
    let paidOutCents = 0;
    let refundedCents = 0;
    for (const item of order.items) {
      if (item.status === "refunded") {
        refundedCents += item.amountCents;
      } else if (item.paidOutAt) {
        paidOutCents += item.amountCents;
      } else {
        heldCents += item.amountCents;
      }
    }
    return { heldCents, paidOutCents, refundedCents, currency: order.currency };
  }, [order]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const toggleItem = useCallback((itemId: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    setRefundStep("idle");
  }, []);

  const toggleAllEligible = useCallback(() => {
    if (allEligibleSelected) {
      setSelectedItemIds(new Set());
    } else {
      setSelectedItemIds(new Set(eligibleItemIds));
    }
    setRefundStep("idle");
  }, [allEligibleSelected, eligibleItemIds]);

  // Both confirm steps re-read the order as they open: it can be up to
  // `staleTime` old, and a ticket scanned since the panel loaded has to show
  // in the scanned-in notice. Fire-and-forget, so the quote never waits on it.
  const handleQuote = useCallback(() => {
    void refetch();
    setRefundStep("quoting");
  }, [refetch]);

  // The org refund requires a note (3–500 chars) for the audit trail.
  const trimmedNote = refundNote.trim();
  const isNoteValid = trimmedNote.length >= 3 && trimmedNote.length <= 500;

  const handleConfirmRefund = useCallback(() => {
    if (!isNoteValid) return;
    refundMutation.mutate({
      orgId,
      orderId,
      orderItemIds: Array.from(selectedItemIds),
      note: trimmedNote,
    });
    setRefundStep("processing");
  }, [orgId, orderId, selectedItemIds, refundMutation, isNoteValid, trimmedNote]);

  const handleCancelRefund = useCallback(() => {
    setRefundStep("idle");
  }, []);

  // Whole-order path: no org-scoped quote exists, so the flow goes straight
  // to confirm and shows the order's paid total for magnitude.
  const handleStartFullRefund = useCallback(() => {
    fullRefundMutation.reset();
    void refetch();
    setRefundStep("confirm");
  }, [fullRefundMutation, refetch]);

  const handleConfirmFullRefund = useCallback(() => {
    if (!isNoteValid) return;
    fullRefundMutation.mutate({ orgId, orderId, note: trimmedNote });
    setRefundStep("processing");
  }, [orgId, orderId, fullRefundMutation, isNoteValid, trimmedNote]);

  // When quote loads, move to confirm step
  if (refundStep === "quoting" && quoteQuery.data && !quoteQuery.isLoading) {
    setRefundStep("confirm");
  }

  // When quote errors, return to idle so the user can retry
  if (refundStep === "quoting" && quoteQuery.error && !quoteQuery.isLoading) {
    setRefundStep("idle");
  }

  // ── Loading / error ──────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <CardSurface padding="$4">
        <XStack justifyContent="space-between" alignItems="center">
          <Text variant="h4" weight="bold">
            {String(t("admin.orderDetail"))}
          </Text>
          <Button
            variant="ghost"
            size="$2"
            icon
            onPress={onClose}
            aria-label={String(t("admin.close"))}
          >
            <X size={16} />
          </Button>
        </XStack>
        <YStack padding="$6" alignItems="center">
          <Spinner size="lg" />
        </YStack>
      </CardSurface>
    );
  }

  if (error || !order) {
    return (
      <CardSurface padding="$4">
        <XStack justifyContent="space-between" alignItems="center">
          <Text variant="h4" weight="bold">
            {String(t("admin.orderDetail"))}
          </Text>
          <Button
            variant="ghost"
            size="$2"
            icon
            onPress={onClose}
            aria-label={String(t("admin.close"))}
          >
            <X size={16} />
          </Button>
        </XStack>
        <YStack padding="$4" gap="$2">
          <Text variant="body" tone="error">
            {error
              ? formatErrorMessage(error, t)
              : String(t("admin.orderNotFoundPanel"))}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            {String(t("admin.retry"))}
          </Button>
        </YStack>
      </CardSurface>
    );
  }

  const isCashOrder = order.paymentChannel === "CASH";
  const cashAffordance = cashRefundAffordance({
    paymentChannel: order.paymentChannel,
    status: order.status,
    cashRefundableUntil: order.cashRefundableUntil,
    canRefundCash,
    now,
  });
  const cashLabel = isCashOrder ? cashPaymentLabel(order) : null;
  // Both from the server (`getOrgOrder`, CASH orders only): what the buyer
  // paid, which `orgRefundCashSale` hands back, and the CASH_SALE_DEBIT it
  // reverses (tax, or fee + tax on a sale from before 2026-10-08).
  const cashPaidCents = order.cashAmountPaidCents ?? 0;
  const cashDebitCents = order.cashSaleDebitCents ?? 0;
  const cashAmount = fmtCurrency(fmt, cashPaidCents, order.currency);
  const trimmedCashNote = cashNote.trim();
  const cashResult = cashRefundMutation.data;

  // Owner ruling 2026-10-10: a refund of a ticket that was already scanned in
  // means the person has left. The confirm step says so before the admin
  // commits, and says where the ticket goes, which differs by path:
  //  - per-item (a PRIMARY order): the selected tickets are voided and go
  //    back on sale (0b387d5d5);
  //  - whole-order (a RESALE order, the only one `canRefundWholeOrder`
  //    admits): the ticket is NOT voided. The unwind hands it back to the
  //    seller as a valid ticket, so it must never be described as back on
  //    sale at the door. A resale order carries one ticket
  //    (`createResaleCheckout` builds a single qty-1 line per listing).
  // Counted over the tickets the pending refund takes back: every refundable
  // one on the whole-order path, the selected ones on the per-item path.
  const pendingRefundTickets = order.items.filter(
    (i) =>
      i.kind === "ticket" &&
      i.status === "active" &&
      !i.transferredAt &&
      (canRefundWholeOrder || selectedItemIds.has(i.id)),
  );
  const scannedInRefundCount = pendingRefundTickets.filter(
    (i) => i.ticketScannedAt,
  ).length;
  const scannedInRefundNotice =
    scannedInRefundCount > 0 ? (
      <XStack
        gap="$2"
        padding="$2"
        borderRadius={0}
        borderWidth={2}
        borderColor="var(--warning, #92400E)"
        backgroundColor="var(--warningMuted, rgba(245, 158, 11, 0.08))"
        alignItems="flex-start"
      >
        <ScanLine
          size={14}
          color="var(--warning, #92400E)"
          style={{ flexShrink: 0, marginTop: 2 }}
          aria-hidden
        />
        <Text variant="bodySmall" style={{ color: "var(--warning, #92400E)" }}>
          {canRefundWholeOrder
            ? String(t("admin.refundScannedInResale"))
            : pendingRefundTickets.length === 1
              ? String(t("admin.refundScannedInOne"))
              : String(
                  t("admin.refundScannedInSeveral", {
                    count: scannedInRefundCount,
                  }),
                )}
        </Text>
      </XStack>
    ) : null;

  return (
    <CardSurface padding="$4">
      {/* Header */}
      <XStack
        justifyContent="space-between"
        alignItems="flex-start"
        marginBottom="$3"
      >
        <YStack gap="$1" flex={1}>
          <XStack gap="$2" alignItems="center">
            <Text variant="h4" weight="bold">
              {String(t("admin.orderDetail"))}
            </Text>
            <OrderStatusBadge status={order.status} />
          </XStack>
          {/* Order code + raw id. Both unconditional now, so this row always
              carries ~311px of content (measured, Montserrat 12px: 72px code +
              8px gap + 232px UUID) inside a panel whose content box is a couple
              of hundred pixels at 320px.

              It survives without wrapping only because @th/ui <Text> computes
              `flex-shrink: 1` and the UUID's hyphens are break opportunities —
              so the id silently collapses into a 3–4 line ragged column beside
              the code, and once the available width drops under ~157px (its
              min-content: code 72 + gap 8 + longest unbreakable run 78) it
              overflows outright. `flexWrap` retires both: the id drops to its
              own full-width line and breaks at hyphens. Desktop is untouched —
              nothing wraps while the pair fits. */}
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="caption" weight="bold" selectable>
              #{formatOrderCode(order.id)}
            </Text>
            <Text variant="caption" tone="muted" selectable>
              {order.id}
            </Text>
          </XStack>
        </YStack>
        <XStack gap="$2" alignItems="center">
          {order.stripePaymentIntentId && (
            <Button
              variant="ghost"
              size="$2"
              icon
              onPress={() =>
                window.open(
                  `https://dashboard.stripe.com/payments/${order.stripePaymentIntentId}`,
                  "_blank",
                )
              }
              aria-label={String(t("admin.viewInStripe"))}
            >
              <ExternalLink size={14} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="$2"
            icon
            onPress={onClose}
            aria-label={String(t("admin.close"))}
          >
            <X size={16} />
          </Button>
        </XStack>
      </XStack>

      <Separator marginBottom="$3" />

      {/* Order metadata */}
      <XStack gap="$6" flexWrap="wrap" marginBottom="$3">
        <YStack gap="$1" minWidth={140}>
          <Text variant="caption" tone="muted">
            {String(t("admin.buyer"))}
          </Text>
          <Text variant="body" weight="bold">
            {order.buyerName || String(t("admin.unknownBuyer"))}
          </Text>
          {order.buyerEmail && (
            <Text variant="caption" tone="muted">
              {order.buyerEmail}
            </Text>
          )}
        </YStack>
        <YStack gap="$1" minWidth={140}>
          <Text variant="caption" tone="muted">
            {String(t("admin.event"))}
          </Text>
          <Text variant="body">{order.eventTitle}</Text>
        </YStack>
        <YStack gap="$1" minWidth={120}>
          <Text variant="caption" tone="muted">
            {String(t("admin.date"))}
          </Text>
          <Text variant="body">{fmtDate(fmt, order.occurredAt)}</Text>
        </YStack>
      </XStack>

      {/* What the buyer paid and what the event was credited, each with
          the lines that make it up, so the sum can be checked with a
          calculator (docs/pro-social.md, "One fee, taken once, and the sums
          add up"). Every figure comes from the server (`getOrgOrder`):
          `charges` is the buyer page's own breakdown (null when its lines
          would not sum to what was paid), `eventCredit` the ledger's
          OrderSplit total beside the credit rule's expected figure. "The
          event", not "the organizer": payout terms may divide the credit
          among several payees. The stored ticket money
          (`amountGrossCents`) is a "Ticket price" line, never a total. */}
      <XStack gap="$6" flexWrap="wrap" marginBottom="$3">
        <YStack
          gap="$1"
          flexGrow={1}
          flexShrink={1}
          flexBasis={200}
          minWidth={0}
        >
          {/* "Buyer paid" only once money was taken (the server's
              `chargeState`). A held or cancelled cart, or an ACH payment
              still settling, heads the same figure "Order total" and says
              where the payment stands; the lines still show what it costs. */}
          <MoneyLine
            strong
            label={String(
              t(order.buyerPaid ? "admin.odBuyerPaid" : "admin.odOrderTotal"),
            )}
            value={fmtCurrency(fmt, order.buyerTotalCents, order.currency)}
          />
          {order.chargeState !== "PAID" && (
            <Text variant="caption" tone="muted">
              {String(
                t(
                  order.chargeState === "PROCESSING"
                    ? "admin.odPaymentProcessing"
                    : "admin.odNothingCharged",
                ),
              )}
            </Text>
          )}
          {order.charges ? (
            <>
              <MoneyLine
                label={String(t("admin.odTicketPrice"))}
                value={fmtCurrency(
                  fmt,
                  order.charges.subtotalCents,
                  order.currency,
                )}
              />
              {order.charges.platformFeeCents > 0 && (
                <MoneyLine
                  label={String(t("admin.odPlatformFee"))}
                  value={fmtCurrency(
                    fmt,
                    order.charges.platformFeeCents,
                    order.currency,
                  )}
                />
              )}
              {order.charges.processingFeeCents > 0 && (
                <MoneyLine
                  label={String(t("admin.odProcessingFee"))}
                  value={fmtCurrency(
                    fmt,
                    order.charges.processingFeeCents,
                    order.currency,
                  )}
                />
              )}
              {order.charges.taxCents > 0 && (
                <MoneyLine
                  label={String(t("admin.odTax"))}
                  value={fmtCurrency(
                    fmt,
                    order.charges.taxCents,
                    order.currency,
                  )}
                />
              )}
              {order.charges.creditCents < 0 && (
                <MoneyLine
                  label={String(t("admin.odBuyerCredit"))}
                  value={`\u2212${fmtCurrency(
                    fmt,
                    -order.charges.creditCents,
                    order.currency,
                  )}`}
                />
              )}
            </>
          ) : (
            <Text variant="caption" tone="muted">
              {String(t("admin.odNoBuyerLines"))}
            </Text>
          )}
        </YStack>
        {order.eventCredit && (
          <YStack
            gap="$1"
            flexGrow={1}
            flexShrink={1}
            flexBasis={200}
            minWidth={0}
          >
            <MoneyLine
              strong
              label={String(t("admin.odEventCredit"))}
              value={
                order.eventCredit.creditState === "UNAVAILABLE"
                  ? String(t("admin.odCreditUnavailable"))
                  : order.eventCredit.creditedCents === null
                    ? String(t("admin.odNotCreditedYet"))
                    : fmtCurrency(
                        fmt,
                        order.eventCredit.creditedCents,
                        order.currency,
                      )
              }
            />
            <MoneyLine
              label={String(t("admin.odTicketPrice"))}
              value={fmtCurrency(
                fmt,
                order.eventCredit.ticketPriceCents,
                order.currency,
              )}
            />
            {order.eventCredit.platformFeeTakenCents > 0 && (
              <MoneyLine
                label={String(t("admin.odPlatformFeeTakenFromPrice"))}
                value={`\u2212${fmtCurrency(
                  fmt,
                  order.eventCredit.platformFeeTakenCents,
                  order.currency,
                )}`}
              />
            )}
            {/* The rule's figure is shown as such whenever it is not
                already the credited figure above: before a split is
                written, or if the ledger ever disagrees with the rule.
                Not when the read failed: the headline says so, and an
                "expected" figure there would read as a pending credit. A
                free order arrives CREDITED at $0, so it gets no line. */}
            {order.eventCredit.creditState !== "UNAVAILABLE" &&
              order.eventCredit.creditedCents !==
                order.eventCredit.expectedCreditCents && (
              <MoneyLine
                label={String(t("admin.odExpectedCredit"))}
                value={fmtCurrency(
                  fmt,
                  order.eventCredit.expectedCreditCents,
                  order.currency,
                )}
              />
            )}
            {/* "On top" only when the buyer did pay a platform fee: a
                fee-waived or $0 sale gets the plain sentence. Not when the
                credit could not be read: like the Expected line, the rule's
                sentence beside "could not be loaded" reads as a figure. */}
            {order.eventCredit.creditState !== "UNAVAILABLE" &&
              order.eventCredit.platformFeeTakenCents === 0 && (
              <Text variant="caption" tone="muted">
                {String(
                  t(
                    (order.charges?.platformFeeCents ?? 0) > 0
                      ? "admin.odFullPriceCredited"
                      : "admin.odFullPrice",
                  ),
                )}
              </Text>
            )}
            {order.eventCredit.payeeCount > 1 && (
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.odPayoutTermsDivide", {
                    count: order.eventCredit.payeeCount,
                  }),
                )}
              </Text>
            )}
          </YStack>
        )}
      </XStack>

      {/* Extended metadata row */}
      <XStack gap="$6" flexWrap="wrap" marginBottom="$3">
        {cashLabel && (
          <YStack gap="$1" minWidth={120}>
            <XStack gap="$1" alignItems="center">
              <Banknote size={12} color="var(--colorMuted)" aria-hidden />
              <Text variant="caption" tone="muted">
                {String(t("admin.odPaymentMethod"))}
              </Text>
            </XStack>
            <Text variant="body" weight="bold">
              {cashLabel.kind === "cash"
                ? String(t("admin.odCashAtDoor"))
                : cashLabel.kind === "comp"
                  ? String(t("admin.odComp"))
                  : String(
                      t("admin.odFreeWithCode", { code: cashLabel.codes }),
                    )}
            </Text>
          </YStack>
        )}
        {!isCashOrder && order.paymentMethodType && (
          <YStack gap="$1" minWidth={120}>
            <XStack gap="$1" alignItems="center">
              <CreditCard size={12} color="var(--colorMuted)" />
              <Text variant="caption" tone="muted">
                {String(t("admin.odPaymentMethod"))}
              </Text>
            </XStack>
            <Text variant="body" style={{ textTransform: "capitalize" }}>
              {order.paymentMethodType.replace(/_/g, " ")}
            </Text>
          </YStack>
        )}
        {order.source && (
          <YStack gap="$1" minWidth={100}>
            <Text variant="caption" tone="muted">
              {String(t("admin.odSource"))}
            </Text>
            <Text variant="body" style={{ textTransform: "capitalize" }}>
              {order.source.toLowerCase().replace(/_/g, " ")}
            </Text>
          </YStack>
        )}
        {order.promo && (
          <YStack gap="$1" minWidth={140}>
            <XStack gap="$1" alignItems="center">
              <Tag size={12} color="var(--colorMuted)" />
              <Text variant="caption" tone="muted">
                {String(t("admin.odPromo"))}
              </Text>
            </XStack>
            {/* `code` is NULL for a membership-sourced discount — a benefit
                has no code. Rendering it raw put an EMPTY bold line under the
                "Promo" label. Read `source` and name the line instead. */}
            {/* Every typed code, when the order carries more than the one
                `promo` names (a door sale can stack them). */}
            <Text variant="body" weight="bold">
              {order.promo.source === "membership"
                ? String(t("checkout.memberDiscount"))
                : order.promoCodes.length > 0
                  ? order.promoCodes.join(", ")
                  : order.promo.code}
            </Text>
            <Text variant="caption" tone="muted">
              -
              {fmtCurrency(
                fmt,
                order.promo.amountDiscountCents,
                order.currency,
              )}
            </Text>
          </YStack>
        )}
        {order.billingAddress && (
          <YStack gap="$1" minWidth={180}>
            <XStack gap="$1" alignItems="center">
              <MapPin size={12} color="var(--colorMuted)" />
              <Text variant="caption" tone="muted">
                {String(t("admin.odBillingAddress"))}
              </Text>
            </XStack>
            <Text variant="bodySmall">
              {[
                order.billingAddress.line1,
                order.billingAddress.line2,
                [order.billingAddress.city, order.billingAddress.state]
                  .filter(Boolean)
                  .join(", "),
                [order.billingAddress.postalCode, order.billingAddress.country]
                  .filter(Boolean)
                  .join(" "),
              ]
                .filter(Boolean)
                .join(", ")}
            </Text>
          </YStack>
        )}
        {order.parentOrderId && (
          <YStack gap="$1" minWidth={120}>
            <Text variant="caption" tone="muted">
              {String(t("admin.odParentOrder"))}
            </Text>
            <Text variant="caption" selectable>
              {order.parentOrderId}
            </Text>
          </YStack>
        )}
      </XStack>

      {/* Financial summary — held / paid out / refunded */}
      {financialSummary && (
        <>
          <Separator marginBottom="$3" />
          <XStack gap="$4" flexWrap="wrap" marginBottom="$3">
            <XStack gap="$2" alignItems="center">
              <Banknote size={14} color="var(--success)" />
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.heldLabel"))}
              </Text>
              <Text variant="bodySmall" weight="bold">
                {fmtCurrency(
                  fmt,
                  financialSummary.heldCents,
                  financialSummary.currency,
                )}
              </Text>
            </XStack>
            <XStack gap="$2" alignItems="center">
              <CheckCircle size={14} color="var(--info)" />
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.paidOutLabel"))}
              </Text>
              <Text variant="bodySmall" weight="bold">
                {fmtCurrency(
                  fmt,
                  financialSummary.paidOutCents,
                  financialSummary.currency,
                )}
              </Text>
            </XStack>
            <XStack gap="$2" alignItems="center">
              <RotateCcw size={14} color="var(--colorMuted)" />
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.refundedLabel"))}
              </Text>
              <Text variant="bodySmall" weight="bold">
                {fmtCurrency(
                  fmt,
                  financialSummary.refundedCents,
                  financialSummary.currency,
                )}
              </Text>
            </XStack>
          </XStack>
        </>
      )}

      {/* Fee policy snapshot + Stripe references */}
      {(order.feePolicySnapshot ||
        order.stripePaymentIntentId ||
        order.stripeTaxCalculationId) && (
        <>
          <Separator marginBottom="$3" />
          <YStack gap="$2" marginBottom="$3">
            {order.feePolicySnapshot &&
              typeof order.feePolicySnapshot === "object" && (
                <>
                  <Text variant="caption" tone="muted" weight="bold">
                    {String(t("admin.odFeePolicySnapshot"))}
                  </Text>
                  <XStack gap="$6" flexWrap="wrap">
                    {(() => {
                      const fp = order.feePolicySnapshot as Record<
                        string,
                        unknown
                      >;
                      return (
                        <>
                          {fp.mode && (
                            <YStack gap="$1" minWidth={80}>
                              <Text variant="caption" tone="muted">
                                {String(t("admin.odFeeMode"))}
                              </Text>
                              <Text variant="caption">{String(fp.mode)}</Text>
                            </YStack>
                          )}
                          {fp.buyerFeePct != null && (
                            <YStack gap="$1" minWidth={80}>
                              <Text variant="caption" tone="muted">
                                {String(t("admin.odBuyerFeePct"))}
                              </Text>
                              <Text variant="caption">
                                {String(fp.buyerFeePct)}%
                              </Text>
                            </YStack>
                          )}
                          {fp.platformFixedCents != null && (
                            <YStack gap="$1" minWidth={80}>
                              <Text variant="caption" tone="muted">
                                {String(t("admin.odPlatformFixed"))}
                              </Text>
                              <Text variant="caption">
                                {fmtCurrency(
                                  fmt,
                                  Number(fp.platformFixedCents),
                                  order.currency,
                                )}
                              </Text>
                            </YStack>
                          )}
                          {fp.processsorFeePct != null && (
                            <YStack gap="$1" minWidth={100}>
                              <Text variant="caption" tone="muted">
                                {String(t("admin.odProcessorRate"))}
                              </Text>
                              <Text variant="caption">
                                {String(fp.processsorFeePct)}% +{" "}
                                {fmtCurrency(
                                  fmt,
                                  Number(fp.processorFixedCents ?? 0),
                                  order.currency,
                                )}
                              </Text>
                            </YStack>
                          )}
                          {(fp.maxFeeCents != null ||
                            fp.minFeeCents != null) && (
                            <YStack gap="$1" minWidth={80}>
                              <Text variant="caption" tone="muted">
                                {String(t("admin.odFeeRange"))}
                              </Text>
                              <Text variant="caption">
                                {fp.minFeeCents != null
                                  ? fmtCurrency(
                                      fmt,
                                      Number(fp.minFeeCents),
                                      order.currency,
                                    )
                                  : "—"}
                                {" – "}
                                {fp.maxFeeCents != null
                                  ? fmtCurrency(
                                      fmt,
                                      Number(fp.maxFeeCents),
                                      order.currency,
                                    )
                                  : "—"}
                              </Text>
                            </YStack>
                          )}
                        </>
                      );
                    })()}
                  </XStack>
                </>
              )}
            {(order.stripePaymentIntentId || order.stripeTaxCalculationId) && (
              <>
                <Text
                  variant="caption"
                  tone="muted"
                  weight="bold"
                  marginTop="$1"
                >
                  {String(t("admin.odStripeRefs"))}
                </Text>
                <XStack gap="$6" flexWrap="wrap">
                  {order.stripePaymentIntentId && (
                    <YStack gap="$1" minWidth={200}>
                      <Text variant="caption" tone="muted">
                        {String(t("admin.odStripePI"))}
                      </Text>
                      <Text variant="caption" selectable>
                        {order.stripePaymentIntentId}
                      </Text>
                    </YStack>
                  )}
                  {order.stripeTaxCalculationId && (
                    <YStack gap="$1" minWidth={200}>
                      <Text variant="caption" tone="muted">
                        {String(t("admin.odStripeTaxCalc"))}
                      </Text>
                      <Text variant="caption" selectable>
                        {order.stripeTaxCalculationId}
                      </Text>
                    </YStack>
                  )}
                </XStack>
              </>
            )}
          </YStack>
        </>
      )}

      {/* Dispute banner — open / lost / won; nothing for early warnings */}
      {disputeBanner && (
        <>
          <Separator marginBottom="$3" />
          <XStack
            gap="$3"
            padding="$3"
            marginBottom="$3"
            borderRadius={0}
            borderWidth={2}
            borderColor={disputeBanner.color}
            backgroundColor={disputeBanner.background}
            alignItems="flex-start"
            role="note"
            aria-label={disputeBanner.ariaLabel}
          >
            <ShieldAlert
              size={18}
              color={disputeBanner.color}
              style={{ flexShrink: 0, marginTop: 2 }}
              aria-hidden
            />
            <YStack gap="$1" flex={1}>
              <Text variant="body" weight="bold">
                {disputeBanner.titleKey
                  ? String(t(disputeBanner.titleKey))
                  : disputeBanner.title}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {disputeBanner.bodyKey
                  ? String(t(disputeBanner.bodyKey))
                  : disputeBanner.body}
              </Text>
              {order.stripePaymentIntentId && (
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() =>
                    window.open(
                      `https://dashboard.stripe.com/payments/${order.stripePaymentIntentId}`,
                      "_blank",
                    )
                  }
                  alignSelf="flex-start"
                  marginTop="$1"
                >
                  <ExternalLink size={12} />
                  <Text tone="inherit" variant="caption" weight="bold">
                    {String(t("admin.viewDisputeInStripe"))}
                  </Text>
                </Button>
              )}
            </YStack>
          </XStack>
        </>
      )}

      <Separator marginBottom="$3" />

      {/* Order items */}
      <YStack gap="$2" marginBottom="$3">
        <XStack justifyContent="space-between" alignItems="center">
          <XStack gap="$2" alignItems="center">
            <Package size={16} />
            <Text variant="body" weight="bold">
              {String(t("admin.nTicketsLabel", { count: order.items.length }))}
            </Text>
          </XStack>
          {eligibleItemIds.size > 0 && (
            <Button variant="secondary" size="$3" onPress={toggleAllEligible}>
              {allEligibleSelected
                ? String(t("admin.deselectAll"))
                : String(
                    t("admin.selectAllRefundable", {
                      count: eligibleItemIds.size,
                    }),
                  )}
            </Button>
          )}
        </XStack>

        {/* Items table */}
        <YStack
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          overflow="hidden"
        >
          {/* Header row */}
          <XStack
            paddingHorizontal="$3"
            paddingVertical="$2"
            backgroundColor="$backgroundHover"
          >
            <XStack width={32} />
            <Text variant="caption" tone="muted" flex={2}>
              {String(t("admin.ticketColumn"))}
            </Text>
            <Text variant="caption" tone="muted" flex={1} textAlign="right">
              {String(t("admin.priceColumn"))}
            </Text>
            <Text variant="caption" tone="muted" flex={1} textAlign="center">
              {String(t("admin.statusColumn"))}
            </Text>
            <Text variant="caption" tone="muted" flex={1.2} textAlign="center">
              {String(t("admin.odScanColumn"))}
            </Text>
            <Text variant="caption" tone="muted" flex={1.2} textAlign="right">
              {String(t("admin.payoutColumn"))}
            </Text>
          </XStack>

          {order.items.map((item) => {
            const isEligible = eligibleItemIds.has(item.id);
            const isSelected = selectedItemIds.has(item.id);
            const typeName =
              (item.ticketTypeId && order.ticketTypeNames[item.ticketTypeId]) ||
              item.kind;

            return (
              <XStack
                key={item.id}
                paddingHorizontal="$3"
                paddingVertical="$2"
                borderTopWidth={1}
                borderColor="$borderColor"
                alignItems="center"
                backgroundColor={
                  isSelected
                    ? "$backgroundFocus"
                    : itemStatusBgColor(item.status as ItemStatus)
                }
                hoverStyle={
                  isEligible
                    ? { backgroundColor: "$backgroundHover" }
                    : undefined
                }
                cursor={isEligible ? "pointer" : "default"}
                onPress={isEligible ? () => toggleItem(item.id) : undefined}
                opacity={item.status === "refunded" ? 0.75 : 1}
              >
                {/* Checkbox area */}
                <XStack width={32} justifyContent="center">
                  {isEligible && (
                    <XStack
                      width={16}
                      height={16}
                      borderRadius={0}
                      borderWidth={2}
                      // $accentColor is NOT a theme token (see toRoles in
                      // packages/ui/.../tokens/colors.ts) — it never resolved,
                      // so the fill never painted and the check was invisible
                      // whatever its color. $accent is the intent, and matches
                      // the identical checkbox in TwoFactorChallengeCard.
                      borderColor={isSelected ? "$accent" : "$borderColor"}
                      backgroundColor={isSelected ? "$accent" : "transparent"}
                      alignItems="center"
                      justifyContent="center"
                    >
                      {isSelected && (
                        <Text
                          variant="caption"
                          style={{
                            color: "var(--onBrandSecondary, #FFFFFF)",
                            fontSize: 10,
                            lineHeight: 14,
                          }}
                        >
                          &#10003;
                        </Text>
                      )}
                    </XStack>
                  )}
                </XStack>

                <YStack flex={2} gap="$1">
                  <Text variant="bodySmall" ellipse>
                    {typeName}
                  </Text>
                  {item.ticketCode && (
                    <Text
                      variant="caption"
                      tone="muted"
                      selectable
                      style={{ fontSize: 10 }}
                    >
                      {item.ticketCode}
                    </Text>
                  )}
                  {(item.seatId || item.ticketOwnerName) && (
                    <XStack gap="$2">
                      {item.seatId && (
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontSize: 10 }}
                        >
                          {String(t("admin.odSeat"))}: {item.seatId}
                        </Text>
                      )}
                      {item.ticketOwnerName && (
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontSize: 10 }}
                        >
                          {String(t("admin.odOwner"))}: {item.ticketOwnerName}
                        </Text>
                      )}
                    </XStack>
                  )}
                </YStack>
                <Text
                  variant="bodySmall"
                  flex={1}
                  textAlign="right"
                  weight="bold"
                  style={
                    item.status === "refunded"
                      ? { textDecoration: "line-through" }
                      : undefined
                  }
                >
                  {fmtCurrency(fmt, item.amountCents, order.currency)}
                </Text>
                <XStack flex={1} justifyContent="center">
                  <YStack alignItems="center" gap="$1">
                    <Text
                      variant="caption"
                      style={{
                        color: itemStatusColor(item.status as ItemStatus),
                      }}
                      weight="bold"
                    >
                      {String(t(ITEM_STATUS_KEYS[item.status as ItemStatus]))}
                    </Text>
                    {item.status === "refunded" && item.refundedAt && (
                      <Text
                        variant="caption"
                        tone="muted"
                        style={{ fontSize: 10 }}
                      >
                        {fmtDate(fmt, item.refundedAt)}
                      </Text>
                    )}
                  </YStack>
                </XStack>
                <XStack
                  flex={1.2}
                  justifyContent="center"
                  alignItems="center"
                  gap="$1"
                >
                  {item.ticketScannedAt ? (
                    <>
                      <ScanLine size={12} color="var(--success, #166534)" />
                      <Text
                        variant="caption"
                        style={{
                          color: "var(--success, #166534)",
                          fontSize: 10,
                        }}
                      >
                        {fmtDate(fmt, item.ticketScannedAt)}
                      </Text>
                    </>
                  ) : item.ticketCode ? (
                    <Text
                      variant="caption"
                      tone="muted"
                      style={{ fontSize: 10 }}
                    >
                      {String(t("admin.odNotScanned"))}
                    </Text>
                  ) : (
                    <Text variant="caption" tone="muted">
                      {"\u2014"}
                    </Text>
                  )}
                </XStack>
                <Text
                  variant="caption"
                  tone="muted"
                  flex={1.2}
                  textAlign="right"
                >
                  {isCashOrder ? (
                    // Cash never passes through the platform: nothing to
                    // hold or pay out.
                    "\u2014"
                  ) : item.paidOutAt ? (
                    <XStack
                      gap="$1"
                      justifyContent="flex-end"
                      alignItems="center"
                    >
                      {eligibleItemIds.has(item.id) && (
                        <ArrowLeftRight
                          size={10}
                          color="var(--warning, #92400E)"
                        />
                      )}
                      <Text variant="caption" tone="muted">
                        {fmtDate(fmt, item.paidOutAt)}
                      </Text>
                    </XStack>
                  ) : item.status === "refunded" ? (
                    "\u2014"
                  ) : (
                    String(t("admin.held"))
                  )}
                </Text>
              </XStack>
            );
          })}
        </YStack>
      </YStack>

      {/* Cash refund — door cash sales only (door-sales step 9b). Owner,
          Admin or Finance here (Orders carries buyer details; Editors refund
          from Sell → Cash taken tonight), until event end + 7 days
          (inclusive); after that the closed line, since only platform staff
          can still refund. */}
      {/* Kept while an error is showing: a refusal that re-reads the order
          (ORDER_NOT_REFUNDABLE) can turn the affordance to "none", and the
          message must not vanish with it. */}
      {isCashOrder &&
        (cashAffordance !== "none" || cashResult || cashErrorMessage) && (
        <>
          <Separator marginBottom="$3" />
          <YStack gap="$3" marginBottom="$3" data-testid="cash-refund">
            {!cashResult && cashAffordance === "open" && cashStep === "idle" && (
              <YStack gap="$2">
                <XStack>
                  <Button
                    variant="secondary"
                    size="$3"
                    onPress={() => {
                      cashRefundMutation.reset();
                      setCashErrorMessage(null);
                      setCashStep("confirm");
                    }}
                  >
                    <RotateCcw size={14} aria-hidden />
                    {String(t("admin.odCashRefundTitle"))}
                  </Button>
                </XStack>
                <Text variant="caption" tone="muted">
                  {String(
                    t("admin.odCashRefundWindowOpen", {
                      date: fmtDate(fmt, order.cashRefundableUntil),
                    }),
                  )}
                </Text>
              </YStack>
            )}

            {cashAffordance === "open" && cashStep === "confirm" && (
              <YStack gap="$3">
                <Text variant="body" weight="bold" tag="h3">
                  {String(t("admin.odCashRefundTitle"))}
                </Text>
                <YStack gap="$1">
                  <Text variant="bodySmall">
                    {cashPaidCents > 0
                      ? String(
                          t("admin.odCashRefundBody", { amount: cashAmount }),
                        )
                      : String(t("admin.odCashRefundBodyZero"))}
                  </Text>
                  {cashDebitCents > 0 && (
                    <Text variant="bodySmall">
                      {String(
                        t("admin.odCashRefundDebitNote", {
                          amount: fmtCurrency(
                            fmt,
                            cashDebitCents,
                            order.currency,
                          ),
                        }),
                      )}
                    </Text>
                  )}
                </YStack>
                <YStack gap="$1">
                  <Text variant="overline" tone="muted">
                    {String(t("admin.noteOptional"))}
                  </Text>
                  <TextInput
                    value={cashNote}
                    onChangeText={setCashNote}
                    placeholder={String(t("admin.odCashRefundNotePlaceholder"))}
                    aria-label={String(t("admin.noteOptional"))}
                    maxLength={500}
                    fullWidth
                    minHeight={44}
                  />
                </YStack>
                <XStack gap="$2" flexWrap="wrap">
                  <Button
                    variant="primary"
                    size="$4"
                    onPress={() => {
                      if (
                        cashRefundInFlight.current ||
                        cashRefundMutation.isPending
                      ) {
                        return;
                      }
                      cashRefundInFlight.current = true;
                      setCashErrorMessage(null);
                      cashRefundMutation.mutate({
                        orgId,
                        orderId,
                        ...(trimmedCashNote ? { note: trimmedCashNote } : {}),
                      });
                    }}
                    disabled={cashRefundMutation.isPending}
                  >
                    {cashRefundMutation.isPending
                      ? String(t("admin.processingRefund"))
                      : cashPaidCents > 0
                        ? String(
                            t("admin.odCashRefundConfirm", {
                              amount: cashAmount,
                            }),
                          )
                        : String(t("admin.odCashRefundConfirmZero"))}
                  </Button>
                  <Button
                    variant="ghost"
                    size="$4"
                    onPress={() => {
                      setCashStep("idle");
                      setCashErrorMessage(null);
                    }}
                    disabled={cashRefundMutation.isPending}
                  >
                    {String(t("admin.cancel"))}
                  </Button>
                </XStack>
                <Text variant="caption" tone="muted">
                  {String(
                    t("admin.odCashRefundWindowOpen", {
                      date: fmtDate(fmt, order.cashRefundableUntil),
                    }),
                  )}
                </Text>
              </YStack>
            )}

            {!cashResult && cashAffordance === "closed" && (
              <YStack gap="$2">
                <Text variant="body" weight="bold" tag="h3">
                  {String(t("admin.odCashRefundTitle"))}
                </Text>
                <Text variant="bodySmall">
                  {String(
                    t("admin.odCashRefundWindowClosed", {
                      date: fmtDateShort(fmt, order.cashRefundableUntil),
                    }),
                  )}
                </Text>
                <XStack>
                  <ButtonOutline href="/contact" style={{ minHeight: 44 }}>
                    {String(t("admin.odContactSupport"))}
                  </ButtonOutline>
                </XStack>
              </YStack>
            )}

            {cashResult && (
              <XStack gap="$2" alignItems="flex-start" role="status">
                <CheckCircle
                  size={14}
                  color="var(--success, #166534)"
                  style={{ flexShrink: 0, marginTop: 2 }}
                  aria-hidden
                />
                <Text variant="bodySmall">
                  {cashResult.alreadyRefunded
                    ? String(t("admin.odCashRefundAlreadyDone"))
                    : cashResult.amountReturnedCents > 0
                      ? String(
                          t("admin.odCashRefundDone", {
                            amount: fmtCurrency(
                              fmt,
                              cashResult.amountReturnedCents,
                              order.currency,
                            ),
                          }),
                        )
                      : String(t("admin.odCashRefundDoneZero"))}
                </Text>
              </XStack>
            )}

            {cashErrorMessage && (
              <XStack gap="$2" alignItems="flex-start" role="alert">
                <AlertTriangle
                  size={14}
                  color="var(--danger, #B91C1C)"
                  style={{ flexShrink: 0, marginTop: 2 }}
                  aria-hidden
                />
                <Text variant="bodySmall" tone="error">
                  {cashErrorMessage}
                </Text>
              </XStack>
            )}
          </YStack>
        </>
      )}

      {/* Refund actions — gated on org-finance capability */}
      {canFinance && eligibleItemIds.size > 0 && (
        <>
          <Separator marginBottom="$3" />
          <YStack gap="$3">
            {refundStep === "idle" && selectedItemIds.size > 0 && (
              <XStack gap="$3" alignItems="center">
                <Button variant="primary" size="$3" onPress={handleQuote}>
                  <RotateCcw size={14} aria-hidden />
                  {String(
                    t("admin.quoteRefund", { count: selectedItemIds.size }),
                  )}
                </Button>
              </XStack>
            )}

            {refundStep === "quoting" && (
              <XStack gap="$2" alignItems="center">
                <Spinner size="sm" />
                <Text variant="body" tone="muted">
                  {String(t("admin.calculatingRefund"))}
                </Text>
              </XStack>
            )}

            {quoteQuery.error &&
              refundStep === "idle" &&
              selectedItemIds.size > 0 && (
                <XStack gap="$2" alignItems="center">
                  <AlertTriangle size={14} color="var(--danger)" />
                  <Text variant="bodySmall" tone="error">
                    {String(
                      t("admin.couldNotLoadQuote", {
                        error: formatErrorMessage(quoteQuery.error, t),
                      }),
                    )}
                  </Text>
                </XStack>
              )}

            {refundStep === "confirm" && quoteQuery.data && (
              <CardSurface
                padding="$3"
                borderWidth={2}
                borderColor="$borderColor"
              >
                <YStack gap="$3">
                  <Text variant="body" weight="bold">
                    {String(t("admin.refundQuote"))}
                  </Text>

                  {/* Transfer reversal warning */}
                  {quoteQuery.data.hasTransferReversals && (
                    <XStack
                      gap="$2"
                      padding="$2"
                      borderRadius={0}
                      borderWidth={2}
                      borderColor="var(--warning, #92400E)"
                      backgroundColor="var(--warningMuted, rgba(245, 158, 11, 0.08))"
                      alignItems="center"
                    >
                      <ArrowLeftRight
                        size={14}
                        color="var(--warning, #92400E)"
                        style={{ flexShrink: 0 }}
                      />
                      <Text
                        variant="bodySmall"
                        style={{ color: "var(--warning, #92400E)" }}
                      >
                        {String(t("admin.transferReversalWarning"))}
                      </Text>
                    </XStack>
                  )}

                  {/* Per-item breakdown */}
                  {quoteQuery.data.items.map((qi) => {
                    const typeName =
                      (qi.ticketTypeId &&
                        order.ticketTypeNames[qi.ticketTypeId]) ||
                      String(t("admin.itemFallback"));
                    return (
                      <XStack
                        key={qi.orderItemId}
                        justifyContent="space-between"
                      >
                        <YStack>
                          <XStack gap="$1" alignItems="center">
                            <Text variant="bodySmall">{typeName}</Text>
                            {qi.requiresTransferReversal && (
                              <ArrowLeftRight
                                size={10}
                                color="var(--warning, #92400E)"
                              />
                            )}
                          </XStack>
                          {!qi.isEligible && (
                            <XStack gap="$1" alignItems="center">
                              <AlertTriangle size={12} color="var(--danger)" />
                              <Text variant="caption" tone="error">
                                {qi.ineligibleReason?.replace(/_/g, " ") ??
                                  String(t("admin.notEligible"))}
                              </Text>
                            </XStack>
                          )}
                        </YStack>
                        <YStack alignItems="flex-end">
                          <Text variant="bodySmall" weight="bold">
                            {fmtCurrency(
                              fmt,
                              qi.refundableCents,
                              quoteQuery.data.currency,
                            )}
                          </Text>
                          {qi.stripeFeeShareCents > 0 && (
                            <Text variant="caption" tone="muted">
                              {String(
                                t("admin.stripeFeeLabel", {
                                  amount: fmtCurrency(
                                    fmt,
                                    qi.stripeFeeShareCents,
                                    quoteQuery.data.currency,
                                  ),
                                }),
                              )}
                            </Text>
                          )}
                        </YStack>
                      </XStack>
                    );
                  })}

                  <Separator />

                  <XStack
                    justifyContent="space-between"
                    alignItems="center"
                    paddingTop="$1"
                  >
                    <Text variant="body" weight="bold">
                      {String(t("admin.totalRefund"))}
                    </Text>
                    <Text variant="body" weight="bold" color="$green10">
                      {fmtCurrency(
                        fmt,
                        quoteQuery.data.totalRefundableCents,
                        quoteQuery.data.currency,
                      )}
                    </Text>
                  </XStack>

                  {/* Required note (audit trail) */}
                  <YStack gap="$1">
                    <Text variant="caption" tone="muted">
                      {String(t("admin.refundNoteRequired"))}
                    </Text>
                    <TextInput
                      value={refundNote}
                      onChangeText={setRefundNote}
                      placeholder={t("admin.refundReasonPlaceholder") as string}
                      multiline
                      numberOfLines={2}
                    />
                    {!isNoteValid && trimmedNote.length > 0 && (
                      <Text variant="caption" tone="error">
                        {String(t("admin.refundNoteTooShort"))}
                      </Text>
                    )}
                  </YStack>

                  {scannedInRefundNotice}

                  <XStack gap="$3" justifyContent="flex-end">
                    <Button
                      variant="secondary"
                      size="$2"
                      onPress={handleCancelRefund}
                    >
                      {String(t("admin.cancel"))}
                    </Button>
                    <Button
                      variant="primary"
                      size="$2"
                      onPress={handleConfirmRefund}
                      disabled={
                        quoteQuery.data.totalRefundableCents <= 0 || !isNoteValid
                      }
                    >
                      {String(t("admin.confirmRefund"))}
                    </Button>
                  </XStack>
                </YStack>
              </CardSurface>
            )}

            {refundStep === "processing" && (
              <XStack gap="$2" alignItems="center">
                <Spinner size="sm" />
                <Text variant="body" tone="muted">
                  {String(t("admin.processingRefund"))}
                </Text>
              </XStack>
            )}

            {refundMutation.error && (
              <XStack gap="$2" alignItems="center">
                <AlertTriangle size={14} color="var(--danger)" />
                <Text variant="bodySmall" tone="error">
                  {formatErrorMessage(refundMutation.error, t)}
                </Text>
              </XStack>
            )}
          </YStack>
        </>
      )}

      {/* Whole-order refund — the only org path for a RESALE order */}
      {canRefundWholeOrder && (
        <>
          <Separator marginBottom="$3" />
          <YStack gap="$3">
            {refundStep === "idle" && (
              <YStack gap="$3">
                <XStack gap="$2" alignItems="flex-start">
                  <RotateCcw
                    size={14}
                    color="var(--colorMuted)"
                    style={{ flexShrink: 0, marginTop: 2 }}
                    aria-hidden
                  />
                  <Text variant="bodySmall" tone="muted">
                    {String(t("admin.resaleRefundExplainer"))}
                  </Text>
                </XStack>
                <XStack>
                  <Button
                    variant="primary"
                    size="$3"
                    onPress={handleStartFullRefund}
                  >
                    {String(t("admin.refundWholeOrder"))}
                  </Button>
                </XStack>
              </YStack>
            )}

            {refundStep === "confirm" && (
              <CardSurface
                padding="$3"
                borderWidth={2}
                borderColor="$borderColor"
              >
                <YStack gap="$3">
                  <Text variant="body" weight="bold">
                    {String(t("admin.refundWholeOrder"))}
                  </Text>

                  <Text variant="bodySmall" tone="muted">
                    {String(t("admin.resaleRefundExplainer"))}
                  </Text>

                  <Separator />

                  {/* No org-scoped full-refund quote exists. `refundFullOrder`
                      returns what the buyer paid (`computeExpectedPaymentAmount`)
                      less the payment processing fee Stripe keeps, looked up
                      when the refund runs, so the confirm names the paid
                      figure and says the fee comes off it. It used to show
                      `amountGrossCents` as "Total": the ticket money alone,
                      which is neither what was paid nor what is refunded.
                      `refundBasePaidCents` is that same function's figure,
                      from the server, so the row matches the refund's base
                      even where the display breakdown departs from it. */}
                  <YStack gap="$1" paddingTop="$1">
                    <MoneyLine
                      strong
                      label={String(t("admin.odBuyerPaid"))}
                      value={fmtCurrency(
                        fmt,
                        order.refundBasePaidCents,
                        order.currency,
                      )}
                    />
                    <Text variant="caption" tone="muted">
                      {String(t("admin.odRefundLessProcessingFee"))}
                    </Text>
                  </YStack>

                  {/* Required note (audit trail) */}
                  <YStack gap="$1">
                    <Text variant="caption" tone="muted">
                      {String(t("admin.refundNoteRequired"))}
                    </Text>
                    <TextInput
                      value={refundNote}
                      onChangeText={setRefundNote}
                      placeholder={t("admin.refundReasonPlaceholder") as string}
                      aria-label={String(t("admin.refundNoteRequired"))}
                      multiline
                      numberOfLines={2}
                    />
                    {!isNoteValid && trimmedNote.length > 0 && (
                      <Text variant="caption" tone="error">
                        {String(t("admin.refundNoteTooShort"))}
                      </Text>
                    )}
                  </YStack>

                  {scannedInRefundNotice}

                  <XStack gap="$3" justifyContent="flex-end">
                    <Button
                      variant="secondary"
                      size="$2"
                      onPress={handleCancelRefund}
                    >
                      {String(t("admin.cancel"))}
                    </Button>
                    <Button
                      variant="primary"
                      size="$2"
                      onPress={handleConfirmFullRefund}
                      disabled={!isNoteValid}
                    >
                      {String(t("admin.confirmFullRefund"))}
                    </Button>
                  </XStack>
                </YStack>
              </CardSurface>
            )}

            {refundStep === "processing" && (
              <XStack gap="$2" alignItems="center">
                <Spinner size="sm" />
                <Text variant="body" tone="muted">
                  {String(t("admin.processingRefund"))}
                </Text>
              </XStack>
            )}

            {fullRefundMutation.error && (
              <XStack gap="$2" alignItems="center">
                <AlertTriangle size={14} color="var(--danger)" />
                <Text variant="bodySmall" tone="error">
                  {formatErrorMessage(fullRefundMutation.error, t)}
                </Text>
              </XStack>
            )}
          </YStack>
        </>
      )}

      {/* Dispute refund block — explained inline, before any server call */}
      {canFinance && refundBlockedByDispute && (
        <>
          <Separator marginBottom="$3" />
          <XStack
            gap="$2"
            alignItems="flex-start"
            paddingVertical="$1"
            role="status"
          >
            <ShieldAlert
              size={14}
              color="var(--warning, #92400E)"
              style={{ flexShrink: 0, marginTop: 2 }}
              aria-hidden
            />
            {/* i18n: key pending — admin.refundBlockedByDispute / …Lost */}
            <Text variant="bodySmall" tone="muted">
              {order.disputeStatus === "LOST"
                ? ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE
                : ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE}
            </Text>
          </XStack>
        </>
      )}

      {/* No refundable items notice */}
      {eligibleItemIds.size === 0 &&
        order.items.length > 0 &&
        !refundBlockedByDispute &&
        !canRefundWholeOrder &&
        !isCashOrder && (
        <>
          <Separator marginBottom="$3" />
          <XStack gap="$2" alignItems="center" paddingVertical="$1">
            <AlertTriangle size={14} color="var(--colorMuted)" />
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.noTicketsEligible"))}
            </Text>
          </XStack>
        </>
      )}
    </CardSurface>
  );
}
