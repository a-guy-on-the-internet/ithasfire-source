import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { allocateRefundItemBases } from "../../lib/orders/refund-item-base";
import { allocateRefundFeeShares } from "../../lib/orders/refund-tax-share";
import { checkRefundEligibility } from "../../lib/payout-scheduling/refund-eligibility";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { refundOrderItemIdsSchema } from "./_shared/refund-item-ids";
import { allocateRefundTaxSharesForOrder } from "./_shared/refund-tax-shares-for-order";

// ── Shared eligibility rules (item path + full-order path) ──────────────────

/**
 * Why an individual ticket item cannot be refunded right now.
 *
 * - `already_refunded` / `already_transferred`: terminal item states.
 * - `listing_active`: the ticket is up for resale (item still linked to a
 *   listing, or the ticket row reads LISTED). Refunding it would leave the
 *   listing live; when it then sold, `finalizeResalePurchase` would flip the
 *   refunded item to `transferred` and the seller would pocket refund AND
 *   proceeds. Applies to EVERY caller — the double-dip does not care who
 *   pressed the button.
 * - `already_scanned`: the ticket was used at the door. Buyer paths only;
 *   org/staff may still refund a scanned ticket (goodwill, cancelled set).
 * - `already_paid_out`: the item's revenue has been paid out to the payee.
 *   Buyer paths only — once paid out, the money is the payee's and a buyer's
 *   unilateral action must not claw it back. Org/staff may still refund the
 *   item via a transfer reversal (`requiresTransferReversal`). This is the
 *   rule the eligibility screen has always shown (`order_already_paid_out`);
 *   see docs/decisions/buyer-refunds-stop-at-payout.md.
 */
export const refundItemIneligibleReasonSchema = z.enum([
  "already_refunded",
  "already_transferred",
  "already_scanned",
  "already_paid_out",
  "listing_active",
]);
export type RefundItemIneligibleReason = z.infer<
  typeof refundItemIneligibleReasonSchema
>;

/**
 * Classifies one ticket item for refund. Pure: the caller supplies the item's
 * ticket row (or null when there is none — legacy items without a ticket fall
 * back to item-only rules).
 *
 * `orderSource` matters for the listing rule: on a RESALE order the item's
 * `resaleListingId` is the listing the buyer PURCHASED, not one they opened,
 * so only the ticket's own LISTED status counts there. On every other source
 * `create-resale-listing` stamps the link onto the item and clears it on
 * cancel/sale, so a set link means a listing that is ACTIVE or HELD.
 */
export function classifyRefundItem(params: {
  item: Pick<
    OrderItemRecord,
    "status" | "refundedAt" | "transferredAt" | "paidOutAt" | "resaleListingId"
  >;
  ticket: Pick<TicketRecord, "status"> | null;
  orderSource: string;
  buyerInitiated: boolean;
}): {
  ineligibleReason: RefundItemIneligibleReason | null;
  /** Eligible, but its payout transfer must be reversed before refunding. */
  requiresTransferReversal: boolean;
} {
  const { item, ticket, orderSource, buyerInitiated } = params;

  if (item.status === "refunded" || item.refundedAt) {
    return {
      ineligibleReason: "already_refunded",
      requiresTransferReversal: false,
    };
  }
  if (item.status === "transferred" || item.transferredAt) {
    return {
      ineligibleReason: "already_transferred",
      requiresTransferReversal: false,
    };
  }

  const linkedToOwnListing =
    orderSource !== "RESALE" && Boolean(item.resaleListingId);
  if (linkedToOwnListing || ticket?.status === "LISTED") {
    return {
      ineligibleReason: "listing_active",
      requiresTransferReversal: false,
    };
  }

  if (buyerInitiated && ticket?.status === "SCANNED") {
    return {
      ineligibleReason: "already_scanned",
      requiresTransferReversal: false,
    };
  }

  // Buyer refunds stop at payout (docs/decisions/buyer-refunds-stop-at-
  // payout.md). Org/staff fall through: for them a paid-out item is eligible
  // and its transfer is reversed first.
  if (buyerInitiated && item.paidOutAt) {
    return {
      ineligibleReason: "already_paid_out",
      requiresTransferReversal: false,
    };
  }

  return {
    ineligibleReason: null,
    requiresTransferReversal: Boolean(item.paidOutAt),
  };
}

