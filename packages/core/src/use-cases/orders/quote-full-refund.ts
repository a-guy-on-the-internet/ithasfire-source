import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { fail } from "@th/errors";
import { assertOrderNotDisputeBlocked } from "./_shared/dispute-refund-guard";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { allocateRefundTaxSharesForOrder } from "./_shared/refund-tax-shares-for-order";
import { assertBuyerRefundWindowOpen } from "./quote-item-refund";
import {
  allocateFullRefundShares,
  assertNoPendingClaimRefund,
  assertOrderInRefundableState,
  loadAndClassifyTicketItems,
} from "./refund-full-order";

export const quoteFullRefundInputSchema = z.object({
  actorHumanId: z.uuid(),
  orderId: z.uuid(),
});

export const quoteFullRefundOutputSchema = z.object({
  orderId: z.uuid(),
  currency: z.string().min(3).max(3),
  amountPaidCents: z.number().int().nonnegative(),
  stripeFeeCents: z.number().int().nonnegative(),
  /** What `refundFullOrder` would refund this buyer right now. */
  refundableCents: z.number().int().nonnegative(),
  /** Ticket items the refund would include. */
  refundableItemCount: z.number().int().nonnegative(),
  /**
   * Ticket items the refund would skip: scanned, gifted, listed for resale,
   * already refunded, or paid out (buyer refunds stop at payout).
   */
  skippedItemCount: z.number().int().nonnegative(),
});

export type QuoteFullRefundInput = z.infer<typeof quoteFullRefundInputSchema>;
export type QuoteFullRefundOutput = z.infer<typeof quoteFullRefundOutputSchema>;

export type QuoteFullRefundDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  /**
   * Clock for the buyer refund-window check. Optional because this quote has
   * historically been constructed with repos + payments only; when absent it
   * falls back to the wall clock, which is what the injected `ClockPort`
   * resolves to in production anyway (same pattern as `quoteItemRefund`).
   */
  clock?: ClockPort;
  /**
   * Best-effort reporter for the tax-line mismatch fallback (CLAUDE.md
   * error-reporting convention); a throwing reporter never changes the quote.
   */
  reportError?: ReporterPort | null;
};

/**
 * Previews what a BUYER's full-order refund would return — the number
 * `refundFullOrder` would actually pay for the same order, right now — and
 * refuses exactly what it would refuse.
 *
 * - Buyer endpoint: only the order's buyer may quote it. A stranger gets
 *   `ORDER_NOT_FOUND`, the same answer `refundFullOrder` and
 *   `quoteItemRefund` give, so none of the three confirms the order exists.
 *   There is no staff bypass here; staff quote elsewhere.
 * - Gates, in `refundFullOrder`'s buyer order: owner → `nonRefundable` →
 *   dispute → refund window → order state (paid / not already refunded /
 *   SUCCEEDED / no resale-linked transfer) → no pending resale-claim refund
 *   → item classification.
 * - Item rules: the ticket items are classified with the SAME
 *   `classifyRefundItem({ buyerInitiated: true })` rule the refund executes
 *   under (`loadAndClassifyTicketItems`), so a scanned, gifted, listed,
 *   already-refunded or paid-out item is excluded from the quote exactly as
 *   the refund would skip it.
 * - Amount: buyer-paid (ticket price, tax AND platform fee) and the *actual*
 *   Stripe processing fee (read from the balance transaction, never
 *   estimated) are each allocated across ALL ticket items; the quote is Σ
 *   over the refundable items of `max(0, buyerPaid − stripeFee)` — the same
 *   `allocateFullRefundShares` the refund pays from. The processor retains
 *   its fee on refunds, so it is the sole non-refundable component, uniform
 *   across ABSORB and PASS_THROUGH. For a fully refundable order this is
 *   `amountPaidCents − stripeFeeCents` to the cent (the allocation is exact).
 */
export async function quoteFullRefund(
  deps: QuoteFullRefundDeps,
  rawInput: unknown,
): Promise<QuoteFullRefundOutput> {
  const logger = deps.logger?.child({ useCase: "quoteFullRefund" });

  const input = parseInput(quoteFullRefundInputSchema, rawInput);

  // NOTE: Until we wire proper RBAC, we at least ensure the actor exists.
  // This mirrors the minimal "existence check" pattern used in other use-cases.
  const actor = await deps.repos.humans.getById(input.actorHumanId);
  if (!actor) {
    throw fail("ACTOR_NOT_FOUND");
  }

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  // ── Guard: only the buyer who placed the order may quote its refund ─────
  // Before any state or money read. ORDER_NOT_FOUND, not "not owner": the
  // three buyer endpoints on an order answer a stranger identically.
  if (order.buyerHumanId !== input.actorHumanId) {
    throw fail("ORDER_NOT_FOUND");
  }

  // ── Non-refundable guard (adjustable-price orders) ─────────────────────
  if (order.nonRefundable) {
    throw fail("ORDER_NON_REFUNDABLE");
  }

  // ── Dispute guard ────────────────────────────────────────────────────────
  // Before the state gates, as in the refund: a disputed order explains the
  // dispute rather than a less specific refusal.
  assertOrderNotDisputeBlocked(order);

  // ── Buyer refund window ──────────────────────────────────────────────────
  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  assertBuyerRefundWindowOpen(event, deps.clock?.now() ?? new Date());

  // ── Order state ──────────────────────────────────────────────────────────
  assertOrderInRefundableState(order);
  // A resale claim's refund already on its way: the refund refuses with
  // CLAIM_REFUND_PENDING, so the quote does too.
  await assertNoPendingClaimRefund(deps.repos, order);

  // ── Classify: the buyer's view of what the refund would take back ───────
  const { ticketItems, refundable, requiresReversal, skipped } =
    await loadAndClassifyTicketItems(deps, order, { buyerInitiated: true });
  // `requiresReversal` is always empty for a buyer (a paid-out item is
  // `already_paid_out` for them), but summing both mirrors the refund's own
  // `allRefundable` so the two can never be summed differently.
  const allRefundable = [...refundable, ...requiresReversal];

  const amountPaidCents = computeExpectedPaymentAmount(order);

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

  const stripeFeeCents = processingFee.feeCents;

  // Same per-line paid amounts `refundFullOrder` pays from (non-null only on
  // an order whose tax is split per PLATFORM line).
  const { perLinePaidByItem } = allocateRefundTaxSharesForOrder({
    useCase: "quoteFullRefund",
    order,
    ticketItems,
    taxLines: await deps.repos.orders.listTaxLines(order.id),
    logger,
    reportError: deps.reportError,
  });
  const { netRefundCentsForItem } = allocateFullRefundShares(
    ticketItems,
    amountPaidCents,
    stripeFeeCents,
    perLinePaidByItem,
  );
  const refundableCents = allRefundable.reduce(
    (sum, item) => sum + netRefundCentsForItem(item.id),
    0,
  );

  return quoteFullRefundOutputSchema.parse({
    orderId: order.id,
    currency: order.currency,
    amountPaidCents,
    stripeFeeCents,
    refundableCents,
    refundableItemCount: allRefundable.length,
    skippedItemCount: skipped.length,
  });
}
