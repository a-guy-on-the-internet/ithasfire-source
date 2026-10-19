"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, Card, Spinner, styled } from "tamagui";

import { Text, Button, useTranslations, useFormatters } from "@th/ui";

// Swiss 2px structural divider
const Separator = styled(YStack, {
  name: "StructuralLine",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
});

import { trpc } from "@/trpc";
import { fmtCurrency } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import { EmailVerificationRequiredPage } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";

/**
 * Buyer-side wording of `ORDER_DISPUTED_REFUND_BLOCKED` (the staff sentence in
 * format-error-message.ts says "you can refund it", which is wrong for the
 * person who opened the dispute). Shown INSTEAD of the refund form.
 */
// i18n: key pending — refund.reasonDisputed
const BUYER_REFUND_BLOCKED_BY_DISPUTE_MESSAGE =
  "This order is under dispute with your card issuer, so it can't be refunded right now. Once the dispute closes, you can request a refund if anything is still owed.";

/** Dispute LOST (from the platform's side): the buyer already has the money. */
// i18n: key pending — refund.reasonDisputedLost
const BUYER_REFUND_BLOCKED_DISPUTE_LOST_MESSAGE =
  "Your card issuer resolved the dispute in your favour, so the money has already been returned to your card. There is nothing left to refund.";

/** The domain code the wire `errorFormatter` attaches (`data.appCode`). */
function isDisputeRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    message?: unknown;
    data?: { appCode?: unknown } | null;
  };
  return (
    e.data?.appCode === "ORDER_DISPUTED_REFUND_BLOCKED" ||
    e.message === "ORDER_DISPUTED_REFUND_BLOCKED"
  );
}

interface RefundRequestProps {
  orderId: string;
}

const reasonKeys: Record<string, string> = {
  eligible: "refund.reasonEligible",
  event_started: "refund.reasonEventStarted",
  already_refunded: "refund.reasonAlreadyRefunded",
  order_not_paid: "refund.reasonNotPaid",
  order_not_found: "refund.reasonNotFound",
  past_refund_deadline: "refund.reasonPastDeadline",
  order_already_paid_out: "refund.reasonPaidOut",
  no_refundable_items: "refund.reasonNoRefundableItems",
  non_refundable_order: "refund.reasonNonRefundable",
  claim_refund_pending: "refund.reasonClaimRefundPending",
};