/**
 * The buyer refund window. Closed once the event has started, or — when the
 * organizer set an explicit cutoff — once that cutoff has passed. This is
 * EXACTLY what `get-refund-eligibility.ts` shows the buyer (`event_started` /
 * `past_refund_deadline`), so the deadline on screen is the deadline the
 * mutation enforces.
 *
 * Reuses `checkRefundEligibility` for the comparison rather than re-deriving
 * it. `paidOutAt` is passed as null on purpose: this is the ORDER-level window
 * check only. Paid-out items are blocked for buyers per item by
 * `classifyRefundItem` (`already_paid_out`), so a buyer's full-order refund
 * still goes through for the items that were not paid out.
 *
 * Only for buyer-initiated calls. Org/staff paths bypass it by design
 * (`_skipBuyerCheck`); cancel-event never calls this at all.
 */
export function assertBuyerRefundWindowOpen(
  event: { startsAt: Date; refundCutoffAt?: Date | null },
  now: Date,
): void {
  const started = !checkRefundEligibility(event.startsAt, null, now).eligible;
  const pastCutoff =
    event.refundCutoffAt != null &&
    !checkRefundEligibility(event.refundCutoffAt, null, now).eligible;

  if (started || pastCutoff) {
    throw fail("REFUND_WINDOW_CLOSED", {
      meta: {
        eventStartsAt: event.startsAt.toISOString(),
        refundCutoffAt: event.refundCutoffAt?.toISOString() ?? null,
        now: now.toISOString(),
      },
    });
  }
}

export const quoteItemRefundInputSchema = z.object({
  actorHumanId: z.uuid(),
  orderId: z.uuid(),
  /** The specific order item IDs to refund. Each must belong to the order; no repeats. */
  orderItemIds: refundOrderItemIdsSchema,
});

const itemQuoteSchema = z.object({
  orderItemId: z.uuid(),
  ticketTypeId: z.string().nullable(),
  unitPriceCents: z.number().int().nonnegative(),
  buyerPaidCents: z.number().int().nonnegative(),
  /** This item's proportional share of the Stripe processing fee. */
  stripeFeeShareCents: z.number().int().nonnegative(),
  /** This item's proportional share of order-level tax. */
  taxShareCents: z.number().int().nonnegative(),
  refundableCents: z.number().int().nonnegative(),
  /** Whether this specific item can be refunded. */
  isEligible: z.boolean(),
  /** Reason if not eligible (null when eligible). */
  ineligibleReason: refundItemIneligibleReasonSchema.nullable(),
  /** True when this item was already paid out and its transfer must be reversed before refunding. */
  requiresTransferReversal: z.boolean(),
});

export const quoteItemRefundOutputSchema = z.object({
  orderId: z.uuid(),
  currency: z.string().min(3).max(3),
  /** Total the buyer originally paid for the whole order. */
  orderTotalPaidCents: z.number().int().nonnegative(),
  /** Total Stripe fee for the whole order (from balance transaction). */
  orderStripeFeeCents: z.number().int().nonnegative(),
  /** Sum of refundable cents across the requested items. */
  totalRefundableCents: z.number().int().nonnegative(),
  /** True when any eligible item requires a transfer reversal before refunding. */
  hasTransferReversals: z.boolean(),
  /** Per-item breakdown. */
  items: z.array(itemQuoteSchema),
});

export type QuoteItemRefundInput = z.infer<typeof quoteItemRefundInputSchema>;
export type QuoteItemRefundOutput = z.infer<typeof quoteItemRefundOutputSchema>;

