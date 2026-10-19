import { z } from "zod";

import {
  computeExpectedPaymentAmount,
  extractNumber,
} from "./compute-expected-payment-amount";

/**
 * The fee arrangement the BUYER saw at checkout:
 *
 * - `PASS_THROUGH`: platform and processing fees were itemised on top of the
 *   ticket price and the buyer paid them.
 * - `ABSORB`: the buyer paid face + tax only. The organiser absorbed the
 *   platform fee (out of their settlement basis); Stripe's processing fee
 *   was the PLATFORM's cost, not the organiser's.
 *   `Order.feesPlatformCents` is still recorded on these orders (the
 *   organiser pays it out of their basis), so it must never be shown to the
 *   buyer as a charge.
 */
export type BuyerFeeMode = "ABSORB" | "PASS_THROUGH";

/**
 * What the buyer was charged, split into display lines.
 *
 * Invariant, by construction:
 * `subtotal + platformFee + processingFee + tax + credit === total`.
 * `credit` is ≤ 0 (platform credits reduce the charge).
 */
export type BuyerChargeBreakdown = {
  buyerFeeMode: BuyerFeeMode;
  subtotalCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  taxCents: number;
  creditCents: number;
  totalCents: number;
};

/**
 * Output schema for read models that expose the breakdown (`getMyOrder`,
 * `listPlatformOrders`). Render these lines, not `feesPlatformCents`: under
 * ABSORB that column is the organiser's cost and the buyer paid no platform
 * or processing fee.
 */
export const buyerChargeBreakdownSchema = z.object({
  buyerFeeMode: z.enum(["ABSORB", "PASS_THROUGH"]),
  subtotalCents: z.number().int().nonnegative(),
  platformFeeCents: z.number().int().nonnegative(),
  processingFeeCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  /** Platform credit applied; zero or negative. */
  creditCents: z.number().int().nonpositive(),
  totalCents: z.number().int().nonnegative(),
});

export type BuyerChargeOrderInput = {
  amountGrossCents: number;
  /**
   * Set when the order was charged through Stripe. Decides whether a
   * meta-less ABSORB order's recorded total is what was captured (it is: see
   * `computeBuyerChargeBreakdown`).
   */
  stripePaymentIntentId?: string | null;
  feesPlatformCents: number | null | undefined;
  taxAmountCents?: number | null;
  feePolicySnapshot?: unknown;
  items: Array<{ amountCents: number; meta: unknown; kind?: string }>;
};

function asFeeMode(value: unknown): BuyerFeeMode | null {
  return value === "ABSORB" || value === "PASS_THROUGH" ? value : null;
}

function snapshotFeeMode(snapshot: unknown): BuyerFeeMode | null {
  if (snapshot == null || typeof snapshot !== "object") return null;
  return asFeeMode((snapshot as Record<string, unknown>).feeMode);
}

function metaOf(item: { meta: unknown }): Record<string, unknown> | null {
  return item.meta != null && typeof item.meta === "object"
    ? (item.meta as Record<string, unknown>)
    : null;
}

/**
 * The mode checkout stamped on each ticket item (`meta.effectiveFeeMode`,
 * written by `computeOrderAmounts` and by resale). Null when no ticket item
 * carries one, or when they disagree.
 */
function ticketItemsFeeMode(
  items: BuyerChargeOrderInput["items"],
): BuyerFeeMode | null {
  let mode: BuyerFeeMode | null = null;
  for (const item of items) {
    if (item.kind !== undefined && item.kind !== "ticket") continue;
    const itemMode = asFeeMode(metaOf(item)?.effectiveFeeMode);
    if (!itemMode) continue;
    if (mode && mode !== itemMode) return null;
    mode = itemMode;
  }
  return mode;
}

