import { fail } from "@th/errors";
import type { ReporterPort } from "@th/ports/reporter";
import type { CreateOrderTaxLineInput } from "@th/ports/repos/orders";

import {
  ticketsDiscountedToZero,
  type TicketDiscount,
} from "../../../lib/orders/discounted-to-zero";
import { feeRemainderItemIndex } from "../../../lib/orders/fee-remainder-item";
import type { FeeMode } from "../../../lib/pricing/compute-ticket-price-for-agreement";
import {
  solveTaxLinesAndProcessorFee,
  type SolvedTaxLine,
  type TaxLinesAndProcessorFeeResult,
} from "../../../lib/pricing/solve-tax-and-processor-fee";
import type { TaxImposition } from "../../../lib/pricing/tax-impositions";
import {
  buildFeePolicySnapshot,
  computeOrderAmounts,
  isTicketDiscountedToZero,
  zeroFeesForFreeOrder,
  type AggregatedItem,
  type OrderComputation,
  type PayoutTermsContext,
  type SeatPrices,
  type TicketLineComputation,
  type TicketTypeSummary,
} from "../checkout-helpers";
import { toOrderTaxLineInputs } from "./order-tax-lines";

/**
 * THE pricing pipeline for a primary-ticket cart: face price, platform fee,
 * tax lines, processor fee, charge total and the per-item `buyerTotalCents`
 * the finalize AMOUNT_MISMATCH guard sums. Online checkout prices through
 * here, and the door (POS card, POS cash, the Sell screen quote) must too, so
 * the door charges exactly what the event page shows
 * (docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml, FR-001).
 *
 * PURE. Everything that needs I/O is resolved by the caller first and passed
 * in: the ticket types, the payout terms + fee policy, the fee-waiver
 * reservation (`waivedTickets`), the promo evaluation, and the tax
 * impositions from `resolveCheckoutTax`. No repo, clock or network call
 * happens in here, so a door path can quote it outside a transaction and
 * charge it inside one with the same answer.
 *
 * Inputs are never mutated: the computation's items are copied before the
 * processor-fee spread writes into their `meta`.
 *
 * CHANNELS.
 *  - `ONLINE` and `DOOR_CARD` are the same computation (owner ruling R2,
 *    2026-10-07: card at the door = online, the buyer pays the platform fee
 *    and the processing fee on top).
 *  - `DOOR_CASH` charges the ticket price (after any promo) plus tax, nothing
 *    else (owner ruling 2026-10-08: cash = no platform fee; it revises R3,
 *    which had cash pay the platform fee). No platform fee in EITHER fee mode
 *    (the buyer pays none, and the organiser owes none: `feesPlatformCents`
 *    and `buyerFeesCents` are 0, and so is every item's fee), and no
 *    processing fee. The tax solve is RE-RUN on that fee-less base with a
 *    zero processor rate, not adjusted afterwards: under a `BUYER_TOTAL`
 *    base (TN, MN) the fees are part of what is taxed, so removing them
 *    changes the tax too, and the base becomes the discounted face. A cash
 *    computation must carry no fee waiver: with no fee there is nothing to
 *    waive, so a waived computation means a caller reserved an allowance the
 *    sale cannot use, and it is refused (INTERNAL).
 *
 * TWO ENTRY POINTS, ONE PIPELINE. `priceCart` runs the whole thing.
 * `priceComputedCart` starts from a face/fee computation the caller already
 * holds: online checkout needs that split because two I/O steps sit between
 * the face computation and the tax solve (promo evaluation reads the priced
 * lines, and the fee-waiver reservation is priced off a waiver-free
 * computation that already knows which tickets the promo made $0). Both end
 * in the same code.
 *
 * A TICKET A DISCOUNT BRINGS DOWN TO $0 PAYS NO PLATFORM FEE (owner ruling
 * 2026-10-10; `lib/orders/discounted-to-zero.ts` defines "brought down to
 * $0"). The fee comes off inside `computeOrderAmounts({ discounts })`, before
 * the order cap and the waiver, so `priceCart` hands it the promo's
 * `ticketDiscounts`, and `priceComputedCart` REFUSES (INTERNAL) a computation
 * whose tickets do not carry the marks this promo implies: a caller that
 * priced the cart without the promo would otherwise charge the fee silently.
 */

export type PriceCartChannel = "ONLINE" | "DOOR_CARD" | "DOOR_CASH";

