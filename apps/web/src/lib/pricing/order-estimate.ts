import { computePlatformFeePerTicketCents } from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import { solveTaxLinesAndProcessorFee } from "@th/core/lib/pricing/solve-tax-and-processor-fee";
import {
  estimateOrderTotal,
  type EstimateOrderTotalResult,
} from "@th/core/lib/pricing/estimate-order-total";

/**
 * The slice of `events.getCheckoutFeeRates` the order-level estimator needs.
 * Optional fields tolerate older cached payloads that predate the numeric
 * rate exposure — the estimate degrades to "unknown" instead of guessing.
 */
export type FeeRatesForOrderEstimate = {
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  admissionTaxRateBps: number | null;
  /**
   * Every tax the admission owes (`getCheckoutFeeRates.taxImpositions`) — the
   * ONLY tax input to the cart total. Optional so a cached payload from before
   * the field existed still type-checks: when it is missing and the event DOES
   * carry a rate, the total is "unknown" (null) until the rates refetch, rather
   * than guessed from `admissionTaxRateBps` alone, which would silently drop
   * any local imposition the charge includes.
   */
  taxImpositions?: ReadonlyArray<{
    code: string;
    label: string;
    jurisdiction: string;
    rateBps: number;
    base: "TICKET_FACE" | "BUYER_TOTAL";
    collector: "PLATFORM" | "ORGANISER";
  }> | null;
  processorPct?: number | null;
  processorFixedCents?: number | null;
  maxPlatformFeeCents?: number | null;
  /**
   * Per-ticket platform-fee rates (`getCheckoutFeeRates.platformFeeRates`),
   * null unless PASS_THROUGH. The only way to price the fee on a
   * pay-what-you-want amount: no per-ticket row can, because the row is
   * computed on the tier's floor, not on the amount the buyer typed. Optional so an older cached payload
   * type-checks; missing under PASS_THROUGH ⇒ a PWYW cart is "unknown".
   */
  platformFeeRates?: {
    buyerFeePct: number;
    maxFeeCents: number | null;
    minFeeCents: number;
    platformFixedCents: number;
  } | null;
  perTicketEstimates: Array<{
    ticketTypeId: string;
    /** Ticket face value in cents. */
    unitPriceCents: number;
    /** Per-ticket platform fee in cents (0 in ABSORB / no policy). */
    platformFeeCents: number;
  }>;
};

export type OrderEstimateCartItem = {
  ticketTypeId: string;
  qty: number;
  /**
   * Ticket face value from the ticket-type record. Used to distinguish a
   * free ticket (known: contributes 0) from a priced ticket whose estimate
   * row hasn't loaded (unknown: the whole total is unknown) — mirrors
   * `isBuyerAllInPriceKnown`.
   */
  priceCents: number;
  /**
   * The buyer-chosen amount on a pay-what-you-want (ADJUSTABLE) tier. When
   * set it IS the line's face: the platform fee is the policy's fee on it,
   * and processing and tax go on top exactly as for a fixed price of that
   * amount — the way `computeOrderAmounts` charges it. Leave unset for FIXED
   * tiers.
   */
  chosenAmountCents?: number | null;
};

/**
 * Pre-hold cart total estimate for the checkout surfaces.
 *
 * Wraps the server-parity `estimateOrderTotal` (packages/core) with the
 * "is the estimate known yet?" bookkeeping the UI needs:
 *
 *  - Empty cart → a zero estimate (always known).
 *  - Fee-rates query not loaded → null ("Calculating total…").
 *  - A PRICED item without a per-ticket estimate row → null.
 *  - A cached estimate row whose face price disagrees with the fresh
 *    ticket record (mid-session reprice) → null.
 *  - PASS_THROUGH without numeric processor rates → null (never silently
 *    undercount the processor fee).
 *
 * NEVER compute a cart total as `buyerUnitTotalCents × qty` — that
 * double-counts the per-ORDER fixed processor fee and drifts on tax rounding
 * (2 × $45.00 showed $102.18 vs the $101.85 actually charged).
 */
