import { solveTaxLinesAndProcessorFee } from "./solve-tax-and-processor-fee";
import type { TaxImposition } from "./tax-impositions";

/**
 * One cart line for the order-level buyer total estimate.
 *
 * `faceCents` / `platformFeePerTicketCents` map 1:1 onto a
 * `getCheckoutFeeRates` per-ticket estimate row (`unitPriceCents` /
 * `platformFeeCents`) — clients feed those rows straight in.
 */
export type EstimateOrderTotalItem = {
  /** Ticket face value in cents (the order line basis, `unitPriceCents`). */
  faceCents: number;
  /**
   * Per-ticket platform fee in cents. 0 for ABSORB / no-policy estimates
   * (mirrors `estimateBuyerTicketPricingForEvent`, which only reports a
   * buyer-funded platform fee in PASS_THROUGH).
   */
  platformFeePerTicketCents: number;
  qty: number;
};

export type EstimateOrderTotalInput = {
  items: EstimateOrderTotalItem[];
  /**
   * EVERY tax the admission owes, from `resolveTaxImpositions({ situs,
   * salesTaxRateBps })` (`lib/pricing/tax-impositions.ts`) — surfaced to clients
   * as `events.getCheckoutFeeRates.taxImpositions`. Each line carries its own
   * rate, base (`TICKET_FACE` | `BUYER_TOTAL`) and collector; only PLATFORM
   * lines are charged. `[]` = no tax.
   *
   * REQUIRED, never defaulted: an optional `taxableBase` defaulting to the face
   * is how five surfaces silently kept the pre-Tennessee base, and a defaulted
   * list would silently drop a local imposition the charge includes. Under a
   * `BUYER_TOTAL` line the tax and the grossed-up processor fee are solved
   * JOINTLY — the difference between the quote and the charge.
   */
  taxImpositions: ReadonlyArray<TaxImposition>;
  /**
   * Effective fee mode. PASS_THROUGH: the buyer funds the platform fee and
   * the grossed-up processor fee. ABSORB / null: the buyer pays face + tax
   * only (the seller absorbs platform + processor).
   */
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  /** Processor percentage rate as a decimal (e.g. 0.029). Ignored unless PASS_THROUGH. */
  processorPct: number;
  /** Processor per-order fixed fee in cents (e.g. 30). Ignored unless PASS_THROUGH. */
  processorFixedCents: number;
  /**
   * Order-level platform-fee cap (`FeePolicy.maxPlatformFeeCents`).
   * Mirrors the cap applied across all tickets in `computeOrderAmounts`.
   */
  maxPlatformFeeCents?: number | null;
  /**
   * Promo discount on the order, in cents (`previewPromos.totalDiscountCents`).
   * Applied the way `createCheckout` charges it: the platform fee stays on the
   * PRE-discount lines (less `platformFeeReductionCents`, below), while tax
   * and the processor gross-up are solved on `gross − discount` and the
   * discount comes off the total. Omitted / 0 ⇒
   * no discount (every existing caller).
   */
  discountCents?: number;
  /**
   * How much of the platform fee the discount takes with it
   * (`previewPromos.platformFeeReductionCents`): a ticket a promo code or a
   * membership benefit brings down to $0 pays no platform fee (owner ruling
   * 2026-10-10). Subtracted AFTER the order-level cap, because the figure is
   * already net of it. Omitted / 0 ⇒ no ticket reaches $0, and the fee is the
   * fee on the pre-discount lines, as for every partially discounted ticket.
   */
  platformFeeReductionCents?: number;
};

export type EstimateOrderTotalResult = {
  /** Σ face × qty — matches `Order.amountGrossCents` (pre-discount). */
  grossCents: number;
  /** Buyer-funded platform fee (0 in ABSORB), after the order-level cap. */
  platformFeeCents: number;
  /**
   * Σ PLATFORM imposition lines, each rounded ONCE on its aggregate base —
   * matches the server stamp (`Order.taxAmountCents`). A line's base is the
   * aggregate gross under `TICKET_FACE`, and gross + platform fee + processor
   * fee under `BUYER_TOTAL`.
   */
  taxCents: number;
  /** Processor fee grossed up ONCE per order (0 in ABSORB). */
  processorFeeCents: number;
  /** What the buyer will be charged (before promo discounts / credits). */
  totalCents: number;
};

const ZERO_RESULT: EstimateOrderTotalResult = {
  grossCents: 0,
  platformFeeCents: 0,
  taxCents: 0,
  processorFeeCents: 0,
  totalCents: 0,
};

