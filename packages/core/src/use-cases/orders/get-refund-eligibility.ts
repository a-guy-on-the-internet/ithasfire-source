import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { allocateProportionalCents } from "../../lib/orders/allocate-proportional-cents";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { refundWeightCents } from "../../lib/orders/refund-weight";
import { allocateRefundFeeShares } from "../../lib/orders/refund-tax-share";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { allocateRefundTaxSharesForOrder } from "./_shared/refund-tax-shares-for-order";
import { isBlockedSettlementDisputeStatus } from "../settlements/dispute-statuses";
import { classifyRefundItem } from "./quote-item-refund";
import { hasPendingClaimRefund } from "./refund-full-order";

export const getRefundEligibilityInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export const getRefundEligibilityOutputSchema = z.object({
  orderId: z.string().uuid(),
  isEligible: z.boolean(),
  reason: z.enum([
    "eligible",
    "event_started",
    "already_refunded",
    "order_not_paid",
    "order_not_found",
    "past_refund_deadline",
    "order_already_paid_out",
    "no_refundable_items",
    "non_refundable_order",
    /** Charge under an OPEN / UNDER_REVIEW dispute — Stripe refuses refunds until it closes. */
    "disputed",
    /** Dispute LOST — the cardholder already has the money back; nothing to refund, ever. */
    "disputed_lost",
    /**
     * A resale claim on this order was approved and its refund has not landed
     * yet; `refundFullOrder` refuses with CLAIM_REFUND_PENDING.
     */
    "claim_refund_pending",
  ]),
  eventStartsAt: z.string().datetime().nullable(),
  refundDeadline: z.string().datetime().nullable(),
  feeBreakdown: z
    .object({
      amountPaidCents: z.number().int().nonnegative(),
      ticketPriceCents: z.number().int().nonnegative(),
      platformFeeCents: z.number().int().nonnegative(),
      taxCents: z.number().int().nonnegative(),
      stripeFeeCents: z.number().int().nonnegative(),
      refundableCents: z.number().int().nonnegative(),
      currency: z.string().min(3).max(3),
    })
    .nullable(),
  /**
   * True when the order is a resale purchase (no platform fee was charged on
   * it), so the page words its refund policy without one. Set on EVERY result
   * once the order is loaded, eligible or not (the policy card renders for
   * both); false only when there is no order to read it from.
   */
  isResale: z.boolean(),
  /** True when some items were transferred and won't be refunded. */
  hasTransferredItems: z.boolean(),
  /** Number of ticket items eligible for refund. */
  refundableItemCount: z.number().int().nonnegative(),
  /** Total ticket items in the order (refundable + ineligible). */
  totalItemCount: z.number().int().nonnegative(),
});

export type GetRefundEligibilityInput = z.infer<
  typeof getRefundEligibilityInputSchema
>;
export type GetRefundEligibilityOutput = z.infer<
  typeof getRefundEligibilityOutputSchema
>;

export type GetRefundEligibilityDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for the tax-line mismatch fallback (CLAUDE.md
   * error-reporting convention); a throwing reporter never changes the result.
   */
  reportError?: ReporterPort | null;
};

/**
 * Checks whether a buyer's order is eligible for a refund.
 * Returns eligibility status, timing info, and a fee breakdown.
 *
 * Default policy: refunds allowed until event starts.
 * Future: events can set refundCutoffHours to require earlier refund requests.
 */