/** The resolved promo result — `evaluatePromoApplications` output satisfies it. */
export type PriceCartPromo = {
  totalDiscountCents: number;
  /** Negative `discount` order items, appended after the ticket items. */
  discountItems: OrderComputation["items"];
  /**
   * The same discounts, as spread over tickets (which ones end at $0 and so
   * pay no platform fee). Required, and checked at run time too
   * (`promoTicketDiscounts`): there is no default reading of a promo that
   * does not say which tickets its discounts are on.
   */
  ticketDiscounts: ReadonlyArray<TicketDiscount>;
};

/**
 * The discounts a promo spreads over tickets: its `ticketDiscounts`.
 *
 * A promo object WITHOUT the field is refused (INTERNAL). The type already
 * requires it, so only a caller the compiler does not check can get here (a
 * test fixture, which sits outside typecheck). It used to be read as one
 * order-wide discount, which silently priced a ticket-type code as if it
 * were on the whole order: the wrong tickets freed of their fee, no error.
 */
export function promoTicketDiscounts(
  promo: PriceCartPromo | null | undefined,
): ReadonlyArray<TicketDiscount> {
  if (!promo) {
    return [];
  }
  const { ticketDiscounts } = promo as {
    ticketDiscounts?: ReadonlyArray<TicketDiscount>;
  };
  if (!Array.isArray(ticketDiscounts)) {
    throw fail("INTERNAL", {
      message:
        "promo_ticket_discounts_missing: a promo was priced without its per-ticket discounts; pass evaluatePromoApplications' result, or build `ticketDiscounts` for a hand-made promo",
    });
  }
  return ticketDiscounts;
}

type PriceCartCommonInput = {
  channel: PriceCartChannel;
  /** Primary payout terms + fee policy (`loadPayoutTermsContext`). */
  payoutTerms: PayoutTermsContext;
  /** The order's single evaluation instant (scheduled prices, snapshot time). */
  now: Date;
  /** Already-evaluated promos. Omit for none. */
  promo?: PriceCartPromo | null;
  /**
   * Every tax imposition for the sale, PLATFORM and ORGANISER
   * (`CheckoutTaxResolution.impositions`). Empty list = no tax.
   */
  taxImpositions: ReadonlyArray<TaxImposition>;
};

export type PriceCartInput = PriceCartCommonInput & {
  /** `aggregateItems(...)` output. */
  items: AggregatedItem[];
  /** ACTIVE ticket types for the event, by id. */
  ticketTypes: Map<string, TicketTypeSummary>;
  /** Tickets whose platform fee a fee-waiver reservation actually granted. */
  waivedTickets?: number;
  /** Forwarded to the sales-window guard in `computeOrderAmounts`. */
  reportError?: ReporterPort | null;
  /**
   * Per-seat overrides for `computeOrderAmounts` (required there, so required
   * here). The door sells no explicitly picked seats and passes
   * `unseatedSeatPrices(items)`.
   */
  seatPrices: SeatPrices;
};

export type PriceComputedCartInput = PriceCartCommonInput & {
  /**
   * A `computeOrderAmounts` result (post-waiver), priced with
   * `discounts: promoTicketDiscounts(promo)` when there is a promo. Not
   * mutated.
   */
  computation: OrderComputation;
};

export type PricedCart = {
  channel: PriceCartChannel;
  /** True when the post-promo ticket subtotal (`faceCents − discountCents`) is <= 0. */
  isFree: boolean;
  /** Ticket face BEFORE promo discounts. */
  faceCents: number;
  discountCents: number;
  /** Ticket face AFTER promo discounts — what `Order.amountGrossCents` stores. */
  amountGrossCents: number;
  /** Platform fee net of cap and waiver — `Order.feesPlatformCents`. 0 for DOOR_CASH. */
  feesPlatformCents: number;
  /**
   * Platform fee forgone to a fee waiver (informational, already deducted).
   * 0 for DOOR_CASH (no fee, so no waiver).
   */
  feesWaivedCents: number;
  waivedTicketCount: number;
  /** Platform fee the buyer pays on top of the face. 0 for DOOR_CASH. */
  buyerFeesCents: number;
  effectiveFeeMode: FeeMode;
  /** Σ PLATFORM tax lines — `Order.taxAmountCents`, charged to the buyer. */
  taxAmountCents: number;
  /** Every imposition, solved (ORGANISER lines included, not charged). */
  taxLines: SolvedTaxLine[];
  /** `OrderTaxLine` rows, asserted to sum to `taxAmountCents`. */
  orderTaxLines: CreateOrderTaxLineInput[];
  /** The full solve, for callers that persist or audit it. */
  taxSolve: TaxLinesAndProcessorFeeResult;
  /** Processor fee charged on top of everything else. 0 for DOOR_CASH. */
  processorFeeCents: number;
  /**
   * The processor fee a buyer-facing summary shows: the charged fee in
   * PASS_THROUGH, the display estimate otherwise (ABSORB is removed, so that
   * arm is legacy). 0 for DOOR_CASH. Not the credit-covered 0 — the caller
   * knows whether a charge happens.
   */
  processorFeeDisplayCents: number;
  /** Processor rate and fixed fee the solve actually used (0/0 for DOOR_CASH). */
  processorPct: number;
  processorFixedCents: number;
  /**
   * What the buyer pays before platform credit:
   * `amountGrossCents + buyerFeesCents + taxAmountCents + processorFeeCents`.
   */
  chargeTotalCents: number;
  /**
   * Order items: one `ticket` item per seat (qty 1) whose `meta.buyerTotalCents`
   * includes its share of the processor fee, then the promo `discount` items.
   * `computeExpectedPaymentAmount` over these + `taxAmountCents` ===
   * `chargeTotalCents`.
   */
  items: OrderComputation["items"];
  ticketLines: TicketLineComputation[];
  nonRefundable: boolean;
  /** `Order.feePolicySnapshot`. */
  feePolicySnapshot: ReturnType<typeof buildFeePolicySnapshot>;
};