export function estimateCartTotal(
  feeRates: FeeRatesForOrderEstimate | null | undefined,
  cartItems: OrderEstimateCartItem[],
  options: {
    /**
     * The live promo preview's `totalDiscountCents`. Priced the way the charge
     * prices it (see `estimateOrderTotal`'s `discountCents`): tax and the
     * processor gross-up on the discounted subtotal, the platform fee not.
     * Subtracting it from the finished total instead left the tax — and the
     * gross-up — on the full price (8.88% of a $5.50 discount = 48¢ high).
     */
    discountCents?: number;
    /**
     * The live promo preview's `platformFeeReductionCents`: the platform fee
     * of every ticket the discount brings down to $0, which the charge does
     * not take (owner ruling 2026-10-10). 0 for any discount that leaves
     * every ticket above $0. Pass it with `discountCents`, from the same
     * preview. Before the hold only: it is measured against these fee rates.
     * A held order takes the server's `heldCartFees` instead
     * (./held-order-fees.ts).
     */
    platformFeeReductionCents?: number;
  } = {},
): EstimateOrderTotalResult | null {
  const selected = cartItems.filter((item) => item.qty > 0);
  const faceOf = (item: OrderEstimateCartItem) =>
    item.chosenAmountCents ?? item.priceCents;
  if (selected.length === 0) {
    return estimateOrderTotal({
      items: [],
      taxImpositions: [],
      feeMode: null,
      processorPct: 0,
      processorFixedCents: 0,
    });
  }

  // A cart of only free tickets is always known — free orders never reach
  // the paid-charge path, so no fee rates are needed. Checking BEFORE the
  // !feeRates guard keeps "Free" from flashing "Calculating total…" while
  // the rates query loads (the pre-estimator behavior).
  if (selected.every((item) => faceOf(item) <= 0)) {
    // ...unless a loaded row says one of those "free" tickets now costs
    // something (a scheduled flip the cached ticket list predates): that is
    // the stale-price case below, and "Free" would be the wrong total.
    if (
      feeRates &&
      selected.some((item) => {
        if (item.chosenAmountCents != null) return false;
        const row = feeRates.perTicketEstimates.find(
          (estimate) => estimate.ticketTypeId === item.ticketTypeId,
        );
        return row !== undefined && row.unitPriceCents !== item.priceCents;
      })
    ) {
      return null;
    }
    return estimateOrderTotal({
      items: [],
      taxImpositions: [],
      feeMode: null,
      processorPct: 0,
      processorFixedCents: 0,
    });
  }

  if (!feeRates) {
    return null;
  }

  const estimateByTicketType = new Map(
    feeRates.perTicketEstimates.map((estimate) => [
      estimate.ticketTypeId,
      estimate,
    ]),
  );

  const items: Array<{
    faceCents: number;
    platformFeePerTicketCents: number;
    qty: number;
  }> = [];
  for (const item of selected) {
    if (item.chosenAmountCents != null) {
      // Buyer-priced line. Its estimate row (if any) was computed on the
      // tier's floor, not this amount, so it is never read here.
      let platformFeePerTicketCents = 0;
      if (feeRates.feeMode === "PASS_THROUGH") {
        if (!feeRates.platformFeeRates) {
          // The buyer funds a fee we cannot price — unknown, never guessed.
          return null;
        }
        platformFeePerTicketCents = computePlatformFeePerTicketCents(
          item.chosenAmountCents,
          feeRates.platformFeeRates,
        );
      }
      items.push({
        faceCents: item.chosenAmountCents,
        platformFeePerTicketCents,
        qty: item.qty,
      });
      continue;
    }
    const estimate = estimateByTicketType.get(item.ticketTypeId);
    if (estimate) {
      // Stale-price guard: the fee-rates row is cached (staleTime 60s); if
      // the organiser reprices mid-session the fresh ticket record and the
      // cached row disagree. A wrong number is the one unacceptable failure
      // mode for money — degrade to "unknown" until the rates refetch.
      if (estimate.unitPriceCents !== item.priceCents) {
        return null;
      }
      items.push({
        faceCents: estimate.unitPriceCents,
        platformFeePerTicketCents: estimate.platformFeeCents,
        qty: item.qty,
      });
      continue;
    }
    if (item.priceCents <= 0) {
      // Free ticket without a row — contributes nothing, stays "known".
      items.push({ faceCents: 0, platformFeePerTicketCents: 0, qty: item.qty });
      continue;
    }
    // Priced ticket with no estimate row: the total is unknown.
    return null;
  }

  const processorPct = feeRates.processorPct ?? null;
  const processorFixedCents = feeRates.processorFixedCents ?? null;
  if (
    feeRates.feeMode === "PASS_THROUGH" &&
    (processorPct == null || processorFixedCents == null)
  ) {
    // The buyer funds the processor fee but we don't have the rate — treat
    // the total as unknown rather than silently undercounting it.
    return null;
  }

  const taxImpositions = feeRates.taxImpositions ?? null;
  if (taxImpositions == null) {
    // A pre-`taxImpositions` payload: even at a zero sales rate a local
    // imposition could apply, so the total is unknown, not guessed.
    return null;
  }

  return estimateOrderTotal({
    items,
    taxImpositions,
    feeMode: feeRates.feeMode,
    processorPct: processorPct ?? 0,
    processorFixedCents: processorFixedCents ?? 0,
    maxPlatformFeeCents: feeRates.maxPlatformFeeCents ?? null,
    discountCents: options.discountCents ?? 0,
    platformFeeReductionCents: options.platformFeeReductionCents ?? 0,
  });
}