export type QuoteItemRefundDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for the tax-line mismatch fallback (the order's
   * PLATFORM tax lines do not sum to its tax; the quote falls back to the
   * single buyer-paid weight). CLAUDE.md error-reporting convention; a
   * throwing reporter never changes the quote.
   */
  reportError?: ReporterPort | null;
  /**
   * Clock for the buyer refund-window check. Optional because this quote has
   * historically been constructed without one (the tRPC `quoteItemRefund`
   * procedure passes only repos + payments); when absent it falls back to the
   * wall clock, which is what the injected `ClockPort` resolves to in
   * production anyway. `refundOrderItems` forwards its own clock so quote and
   * execution judge the window at the same instant.
   */
  clock?: ClockPort;
  /**
   * When true, the buyer-ownership guard is skipped — and with it the
   * buyer-only policy gates (refund window, `nonRefundable`, scanned ticket,
   * paid-out item). Only set this from internal callers that perform their
   * own authz (e.g., orgQuoteItemRefund which validates org-finance roles + org
   * ownership before delegating). It is intentionally NOT part of the input
   * schema so buyer-facing tRPC clients can never toggle it.
   */
  _skipBuyerCheck?: boolean;
};

/**
 * Quotes the refund amount for specific order items (tickets).
 *
 * Math:
 * - The ticket-price BASE, tax and the Stripe fee are each allocated across
 *   ALL ticket items of the order (not just the requested ones) with
 *   largest-remainder rounding, weighted by what the buyer paid per item —
 *   see `refund-item-base.ts` and `refund-tax-share.ts`. An item's share is
 *   therefore the same whichever items are in the request, the shares sum to
 *   exactly the order's post-discount charge / tax / fee, and refunding every
 *   item one at a time returns what `refundFullOrder` would.
 * - `buyerPaidCents` is the item's BASE, i.e. its share of
 *   `computeExpectedPaymentAmount(order) − tax`, NOT the raw
 *   `computeItemBuyerPaid(item)`. The two differ only when the order carries a
 *   negative line item (a discount / platform credit), which lives OUTSIDE the
 *   ticket items' `buyerTotalCents`; using the raw figure as an absolute
 *   amount over-refunded the whole discount. See `refund-item-base.ts`.
 * - `refundable = base + taxShare − stripeFeeShare` (clamped at 0).
 * - Only eligible items contribute to `totalRefundableCents`.
 * - Items that are already refunded or transferred, listed for resale, or
 *   (buyer paths) already scanned or already paid out are marked ineligible;
 *   for org/staff, paid-out items stay eligible with
 *   `requiresTransferReversal`.
 *
 * Gates:
 * - RESALE orders are refused outright (`RESALE_ORDER_USE_FULL_REFUND`): they
 *   are single-item and must go through `refundFullOrder`, which unwinds the
 *   resale. The item path has no unwind, so allowing it would pay the resale
 *   buyer while the seller ends with neither ticket nor money.
 * - Buyer-initiated quotes are refused on `nonRefundable` orders and once the
 *   refund window has closed (see `assertBuyerRefundWindowOpen`).
 */