export const RefundRequest = ({ orderId }: RefundRequestProps) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Resolve a message key, falling back to inline English when the key is not
  // yet present in the catalog. The translator returns the raw key string for
  // missing messages, so we probe via getRawMessage first to avoid rendering a
  // bare key. Used for the new refund-policy copy (see report for keys to add).
  const tx = (key: string, fallback: string): string => {
    const raw = fmt.getRawMessage(key);
    return raw ? String(t(key)) : fallback;
  };

  const formatTimeUntil = (date: Date | string): string => {
    const d = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return String(t("refund.eventStarted"));
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return String(t("refund.nDaysUntilEvent", { count: days }));
    if (hours > 0)
      return String(t("refund.nHoursUntilEvent", { count: hours }));
    const minutes = Math.floor(diffMs / (1000 * 60));
    return String(t("refund.nMinutesUntilEvent", { count: minutes }));
  };
  const [refundComplete, setRefundComplete] = useState(false);
  const [refundResult, setRefundResult] = useState<{
    refundedCents: number;
    currency: string;
    skippedItems?: Array<{ orderItemId: string; reason: string }>;
  } | null>(null);

  const eligibilityQuery = trpc.orders.getRefundEligibility.useQuery(
    { orderId },
    {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Retry on transient errors (e.g., fee lookup might take time)
        if (error.message?.includes("processing")) return failureCount < 5;
        return false;
      },
      retryDelay: 2000,
    },
  );

  const requestRefundMutation = trpc.orders.refundFullOrder.useMutation({
    onSuccess: (data) => {
      setRefundResult({
        refundedCents: data.refundedCents,
        currency: data.currency,
        skippedItems: data.skippedItems,
      });
      setRefundComplete(true);
    },
    onError: () => {
      setIsSubmitting(false);
    },
  });

  const handleRefundRequest = async () => {
    setIsSubmitting(true);
    requestRefundMutation.mutate({ orderId });
  };

  const { data, isLoading, error } = eligibilityQuery;

  // Loading state
  if (isLoading) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <Spinner size="large" color="$color" />
        <Text variant="body" tone="muted">
          {String(t("refund.checkingEligibility"))}
        </Text>
      </YStack>
    );
  }

  // Withheld until the email is verified (B2): "unable to check" is wrong,
  // the order is there once the code is in.
  if (isEmailVerificationRequired(error)) {
    return (
      <EmailVerificationRequiredPage
        context="order"
        backHref="/my-tickets"
        backLabel={String(t("orderDetail.backToMyTickets"))}
        testId="refund-verify-email"
      />
    );
  }

  // Error state
  if (error) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <Text variant="h4" color="$red10">
          {String(t("refund.unableToCheck"))}
        </Text>
        <Text variant="body" tone="muted">
          {error.message}
        </Text>
        <Link href={`/my-tickets/${orderId}`}>
          <Button tag="span" variant="secondary">
            {String(t("refund.backToOrder"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  if (!data) {
    return null;
  }

  // Refund complete
  if (refundComplete && refundResult) {
    return (
      <YStack padding="$4" gap="$6" maxWidth={600} marginHorizontal="auto">
        <Card
          padding="$6"
          borderRadius={0}
          backgroundColor="$green2"
          borderTopWidth={3}
          borderTopColor="$green10"
        >
          <YStack alignItems="center" gap="$4">
            <Text
              variant="h3"
              tag="h1"
              color="$green11"
              textTransform="uppercase"
              letterSpacing={0.5}
              weight="bold"
            >
              {String(t("refund.refundProcessed"))}
            </Text>
            <Text variant="body" textAlign="center">
              {String(
                t("refund.refundSubmitted", {
                  amount: fmtCurrency(
                    fmt,
                    refundResult.refundedCents,
                    refundResult.currency,
                  ),
                }),
              )}
            </Text>
            <Text variant="bodySmall" tone="muted" textAlign="center">
              {String(t("refund.refundDelay"))}
            </Text>
            {refundResult.skippedItems &&
              refundResult.skippedItems.length > 0 && (
                <Text variant="bodySmall" tone="muted" textAlign="center">
                  {String(
                    t("refund.skippedItemsNote", {
                      count: refundResult.skippedItems.length,
                    }),
                  )}
                </Text>
              )}
          </YStack>
        </Card>

        <XStack gap="$3" justifyContent="center">
          <Link href="/my-tickets">
            <Button tag="span" variant="primary">
              {String(t("orderDetail.backToMyTickets"))}
            </Button>
          </Link>
        </XStack>
      </YStack>
    );
  }

  // Dispute-blocked: the server refuses the refund outright (Stripe will not
  // refund a disputed charge), so there is no form to show — explain and stop.
  const buyerDisputeMessage =
    data.reason === "disputed"
      ? BUYER_REFUND_BLOCKED_BY_DISPUTE_MESSAGE
      : data.reason === "disputed_lost"
        ? BUYER_REFUND_BLOCKED_DISPUTE_LOST_MESSAGE
        : null;
  if (buyerDisputeMessage) {
    return (
      <YStack padding="$4" gap="$6" maxWidth={600} marginHorizontal="auto">
        <Link href={`/my-tickets/${orderId}`}>
          <XStack gap="$2" alignItems="center">
            <Text
              variant="bodySmall"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1.2}
              color="$accent"
              hoverStyle={{ color: "$color" }}
            >
              ← {String(t("refund.backToOrder"))}
            </Text>
          </XStack>
        </Link>

        <YStack
          gap="$2"
          paddingBottom="$3"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
        >
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("refund.requestRefund"))}
          </Text>
        </YStack>

        <Card
          padding="$4"
          borderRadius={0}
          backgroundColor="$orange2"
          gap="$2"
          role="status"
        >
          <Text variant="body" weight="bold">
            {String(t("refund.notEligible"))}
          </Text>
          <Text variant="body">{buyerDisputeMessage}</Text>
        </Card>

        <XStack gap="$3" justifyContent="flex-end">
          <Link href={`/my-tickets/${orderId}`}>
            <Button tag="span" variant="secondary">
              {String(t("refund.backToOrder"))}
            </Button>
          </Link>
        </XStack>
      </YStack>
    );
  }

  const { isEligible, reason, eventStartsAt, refundDeadline, feeBreakdown } =
    data;
  const hasTransferredItems = data.hasTransferredItems ?? false;
  const refundableItemCount = data.refundableItemCount ?? 0;
  const totalItemCount = data.totalItemCount ?? 0;

  return (
    <YStack padding="$4" gap="$6" maxWidth={600} marginHorizontal="auto">
      {/* Back link */}
      <Link href={`/my-tickets/${orderId}`}>
        <XStack gap="$2" alignItems="center">
          <Text
            variant="bodySmall"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1.2}
            color="$accent"
            hoverStyle={{ color: "$color" }}
          >
            ← {String(t("refund.backToOrder"))}
          </Text>
        </XStack>
      </Link>

      {/* Header */}
      <YStack
        gap="$2"
        paddingBottom="$3"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
      >
        <Text
          variant="h2"
          tag="h1"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {String(t("refund.requestRefund"))}
        </Text>
      </YStack>

      {/* Event Timing Card */}
      {eventStartsAt && (
        <Card
          padding="$4"
          borderRadius={0}
          gap="$3"
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <Text
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("refund.eventDetails"))}
          </Text>
          <Separator />
          <YStack gap="$2">
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("refund.eventDate"))}
              </Text>
              <Text variant="body">
                {fmt.dateTime(
                  new Date(
                    typeof eventStartsAt === "string"
                      ? eventStartsAt
                      : eventStartsAt,
                  ),
                  {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  },
                )}
              </Text>
            </XStack>
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("refund.timeUntilEvent"))}
              </Text>
              <Text variant="body">{formatTimeUntil(eventStartsAt)}</Text>
            </XStack>
            {refundDeadline && (
              <XStack justifyContent="space-between">
                <Text variant="body" tone="muted">
                  {String(t("refund.refundDeadline"))}
                </Text>
                <Text variant="body">
                  {fmt.dateTime(
                    new Date(
                      typeof refundDeadline === "string"
                        ? refundDeadline
                        : refundDeadline,
                    ),
                    {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    },
                  )}
                </Text>
              </XStack>
            )}
          </YStack>
        </Card>
      )}

      {/* Refund Breakdown Card - only show if fee breakdown is available */}
      {feeBreakdown && (
        <Card
          padding="$4"
          borderRadius={0}
          gap="$3"
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <Text
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("refund.refundBreakdown"))}
          </Text>
          <Separator />
          <YStack gap="$3">
            <XStack justifyContent="space-between">
              <Text variant="body">{String(t("refund.amountPaid"))}</Text>
              <Text variant="body">
                {fmtCurrency(
                  fmt,
                  feeBreakdown.amountPaidCents ?? 0,
                  feeBreakdown.currency,
                )}
              </Text>
            </XStack>

            {/* Refundable components: ticket price, tax, and the platform fee
                are ALL returned to the buyer. The payment-processing fee is the
                only component withheld (see below). */}
            {(feeBreakdown.ticketPriceCents ?? 0) > 0 && (
              <XStack justifyContent="space-between">
                <YStack>
                  <Text variant="body">{String(t("refund.ticketPrice"))}</Text>
                  <Text variant="bodySmall" color="$green10">
                    {tx("refund.platformFeeIncluded", "Fully refunded")}
                  </Text>
                </YStack>
                <Text variant="body">
                  {fmtCurrency(
                    fmt,
                    feeBreakdown.ticketPriceCents ?? 0,
                    feeBreakdown.currency,
                  )}
                </Text>
              </XStack>
            )}

            {(feeBreakdown.taxCents ?? 0) > 0 && (
              <XStack justifyContent="space-between">
                <YStack>
                  <Text variant="body">{String(t("refund.tax"))}</Text>
                  <Text variant="bodySmall" color="$green10">
                    {tx("refund.platformFeeIncluded", "Fully refunded")}
                  </Text>
                </YStack>
                <Text variant="body">
                  {fmtCurrency(
                    fmt,
                    feeBreakdown.taxCents ?? 0,
                    feeBreakdown.currency,
                  )}
                </Text>
              </XStack>
            )}

            {(feeBreakdown.platformFeeCents ?? 0) > 0 && (
              <XStack justifyContent="space-between">
                <YStack>
                  <Text variant="body">{String(t("refund.platformFee"))}</Text>
                  <Text variant="bodySmall" color="$green10">
                    {tx("refund.platformFeeIncluded", "Fully refunded")}
                  </Text>
                </YStack>
                <Text variant="body">
                  {fmtCurrency(
                    fmt,
                    feeBreakdown.platformFeeCents ?? 0,
                    feeBreakdown.currency,
                  )}
                </Text>
              </XStack>
            )}

            {/* Only the payment-processing fee is withheld — the payment
                processor keeps it even on a refund. */}
            <XStack justifyContent="space-between">
              <YStack flex={1} paddingRight="$3">
                <Text variant="body">
                  {String(t("refund.paymentProcessingFee"))}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  {tx(
                    "refund.processingFeeReason",
                    "Payment processing fees are retained by our payment processor and can't be returned.",
                  )}
                </Text>
              </YStack>
              <Text variant="body" color="$red10">
                -
                {fmtCurrency(
                  fmt,
                  feeBreakdown.stripeFeeCents ?? 0,
                  feeBreakdown.currency,
                )}
              </Text>
            </XStack>

            <Separator />

            <XStack justifyContent="space-between">
              <Text variant="body" weight="bold">
                {String(t("refund.youWillReceive"))}
              </Text>
              <Text
                variant="h4"
                weight="bold"
                color={isEligible ? "$green10" : "$gray10"}
              >
                {fmtCurrency(
                  fmt,
                  feeBreakdown.refundableCents ?? 0,
                  feeBreakdown.currency,
                )}
              </Text>
            </XStack>
          </YStack>
        </Card>
      )}

      {/* Transferred Items Notice */}
      {hasTransferredItems && isEligible && (
        <Card padding="$4" borderRadius={0} backgroundColor="$yellow2" gap="$2">
          <Text variant="body" weight="bold" color="$yellow11">
            {String(t("refund.partialRefundNotice"))}
          </Text>
          <Text variant="body" color="$yellow11">
            {String(
              t("refund.transferredItemsExplanation", {
                refundable: refundableItemCount,
                total: totalItemCount,
              }),
            )}
          </Text>
        </Card>
      )}

      {/* Eligibility Status Card */}
      <Card
        padding="$4"
        borderRadius={0}
        backgroundColor={isEligible ? "$blue2" : "$orange2"}
        gap="$2"
      >
        <Text variant="body" weight="bold">
          {isEligible
            ? String(t("refund.eligible"))
            : String(t("refund.notEligible"))}
        </Text>
        <Text variant="body">
          {reasonKeys[reason] ? String(t(reasonKeys[reason]!)) : reason}
        </Text>
      </Card>

      {/* Refund Policy Info */}
      <Card
        padding="$4"
        borderRadius={0}
        backgroundColor="$backgroundHover"
        gap="$3"
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <Text
          variant="bodySmall"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={1}
        >
          {String(t("refund.refundPolicy"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("refund.policyDeadline"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {data.isResale
            ? tx(
                "refund.policyFeeRefundableResale",
                "Your ticket price and tax are refunded. Only the payment processing fee is withheld, because our payment processor keeps it even when an order is refunded.",
              )
            : tx(
                "refund.policyFeeRefundable",
                "Your ticket price, tax, and the platform fee are all refunded. Only the payment processing fee is withheld, because our payment processor keeps it even when an order is refunded.",
              )}
        </Text>
      </Card>

      {/* Action Buttons */}
      <XStack gap="$3" justifyContent="flex-end">
        {/* Tertiary escape next to the destructive confirm → ghost (matches
            the inline refund confirm/cancel pair on the order page). */}
        <Link href={`/my-tickets/${orderId}`}>
          <Button tag="span" variant="ghost">
            {String(t("orderDetail.cancel"))}
          </Button>
        </Link>

        {isEligible && feeBreakdown ? (
          <Button
            variant="destructive"
            onPress={handleRefundRequest}
            disabled={isSubmitting}
          >
            {isSubmitting && <Spinner size="small" color="$colorInverted" />}
            {isSubmitting
              ? String(t("orderDetail.processing"))
              : String(
                  t("refund.confirmRefund", {
                    amount: fmtCurrency(
                      fmt,
                      feeBreakdown.refundableCents,
                      feeBreakdown.currency,
                    ),
                  }),
                )}
          </Button>
        ) : (
          <Button variant="secondary" disabled>
            {String(t("refund.refundNotAvailable"))}
          </Button>
        )}
      </XStack>

      {/* Error from mutation — a typed code (e.g. a dispute opened between
          the eligibility check and the refund) resolves to its sentence
          instead of leaking the raw identifier. The translator wrapper probes
          the catalog first so a pending key never logs a missing-message. */}
      {requestRefundMutation.error && (
        <Card padding="$4" borderRadius={0} backgroundColor="$red2" role="alert">
          <Text variant="body" color="$red11">
            {isDisputeRefusal(requestRefundMutation.error)
              ? // The dictionary sentence is staff wording ("the buyer's card
                // issuer"); the buyer gets their own.
                BUYER_REFUND_BLOCKED_BY_DISPUTE_MESSAGE
              : formatErrorMessage(requestRefundMutation.error, (key) =>
                  fmt.getRawMessage(key) ? String(t(key)) : key,
                )}
          </Text>
        </Card>
      )}
    </YStack>
  );
};

export default RefundRequest;
