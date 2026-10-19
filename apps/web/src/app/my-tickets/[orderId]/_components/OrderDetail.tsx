"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { QRCodeSVG } from "qrcode.react";
import {
  YStack,
  XStack,
  Card,
  Spinner,
  Stack,
  styled,
  useMedia,
  type TamaguiElement,
} from "tamagui";
import {
  ArrowLeft,
  RefreshCw,
  Repeat,
  Send,
  Calendar,
  Lock,
  MapPin,
  Printer,
  Wallet,
} from "lucide-react";

import {
  Text,
  Button,
  Badge,
  Ticket,
  ButtonGroup,
  MenuButton,
  useTranslations,
  useFormatters,
} from "@th/ui";

import { formatOrderCode } from "@th/types/order-identifier";

import { trpc } from "@/trpc";
import { useSupportChatAvailable } from "@/components/support/SupportWidget";
import { getAppErrorCode } from "@/lib/app-error";
import { EmailVerificationRequiredPage } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { useEmailGateLatch } from "@/hooks/useEmailGateLatch";
import { fmtCurrency } from "@/lib/format";
import { useIsMobile } from "@/hooks/useIsMobile";
import { selectPrintableTickets } from "@/lib/tickets/printable-tickets";
// One rule only (`@media print { [data-print-hide] { display: none } }`) —
// NOT the paper stylesheet, which would re-margin this page via `@page`.
import "@/app/_print/print-hide.css";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { isRefundPending } from "@/lib/resale-claims";
import { ResaleClaimSection, useResaleClaimView } from "./ResaleClaimSection";

// ── Structural line (Swiss 2px divider) ────────────────────────────────────

const Separator = styled(YStack, {
  name: "StructuralLine",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
});

// ── Skeletons ──────────────────────────────────────────────────────────────