export async function quoteItemRefund(
  deps: QuoteItemRefundDeps,
  rawInput: unknown,
): Promise<QuoteItemRefundOutput> {
  const input = parseInput(quoteItemRefundInputSchema, rawInput);

  const actor = await deps.repos.humans.getById(input.actorHumanId);
  if (!actor) {
    throw fail("ACTOR_NOT_FOUND");
  }

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  // ── Guard: only the buyer who placed the order may quote/request a refund ─
  // Internal callers (org-finance flows) bypass this after their own authz.
  if (!deps._skipBuyerCheck && order.buyerHumanId !== input.actorHumanId) {
    throw fail("ORDER_NOT_FOUND");
  }

  if (!order.stripePaymentIntentId) {
    throw fail("ORDER_NOT_PAID");
  }

  // Allow quoting on SUCCEEDED or PART_REFUNDED orders (some items may still be refundable)
  if (order.status !== "SUCCEEDED" && order.status !== "PART_REFUNDED") {
    throw fail("ORDER_NOT_REFUNDABLE");
  }

  // ── Guard: resale orders have no per-item path ──────────────────────────
  // Every other refund path on a RESALE order runs the resale unwind (ticket
  // back to the seller, listing restored). This one has none, so it is not
  // allowed to start. Applies to org callers too.
  if (order.source === "RESALE") {
    throw fail("RESALE_ORDER_USE_FULL_REFUND", {
      meta: { orderId: order.id },
    });
  }

  const buyerInitiated = !deps._skipBuyerCheck;

  // ── Guard: buyer-only policy — non-refundable orders ────────────────────
  // Same rule as refund-full-order: staff bypass, buyers do not.
  if (buyerInitiated && order.nonRefundable) {
    throw fail("ORDER_NON_REFUNDABLE");
  }

  // ── Guard: event's org must have a valid Stripe connected account ───────
  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // ── Guard: buyer-only policy — refund window ────────────────────────────
  // Before the Stripe fee lookup: a refusal must not reach the processor.
  if (buyerInitiated) {
    assertBuyerRefundWindowOpen(event, deps.clock?.now() ?? new Date());
  }

  const payeeSubjectType = event.orgId ? "ORGANIZATION" : "HUMAN";
  const payeeSubjectId = event.orgId ?? event.humanId;
  if (!payeeSubjectId) {
    throw fail("NO_PAYEE_SUBJECT");
  }

  const payeeRef = await deps.repos.payees.getBySubject({
    type: payeeSubjectType,
    id: payeeSubjectId,
  });
  if (!payeeRef) {
    throw fail("NO_STRIPE_ACCOUNT");
  }

  const payee = await deps.repos.payees.getById(payeeRef.id);
  if (!payee?.stripeAccountId) {
    throw fail("NO_STRIPE_ACCOUNT");
  }

  // Validate all requested items belong to this order
  const allItems = order.items.filter((i) => i.kind === "ticket");
  const itemMap = new Map(allItems.map((i) => [i.id, i]));

  for (const itemId of input.orderItemIds) {
    if (!itemMap.has(itemId)) {
      throw {
        code: "not_found",
        message: "order_item_not_found",
        orderItemId: itemId,
      } as const;
    }
  }

  // The buyer's total charge, tax included and discounts already netted out
  // (`computeExpectedPaymentAmount` folds in every negative line item).
  // Reported for display and used as the "was this paid" gate. It is also the
  // BASIS the per-item ticket-price bases are allocated from, less tax — but
  // never a per-item DENOMINATOR: the old `buyerPaid / orderTotalPaid` ratio
  // had tax in the denominator and under-returned tax on every item refund.
  const orderTotalPaidCents = computeExpectedPaymentAmount(order);
  if (orderTotalPaidCents <= 0) {
    throw fail("ORDER_NOT_PAID");
  }

  // Get the actual Stripe fee for the whole payment.
  const { feeCents: orderStripeFeeCents } =
    await deps.payments.getProcessingFeeForPaymentIntent({
      paymentIntentId: order.stripePaymentIntentId!,
    });

  // ONE allocation over ALL ticket items, shared with `refundFullOrder` and
  // `getRefundEligibility`. Each requested item then reads its own share.
  //
  // `baseByItemId` is the post-discount ticket-price base: the item's share of
  // `orderTotalPaidCents − tax`, so the bases sum to exactly what the buyer
  // was charged ex-tax even when a negative line item (discount / platform
  // credit) reduced that charge. On an order with no negative line it equals
  // `computeItemBuyerPaid(item)` exactly, so undiscounted numbers do not move.
  const baseByItemId = allocateRefundItemBases(allItems, order);
  // Tax is split per PLATFORM tax line, each by its own base (face vs
  // buyer-paid); orders with fewer than two lines get the single buyer-paid
  // weight exactly as before. Lines are immutable after checkout, so a plain
  // read through the same repo the order came from is enough.
  // The item path's money is `base + taxShare − feeShare` on every order, so
  // on the per-line path it already equals what the full-order path pays.
  const { taxByItem: taxShareByItemId } = allocateRefundTaxSharesForOrder({
    useCase: "quoteItemRefund",
    order,
    ticketItems: allItems,
    taxLines: await deps.repos.orders.listTaxLines(order.id),
    logger: deps.logger,
    reportError: deps.reportError,
  });
  const stripeFeeShareByItemId = allocateRefundFeeShares(
    allItems,
    orderStripeFeeCents,
  );

  // The ticket behind each REQUESTED item (one read per requested id, so the
  // read count is bounded by the request, not the order). Eligibility needs
  // the ticket's state — LISTED and SCANNED live on the ticket, not the item.
  const ticketByItemId = new Map<string, TicketRecord | null>();
  for (const itemId of input.orderItemIds) {
    ticketByItemId.set(
      itemId,
      await deps.repos.tickets.getByOrderItemId(itemId),
    );
  }

  // Build per-item quotes
  const itemQuotes = input.orderItemIds.map((itemId) => {
    const item = itemMap.get(itemId)!;

    // This item's share of the order's post-discount, pre-tax charge. NOT
    // `computeItemBuyerPaid(item)` — that is the item's PRE-discount sticker
    // figure and, used as an absolute amount, refunds the discount back to the
    // buyer a second time. See `refund-item-base.ts`.
    const buyerPaidCents = baseByItemId.get(item.id) ?? 0;

    // This item's share of the Stripe fee (largest-remainder, over the whole
    // order).
    const stripeFeeShareCents = stripeFeeShareByItemId.get(item.id) ?? 0;

    // This item's share of order-level tax. Shared with the execution path:
    // `refundOrderItems` stamps this exact number onto the item as
    // `refundedTaxCents`, so the recorded tax can never drift from the tax the
    // buyer actually got back.
    const taxShareCents = taxShareByItemId.get(item.id) ?? 0;

    // Check item-level eligibility (shared rule with refund-full-order)
    const { ineligibleReason, requiresTransferReversal } = classifyRefundItem({
      item,
      ticket: ticketByItemId.get(itemId) ?? null,
      orderSource: order.source,
      buyerInitiated,
    });
    const isEligible = ineligibleReason === null;

    // Refundable = this item's share of the post-discount charge + its tax
    // share, minus only the non-refundable Stripe fee share. Ticket price,
    // tax, and platform fee are all refunded — uniform across ABSORB and
    // PASS_THROUGH. All three terms are exact allocations over the same item
    // set, so Σ over every item is exactly `orderTotalPaid − stripeFee`.
    const refundableCents = isEligible
      ? Math.max(0, buyerPaidCents + taxShareCents - stripeFeeShareCents)
      : 0;

    return {
      orderItemId: item.id,
      ticketTypeId: item.ticketTypeId,
      unitPriceCents: item.unitPriceCents,
      buyerPaidCents,
      stripeFeeShareCents,
      taxShareCents,
      refundableCents,
      isEligible,
      ineligibleReason,
      requiresTransferReversal,
    };
  });

  const totalRefundableCents = itemQuotes.reduce(
    (sum, q) => sum + q.refundableCents,
    0,
  );
  const hasTransferReversals = itemQuotes.some(
    (q) => q.isEligible && q.requiresTransferReversal,
  );

  return quoteItemRefundOutputSchema.parse({
    orderId: order.id,
    currency: order.currency,
    orderTotalPaidCents,
    orderStripeFeeCents,
    totalRefundableCents,
    hasTransferReversals,
    items: itemQuotes,
  });
}