/** The whole pipeline from aggregated cart lines. */
export function priceCart(input: PriceCartInput): PricedCart {
  const discounts = promoTicketDiscounts(input.promo);
  const computation = computeOrderAmounts(
    input.items,
    input.ticketTypes,
    input.payoutTerms,
    {
      now: input.now,
      ...(input.waivedTickets ? { waivedTickets: input.waivedTickets } : {}),
      reportError: input.reportError,
      seatPrices: input.seatPrices,
      ...(discounts.length > 0 ? { discounts } : {}),
    },
  );
  return priceComputedCart({
    channel: input.channel,
    computation,
    payoutTerms: input.payoutTerms,
    now: input.now,
    promo: input.promo,
    taxImpositions: input.taxImpositions,
  });
}

/** The pipeline from a face/fee computation the caller already holds. */
export function priceComputedCart(input: PriceComputedCartInput): PricedCart {
  const { channel } = input;
  const discountCents = input.promo?.totalDiscountCents ?? 0;
  // Copied like the ticket items, so the caller's promo objects never ride
  // into an order the caller then mutates (seat ids, hold expiry).
  const discountItems = (input.promo?.discountItems ?? []).map(copyItem);

  const computation = copyComputation(input.computation);
  const faceCents = computation.amountGrossCents;
  const amountGrossCents = faceCents - discountCents;
  const isFree = amountGrossCents <= 0;

  // A paid order's computation must already carry this promo's $0 tickets
  // (see the module doc). A free order is exempt: every fee on it is zeroed
  // just below whatever the computation says.
  if (!isFree) {
    assertPricedWithPromo(computation, promoTicketDiscounts(input.promo));
  }

  const cash = channel === "DOOR_CASH";
  if (cash) {
    zeroFeesForCashSale(computation);
  }

  // A promo that cancels the whole subtotal leaves a free order: no fee may
  // survive onto it (same rule as claimFreeTickets).
  if (isFree) {
    zeroFeesForFreeOrder(computation);
    // A free order's tickets carry no fee because the ORDER is free, and
    // `claimFreeTickets` (the online free path) writes no per-ticket mark.
    // Drop the mark so a free order reads the same whichever path wrote it.
    for (const item of computation.items) {
      if (isTicketDiscountedToZero(item)) {
        delete (item.meta as Record<string, unknown>).discountedToZero;
      }
    }
  }

  const processorPct = cash ? 0 : computation.processorPct;
  const processorFixedCents = cash ? 0 : computation.processorFixedCents;
  const passThrough = computation.effectiveFeeMode === "PASS_THROUGH";

  // ── Tax + processor-fee gross-up (the joint solve) ─────────────────
  // In PASS_THROUGH the buyer funds the processor's fee: the solve finds the
  // exact gross-up so the net after the processor's (ceil'd) fee lands on
  // everything else the order must cover. Tax rides along because the two are
  // circular under a `BUYER_TOTAL` base (TN, MN): the tax applies to the
  // processing fee and the fee is grossed up over the tax. `taxCents` is
  // Σ PLATFORM lines; ORGANISER lines are recorded but never charged.
  const taxSolve = solveTaxLinesAndProcessorFee({
    taxableGrossCents: amountGrossCents,
    buyerPlatformFeeCents: computation.buyerFeesCents,
    taxLines: input.taxImpositions,
    passThrough,
    processorPct,
    processorFixedCents,
  });
  const taxAmountCents = taxSolve.taxCents;
  const processorFeeCents = taxSolve.processorFeeCents;

  const chargeTotalCents =
    amountGrossCents +
    computation.buyerFeesCents +
    taxAmountCents +
    processorFeeCents;

  // ── Spread the processor fee into per-item buyer totals ─────────────
  // So that computeExpectedPaymentAmount(order) — the finalize AMOUNT_MISMATCH
  // guard — sums to the charge:
  //   Σ ticket buyerTotalCents (= face + platform fee + processor fee; the
  //   face alone on DOOR_CASH) + Σ discounts + tax === chargeTotalCents.
  // Floored shares by current buyerTotalCents; the last PAID ticket takes the
  // remainder so the shares sum EXACTLY to the fee, and a $0 ticket takes
  // none of it (`spreadProcessorFee`).
  if (processorFeeCents > 0) {
    spreadProcessorFee(computation.items, processorFeeCents);
  }

  return {
    channel,
    isFree,
    faceCents,
    discountCents,
    amountGrossCents,
    feesPlatformCents: computation.feesPlatformCents,
    feesWaivedCents: computation.feesWaivedCents,
    waivedTicketCount: computation.waivedTicketCount,
    buyerFeesCents: computation.buyerFeesCents,
    effectiveFeeMode: computation.effectiveFeeMode,
    taxAmountCents,
    taxLines: taxSolve.lines,
    orderTaxLines: toOrderTaxLineInputs(taxSolve, taxAmountCents),
    taxSolve,
    processorFeeCents,
    processorFeeDisplayCents: passThrough
      ? processorFeeCents
      : computation.processorFeeCents,
    processorPct,
    processorFixedCents,
    chargeTotalCents,
    items: [...computation.items, ...discountItems],
    ticketLines: computation.ticketLines,
    nonRefundable: computation.nonRefundable,
    feePolicySnapshot: buildFeePolicySnapshot(input.payoutTerms, input.now),
  };
}