const SkeletonPulse = styled(Stack, {
  name: "SkeletonPulse",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

/** v2 kicker index numeral — decorative, so aria-hidden. fontSize bumped to
 *  14 to sit optically next to the section headings (override noted per the
 *  page-pass checklist; matches the home-pilot section-number pattern). */
const SectionNum = ({ children }: { children: ReactNode }) => (
  <Text
    variant="kicker"
    tone="accent"
    weight="bold"
    aria-hidden
    fontSize={14}
    minWidth={28}
  >
    {children}
  </Text>
);

const OrderDetailSkeleton = () => (
  <YStack gap="$6" maxWidth={640} marginHorizontal="auto" width="100%">
    {/* Back link */}
    <SkeletonPulse height={16} width={120} />
    {/* Header */}
    <YStack gap="$2">
      <XStack justifyContent="space-between" alignItems="center">
        <SkeletonPulse height={28} width="65%" />
        <SkeletonPulse height={22} width={80} borderRadius={0} />
      </XStack>
      <SkeletonPulse height={16} width="40%" />
      <SkeletonPulse height={16} width="55%" />
    </YStack>
    {/* Summary card */}
    <Card padding="$4" gap="$3" borderRadius={0}>
      <SkeletonPulse height={20} width={140} />
      <Separator />
      <YStack gap="$2">
        <XStack justifyContent="space-between">
          <SkeletonPulse height={16} width={100} />
          <SkeletonPulse height={16} width={80} />
        </XStack>
        <XStack justifyContent="space-between">
          <SkeletonPulse height={16} width={100} />
          <SkeletonPulse height={16} width={80} />
        </XStack>
        <Separator />
        <XStack justifyContent="space-between">
          <SkeletonPulse height={18} width={80} />
          <SkeletonPulse height={18} width={70} />
        </XStack>
      </YStack>
    </Card>
    {/* Ticket cards */}
    <YStack gap="$4">
      <SkeletonPulse height={22} width={120} />
      <Card bordered padding="$3" gap="$3" borderRadius={0}>
        <XStack justifyContent="space-between" alignItems="center">
          <YStack gap="$1">
            <SkeletonPulse height={18} width={120} />
            <SkeletonPulse height={14} width={60} />
          </YStack>
          <SkeletonPulse height={22} width={50} borderRadius={0} />
        </XStack>
        <Separator />
        <XStack gap="$3" alignItems="center">
          <SkeletonPulse width={140} height={140} borderRadius={0} />
          <YStack gap="$1" flex={1}>
            <SkeletonPulse height={14} width={90} />
            <SkeletonPulse height={18} width="80%" />
            <SkeletonPulse height={12} width="60%" />
          </YStack>
        </XStack>
      </Card>
    </YStack>
  </YStack>
);

// ── Helpers ────────────────────────────────────────────────────────────────

const orderStatusKeys: Record<string, { key: string; color: string }> = {
  SUCCEEDED: { key: "myTickets.confirmed", color: "$green10" },
  PENDING: { key: "myTickets.pending", color: "$yellow10" },
  PROCESSING: { key: "myTickets.paymentProcessing", color: "$yellow10" },
  PART_REFUNDED: { key: "myTickets.partialRefund", color: "$orange10" },
  REFUNDED: { key: "myTickets.refunded", color: "$gray10" },
  DISPUTED: { key: "myTickets.disputed", color: "$red10" },
  CANCELLED: { key: "myTickets.cancelled", color: "$gray10" },
};

const orderStatusTone: Record<
  string,
  "success" | "warning" | "danger" | "neutral" | "info"
> = {
  SUCCEEDED: "success",
  PENDING: "warning",
  // A bank debit still clearing: not paid yet, and it can still fail.
  PROCESSING: "warning",
  PART_REFUNDED: "info",
  REFUNDED: "neutral",
  DISPUTED: "danger",
  CANCELLED: "neutral",
};

const OrderStatusBadge = ({ status }: { status: string }) => {
  const t = useTranslations();
  const entry = orderStatusKeys[status];
  const label = entry ? String(t(entry.key)) : status;
  const tone = orderStatusTone[status] ?? ("neutral" as const);
  return (
    <Badge tone={tone} size="sm">
      {label}
    </Badge>
  );
};

const ticketStatusKeys: Record<string, { key: string; color: string }> = {
  VALID: { key: "orderDetail.valid", color: "$green10" },
  SCANNED: { key: "orderDetail.used", color: "$gray10" },
  INVALID: { key: "orderDetail.invalid", color: "$red10" },
  REFUNDED: { key: "myTickets.refunded", color: "$orange10" },
  LISTED: { key: "orderDetail.listedForResale", color: "$accent" },
};

const ticketStatusTone: Record<
  string,
  "success" | "neutral" | "danger" | "warning" | "info"
> = {
  VALID: "success",
  SCANNED: "neutral",
  INVALID: "danger",
  REFUNDED: "warning",
  LISTED: "info",
};

// ── Types ──────────────────────────────────────────────────────────────────

type TicketData = {
  id: string;
  code: string;
  status: string;
  scannedAt: Date | null;
  orderItemId: string | null;
  ticketTypeId: string | null;
};

type OrderItemData = {
  id: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  kind: string;
  ticketTypeId: string | null;
  /** Set when this item is a resale purchase (RESALE order) or the buyer
      listed it for resale — either way not item-refundable. */
  resaleListingId: string | null;
  paidOutAt: Date | null;
  refundedAt: Date | null;
  transferredAt: Date | null;
  status: string;
};

/** A ticket enriched with its linked order-item data (when available). */
type EnrichedTicket = TicketData & {
  item: OrderItemData | null;
  ticketTypeName: string | null;
};

// ── Per-ticket refund inline component ─────────────────────────────────────

/**
 * Whether the per-ticket "Refund" trigger may render at all.
 *
 * Sourced from `getRefundEligibility` — the SAME display query the full-refund
 * page reads and the same `classifyRefundItem` + window rule the mutations
 * enforce — never re-derived from dates on the client. `pending` covers the
 * query still loading: fail-closed, like the resale gate in `TicketCard`, so a
 * trigger never appears and then vanishes.
 */
type ItemRefundAvailability = "open" | "closed" | "pending";

type RefundEligibilityReason =
  inferRouterOutputs<AppRouter>["orders"]["getRefundEligibility"]["reason"];

/**
 * What each eligibility reason means for the per-ticket trigger. Exhaustive
 * over the query's `reason` union on purpose: a reason added server-side is a
 * type error here, not a button that silently fails.
 *
 * `closed` = `refundOrderItems` / `quoteItemRefund` would refuse a buyer
 * outright (`REFUND_WINDOW_CLOSED`, `ORDER_NON_REFUNDABLE`, `ORDER_NOT_PAID`,
 * the dispute guard) or every item is already classified ineligible.
 *
 * Deliberately `open`:
 * - `already_refunded` — the display query says this for PART_REFUNDED orders
 *   and short-circuits before the window check, but the item path still
 *   accepts them (the remaining tickets are refundable). Hiding would remove
 *   a working path; the quote error branch catches the closed-window case.
 *
 * `order_already_paid_out` is `closed`: buyer-initiated refunds stop at
 * payout on the server too (`classifyRefundItem` → `already_paid_out`, see
 * docs/decisions/buyer-refunds-stop-at-payout.md), so the per-ticket path
 * would only ever answer `items_not_refundable`.
 */
const ITEM_REFUND_BY_REASON: Record<RefundEligibilityReason, "open" | "closed"> =
  {
    eligible: "open",
    already_refunded: "open",
    order_already_paid_out: "closed",
    event_started: "closed",
    past_refund_deadline: "closed",
    non_refundable_order: "closed",
    no_refundable_items: "closed",
    // Free checkouts / comps: SUCCEEDED with no PaymentIntent, so the quote
    // throws ORDER_NOT_PAID — nothing to refund through Stripe.
    order_not_paid: "closed",
    order_not_found: "closed",
    disputed: "closed",
    disputed_lost: "closed",
    // An approved resale claim's refund is on its way: nothing to take back.
    claim_refund_pending: "closed",
  };

type ItemRefundActionProps = {
  orderId: string;
  orderItemId: string;
  currency: string;
};

type RefundStep = "idle" | "quoting" | "confirm";

const ItemRefundAction = ({
  orderId,
  orderItemId,
  currency,
}: ItemRefundActionProps) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<RefundStep>("idle");

  // Only fire the Stripe quote call once the user clicks the refund button.
  const quoteQuery = trpc.orders.quoteItemRefund.useQuery(
    { orderId, orderItemIds: [orderItemId] },
    {
      staleTime: 30_000,
      enabled: step === "quoting" || step === "confirm",
    },
  );

  const refundMutation = trpc.orders.refundOrderItems.useMutation({
    onSuccess: () => {
      void utils.orders.getMyOrder.invalidate({ orderId });
      void utils.orders.listMyOrderTickets.invalidate({ orderId });
      void utils.orders.listMyOrders.invalidate();
      // The order's eligibility changes with every item refund (status flips
      // to PART_REFUNDED / REFUNDED); the per-item gate reads it.
      void utils.orders.getRefundEligibility.invalidate({ orderId });
      setStep("idle");
    },
  });

  const quote = quoteQuery.data;
  const isRefunding = refundMutation.isPending;

  // A closed refund window is a policy refusal, not an outage: no Retry, and
  // the deadline copy the refund page already uses instead of "could not
  // load". Reached only when the display query could not report the window
  // itself (it short-circuits PART_REFUNDED orders as `already_refunded`
  // before the timing check).
  const quoteError = step === "quoting" ? quoteQuery.error : null;
  const windowClosed =
    !!quoteError && getAppErrorCode(quoteError) === "REFUND_WINDOW_CLOSED";

  // Pressing the trigger unmounts it, so on a quote failure keyboard focus
  // would fall to <body>. Move it to the failure's first action (Retry, or
  // Cancel when there is nothing to retry into); that action is described by
  // the message, so the reason is announced with the focus rather than left
  // to a freshly mounted live region.
  const errorActionRef = useRef<TamaguiElement>(null);
  useEffect(() => {
    if (!quoteError) return;
    // Web only (this is a Next.js route): the Tamagui ref is the DOM node.
    (errorActionRef.current as HTMLElement | null)?.focus();
  }, [quoteError]);
  const quoteErrorMessageId = `refund-item-${orderItemId}-quote-error`;

  // Advance to confirm once the quote arrives.
  if (step === "quoting" && quote) {
    setStep("confirm");
  }

  const handleConfirmRefund = useCallback(() => {
    refundMutation.mutate({
      orderId,
      orderItemIds: [orderItemId],
      reason: "requested_by_customer",
    });
  }, [refundMutation, orderId, orderItemId]);

  // ── Confirm panel ──────────────────────────────────────────────────────
  if (step === "confirm" && quote) {
    const itemQuote = quote.items[0];
    const showBreakdown =
      itemQuote && itemQuote.isEligible && itemQuote.stripeFeeShareCents > 0;

    return (
      <Card
        padding="$3"
        gap="$3"
        borderRadius={0}
        borderColor="$orange6"
        borderWidth={2}
      >
        <YStack gap="$2">
          <Text variant="bodySmall" weight="bold">
            {String(t("orderDetail.refundBreakdown"))}
          </Text>

          {showBreakdown && (
            <YStack gap="$2" paddingVertical="$1">
              {/* Ticket price */}
              <XStack justifyContent="space-between" alignItems="center">
                <Text variant="bodySmall" tone="muted">
                  {String(t("orderDetail.ticketPrice"))}
                </Text>
                <Text variant="bodySmall">
                  {fmtCurrency(fmt, itemQuote.buyerPaidCents, currency)}
                </Text>
              </XStack>

              {/* Tax (only when present) — without this row the maths
                   reads wrong: the total adds tax back in, so leaving it
                   off makes "ticket − fee" not equal "you will receive". */}
              {itemQuote.taxShareCents > 0 && (
                <XStack justifyContent="space-between" alignItems="center">
                  <Text variant="bodySmall" tone="muted">
                    {String(t("refund.tax"))}
                  </Text>
                  <Text variant="bodySmall">
                    {fmtCurrency(fmt, itemQuote.taxShareCents, currency)}
                  </Text>
                </XStack>
              )}

              {/* Stripe processing fee */}
              <XStack justifyContent="space-between" alignItems="flex-start">
                <YStack flex={1} paddingRight="$2">
                  <Text variant="bodySmall" tone="muted">
                    {String(t("orderDetail.stripeProcessingFee"))}
                  </Text>
                  <Text variant="bodySmall" tone="muted" fontSize={11}>
                    {String(t("orderDetail.stripeProcessingFeeNote"))}
                  </Text>
                </YStack>
                <Text variant="bodySmall" color="$red10">
                  −{fmtCurrency(fmt, itemQuote.stripeFeeShareCents, currency)}
                </Text>
              </XStack>

              <Separator />

              {/* Refund total — bumped to body/bold so the headline number
                  pops over the breakdown rows above it. */}
              <XStack
                justifyContent="space-between"
                alignItems="center"
                paddingTop="$1"
              >
                <Text variant="body" weight="bold">
                  {String(t("orderDetail.youWillReceive"))}
                </Text>
                <Text variant="body" weight="bold" color="$green10">
                  {fmtCurrency(fmt, itemQuote.refundableCents, currency)}
                </Text>
              </XStack>
            </YStack>
          )}

          {!showBreakdown && (
            <Text variant="bodySmall">
              {String(t("orderDetail.refundAmount"))}{" "}
              <Text variant="bodySmall" weight="bold" tag="span">
                {fmtCurrency(fmt, quote.totalRefundableCents, currency)}
              </Text>
            </Text>
          )}

          {itemQuote && !itemQuote.isEligible && (
            <Text variant="bodySmall" color="$red10">
              {String(t("orderDetail.notEligible"))}{" "}
              {itemQuote.ineligibleReason?.replace(/_/g, " ") ??
                String(t("orderDetail.ineligible"))}
            </Text>
          )}
          {refundMutation.error && (
            <Text variant="bodySmall" color="$red10">
              {isEmailVerificationRequired(refundMutation.error)
                ? String(t("errors.emailVerificationRequired"))
                : refundMutation.error.message}
            </Text>
          )}
          <XStack gap="$2">
            <Button
              size="$2"
              variant="primary"
              minHeight={44}
              onPress={handleConfirmRefund}
              disabled={
                isRefunding || (itemQuote != null && !itemQuote.isEligible)
              }
            >
              {isRefunding
                ? String(t("orderDetail.processing"))
                : String(t("orderDetail.confirmRefund"))}
            </Button>
            <Button
              size="$2"
              variant="ghost"
              minHeight={44}
              onPress={() => setStep("idle")}
              disabled={isRefunding}
            >
              {String(t("orderDetail.cancel"))}
            </Button>
          </XStack>
        </YStack>
      </Card>
    );
  }

  // ── Quoting in progress ────────────────────────────────────────────────
  if (step === "quoting") {
    // Error while fetching quote — let user retry or dismiss.
    if (quoteError) {
      return (
        <YStack gap="$2">
          {windowClosed ? (
            <Text
              id={quoteErrorMessageId}
              variant="bodySmall"
              tone="muted"
              data-testid={`refund-item-${orderItemId}-closed`}
            >
              {String(t("refund.reasonPastDeadline"))}
            </Text>
          ) : (
            <Text id={quoteErrorMessageId} variant="bodySmall" color="$red10">
              {String(
                t(
                  isEmailVerificationRequired(quoteError)
                    ? "errors.emailVerificationRequired"
                    : "orderDetail.couldNotLoadQuote",
                ),
              )}
            </Text>
          )}
          <XStack gap="$2">
            {!windowClosed && (
              <Button
                ref={errorActionRef}
                aria-describedby={quoteErrorMessageId}
                size="$2"
                variant="secondary"
                minHeight={44}
                onPress={() => {
                  void quoteQuery.refetch();
                }}
                data-testid={`refund-item-${orderItemId}-retry`}
              >
                <RefreshCw size={14} aria-hidden />
                {String(t("orderDetail.retry"))}
              </Button>
            )}
            <Button
              ref={windowClosed ? errorActionRef : undefined}
              aria-describedby={windowClosed ? quoteErrorMessageId : undefined}
              size="$2"
              variant="ghost"
              minHeight={44}
              onPress={() => setStep("idle")}
              data-testid={`refund-item-${orderItemId}-cancel`}
            >
              {String(t("orderDetail.cancel"))}
            </Button>
          </XStack>
        </YStack>
      );
    }

    return (
      <XStack gap="$2" alignItems="center">
        <Spinner size="small" />
        <Text variant="bodySmall" tone="muted">
          {String(t("orderDetail.calculatingRefund"))}
        </Text>
      </XStack>
    );
  }

  // ── Idle: simple trigger button ────────────────────────────────────────
  return (
    <Button
      size="$2"
      variant="secondary"
      minHeight={44}
      onPress={() => setStep("quoting")}
      data-testid={`refund-item-${orderItemId}`}
    >
      <RefreshCw size={14} aria-hidden />
      {String(t("orderDetail.refund"))}
    </Button>
  );
};

// ── Unified Ticket Card ────────────────────────────────────────────────────

type TicketCardProps = {
  ticket: EnrichedTicket;
  orderId: string;
  currency: string;
  /** Event facts the ticket object prints — they live on the order, not the
      ticket, so the parent threads them down rather than re-querying. */
  eventName: string;
  eventStartsAt: Date | string | null;
  eventVenue: string | null;
  /** The event is over (server rule, `getMyOrder.eventEnded`): transfer and
      resale close, and the card says why "Transfer" is gone. */
  eventEnded: boolean;
  /** Order-level gate for the per-ticket refund trigger (see the type). */
  itemRefundAvailability: ItemRefundAvailability;
};

const TicketCard = ({
  ticket,
  orderId,
  currency,
  eventName,
  eventStartsAt,
  eventVenue,
  eventEnded,
  itemRefundAvailability,
}: TicketCardProps) => {
  // The ticket is landscape with a tear-off stub beside the body; below the
  // xs breakpoint there is no room for two columns, so the stub moves under
  // the body and the perforation turns horizontal. It re-declares its columns
  // rather than hiding anything.
  const media = useMedia();
  const t = useTranslations();
  const fmt = useFormatters();

  // `resale` feature gate — off by default until resale is vetted. When off,
  // the "Resell" entry link is hidden (fail-closed while gates load) so it
  // never dead-ends on the 404'd Seller Hub.
  const { gates } = useFeatureGates();
  const resaleEnabled = gates?.resale === true;

  const { item } = ticket;
  const isTransferred = !!item?.transferredAt;

  const statusEntry = isTransferred
    ? { key: "orderDetail.transferred", color: "$gray10" }
    : ticketStatusKeys[ticket.status];
  const statusLabel = statusEntry ? String(t(statusEntry.key)) : ticket.status;
  const tone: "success" | "neutral" | "danger" | "warning" | "info" =
    isTransferred ? "neutral" : (ticketStatusTone[ticket.status] ?? "neutral");
  const isUsable = !isTransferred && ticket.status === "VALID";

  const canRefund =
    item?.kind === "ticket" && item.status === "active" && !item.refundedAt;
  // Only a VALID ticket moves (core: TICKET_NOT_TRANSFERABLE otherwise). A
  // SCANNED ticket's item is still `active`, so the item alone would offer
  // Transfer mid-show and the transfer page would then find nothing to send.
  const transferEligible =
    !!item &&
    !item.transferredAt &&
    !item.paidOutAt &&
    canRefund &&
    ticket.status === "VALID";
  // A past event's ticket cannot change hands (core refuses it too, with
  // TICKET_TRANSFER_EVENT_PAST); the action goes and a note takes its place.
  const canTransfer = transferEligible && !eventEnded;
  const transferClosed = transferEligible && eventEnded;
  const canResell = canRefund && resaleEnabled && !eventEnded;
  // The per-ticket refund trigger, on top of the item predicate:
  // - `resaleListingId` set: on a RESALE order this is the listing the buyer
  //   PURCHASED (`refundOrderItems` refuses with RESALE_ORDER_USE_FULL_REFUND;
  //   the full-order path below does the unwind), and on any other order it
  //   is a listing the buyer OPENED (`listing_active`). Both cases close the
  //   trigger, so `order.source` is not needed to tell them apart here, and
  //   this is the field `classifyRefundItem` reads.
  //   On a resale order it is set for the life of the item, so it does NOT
  //   mean "on sale now" there: `canResell` above must never read it.
  // - `paidOutAt` set: buyer refunds stop at payout (`classifyRefundItem` →
  //   `already_paid_out`), so on a mixed order the trigger would only ever
  //   quote "not eligible". Same field `canTransfer` already reads.
  // - the order-level window gate from `getRefundEligibility`.
  const canRefundItem =
    canRefund &&
    !!item &&
    !item.resaleListingId &&
    !item.paidOutAt &&
    itemRefundAvailability === "open";

  const appleWallet = trpc.walletPasses.generate.useMutation({
    onSuccess(data) {
      if (!data.passBase64 || !data.filename) {
        throw new Error("Missing pass data");
      }
      const binary = atob(data.passBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.apple.pkpass" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const googleWallet = trpc.walletPasses.generate.useMutation({
    onSuccess(data) {
      if (!data.saveUrl) {
        throw new Error("Missing save URL");
      }
      window.open(data.saveUrl, "_blank", "noopener,noreferrer");
    },
  });

  return (
    // The ticket object itself, with its actions beneath it. It is NOT wrapped
    // in a Card: the Ticket *is* the card, and nesting one inside another is
    // exactly the doubled border the design system rules out.
    //
    // The old card also dimmed a spent ticket to `opacity: 0.65`. Removed —
    // dimming reads as broken rather than as spent, and someone showing a
    // refunded ticket at the door needs to read it, not squint at it.
    <YStack gap="$3" data-testid={`ticket-card-${ticket.id}`}>
      {/* State first: what this ticket IS before what it looks like. */}
      <XStack justifyContent="space-between" alignItems="center" gap="$3">
        {item ? (
          <Text variant="bodySmall" tone="muted">
            {fmtCurrency(fmt, item.amountCents, currency)}
          </Text>
        ) : (
          <Stack />
        )}
        <Badge tone={tone} size="sm">
          {statusLabel}
        </Badge>
      </XStack>

      {isTransferred ? (
        <Text variant="bodySmall" tone="muted">
          {String(t("orderDetail.ticketTransferredMessage"))}
        </Text>
      ) : (
        <>
          <Ticket
            medium="screen"
            stacked={media.xs}
            eventTitle={eventName}
            when={
              eventStartsAt
                ? fmt.dateTime(new Date(eventStartsAt), {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : undefined
            }
            whenLabel={String(t("orderDetail.ticketWhen"))}
            where={eventVenue ?? undefined}
            whereLabel={String(t("orderDetail.ticketWhere"))}
            tier={ticket.ticketTypeName ?? undefined}
            tierLabel={String(t("orderDetail.ticketTier"))}
            admitLabel={String(t("orderDetail.ticketAdmit"))}
            code={ticket.code}
            // `holder` and `seat` are part of the object's fixed fact set but
            // are not on `getMyOrder`'s output yet, so they are simply absent
            // rather than faked. Adding them is a use-case + repo change.
            qr={
              // Literal white is REQUIRED, not debt: a QR needs a true-white
              // quiet zone for scanners to lock on. Tinting this to paper
              // ($surface) or letting it track a dark theme breaks scanning at
              // the door. Same rule for every QR/barcode surface.
              <Stack backgroundColor="white" padding="$2">
                <QRCodeSVG
                  value={ticket.code}
                  size={140}
                  level="H"
                  includeMargin={false}
                  imageSettings={{
                    src: "/brand/hearth-flame-mark-orange.png",
                    height: 30,
                    // 30 × the compact mark's aspect (651/1032) — qrcode.react
                    // stretches the image to these exact dimensions rather than
                    // preserving the source ratio.
                    width: 18.9,
                    excavate: true,
                  }}
                />
              </Stack>
            }
            testId={`ticket-object-${ticket.id}`}
          />

          {ticket.scannedAt && (
            <Text variant="bodySmall" tone="muted" fontSize={12}>
              {String(
                t("orderDetail.scanned", {
                  date: fmt.dateTime(
                    new Date(
                      typeof ticket.scannedAt === "string"
                        ? ticket.scannedAt
                        : ticket.scannedAt,
                    ),
                    {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    },
                  ),
                }),
              )}
            </Text>
          )}


          {/*
            Ticket actions — ONE joined bar, the way the design system presents
            them beneath a ticket.

            They were two rows before: wallet passes in one, refund/resell/
            transfer in another, each row fenced off by a `Separator`, with gaps
            between the buttons and three different variants between them. That
            reads as three unrelated clusters. These are peers — every one of
            them acts on this same ticket — so they share one 2px seam and one
            variant, and the separators are gone.
          */}
          {(isUsable ||
            (item &&
              (canRefundItem ||
                canTransfer ||
                canResell))) && (
            <YStack gap="$2">
              <ButtonGroup label={String(t("orderDetail.ticketActions"))}>
                {/*
                  ONE wallet action, not two.

                  Spelled out, "Add to Apple Wallet" and "Add to Google Wallet"
                  ran ~250px each next to a 125px "Refund" — a bar of wildly
                  uneven segments. They are also one decision, not two: which
                  wallet is a detail of "save this ticket". Collapsed to a menu,
                  the bar's segments even out and the choice moves inside.
                */}
                {isUsable ? (
                  <MenuButton
                    size="$2"
                    variant="secondary"
                    minHeight={44}
                    label={
                      appleWallet.isPending || googleWallet.isPending
                        ? String(t("orderDetail.walletDownloading"))
                        : String(t("orderDetail.addToWallet"))
                    }
                    icon={<Wallet size={14} aria-hidden />}
                    testId={`wallet-menu-${ticket.id}`}
                    items={[
                      {
                        label: String(t("orderDetail.appleWallet")),
                        onSelect: () =>
                          appleWallet.mutate({
                            ticketId: ticket.id,
                            passType: "apple",
                          }),
                        disabled: appleWallet.isPending,
                        testId: `apple-wallet-${ticket.id}`,
                      },
                      {
                        label: String(t("orderDetail.googleWallet")),
                        onSelect: () =>
                          googleWallet.mutate({
                            ticketId: ticket.id,
                            passType: "google",
                          }),
                        disabled: googleWallet.isPending,
                        testId: `google-wallet-${ticket.id}`,
                      },
                    ]}
                  />
                ) : null}

                {item && canResell ? (
                  <Link
                    href={`/sell/listings/new?orderId=${encodeURIComponent(orderId)}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Button
                      size="$2"
                      variant="secondary"
                      minHeight={44}
                      tag="span"
                      data-testid={`resell-item-${item.id}`}
                    >
                      <Repeat size={14} aria-hidden />
                      {String(t("orderDetail.resell"))}
                    </Button>
                  </Link>
                ) : null}

                {item && canTransfer ? (
                  // `textDecoration: none` on the Link: it wraps the Button, so
                  // without it the anchor's underline runs under the whole
                  // control and the action reads as a text link wearing a
                  // border.
                  <Link
                    href={`/my-tickets/${orderId}/transfer`}
                    style={{ textDecoration: "none" }}
                  >
                    <Button
                      size="$2"
                      variant="secondary"
                      minHeight={44}
                      tag="span"
                      data-testid={`transfer-item-${item.id}`}
                    >
                      <Send size={14} aria-hidden />
                      {String(t("orderDetail.transfer"))}
                    </Button>
                  </Link>
                ) : null}

                {item && canRefundItem ? (
                  // Renders a peer trigger while idle; it expands into its own
                  // quote panel once pressed, which grows the row rather than
                  // sitting in it.
                  <ItemRefundAction
                    orderId={orderId}
                    orderItemId={item.id}
                    currency={currency}
                  />
                ) : null}
              </ButtonGroup>

              {/* Wallet failures belong under the bar, not inside it — an
                  error message is not a peer action and would break the seam. */}
              {appleWallet.error || googleWallet.error ? (
                <Text role="alert" variant="bodySmall" color="$danger" fontSize={12}>
                  {String(
                    t(
                      isEmailVerificationRequired(
                        appleWallet.error ?? googleWallet.error,
                      )
                        ? "errors.emailVerificationRequired"
                        : "orderDetail.walletError",
                    ),
                  )}
                </Text>
              ) : null}
            </YStack>
          )}

          {transferClosed ? (
            <Text
              variant="bodySmall"
              tone="muted"
              data-testid={`transfer-closed-${ticket.id}`}
            >
              {String(t("orderDetail.transferClosedEventEnded"))}
            </Text>
          ) : null}
        </>
      )}
    </YStack>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

type OrderDetailProps = {
  orderId: string;
  /** Platform support email (resolved server-side; always a real address). */
  supportEmail: string;
};

export const OrderDetail = ({ orderId, supportEmail }: OrderDetailProps) => {
  const t = useTranslations();
  const fmt = useFormatters();
  // Is the floating support chat reachable on this route? The SupportWidget
  // mounts its launcher only where the chat is available (not on hidden or
  // checkout routes), so gate the "prefer to chat?" pointer on that — never
  // point at a bubble that isn't there. Since 2026-08-27 the bubble is the
  // entry point at EVERY width.
  const isMobile = useIsMobile();
  const chatAvailable = useSupportChatAvailable();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const orderQuery = trpc.orders.getMyOrder.useQuery(
    { orderId },
    { staleTime: 30_000, refetchOnWindowFocus: true },
  );

  const ticketsQuery = trpc.orders.listMyOrderTickets.useQuery(
    { orderId },
    {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      enabled: !!orderQuery.data,
    },
  );

  const {
    data: order,
    isLoading: orderLoading,
    error: orderError,
  } = orderQuery;
  const { data: ticketsData, isLoading: ticketsLoading } = ticketsQuery;
  // B2, latched: the focus refetch below must not unmount an open code card.
  const orderGated = useEmailGateLatch(orderQuery);

  // Order-level refund eligibility — the display query the refund page reads,
  // which judges the window (and per-item classification) with the same rule
  // the mutations enforce. Gates the per-ticket "Refund" triggers so a buyer
  // is never offered a button the server will refuse. Only asked for orders
  // that can be refunded at all (it reaches Stripe for the processing fee).
  const eligibilityQuery = trpc.orders.getRefundEligibility.useQuery(
    { orderId },
    {
      staleTime: 30_000,
      enabled:
        order?.status === "SUCCEEDED" || order?.status === "PART_REFUNDED",
    },
  );
  const itemRefundAvailability: ItemRefundAvailability = eligibilityQuery.data
    ? ITEM_REFUND_BY_REASON[eligibilityQuery.data.reason]
    : eligibilityQuery.error
      ? // Fail-open on a transport failure: the eligibility read is not a
        // policy refusal, and the quote step has its own error handling
        // (including the closed-window mapping).
        "open"
      : "pending";

  // Sticky shrinking header: a 1px sentinel sits just above the header; once it
  // scrolls past the navbar pin-line the IntersectionObserver flips `.is-stuck`,
  // which CSS uses to shrink the title and collapse the metadata row. IO is used
  // (rather than a scroll listener) because the page scrolls an inner container,
  // not the window — IO tracks viewport-relative geometry regardless of which
  // element scrolls, and stays smooth under iOS momentum scrolling. Keyed on
  // `hasOrder` (a stable boolean) so window-focus refetches — which hand back a
  // fresh `order` reference — don't tear down and recreate the observer
  // mid-scroll (that churn previously left the header stuck on the way back up).
  const hasOrder = !!order;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const header = headerRef.current;
    if (!sentinel || !header || typeof IntersectionObserver === "undefined") {
      return;
    }

    // Desktop navbar is pinned at 68px; on mobile it auto-hides, so the header
    // pins at 0 (see globals.css). Offset the trigger line to match.
    const navOffset = window.matchMedia("(min-width: 768px)").matches ? 68 : 0;

    const observer = new IntersectionObserver(
      ([entry]) => {
        header.classList.toggle("is-stuck", !entry.isIntersecting);
      },
      { rootMargin: `-${navOffset + 1}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOrder]);

  // Deep-link support: order emails link to …/my-tickets/[orderId]#get-help.
  // The "get help" section only mounts after the order query resolves, so the
  // browser's native scroll-to-anchor on load fires before it exists. Once the
  // order is present, scroll it into view if that hash is set.
  useEffect(() => {
    if (!hasOrder || typeof window === "undefined") return;
    if (window.location.hash !== "#get-help") return;
    const el = document.getElementById("get-help");
    if (!el) return;
    const id = requestAnimationFrame(() =>
      el.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    return () => cancelAnimationFrame(id);
  }, [hasOrder]);

  // Build enriched tickets: join ticket → order item via orderItemId
  const enrichedTickets = useMemo<EnrichedTicket[]>(() => {
    if (!ticketsData?.tickets || !order) return [];

    const itemsById = new Map(order.items.map((i) => [i.id, i]));

    return ticketsData.tickets.map((ticket) => ({
      ...ticket,
      item: ticket.orderItemId
        ? (itemsById.get(ticket.orderItemId) ?? null)
        : null,
      ticketTypeName: ticket.ticketTypeId
        ? (order.ticketTypeNames[ticket.ticketTypeId] ?? null)
        : null,
    }));
  }, [ticketsData, order]);

  // How many tickets can be put on paper. Shares the predicate module with the
  // print sheet itself so the entry point and the document can never disagree
  // about whether there is anything to print.
  const printableTicketCount = useMemo(
    () => selectPrintableTickets(enrichedTickets).length,
    [enrichedTickets],
  );

  // Resale claim: the buyer's filed claims on this order, or the way to file
  // one. Decided here (before the early returns) so the sections below it
  // can be numbered.
  const { view: claimView, settled: claimsSettled } = useResaleClaimView(
    orderId,
    order,
    enrichedTickets,
  );

  // ── Withheld until the email is verified (B2) ─────────────────────────────

  if (orderGated) {
    return (
      <EmailVerificationRequiredPage
        context="order"
        backHref="/my-tickets"
        backLabel={String(t("orderDetail.backToMyTickets"))}
        testId="order-detail-verify-email"
      />
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  if (orderLoading) {
    return <OrderDetailSkeleton />;
  }

  // ── Error / not found ──────────────────────────────────────────────────────

  if (orderError || !order) {
    return (
      <YStack
        padding="$8"
        gap="$4"
        data-testid="order-detail-not-found"
        borderTopWidth={2}
        borderTopColor="$borderColor"
        maxWidth={640}
        marginHorizontal="auto"
        width="100%"
      >
        <Text
          variant="h4"
          color="$red10"
          textTransform="uppercase"
          letterSpacing={1}
          weight="bold"
        >
          {String(t("orderDetail.orderNotFound"))}
        </Text>
        {orderError && (
          <Text variant="body" tone="muted">
            {orderError.message}
          </Text>
        )}
        <Link href="/my-tickets">
          <Button tag="span" variant="secondary">
            {String(t("orderDetail.backToMyTickets"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  // An approved resale claim whose refund has not landed already owes the
  // buyer this money; the server refuses a second request (CLAIM_REFUND_PENDING).
  // The claim section explains it (`resaleClaim.nextApproved`), so the card
  // is simply hidden. Wait for the claim reads so it never flashes first.
  const claimRefundPending =
    claimView.kind === "claims" && claimView.claims.some(isRefundPending);
  // Every ticket on the order has left this buyer's hands (resold or gifted):
  // the refund page would answer "not eligible", so the card is not offered.
  // Derived from the loaded items. Resold and gifted look the same from the
  // seller's item (no link to the sale), so the copy stays neutral.
  // Ticket lines only, as get-refund-eligibility counts them: discount and
  // platform-credit lines stay "active" forever and would hide the departure.
  const ticketItems = order.items.filter((i) => i.kind === "ticket");
  const allTicketsDeparted =
    ticketItems.length > 0 &&
    ticketItems.every(
      (i) => i.transferredAt != null || i.status === "transferred",
    );
  const canRefundFullOrder =
    (order.status === "SUCCEEDED" || order.status === "PART_REFUNDED") &&
    claimsSettled &&
    !claimRefundPending &&
    !allTicketsDeparted;

  // Index numerals after "02. Your tickets" depend on which sections render.
  let nextSectionIndex = 3;
  const sectionNumeral = () =>
    `${String(nextSectionIndex++).padStart(2, "0")}.`;
  const refundNumeral = canRefundFullOrder ? sectionNumeral() : null;
  const claimNumeral = claimView.kind !== "none" ? sectionNumeral() : null;
  const helpNumeral = sectionNumeral();

  // What the buyer paid, already split server-side
  // (`computeBuyerChargeBreakdown`): the lines always add to Total paid, and
  // an ABSORB buyer gets no platform or processing line.
  const { charges } = order;

  return (
    <YStack
      gap="$6"
      data-testid="order-detail-content"
      maxWidth={640}
      marginHorizontal="auto"
      width="100%"
    >
      {/* ── Back link ─────────────────────────────────────────────────── */}
      <Link href="/my-tickets">
        <XStack gap="$2" alignItems="center" paddingVertical="$1">
          <ArrowLeft size={16} strokeWidth={2.5} color="var(--accent)" />
          <Text
            variant="bodySmall"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1.2}
            color="$accent"
            hoverStyle={{ color: "$color" }}
          >
            {String(t("orderDetail.backToMyTickets"))}
          </Text>
        </XStack>
      </Link>

      {/* ── Order Header (sticky, shrinks on scroll) ──────────────────── */}
      {/* 1px sentinel just above the sticky header. The negative marginBottom
          cancels the parent YStack's $6 (32px) gap so the sentinel sits flush
          against the header rather than adding visible space. */}
      <div
        ref={sentinelRef}
        aria-hidden
        style={{ height: 1, marginBottom: -32 }}
      />
      <div
        ref={headerRef}
        className="th-order-detail-header"
        data-testid="order-detail-header"
      >
        <div className="th-order-detail-header__bar">
          {/* Page's sole h1 (heading ladder) — styling is class-scoped in
              globals.css, so the element swap is purely semantic. */}
          <h1
            className="th-order-detail-header__title"
            data-testid="order-detail-event-name"
          >
            {order.eventName}
          </h1>
          <OrderStatusBadge status={order.status} />
        </div>
        <div className="th-order-detail-header__meta">
          <XStack gap="$4" flexWrap="wrap">
            {order.eventAddressLocked ? (
              // LOCKED (the event or its venue hides the address, and this
              // holder's reveal has not come, or never will). `eventVenue` is
              // only the coarse area label here, never a street, so it reads
              // as plain text: a maps link would route to a neighbourhood
              // centroid and look like directions. The notice says when (or
              // whether) the real address arrives.
              <YStack
                gap="$1"
                flexShrink={1}
                maxWidth="100%"
                data-testid="order-detail-address-locked"
              >
                {order.eventVenue && (
                  <XStack gap="$2" alignItems="flex-start" flexShrink={1}>
                    <Stack marginTop={2} flexShrink={0}>
                      <MapPin
                        size={14}
                        strokeWidth={2}
                        color="var(--colorMuted, #5C544A)"
                      />
                    </Stack>
                    <Text
                      variant="bodySmall"
                      tone="muted"
                      flexShrink={1}
                      data-testid="order-detail-venue"
                    >
                      {order.eventVenue}
                    </Text>
                  </XStack>
                )}
                <XStack gap="$2" alignItems="flex-start" flexShrink={1}>
                  <Stack marginTop={2} flexShrink={0}>
                    <Lock
                      size={14}
                      strokeWidth={2}
                      color="var(--color, #211C16)"
                    />
                  </Stack>
                  <Text
                    variant="bodySmall"
                    flexShrink={1}
                    data-testid="order-detail-address-locked-notice"
                  >
                    {order.eventAddressNeverShared
                      ? String(t("orderDetail.addressLocked.never"))
                      : order.eventAddressLockReason === "placeUnavailable"
                        ? // The venue's record couldn't be read, so the
                          // address stays locked (fail closed). A transient
                          // state, not a decision anyone made: no date, and
                          // no "ask the organizer".
                          String(t("orderDetail.addressLocked.unavailable"))
                      : order.eventAddressLockReason === "venueUnconfirmed"
                        ? // The venue hides its address and hasn't confirmed
                          // this event, so no date is coming.
                          String(t("orderDetail.addressLocked.venueUnconfirmed"))
                      : order.eventAddressRevealAt
                        ? String(
                            t("orderDetail.addressLocked.revealOn", {
                              // Same format as the event date beside it.
                              date: fmt.dateTime(
                                new Date(order.eventAddressRevealAt),
                                {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                },
                              ),
                            }),
                          )
                        : String(t("orderDetail.addressLocked.pending"))}
                  </Text>
                </XStack>
              </YStack>
            ) : order.eventVenue && (
              // `eventVenue` is the ADDRESS, not a venue name: get-my-order
              // builds it as `[addressText, locality].join(", ")`. For a real
              // event that is 77 chars ("7430 Huntwick Trail, Nashville, TN
              // 37221, United States of America, Nashville"), and it was
              // uppercased at letterSpacing 0.5 inside an XStack with no
              // `flexShrink`, so it could not shrink or wrap — it ran past the
              // header and read as missing. Three fixes, all matching patterns
              // already in this file: an address is DATA so it opts out of the
              // auto-uppercase and reads verbatim (same note as the organiser
              // email below), the row is allowed to shrink, and the pin is
              // pinned to the first line now that the text can wrap.
              <XStack
                gap="$2"
                alignItems="flex-start"
                flexShrink={1}
                maxWidth="100%"
              >
                <Stack marginTop={2} flexShrink={0}>
                  <MapPin size={14} strokeWidth={2} color="var(--colorMuted)" />
                </Stack>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                    order.eventVenue,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline", textUnderlineOffset: 2 }}
                >
                  <Text variant="bodySmall" tone="muted" flexShrink={1}>
                    {order.eventVenue}
                  </Text>
                </a>
              </XStack>
            )}
            {order.eventStartsAt && (
              <XStack gap="$2" alignItems="center">
                <Calendar size={14} strokeWidth={2} color="var(--colorMuted)" />
                <Text
                  variant="bodySmall"
                  tone="muted"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {fmt.dateTime(
                    new Date(
                      typeof order.eventStartsAt === "string"
                        ? order.eventStartsAt
                        : order.eventStartsAt,
                    ),
                    {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    },
                  )}
                </Text>
              </XStack>
            )}
          </XStack>
        </div>
      </div>

      {/* ── 01. Order Summary ──────────────────────────────────────── */}
      <Card
        padding="$4"
        gap="$3"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
        data-testid="order-detail-summary"
      >
        <XStack gap="$2" alignItems="center">
          <SectionNum>01.</SectionNum>
          <Text
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("orderDetail.orderSummary"))}
          </Text>
        </XStack>
        <Separator />
        <YStack gap="$2">
          {/* ONE code on a consumer receipt.
              The raw 36-char UUID used to sit in a second row directly below
              this one. It was there as the buyer's only stable handle back
              when the code above was conditional; now `formatOrderCode` always
              renders, so the UUID bought a buyer nothing and cost something:
              two mono hex rows that differ, where the short code is literally a
              substring of the long one. That is an invitation to quote the
              wrong string to support — the exact drift this code exists to
              kill. Anyone who genuinely needs the full id still has it in the
              address bar (`/my-tickets/<order.id>`), and support resolves the
              8-char code through admin search. The `orderDetail.orderNumber`
              label ("Order #") carries the hash, so the value is bare. */}
          <XStack justifyContent="space-between" alignItems="center">
            <Text variant="body" tone="muted">
              {String(t("orderDetail.orderNumber"))}
            </Text>
            {/* Order number = data → mono, per the v2 mono-for-data rule. */}
            <Text variant="code" weight="bold">
              {formatOrderCode(order.id)}
            </Text>
          </XStack>
          <XStack justifyContent="space-between" alignItems="center">
            <Text variant="body" tone="muted">
              {String(t("orderDetail.purchaseDate"))}
            </Text>
            <Text variant="body">
              {fmt.dateTime(
                new Date(
                  typeof order.occurredAt === "string"
                    ? order.occurredAt
                    : order.occurredAt,
                ),
                {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                },
              )}
            </Text>
          </XStack>
          <XStack justifyContent="space-between">
            <Text variant="body" tone="muted">
              {String(t("orderDetail.items"))}
            </Text>
            <Text variant="body">
              {String(t("myTickets.nTickets", { count: order.items.length }))}
            </Text>
          </XStack>

          <Separator />

          {/* Price breakdown */}
          <XStack justifyContent="space-between">
            <Text variant="body" tone="muted">
              {String(t("orderDetail.subtotal"))}
            </Text>
            <Text variant="body">
              {fmtCurrency(fmt, charges.subtotalCents, order.currency)}
            </Text>
          </XStack>
          {charges.platformFeeCents > 0 && (
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("orderDetail.platformFee"))}
              </Text>
              <Text variant="body">
                {fmtCurrency(fmt, charges.platformFeeCents, order.currency)}
              </Text>
            </XStack>
          )}
          {charges.taxCents > 0 && (
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("orderDetail.tax"))}
              </Text>
              <Text variant="body">
                {fmtCurrency(fmt, charges.taxCents, order.currency)}
              </Text>
            </XStack>
          )}
          {charges.processingFeeCents > 0 && (
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("orderDetail.processingFee"))}
              </Text>
              <Text variant="body">
                {fmtCurrency(fmt, charges.processingFeeCents, order.currency)}
              </Text>
            </XStack>
          )}
          {charges.creditCents < 0 && (
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("orderDetail.creditApplied"))}
              </Text>
              <Text variant="body">
                −{fmtCurrency(fmt, -charges.creditCents, order.currency)}
              </Text>
            </XStack>
          )}

          <Separator />

          <XStack justifyContent="space-between" paddingTop="$1">
            <Text
              variant="body"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.5}
            >
              {String(t("orderDetail.totalPaid"))}
            </Text>
            <Text variant="body" weight="bold">
              {fmtCurrency(fmt, charges.totalCents, order.currency)}
            </Text>
          </XStack>

          {/* Merchant-of-record disclosure. Under Stripe Connect separate
              charges + transfers, Ithas Fire is the MoR (buyer funds land on
              the platform balance); card-network rules require the buyer
              surfaces to name the MoR consistently with the ToS. */}
          <Text variant="bodySmall" tone="muted" fontSize={11}>
            {order.organiserName
              ? String(
                  t("orderDetail.merchantOfRecord", {
                    organiser: order.organiserName,
                  }),
                )
              : String(t("orderDetail.merchantOfRecordNoOrganiser"))}
          </Text>
        </YStack>
      </Card>

      {/* ── 02. Ticket Cards ─────────────────────────────────────────── */}

      <YStack gap="$4" data-testid="order-detail-tickets">
        <XStack
          gap="$2"
          alignItems="center"
          paddingBottom="$2"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
          flexWrap="wrap"
        >
          <SectionNum>02.</SectionNum>
          <Text
            variant="h3"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("orderDetail.yourTickets"))}
          </Text>
          {/* Print is a WHOLE-ORDER action — a family of four wants one sheet,
              not four buttons that each produce the same sheet — so it sits on
              the section header rather than inside each ticket card next to the
              per-ticket wallet buttons. Gated on the same predicate the wallet
              buttons use (VALID and not transferred), so it never opens a route
              that has nothing to print. */}
          {printableTicketCount > 0 && (
            // `data-print-hide`: if a buyer prints THIS page (rather than the
            // sheet), a "Print tickets" button on the paper is nonsense. The
            // marker's rule ships in `_print/print-hide.css`, imported above.
            <XStack marginLeft="auto" data-print-hide>
              <Link href={`/my-tickets/${orderId}/print`}>
                <Button
                  tag="span"
                  variant="secondary"
                  size="$2"
                  minHeight={44}
                  data-testid="print-tickets"
                >
                  <Printer size={14} aria-hidden />
                  {String(t("orderDetail.printTickets"))}
                </Button>
              </Link>
            </XStack>
          )}
        </XStack>
        {ticketsLoading ? (
          <YStack alignItems="center" padding="$4">
            <Spinner size="small" color="$color" />
          </YStack>
        ) : enrichedTickets.length > 0 ? (
          <YStack gap="$3">
            {enrichedTickets.map((ticket) => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                orderId={order.id}
                currency={order.currency}
                eventName={order.eventName}
                eventStartsAt={order.eventStartsAt}
                eventVenue={order.eventVenue}
                eventEnded={order.eventEnded === true}
                itemRefundAvailability={itemRefundAvailability}
              />
            ))}
          </YStack>
        ) : (
          <Card
            padding="$4"
            borderRadius={0}
            borderWidth={2}
            borderColor="$borderColor"
          >
            <Text
              variant="body"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.5}
              weight="bold"
            >
              {order.status === "PENDING"
                ? String(t("orderDetail.ticketsPending"))
                : allTicketsDeparted
                  ? String(t("orderDetail.ticketsTransferredAway"))
                  : String(t("orderDetail.noTicketsFound"))}
            </Text>
          </Card>
        )}
      </YStack>

      {/* ── 03. Full-order refund ────────────────────────────────────── */}

      {canRefundFullOrder && (
        <Card
          padding="$4"
          gap="$3"
          borderRadius={0}
          borderTopWidth={2}
          borderTopColor="$borderColor"
          borderBottomWidth={1}
          borderBottomColor="$borderColor"
        >
          <XStack gap="$2" alignItems="center">
            <SectionNum>{refundNumeral}</SectionNum>
            <Text
              variant="h4"
              tag="h2"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {String(t("orderDetail.needFullRefund"))}
            </Text>
          </XStack>
          <Text variant="bodySmall" tone="muted">
            {String(t("orderDetail.fullRefundDescription"))}
          </Text>
          <Link href={`/my-tickets/${orderId}/refund`}>
            <Button tag="span" variant="secondary" size="$3">
              {String(t("orderDetail.requestFullRefund"))}
            </Button>
          </Link>
        </Card>
      )}

      {/* ── Resale claim (buyer) ──────────────────────────────────────── */}

      {claimView.kind !== "none" && (
        <ResaleClaimSection
          orderId={orderId}
          view={claimView}
          numeral={<SectionNum>{claimNumeral}</SectionNum>}
        />
      )}

      {/* ── Help section (last) ─────────────────────────────────────────── */}
      {/* `id="get-help"` is the anchor that order emails deep-link to
          (…/my-tickets/[orderId]#get-help), so buyers land directly on the
          right contact. Organiser is first-line for event/order questions;
          platform support is the fallback for account/payment issues. */}

      <Card
        id="get-help"
        padding="$5"
        gap="$4"
        borderRadius={0}
        backgroundColor="$backgroundHover"
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <XStack gap="$2" alignItems="center">
          <SectionNum>{helpNumeral}</SectionNum>
          <Text
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("orderDetail.needHelp"))}
          </Text>
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("orderDetail.helpDescription"))}
        </Text>

        {order.organiserContactEmail ? (
          <YStack gap="$2">
            <Text variant="bodySmall" weight="bold">
              {order.organiserName
                ? `${String(t("orderDetail.helpContactOrganiser"))} · ${order.organiserName}`
                : String(t("orderDetail.helpContactOrganiser"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("orderDetail.helpOrganiserNote"))}
            </Text>
            <a
              href={`mailto:${encodeURIComponent(order.organiserContactEmail)}`}
              style={{ textDecoration: "none", width: "fit-content" }}
            >
              {/* Email address = data, not a label — opt out of the atom's
                  auto-uppercase so the address reads verbatim. */}
              <Button
                tag="span"
                variant="secondary"
                size="$3"
                style={{ textTransform: "none" }}
              >
                {order.organiserContactEmail}
              </Button>
            </a>
          </YStack>
        ) : null}

        <YStack gap="$2">
          <Text variant="bodySmall" weight="bold">
            {String(t("orderDetail.helpContactSupport"))}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {String(t("orderDetail.helpSupportNote"))}
          </Text>
          <a
            href={`mailto:${encodeURIComponent(supportEmail)}`}
            style={{ textDecoration: "none", width: "fit-content" }}
          >
            {/* Email address = data — no auto-uppercase (see above). */}
            <Button
              tag="span"
              variant="secondary"
              size="$3"
              style={{ textTransform: "none" }}
            >
              {supportEmail}
            </Button>
          </a>
          {chatAvailable ? (
            <Text variant="bodySmall" tone="muted">
              {String(t("orderDetail.helpChatDesktop"))}
            </Text>
          ) : null}
        </YStack>
      </Card>
    </YStack>
  );
};