export async function getRefundEligibility(
  deps: GetRefundEligibilityDeps,
  rawInput: unknown,
): Promise<GetRefundEligibilityOutput> {
  const logger = deps.logger?.child({ useCase: "getRefundEligibility" });
  const input = parseInput(getRefundEligibilityInputSchema, rawInput);

  /** Helper: build an ineligible response with default zero counts. */
  const ineligible = (
    reason: GetRefundEligibilityOutput["reason"],
    extra?: {
      eventStartsAt?: string | null;
      refundDeadline?: string | null;
      isResale?: boolean;
      hasTransferredItems?: boolean;
      refundableItemCount?: number;
      totalItemCount?: number;
    },
  ): GetRefundEligibilityOutput => ({
    orderId: input.orderId,
    isEligible: false,
    reason,
    eventStartsAt: extra?.eventStartsAt ?? null,
    refundDeadline: extra?.refundDeadline ?? null,
    feeBreakdown: null,
    isResale: extra?.isResale ?? false,
    hasTransferredItems: extra?.hasTransferredItems ?? false,
    refundableItemCount: extra?.refundableItemCount ?? 0,
    totalItemCount: extra?.totalItemCount ?? 0,
  });

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) return ineligible("order_not_found");

  // Basic ownership check
  if (order.buyerHumanId !== input.actorHumanId)
    return ineligible("order_not_found");

  // Every return past this point is about this buyer's order, so each one
  // carries `isResale` (the page's policy sentence reads it in every state).
  const isResale = order.source === "RESALE";
  const ineligibleOrder = (
    reason: GetRefundEligibilityOutput["reason"],
    extra?: Omit<NonNullable<Parameters<typeof ineligible>[1]>, "isResale">,
  ) => ineligible(reason, { ...extra, isResale });

  // ── Dispute guard (mirrors refund-full-order's pre-flight) ────────────
  // Checked before the status gates so a disputed order explains the
  // dispute rather than a less specific refusal.
  if (isBlockedSettlementDisputeStatus(order.disputeStatus)) {
    return ineligibleOrder(
      order.disputeStatus === "LOST" ? "disputed_lost" : "disputed",
    );
  }

  // Order must be in SUCCEEDED status to be refundable
  if (order.status === "REFUNDED" || order.status === "PART_REFUNDED") {
    return ineligibleOrder("already_refunded");
  }

  if (order.status !== "SUCCEEDED" || !order.stripePaymentIntentId) {
    return ineligibleOrder("order_not_paid");
  }

  // ── Non-refundable orders (adjustable-price / donation) ──────────────
  if (order.nonRefundable) {
    return ineligibleOrder("non_refundable_order");
  }

  // ── Classify items ─────────────────────────────────────────────────────
  const orderItems = await deps.repos.orderItems.listByOrderId(order.id);
  const ticketItems = orderItems.filter((item) => item.kind === "ticket");

  // ── Pending resale-claim refund (mirrors refund-full-order's buyer gate) ─
  // The order is SUCCEEDED here, so an approved claim means its refund is
  // still on its way; the refund would refuse with CLAIM_REFUND_PENDING.
  // Checked before the refund window on purpose: past the deadline, "your
  // claim's refund is on its way" is the more useful sentence.
  if (
    await hasPendingClaimRefund(deps.repos, {
      source: order.source,
      items: orderItems,
    })
  ) {
    return ineligibleOrder("claim_refund_pending");
  }

  // What this screen promises MUST be what `refundFullOrder` does for a
  // buyer, so item eligibility goes through the same `classifyRefundItem`
  // the two mutations use (refunded / transferred / listed-for-resale /
  // scanned / paid-out). One ticket read per ticket item, bounded by the
  // order.
  //
  // Paid-out items used to be a private special case here while the
  // mutations reversed the payout and refunded them. That divergence is
  // closed: buyer refunds stop at payout on the server too, and the
  // classifier's `already_paid_out` (buyer-initiated only) is the single
  // rule. See docs/decisions/buyer-refunds-stop-at-payout.md.
  const isTransferred = (item: (typeof ticketItems)[number]) =>
    item.status === "transferred" || item.transferredAt != null;
  const isPaidOut = (item: (typeof ticketItems)[number]) =>
    item.paidOutAt != null;

  const ticketByItemId = new Map(
    await Promise.all(
      ticketItems.map(
        async (item) =>
          [item.id, await deps.repos.tickets.getByOrderItemId(item.id)] as const,
      ),
    ),
  );

  const refundableItems = ticketItems.filter(
    (item) =>
      classifyRefundItem({
        item,
        ticket: ticketByItemId.get(item.id) ?? null,
        orderSource: order.source,
        buyerInitiated: true,
      }).ineligibleReason === null,
  );
  const hasTransferredItems = ticketItems.some(isTransferred);

  // Nothing refundable and at least one item paid out → the specific
  // reason (the one the help centre documents), not the generic one.
  const anyItemPaidOut = ticketItems.some(isPaidOut);
  if (anyItemPaidOut && refundableItems.length === 0) {
    return ineligibleOrder("order_already_paid_out", {
      hasTransferredItems,
      refundableItemCount: 0,
      totalItemCount: ticketItems.length,
    });
  }

  if (refundableItems.length === 0) {
    return ineligibleOrder("no_refundable_items", {
      hasTransferredItems,
      refundableItemCount: 0,
      totalItemCount: ticketItems.length,
    });
  }

  // Get event for timing check
  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) return ineligibleOrder("order_not_found");

  const now = deps.clock.now();
  const eventStartsAt = event.startsAt;
  const refundDeadline = event.refundCutoffAt ?? eventStartsAt;
  const timingExtra = {
    eventStartsAt: eventStartsAt.toISOString(),
    refundDeadline: refundDeadline.toISOString(),
    hasTransferredItems,
    refundableItemCount: refundableItems.length,
    totalItemCount: ticketItems.length,
  };

  if (now >= refundDeadline && now < eventStartsAt) {
    return ineligibleOrder("past_refund_deadline", timingExtra);
  }

  if (now >= eventStartsAt) {
    return ineligibleOrder("event_started", timingExtra);
  }

  // ── Fee breakdown (only for refundable items) ──────────────────────────
  const orderTotalPaidCents = computeExpectedPaymentAmount(order);
  if (orderTotalPaidCents <= 0)
    return ineligibleOrder("order_not_paid", timingExtra);

  const processingFee = await callOrDependencyFailed(
    () =>
      deps.payments.getProcessingFeeForPaymentIntent({
        paymentIntentId: order.stripePaymentIntentId!,
      }),
    logger,
    {
      action: "get_processing_fee",
      orderId: order.id,
      paymentIntentId: order.stripePaymentIntentId,
    },
  );

  const orderStripeFeeCents = processingFee.feeCents;

  // The SAME allocations `refundFullOrder` pays from and `quoteItemRefund`
  // quotes from: every order-level amount is split across ALL ticket items
  // with largest-remainder rounding, weighted by buyer-paid (ex-tax), and the
  // refundable items' shares are summed. Same allocator, same weights, same
  // tie-break — so what this screen promises is what either mutation moves,
  // to the cent, rather than a separately-rounded ratio that lands a cent off.
  //
  // `computeItemBuyerPaid` is a WEIGHT here, never an item's absolute base.
  // That distinction is the whole of the 2026-09-15 discount bug: a discount
  // is a separate NEGATIVE line item, so the per-item figure is PRE-discount
  // and summing it overshoots the charge. This screen was never wrong — it
  // allocates `computeExpectedPaymentAmount(order)`, which already nets every
  // negative line out — but `quoteItemRefund` read the raw figure as an
  // absolute and over-refunded the whole discount. It now takes its
  // ticket-price base from `allocateRefundItemBases`
  // (`lib/orders/refund-item-base.ts`), which is this same allocation less
  // tax. Do NOT "simplify" the line below to `computeItemBuyerPaid(item)` as a
  // per-item amount; it is only ever a ratio.
  //
  // The ratio is `refundWeightCents` (`lib/orders/refund-weight.ts`), the one
  // weight every refund path reads: buyer-paid, and 0 for a ticket a discount
  // brought down to $0 (owner ruling 2026-10-11), so this screen shows such a
  // ticket as worth $0 exactly as the quote and the refund do.
  const byBuyerPaid = (totalCents: number) =>
    allocateProportionalCents(ticketItems, totalCents, (item) =>
      refundWeightCents(item),
    );
  // Tax per PLATFORM tax line, same as the refund paths. On the per-line
  // path (≥2 lines summing to the tax) the paid amount is `base + taxShare`,
  // the one rule every refund path pays from there; every other order keeps
  // the buyer-paid split of the tax-inclusive total below, unchanged.
  const { taxByItem, perLinePaidByItem } = allocateRefundTaxSharesForOrder({
    useCase: "getRefundEligibility",
    order,
    ticketItems,
    taxLines: await deps.repos.orders.listTaxLines(order.id),
    logger,
    reportError: deps.reportError,
  });
  const paidByItem = perLinePaidByItem ?? byBuyerPaid(orderTotalPaidCents);
  const stripeFeeByItem = allocateRefundFeeShares(
    ticketItems,
    orderStripeFeeCents,
  );
  const grossByItem = byBuyerPaid(order.amountGrossCents);
  const platformFeeByItem = byBuyerPaid(order.feesPlatformCents);

  const sumOverRefundable = (shares: Map<string, number>) =>
    refundableItems.reduce((sum, item) => sum + (shares.get(item.id) ?? 0), 0);

  const refundableAmountPaidCents = sumOverRefundable(paidByItem);
  const refundableStripeFeeCents = sumOverRefundable(stripeFeeByItem);
  const refundableTaxCents = sumOverRefundable(taxByItem);
  const refundableGrossCents = sumOverRefundable(grossByItem);
  const refundablePlatformFeeCents = sumOverRefundable(platformFeeByItem);

  // Per-item clamp, exactly as `refundFullOrder` computes `refundedCents`.
  const refundableCents = refundableItems.reduce(
    (sum, item) =>
      sum +
      Math.max(
        0,
        (paidByItem.get(item.id) ?? 0) - (stripeFeeByItem.get(item.id) ?? 0),
      ),
    0,
  );

  return {
    orderId: order.id,
    isEligible: true,
    reason: "eligible",
    eventStartsAt: eventStartsAt.toISOString(),
    refundDeadline: refundDeadline.toISOString(),
    feeBreakdown: {
      amountPaidCents: refundableAmountPaidCents,
      ticketPriceCents: refundableGrossCents,
      platformFeeCents: refundablePlatformFeeCents,
      taxCents: refundableTaxCents,
      stripeFeeCents: refundableStripeFeeCents,
      refundableCents,
      currency: order.currency,
    },
    isResale,
    hasTransferredItems,
    refundableItemCount: refundableItems.length,
    totalItemCount: ticketItems.length,
  };
}