/**
 * A door cash sale pays the ticket price and tax only (owner ruling
 * 2026-10-08: cash = no platform fee). Strips every fee off a computation, in
 * place, BEFORE the free path and the tax solve run, so the solve sees a
 * fee-less base.
 *
 *  - Platform fee: 0 on the order (`feesPlatformCents`, `buyerFeesCents`) and
 *    on every item (`platformFeePerTicketCents`), in both fee modes. The
 *    per-item buyer total becomes the item's own face (`amountCents`; items
 *    are qty 1), so Σ ticket `buyerTotalCents` + Σ discount items + tax ===
 *    the cash total, the sum `computeExpectedPaymentAmount` (the refund and
 *    the receipt) reads.
 *  - Processor fee: no card, no processor. The display estimate and its
 *    per-item audit share go too, so nothing on the order suggests one was
 *    charged. Item shape is exactly what ONLINE writes when there is no
 *    processor fee: `computeOrderAmounts` leaves the share key OFF when its
 *    fee is 0 (a zero-rate policy), and the free path sets it to 0
 *    (`zeroFeesForFreeOrder`, shared with claimFreeTickets). So the key is
 *    removed HERE, before the free path: a paid cash cart has no share key,
 *    and a free cash cart matches a free online one.
 *
 * A computation that already carries a fee waiver is refused: the waiver
 * would have been reserved against a fee this sale never charges, spending
 * the organiser's allowance on nothing. The cash till reserves none.
 */
function zeroFeesForCashSale(computation: OrderComputation): void {
  if (computation.waivedTicketCount > 0 || computation.feesWaivedCents > 0) {
    throw fail("INTERNAL", {
      message: `door_cash_fee_waiver: a cash sale has no platform fee to waive (waivedTicketCount=${computation.waivedTicketCount}, feesWaivedCents=${computation.feesWaivedCents})`,
    });
  }
  computation.feesPlatformCents = 0;
  computation.buyerFeesCents = 0;
  computation.processorFeeCents = 0;
  computation.paymentIntentAmountCents = computation.amountGrossCents;
  for (const item of computation.items) {
    if (!item.meta || typeof item.meta !== "object") continue;
    const meta = item.meta as Record<string, unknown>;
    delete meta.processorFeeShareCents;
    // No fee, so no capped fee either: the order-level cap may have flagged it.
    delete meta.platformFeeCapped;
    if (item.kind === "ticket") {
      meta.platformFeePerTicketCents = 0;
      meta.buyerTotalCents = item.amountCents;
      meta.buyerUnitTotalCents = item.amountCents;
    }
  }
}