/** What the HELD step shows before `createCheckout` stamps the real charge. */
export type HeldChargeEstimate = {
  taxCents: number;
  /** The buyer-funded (PASS_THROUGH) processor fee; null in ABSORB. */
  processorFeeCents: number | null;
  totalCents: number;
};

/**
 * The held step's tax, processing and total — the charge `createCheckout`
 * will make (pre-credit), from the held order plus the live promo discount.
 *
 * The same solve the charge runs: tax on `gross − discount` under every
 * imposition (BUYER_TOTAL included), and — in PASS_THROUGH — the processor fee
 * grossed up over that discounted base. The held order's own processor fee
 * was solved WITHOUT the discount (the hold never sees promos), and the old
 * held tax was a flat `round(taxable × rate)`; together they put step 2 a few
 * cents above the charge whenever a promo applied.
 *
 * Null when the fee rates cannot price it (not loaded, a pre-impositions
 * payload, PASS_THROUGH without processor rates) — callers keep their
 * previous display.
 */
export function estimateHeldOrderCharge(
  feeRates: FeeRatesForOrderEstimate | null | undefined,
  order: {
    amountGrossCents: number;
    buyerFeesCents: number;
    /**
     * The mode the HOLD was priced under. Wins over `feeRates.feeMode` (the
     * event's current setting) so the solve and the rows the page renders
     * read one source.
     */
    feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  },
  discountCents: number,
): HeldChargeEstimate | null {
  if (!feeRates) return null;
  const taxLines = feeRates.taxImpositions ?? null;
  if (taxLines == null) return null;
  const passThrough =
    (order.feeMode ?? feeRates.feeMode) === "PASS_THROUGH";
  const processorPct = feeRates.processorPct ?? null;
  const processorFixedCents = feeRates.processorFixedCents ?? null;
  if (passThrough && (processorPct == null || processorFixedCents == null)) {
    return null;
  }
  const netGrossCents = Math.max(
    0,
    order.amountGrossCents - Math.max(0, discountCents),
  );
  if (netGrossCents === 0) {
    return { taxCents: 0, processorFeeCents: passThrough ? 0 : null, totalCents: 0 };
  }
  // Exactly create-checkout's call: `buyerPlatformFeeCents` is the order's
  // buyer fees (0 in ABSORB, where nothing is passed through).
  //
  // A promo that brings a ticket down to $0 also takes that ticket's
  // platform fee off the charge (owner ruling 2026-10-10). That is NOT
  // worked out here, and must never be done by subtracting from
  // `order.buyerFeesCents`: hand this function the order with the fee the
  // server states for it (`withStatedHeldFees`, ./held-order-fees.ts).
  const { taxCents, processorFeeCents } = solveTaxLinesAndProcessorFee({
    taxableGrossCents: netGrossCents,
    buyerPlatformFeeCents: order.buyerFeesCents,
    taxLines,
    passThrough,
    processorPct: processorPct ?? 0,
    processorFixedCents: processorFixedCents ?? 0,
  });
  return {
    taxCents,
    processorFeeCents: passThrough ? processorFeeCents : null,
    totalCents:
      netGrossCents +
      order.buyerFeesCents +
      taxCents +
      (passThrough ? processorFeeCents : 0),
  };
}