/**
 * Split an order's buyer charge into Subtotal / Platform fee / Processing fee
 * / Tax / Credit lines that always add up to Total paid.
 *
 * The total is `computeExpectedPaymentAmount(order)` — the figure the order
 * page has always shown as "Total paid" and the finalize guard compares to
 * the PaymentIntent. Every other line is derived from it, never the other way
 * round:
 *
 * 1. `buyerFeesPaid = total − tax − credit − amountGrossCents` is what the
 *    buyer paid in fees.
 * 2. The fee mode comes from the order's `feePolicySnapshot.feeMode`, then
 *    from the ticket items' `meta.effectiveFeeMode`. Orders with neither are
 *    decided by the charge itself: fees paid above zero means they were
 *    passed through, otherwise they were absorbed.
 * 3. ABSORB: no platform or processing line, whatever `feesPlatformCents`
 *    says (that column is the organiser's cost under ABSORB).
 *    PASS_THROUGH: the platform line is `feesPlatformCents`, capped at what
 *    the buyer actually paid in fees; the processing line is the rest.
 * 4. The subtotal is whatever remains, so the lines sum to the total exactly.
 *    On a well-formed order it equals `amountGrossCents`.
 *
 * ONE DEPARTURE from `computeExpectedPaymentAmount`, kept narrow on purpose:
 * an order whose items carry no `meta.buyerTotalCents` makes that function
 * fall back to `gross + feesPlatformCents (+ credit) + tax` whatever the mode.
 *
 * - NOT paid through Stripe (`stripePaymentIntentId` null: cash/POS, comp,
 *   a never-charged legacy row) and recorded ABSORB: nothing checked that
 *   figure against a charge, and the buyer paid no fee, so the breakdown
 *   totals `gross + credit + tax`.
 * - Paid through Stripe: finalize only accepts a PaymentIntent whose amount
 *   EQUALS `computeExpectedPaymentAmount(order)`, so that figure is what the
 *   card was charged. The total stays that, and the fee lines follow the
 *   charge (any amount above face + tax is shown as fees), whatever the
 *   recorded mode says. Showing what was captured beats hiding a fee the
 *   buyer demonstrably paid inside the subtotal.
 *
 * The shared function itself is left alone: finalize's amount check, both
 * refund quotes, refund execution, cancel-event, Stripe refund reconciliation
 * and dispute evidence all read it; moving it would move money.
 *
 * No line is ever negative except `credit`: platform and processing are
 * clamped by construction, and the subtotal works out to
 * `amountGrossCents + min(0, buyerFeesPaid)`, which the order total's own
 * floor at zero keeps at or above zero (pinned by a randomised test).
 */
export function computeBuyerChargeBreakdown(
  order: BuyerChargeOrderInput,
): BuyerChargeBreakdown {
  const taxCents = Math.max(0, Math.trunc(order.taxAmountCents ?? 0));
  const creditCents = order.items.reduce(
    (sum, item) =>
      item.kind === "platform_credit" && item.amountCents < 0
        ? sum + Math.trunc(item.amountCents)
        : sum,
    0,
  );
  const recordedMode =
    snapshotFeeMode(order.feePolicySnapshot) ?? ticketItemsFeeMode(order.items);
  const hasBuyerTotals = order.items.some(
    (item) => extractNumber(metaOf(item)?.buyerTotalCents) !== null,
  );
  const stripePaid = Boolean(order.stripePaymentIntentId);

  const totalCents =
    !hasBuyerTotals && !stripePaid && recordedMode === "ABSORB"
      ? Math.max(0, order.amountGrossCents + creditCents + taxCents)
      : computeExpectedPaymentAmount({
          amountGrossCents: order.amountGrossCents,
          feesPlatformCents: order.feesPlatformCents ?? 0,
          taxAmountCents: taxCents,
          items: order.items,
        });

  const buyerFeesPaid =
    totalCents - taxCents - creditCents - order.amountGrossCents;

  const buyerFeeMode: BuyerFeeMode =
    recordedMode ?? (buyerFeesPaid > 0 ? "PASS_THROUGH" : "ABSORB");

  let platformFeeCents = 0;
  let processingFeeCents = 0;
  // Fee lines follow the mode, except on a Stripe-paid order with no per-item
  // buyer totals, where the captured charge is the only truth (see above).
  const feesFromCharge = !hasBuyerTotals && stripePaid;
  if (
    (buyerFeeMode === "PASS_THROUGH" || feesFromCharge) &&
    buyerFeesPaid > 0
  ) {
    platformFeeCents = Math.min(
      Math.max(0, Math.trunc(order.feesPlatformCents ?? 0)),
      buyerFeesPaid,
    );
    processingFeeCents = buyerFeesPaid - platformFeeCents;
  }

  const subtotalCents =
    totalCents - taxCents - creditCents - platformFeeCents - processingFeeCents;

  return {
    buyerFeeMode,
    subtotalCents,
    platformFeeCents,
    processingFeeCents,
    taxCents,
    creditCents,
    totalCents,
  };
}