/**
 * Order-level buyer total estimate — the pre-hold twin of the server's
 * checkout math. Computes the total the way the server actually charges,
 * NOT by multiplying a fee-inclusive per-ticket price by quantity:
 *
 *   gross     = Σ face × qty                    (computeOrderAmounts)
 *   platform  = min(Σ perTicketFee × qty, cap)  (computeOrderAmounts, order-level cap)
 *               − platformFeeReductionCents     (tickets a discount made $0)
 *   tax       = round(taxBasis × taxRateBps / 10⁴) ONCE on the aggregate,
 *   processor = the gross-up over gross + platform + tax, ONCE per order
 *               (the fixed 30¢ is charged per ORDER, not per ticket)
 *               — both from solveTaxLinesAndProcessorFee, the SAME function
 *               create-checkout charges with. `taxBasis` is the aggregate gross
 *               under TICKET_FACE and gross + platform + processor under
 *               BUYER_TOTAL, where the pair is circular and solved jointly.
 *   total     = gross + platform + tax + processor          (PASS_THROUGH)
 *             = gross + tax                                 (ABSORB / null)
 *
 * Multiplying `buyerUnitTotalCents` (which bakes the whole fixed fee and a
 * per-ticket-rounded tax into every unit) by quantity double-counts the fixed
 * processor fee and drifts on tax rounding — e.g. 2 × $45.00 @ 8.88% tax,
 * 2.9% + 30¢ shows $102.18 while the server charges $101.85.
 *
 * Known divergences from the final charge (all reduce or refine the total
 * AFTER the buyer holds tickets, when server-authoritative amounts take over):
 *  - Platform credits are not known pre-hold. (Promo discounts are, when the
 *    caller passes the previewed `discountCents` — see the input.)
 *  - Fee waivers (reserved at checkout) are not known pre-hold.
 *
 * NOT a divergence any more: a $0 ticket in a paid cart. The charge gives it
 * no platform fee (owner ruling 2026-10-10, "If $0 is the cost of the tickets
 * there shouldn't be any fee", enforced in `computePlatformFeePerTicketCents`),
 * which is what the per-ticket estimate rows always reported ("Free"). The
 * charge used to add the policy's fixed part / floor for each free ticket, so
 * this estimate sat below it. The loop below holds the same rule for whatever
 * a caller passes in: a line with a $0 face contributes no platform fee.
 */
export function estimateOrderTotal(
  input: EstimateOrderTotalInput,
): EstimateOrderTotalResult {
  let grossCents = 0;
  let platformFeeCents = 0;

  for (const item of input.items) {
    const qty = Math.max(0, item.qty);
    if (qty === 0) continue;
    grossCents += item.faceCents * qty;
    // A $0 ticket carries no fee (owner ruling 2026-10-10). Callers already
    // pass 0 for one; holding the rule here too means the estimate does not
    // depend on every caller's per-ticket fee input being right.
    if (item.faceCents > 0) {
      platformFeeCents += item.platformFeePerTicketCents * qty;
    }
  }

  // Free order: the server zeroes every buyer-visible fee when the whole
  // order's gross is 0 (computeOrderAmounts `isFreeOrder`), and free orders
  // never reach the paid-charge path at all.
  if (grossCents === 0) {
    return ZERO_RESULT;
  }

  // The charge's taxable/gross-up base is the POST-discount subtotal
  // (create-checkout `amountGrossAfterDiscount`). A discount that clears the
  // whole subtotal makes it a free order, which never reaches the charge.
  const discountCents = Math.min(
    grossCents,
    Math.max(0, input.discountCents ?? 0),
  );
  const netGrossCents = grossCents - discountCents;
  if (netGrossCents === 0) {
    return { ...ZERO_RESULT, grossCents };
  }

  const taxLines = input.taxImpositions;
  const passThrough = input.feeMode === "PASS_THROUGH";

  if (!passThrough) {
    // ABSORB / unknown: the buyer is charged face + tax only. Platform and
    // processor fees are absorbed by the seller (display-only elsewhere) — so
    // there is nothing passed through for a BUYER_TOTAL base to reach, and the
    // base is the face in every jurisdiction.
    const { taxCents } = solveTaxLinesAndProcessorFee({
      taxableGrossCents: netGrossCents,
      buyerPlatformFeeCents: 0,
      taxLines,
      passThrough: false,
      processorPct: 0,
      processorFixedCents: 0,
    });
    return {
      grossCents,
      platformFeeCents: 0,
      taxCents,
      processorFeeCents: 0,
      totalCents: netGrossCents + taxCents,
    };
  }

  // Order-level platform-fee cap — mirrors computeOrderAmounts, which caps
  // the TOTAL platform fee across all tickets (per-ticket caps are already
  // baked into the per-ticket fee inputs).
  const maxPlatformFeeCents = input.maxPlatformFeeCents ?? null;
  if (maxPlatformFeeCents != null && platformFeeCents > maxPlatformFeeCents) {
    platformFeeCents = maxPlatformFeeCents;
  }
  // Tickets a discount brought down to $0 pay no platform fee. The reduction
  // is net of the cap already, so it comes off the capped figure.
  platformFeeCents = Math.max(
    0,
    platformFeeCents - Math.max(0, input.platformFeeReductionCents ?? 0),
  );

  // THE shared solve — the same function create-checkout charges with, so the
  // quote and the charge cannot drift apart on either the tax base or the
  // gross-up.
  const { taxCents, processorFeeCents } = solveTaxLinesAndProcessorFee({
    taxableGrossCents: netGrossCents,
    buyerPlatformFeeCents: platformFeeCents,
    taxLines,
    passThrough: true,
    processorPct: input.processorPct,
    processorFixedCents: input.processorFixedCents,
  });

  return {
    grossCents,
    platformFeeCents,
    taxCents,
    processorFeeCents,
    totalCents:
      netGrossCents + platformFeeCents + taxCents + processorFeeCents,
  };
}