/**
 * Refuses a computation whose tickets are not marked the way `discounts`
 * marks them: priced without the promo (a ticket the promo makes $0 still
 * carries its platform fee), or with a different one. Only the marks are
 * compared, and they are recomputed from the same prices by the same pure
 * function, so this cannot fire on a correctly priced cart.
 */
function assertPricedWithPromo(
  computation: OrderComputation,
  discounts: ReadonlyArray<TicketDiscount>,
): void {
  const ticketItems = computation.items.filter(
    (item) => item.kind === "ticket",
  );
  const expected = ticketsDiscountedToZero(
    ticketItems.map((item) => ({
      ticketTypeId: item.ticketTypeId ?? null,
      unitPriceCents: item.amountCents ?? 0,
    })),
    discounts,
  );
  const mismatchIndex = ticketItems.findIndex(
    (item, index) => isTicketDiscountedToZero(item) !== expected[index],
  );
  if (mismatchIndex !== -1) {
    throw fail("INTERNAL", {
      message: `discounted_to_zero_mismatch: ticket item ${mismatchIndex} is ${
        expected[mismatchIndex] ? "brought to $0 by the promo" : "not brought to $0 by the promo"
      } but the computation says otherwise; price the cart with computeOrderAmounts({ discounts })`,
    });
  }
}

function spreadProcessorFee(
  items: OrderComputation["items"],
  processorFeeCents: number,
): void {
  const ticketItems = items.filter((item) => item.kind === "ticket");
  if (ticketItems.length === 0) {
    return;
  }
  // What each ticket weighs: its buyer total, or 0 when a discount brought it
  // down to $0 (its buyer total is then its pre-discount price, which the
  // discount line cancels; it pays nothing, so it takes no processing fee).
  const buyerWeights = ticketItems.map((item) =>
    isTicketDiscountedToZero(item)
      ? 0
      : (((item.meta as Record<string, unknown>).buyerTotalCents as number) ??
        0),
  );
  const totalBuyerCents = buyerWeights.reduce(
    (sum, weight) => sum + weight,
    0,
  );

  // A $0 ticket weighs 0 (no face, no platform fee: owner ruling 2026-10-10),
  // so its floored share is 0. The cents left over go to the LAST PAID
  // ticket, not to whichever ticket is last: a free ticket at the end of the
  // cart used to pick up the remainder, in its buyer total and its audit
  // share. For a cart of paid tickets that is the last ticket, as before.
  const remainderIndex = feeRemainderItemIndex(
    ticketItems.map((item) =>
      isTicketDiscountedToZero(item) ? 0 : item.amountCents,
    ),
  );
  const shares = buyerWeights.map((itemBuyerCents, i) => {
    if (i === remainderIndex || totalBuyerCents <= 0) {
      return 0;
    }
    return Math.floor((itemBuyerCents / totalBuyerCents) * processorFeeCents);
  });
  shares[remainderIndex] =
    processorFeeCents - shares.reduce((sum, share) => sum + share, 0);

  let distributed = 0;
  for (let i = 0; i < ticketItems.length; i++) {
    const meta = ticketItems[i]!.meta as Record<string, unknown>;
    const share = shares[i]!;
    meta.buyerTotalCents = (meta.buyerTotalCents as number) + share;
    // Items are qty=1, so unit total == total.
    meta.buyerUnitTotalCents = (meta.buyerUnitTotalCents as number) + share;
    // Overwrite the audit estimate with the real charged share.
    meta.processorFeeShareCents = share;
    distributed += share;
  }

  if (distributed !== processorFeeCents) {
    throw fail("INTERNAL", {
      message: `rounding_invariant: processor fee shares ${distributed} !== grossedUpProcessorFeeCents ${processorFeeCents}`,
    });
  }
}

/**
 * Copies a computation deep enough that nothing this module writes (the
 * scalar fee fields, item `meta`) reaches the caller's object. Item meta
 * values are primitives at this point (seat arrays are attached later, by
 * the checkout itself).
 */
function copyComputation(source: OrderComputation): OrderComputation {
  return {
    ...source,
    items: source.items.map(copyItem),
    ticketLines: source.ticketLines.map((line) => ({ ...line })),
  };
}

function copyItem(
  item: OrderComputation["items"][number],
): OrderComputation["items"][number] {
  return {
    ...item,
    meta:
      item.meta && typeof item.meta === "object"
        ? { ...(item.meta as Record<string, unknown>) }
        : item.meta,
  };
}