/**
 * The held step's tax when `estimateHeldOrderCharge` cannot price it (the fee
 * rates have not loaded, or PASS_THROUGH lacks processor rates) — the only
 * time the page derives a tax itself.
 *
 * No discount: the hold's own server-stamped tax (every imposition, already
 * summed), else the estimate's amount. With a discount the tax has to move to
 * the discounted subtotal, and it goes through the shared `estimateOrderTotal`
 * with the quote's impositions — each line at its own rate ON ITS OWN BASE.
 * A flat `round(taxable × summedRate)` taxed a BUYER_TOTAL line on the face
 * alone and, at Minneapolis, summed two rates over two different bases.
 * The held processor fee stands in for the gross-up a BUYER_TOTAL base
 * includes (`processorPct: 0` makes the solve take it as-is); `createCheckout`
 * replaces the figure a moment later either way.
 *
 * Impositions unknown (an older cached quote): the undiscounted figure, never
 * a guess at the rate.
 */
export function estimateHeldTaxFallback(
  order: {
    amountGrossCents: number;
    buyerFeesCents: number;
    taxAmountCents?: number | null;
    processorFeeCents?: number | null;
  },
  options: {
    discountCents: number;
    feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined;
    taxImpositions?: FeeRatesForOrderEstimate["taxImpositions"];
    /** `estimateCheckoutTax.taxAmountCents`, when the hold has no tax yet. */
    estimateTaxCents?: number | null;
  },
): number {
  const undiscounted = order.taxAmountCents ?? options.estimateTaxCents ?? 0;
  const discountCents = Math.max(0, options.discountCents);
  const taxImpositions = options.taxImpositions ?? null;
  if (discountCents === 0 || taxImpositions == null) return undiscounted;
  const passThrough = options.feeMode === "PASS_THROUGH";
  return estimateOrderTotal({
    items: [
      {
        faceCents: order.amountGrossCents,
        platformFeePerTicketCents: passThrough ? order.buyerFeesCents : 0,
        qty: 1,
      },
    ],
    taxImpositions,
    feeMode: passThrough ? "PASS_THROUGH" : "ABSORB",
    processorPct: 0,
    processorFixedCents: passThrough ? (order.processorFeeCents ?? 0) : 0,
    discountCents,
  }).taxCents;
}

/**
 * Merge per-ticket buyer-total estimates onto ticket-type records for the
 * per-UNIT price displays (ticket cards, seat labels). Shared by the main
 * checkout and the embed surfaces — the per-unit inclusive price is exact at
 * qty=1 and stays; only cart TOTALS go through `estimateCartTotal`.
 *
 * `buyerUnitPriceCents` is the face the row was priced at (a PWYW tier's row:
 * its floor). It travels with the total so a display can refuse a row that no
 * longer matches the ticket — the fee-rates query is cached for 60s, and an
 * organiser who moves a price or a minimum inside that window would otherwise
 * get the new face quoted with the old fees and tax.
 */
export function withBuyerUnitTotals<T extends { id: string }>(
  ticketTypes: T[],
  perTicketEstimates:
    | Array<{
        ticketTypeId: string;
        buyerUnitTotalCents: number;
        unitPriceCents?: number;
      }>
    | undefined,
): Array<
  T & { buyerUnitTotalCents: number | null; buyerUnitPriceCents: number | null }
> {
  const estimateByTicketType = new Map(
    (perTicketEstimates ?? []).map((estimate) => [
      estimate.ticketTypeId,
      estimate,
    ]),
  );
  return ticketTypes.map((ticketType) => {
    const estimate = estimateByTicketType.get(ticketType.id);
    return {
      ...ticketType,
      buyerUnitTotalCents: estimate?.buyerUnitTotalCents ?? null,
      buyerUnitPriceCents: estimate?.unitPriceCents ?? null,
    };
  });
}
