import type { TxRepos } from "@th/ports/repos";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrdersRepo } from "@th/ports/repos/orders";
import type { LockedSeatRecord } from "@th/ports/repos/seats";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import {
  computeTicketPriceForAgreement,
  // Both a type and a value (`feeModeSchema.enum`) — the fee-waiver branch
  // compares against `FeeMode.PASS_THROUGH` at runtime.
  FeeMode,
  SALE_FEE_MODE,
  SALE_ORGANISER_CREDIT,
} from "../../lib/pricing/compute-ticket-price-for-agreement";
import { solveProcessingFee } from "../../lib/pricing/processing-cost-schedule";
import {
  reportBestEffort,
  resolveScopedFeePolicy,
} from "../../lib/payments/resolve-scoped-fee-policy";
import { assertTicketTypeOnSale } from "../../lib/orders/door-pricing";
import {
  ticketsDiscountedToZero,
  type TicketDiscount,
} from "../../lib/orders/discounted-to-zero";
import { feeRemainderItemIndex } from "../../lib/orders/fee-remainder-item";
import { isItemDiscountedToZero } from "../../lib/orders/refund-weight";
import {
  resolveSeatUnitPriceCents,
  seatOverrideCents,
} from "../../lib/orders/seat-pricing";
import { fail } from "@th/errors";
import { ticketOwnsSeat } from "@th/types";
import { assertEventUngatedForEmbed } from "../embeds/_shared/assert-event-ungated-for-embed";
import type { CheckoutServerContext } from "./_shared/checkout-server-context";

/**
 * Minimum chargeable amount (in cents) the payment processor will accept for a
 * card PaymentIntent. Stripe rejects USD charges below 50¢. Used by checkout to
 * cap auto-applied platform credit so the remaining buyer charge is either
 * exactly 0 (routed through the zero-charge completion path) or at least this
 * minimum — never a tiny positive amount Stripe would reject.
 */
export const STRIPE_MIN_CHARGE_CENTS = 50;

export type AggregatedItem = {
  ticketTypeId: string;
  qty: number;
  seatIds: string[];
  /** Buyer-chosen amount in cents for ADJUSTABLE ticket types. */
  donationAmountCents?: number;
};

export type TicketTypeSummary = {
  id: string;
  /**
   * The configured ONLINE list price. Do NOT read this to charge a buyer —
   * `computeOrderAmounts` resolves the effective price via
   * `resolveUnitPriceCents(tt, { now })` so a scheduled price change
   * (FR-005) is honoured. Carrying the raw fields (rather than a pre-resolved
   * number) keeps the resolution in exactly one place: the money function.
   */
  priceCents: number;
  pricingMode: "FIXED" | "ADJUSTABLE";
  minimumCents: number | null;
  seatSectionId: string | null;
  /**
   * Scheduled price change (FR-005), both null or both set. Required — not
   * optional — so a new caller building this map is forced by the compiler to
   * decide, rather than silently defaulting to the pre-flip price (R-001).
   */
  scheduledPriceCents: number | null;
  scheduledPriceAt: Date | null;
  /**
   * Per-type sales window (FR-014), both bounds independent, null = no bound.
   * Required — not optional — for the same reason the schedule pair is: a new
   * caller building this map must be forced by the compiler to decide, rather
   * than silently defaulting to "always on sale" and shipping a window that is
   * stored but never enforced.
   */
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
};

export type PayoutTermsContext = {
  agreement: PayoutTermsRecord;
  lines: PayoutTermsLineRecord[];
  feePolicy: FeePolicyRecord;
};

/** @deprecated Use PayoutTermsContext */
export type AgreementContext = PayoutTermsContext;

/**
 * One (ticket type, unit price) group of an order's tickets. A ticket type
 * normally yields ONE entry; a seated type whose seats carry different price
 * overrides yields one entry per distinct price, in first-seen order, so
 * `qty × unitPriceCents === lineGrossCents` holds for every entry and the
 * entries of a type still sum to that type's gross. Consumers that filter by
 * `ticketTypeId` and sum `lineGrossCents` (promo eligibility) are unaffected.
 */
export type TicketLineComputation = {
  ticketTypeId: string;
  qty: number;
  unitPriceCents: number;
  lineGrossCents: number;
};

/**
 * Each requested seat's stored price override in cents, `null` when the seat
 * has none (seat-price-overrides spec FR-002). Built by the caller from
 * `readSeatPriceOverrides`; `computeOrderAmounts` never fetches it, and
 * `holdSeatsForCheckout` compares it against the rows it locks.
 */
export type SeatPrices = ReadonlyMap<string, number | null>;

export type SeatHoldInfo = {
  seatIds: string[];
  expiresAt: Date;
};

export type OrderComputation = {
  amountGrossCents: number;
  /** Platform fee actually charged — already NET of any fee waiver. */
  feesPlatformCents: number;
  /** Platform fee forgone via a fee waiver. Informational; already deducted. */
  feesWaivedCents: number;
  /** How many tickets on this order had their platform fee waived. */
  waivedTicketCount: number;
  /** Platform fee portion passed to the buyer (does NOT include processor fees). */
  buyerFeesCents: number;
  /** Processor percentage rate (e.g. 0.029 for 2.9%) — informational / UI display. */
  processorPct: number;
  /** Processor per-transaction fixed fee in cents (e.g. 30 for $0.30) — informational. */
  processorFixedCents: number;
  /** Estimated processor fee in cents (for checkout UI display only; NOT added to the PaymentIntent). */
  processorFeeCents: number;
  /**
   * Effective fee mode for this order (agreement override ?? policy default).
   * In PASS_THROUGH the buyer funds the platform fee (and, via create-checkout's
   * post-tax gross-up, the processor fee); in ABSORB neither is charged on top.
   */
  effectiveFeeMode: FeeMode;
  // Amount to be charged on the payment instrument, after fees and discounts
  paymentIntentAmountCents: number;
  /** True when ALL items in the order are ADJUSTABLE-priced (non-refundable). */
  nonRefundable: boolean;
  items: OrdersRepo["createPending"] extends (input: infer I) => Promise<any>
    ? I extends { items: Array<infer Item> }
      ? Array<Item>
      : never
    : never;
  ticketLines: TicketLineComputation[];
};

/**
 * Zero every fee on a computation whose order turned out to be free.
 *
 * `computeOrderAmounts` already handles one route to free — items priced at
 * $0 — inline, and it has to happen mid-function so the processor-fee base
 * short-circuits to 0. This helper covers the OTHER route: a promo discount
 * that cancels the whole subtotal. That computation was built from real ticket
 * prices, so it carries real fees, and those must not survive onto a $0 order
 * — they would render a fee line on a "free entry" member benefit and record
 * platform fees against an order that generated none.
 *
 * Call this BEFORE merging discount line items in, so only ticket items are
 * touched. `feesWaivedCents` / `waivedTicketCount` are deliberately left alone:
 * they describe what a fee waiver did, which stays true independently.
 *
 * Mutates in place and returns the same object for call-site convenience.
 */
export function zeroFeesForFreeOrder(
  computation: OrderComputation,
): OrderComputation {
  computation.feesPlatformCents = 0;
  computation.buyerFeesCents = 0;
  computation.processorFeeCents = 0;
  computation.paymentIntentAmountCents = 0;

  for (const orderItem of computation.items) {
    const meta = (orderItem.meta ?? {}) as Record<string, unknown>;
    meta.platformFeePerTicketCents = 0;
    meta.buyerTotalCents = 0;
    meta.buyerUnitTotalCents = 0;
    meta.processorFeeShareCents = 0;
    orderItem.meta = meta;
  }

  return computation;
}

/**
 * Refuses a cart that names one ticket type on more than one line at
 * different pay-what-you-want amounts (`undefined` against a number counts as
 * different).
 *
 * `aggregateItems` merges same-tier lines and keeps ONE amount per tier, so
 * such a cart cannot be honoured: the merge used to keep the first line's
 * amount and charge it for every ticket (2500 + 1000 billed as 2 x 2500). We
 * refuse rather than guess. Lines repeating a tier at the SAME amount (or with
 * none, e.g. two seat lines of a fixed tier) still merge.
 *
 * `aggregateItems` calls this, and every caller of that (createCheckout's
 * routing probe and paid path, claimFreeTickets, updateOrderItems) runs it
 * inside its transaction before its first write. Only the routing probe
 * actually refuses: the paid path and claimFreeTickets see the same items
 * after it, so their calls are not independent gates. Callers that write or
 * call out before reaching it (the embed's guest-human upsert,
 * updateOrderItems' tax lookup) call it up front. The
 * web, embed and mobile carts send one line per tier, so only a hand-built
 * API request reaches the refusal.
 */
export function assertOneDonationAmountPerTier(
  items: ReadonlyArray<{ ticketTypeId: string; donationAmountCents?: number }>,
): void {
  const amountByTier = new Map<string, number | undefined>();
  for (const item of items) {
    if (
      amountByTier.has(item.ticketTypeId) &&
      amountByTier.get(item.ticketTypeId) !== item.donationAmountCents
    ) {
      throw fail("INVALID_INPUT", {
        message:
          "A ticket type appears more than once with different pay-what-you-want amounts; send one line per ticket type.",
        meta: { ticketTypeId: item.ticketTypeId },
      });
    }
    amountByTier.set(item.ticketTypeId, item.donationAmountCents);
  }
}

export function aggregateItems(
  items: Array<{
    ticketTypeId: string;
    qty: number;
    seatIds?: string[] | null;
    donationAmountCents?: number;
  }>,
): AggregatedItem[] {
  assertOneDonationAmountPerTier(items);

  const seen = new Map<string, AggregatedItem>();
  const ordered: AggregatedItem[] = [];
  const usedSeatIds = new Set<string>();

  for (const item of items) {
    const seatIds = Array.isArray(item.seatIds) ? [...item.seatIds] : [];

    if (seatIds.length > 0 && seatIds.length !== item.qty) {
      throw {
        code: "invalid_input",
        message: "seat_assignment_qty_mismatch",
        ticketTypeId: item.ticketTypeId,
      } as const;
    }

    for (const seatId of seatIds) {
      if (usedSeatIds.has(seatId)) {
        throw fail("SEAT_DUPLICATE_IN_REQUEST");
      }
      usedSeatIds.add(seatId);
    }

    const existing = seen.get(item.ticketTypeId);
    if (existing) {
      existing.qty += item.qty;
      if (seatIds.length > 0) {
        existing.seatIds.push(...seatIds);
      }
    } else {
      const aggregate: AggregatedItem = {
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
        seatIds,
        donationAmountCents: item.donationAmountCents,
      };
      seen.set(item.ticketTypeId, aggregate);
      ordered.push(aggregate);
    }
  }

  for (const aggregate of ordered) {
    if (
      aggregate.seatIds.length > 0 &&
      aggregate.seatIds.length !== aggregate.qty
    ) {
      throw {
        code: "invalid_input",
        message: "seat_assignment_qty_mismatch",
        ticketTypeId: aggregate.ticketTypeId,
      } as const;
    }
  }

  return ordered;
}

export function computeOrderAmounts(
  items: AggregatedItem[],
  ticketTypes: Map<string, TicketTypeSummary>,
  context: PayoutTermsContext,
  options: {
    /**
     * Evaluation instant, from the caller's injected `ClockPort`. REQUIRED
     * (time-based-ticket-pricing FR-003): this is the canonical charge site, so
     * a defaulted clock would let a caller silently keep pre-flip pricing while
     * looking migrated. Every ticket line on this order resolves against the
     * SAME instant, so a flip landing mid-computation cannot split one cart
     * across two prices.
     */
    now: Date;
    /**
     * Tickets whose platform fee has been RESERVED against a fee waiver.
     * Callers must reserve first and pass the count actually granted — this
     * function trusts the number and does no allowance accounting.
     */
    waivedTickets?: number;
    /**
     * Best-effort error reporter, forwarded to the sales-window guard so an
     * UNPARSEABLE window bound — which makes that guard fail OPEN — raises a
     * Sentry event instead of silently selling forever. Optional: this stays a
     * pure money function and a missing reporter changes nothing. `null` is
     * accepted alongside `undefined` because the tRPC context carries
     * `ReporterPort | null` and two dev-only e2e routes spread it wholesale;
     * both are falsy and take the same no-op branch.
     */
    reportError?: ReporterPort | null;
    /**
     * Every requested seat's override (seat-price-overrides spec FR-002).
     * REQUIRED, like `now`, so every caller is made to decide by the
     * compiler: a seated line is priced per seat from this map, and a seat id
     * missing from it THROWS rather than falling back to the tier price (that
     * fallback is the defect this field exists to remove). A caller that
     * sells no seated lines passes `unseatedSeatPrices(items)`.
     */
    seatPrices: SeatPrices;
    /**
     * The discounts applied to this order (`PromoEvaluationResult
     * .ticketDiscounts`: promo codes, then the membership benefit). A ticket
     * they bring down to $0 pays no platform fee (owner ruling 2026-10-10;
     * the definition of "brought down to $0" is
     * `lib/orders/discounted-to-zero.ts`). Omit when there are none.
     *
     * This function still returns PRE-discount prices and never subtracts a
     * discount: the discount stays one negative order line, added by
     * `priceComputedCart`. The only thing read from it here is which tickets
     * end up at $0.
     */
    discounts?: ReadonlyArray<TicketDiscount>;
  },
): OrderComputation {
  let amountGrossCents = 0;
  let feesPlatformCents = 0;
  let buyerFeesCents = 0;

  const pricingAgreement = buildPricingPayoutTermsContext(context);

  const orderItems: OrderComputation["items"] = [];
  const ticketLines: TicketLineComputation[] = [];
  let hasAdjustableItem = false;
  let allAdjustable = items.length > 0;

  for (const item of items) {
    const ticketType = ticketTypes.get(item.ticketTypeId);
    if (!ticketType) {
      throw {
        code: "not_found",
        message: "ticket_type_not_found",
        ticketTypeId: item.ticketTypeId,
      } as const;
    }

    // ── Sales window (FR-014) ─────────────────────────────────────
    // THE online enforcement point, deliberately placed inside the money
    // function rather than in each use case: createCheckout's routing probe,
    // createCheckout's paid path (both passes), updateOrderItems and
    // claimFreeTickets ALL funnel through here, so a window cannot be honoured
    // by one and ignored by another. It runs before any pricing so a refused
    // tier never produces an order item, and it uses the order's single `now`,
    // so a cart cannot straddle an open/close boundary.
    //
    // This composes with — never replaces — the EVENT-level close, which the
    // callers have already applied via `ensureEventOnSale`. Both are pure
    // refusals, so the stricter wins and this can only narrow, never widen.
    //
    // ADJUSTABLE is NOT exempt: a window is about whether the tier may be sold
    // at all, which is orthogonal to who names the price.
    assertTicketTypeOnSale(ticketType, options.now, {
      meta: { ticketTypeId: item.ticketTypeId },
      onUnparseableBound: options.reportError
        ? ({ field, meta }) =>
            options.reportError?.(
              new Error(`ticket_type_sales_window_unparseable:${field}`),
              {
                tags: { area: "checkout", field },
                extra: { ...meta, surface: "computeOrderAmounts" },
              },
            )
        : undefined,
    });

    // ── Adjustable pricing validation ─────────────────────────────
    const isAdjustable = ticketType.pricingMode === "ADJUSTABLE";
    if (isAdjustable) {
      hasAdjustableItem = true;
      if (item.donationAmountCents == null) {
        throw {
          code: "invalid_input",
          message: "donation_amount_required",
          ticketTypeId: item.ticketTypeId,
        } as const;
      }
      const min = ticketType.minimumCents ?? 0;
      if (item.donationAmountCents < min) {
        throw {
          code: "invalid_input",
          message: "donation_below_minimum",
          ticketTypeId: item.ticketTypeId,
          minimumCents: min,
        } as const;
      }
    } else {
      allAdjustable = false;
    }

    // THE canonical charge site. Every ticket of this item is priced as its
    // own line by `resolveSeatUnitPriceCents` at the order's single `now`:
    //   - ADJUSTABLE: the buyer-named amount (seat overrides ignored, D-004);
    //   - a seat with an override: that override (D-002/D-003);
    //   - otherwise the tier's resolved (scheduled) price.
    // An unseated ticket has no override. The door card sale (start-pos-sale)
    // and the cash till (record-cash-sale) price through here via
    // `priceCart`, so the door charges this same unit price.
    //
    // `aggregateItems` guarantees `seatIds` is empty or exactly `qty` long.
    const unitPrices: number[] = [];
    for (let ticketIndex = 0; ticketIndex < item.qty; ticketIndex++) {
      const seatId = item.seatIds[ticketIndex];
      let overrideCents: number | null = null;
      if (seatId !== undefined) {
        if (!options.seatPrices.has(seatId)) {
          // Never a fallback to the tier price: that is how a seat override
          // went uncharged (seat-price-overrides spec FR-002).
          throw fail("INTERNAL", {
            message: `seat_price_missing: ${seatId}`,
            meta: { seatId, ticketTypeId: item.ticketTypeId },
          });
        }
        overrideCents = options.seatPrices.get(seatId) ?? null;
      }
      unitPrices.push(
        resolveSeatUnitPriceCents(ticketType, overrideCents, {
          now: options.now,
          donationAmountCents: item.donationAmountCents,
        }),
      );
    }

    // Fees per distinct unit price (D-005): the per-ticket platform fee, its
    // percentage, min and max all apply at THAT ticket's price. Grouping keeps
    // an unoverridden item to exactly one call and one `ticketLines` entry, as
    // before; `computeTicketPriceForAgreement` is linear in `qty`.
    //
    // A $0 unit price (a free ticket type, a seat overridden to $0, a
    // pay-what-you-want line set to $0) prices to NO fee here, whatever else
    // is in the cart: owner ruling 2026-10-10, enforced in
    // `computePlatformFeePerTicketCents`. Its fee is 0 and its buyer total is
    // 0, so it adds nothing to the order's platform fee, to the cap, to the
    // waiver ladder or to the processing-fee base below.
    const pricingByUnit = new Map<
      number,
      ReturnType<typeof computeTicketPriceForAgreement>
    >();
    for (const unitAmount of unitPrices) {
      if (pricingByUnit.has(unitAmount)) {
        continue;
      }
      const qtyAtUnit = unitPrices.filter((u) => u === unitAmount).length;
      const lineGross = unitAmount * qtyAtUnit;
      amountGrossCents += lineGross;

      const pricing = computeTicketPriceForAgreement({
        qty: qtyAtUnit,
        unitPriceCents: unitAmount,
        agreement: pricingAgreement,
      });
      pricingByUnit.set(unitAmount, pricing);

      feesPlatformCents += pricing.platformFeePerTicketCents * qtyAtUnit;
      const lineBuyerFees = Math.max(0, pricing.buyerTotalCents - lineGross);
      buyerFeesCents += lineBuyerFees;

      ticketLines.push({
        ticketTypeId: item.ticketTypeId,
        qty: qtyAtUnit,
        unitPriceCents: unitAmount,
        lineGrossCents: lineGross,
      });
    }

    // Create one OrderItem per ticket (qty=1 each) to enable partial refunds.
    // This allows marking individual tickets as paidOutAt independently. Items
    // stay in request order (the seat order, for a seated item), so callers
    // that attach held seats positionally pair each seat with its own price.
    for (let ticketIndex = 0; ticketIndex < item.qty; ticketIndex++) {
      const unitAmount = unitPrices[ticketIndex]!;
      const pricing = pricingByUnit.get(unitAmount)!;
      const perTicketMeta: Record<string, unknown> = {
        buyerUnitTotalCents: pricing.buyerUnitTotalCents,
        buyerTotalCents: pricing.buyerUnitTotalCents, // Per-ticket total, not line total
        platformFeePerTicketCents: pricing.platformFeePerTicketCents,
        effectiveFeeMode: pricing.effectiveFeeMode,
        ticketIndex, // Track which ticket in the original request this represents
      };

      // The seat this line was PRICED for (FR-001): the same index the unit
      // price above was resolved from, so price and seat cannot come apart.
      const seatId = item.seatIds[ticketIndex];
      if (seatId !== undefined) {
        perTicketMeta.seatId = seatId;
      }

      orderItems.push({
        kind: "ticket",
        ticketTypeId: item.ticketTypeId,
        qty: 1, // Always 1 per OrderItem for granular refund/settlement tracking
        unitPriceCents: unitAmount,
        amountCents: unitAmount, // Per-ticket amount
        meta: perTicketMeta,
      });
    }
  }

  // ── Free order: zero every buyer-visible fee ──────────────────────
  // When every line on the order is free (subtotal = $0), the buyer
  // shouldn't see a platform fee, a processor fee, or any other charge.
  // Per-ticket pricing already gives a $0 ticket no fee (the 2026-10-10
  // ruling in `computePlatformFeePerTicketCents`), so these are already 0;
  // the explicit zeroing stays so a free order's zero does not depend on
  // that one line.
  //
  // This also makes the processor-fee branch below short-circuit to 0
  // because `baseCents = 0 + 0`.
  const isFreeOrder = amountGrossCents === 0;
  if (isFreeOrder) {
    feesPlatformCents = 0;
    buyerFeesCents = 0;
    for (const orderItem of orderItems) {
      const meta = orderItem.meta as Record<string, unknown>;
      meta.platformFeePerTicketCents = 0;
      meta.buyerTotalCents = 0;
      meta.buyerUnitTotalCents = 0;
    }
  }

  // Effective fee mode: always SALE_FEE_MODE (PASS_THROUGH), the mode
  // computeTicketPriceForAgreement priced every line under above. The terms'
  // and policy's stored modes are NOT read: ABSORB is removed
  // (docs/decisions/absorb-removed.md). create-checkout reads this to decide
  // whether to gross up the processor fee. Declared here (rather than beside
  // the processor math) because BOTH the order-level cap and the fee waiver
  // below need it. Their ABSORB arms are unreachable for a new sale.
  const effectiveFeeMode: FeeMode = SALE_FEE_MODE;

  // ── Tickets a discount brings down to $0 ──────────────────────────
  // Owner ruling 2026-10-10: "yes a promo brought down to $0 should have no
  // fee too." Such a ticket's platform fee goes to 0 here: BEFORE the
  // order-level cap (so the cap is measured over the tickets that still carry
  // a fee, and each of those pays what it would pay without the discounted
  // ticket in the cart) and BEFORE the fee waiver (so it is not on the waiver
  // ladder and no allowance is spent on a fee that is not charged).
  //
  // The ticket keeps its PRE-discount price in `amountCents` and in its buyer
  // total: the discount is its own negative order line, and the two net to
  // $0. Only the fee comes off. `meta.discountedToZero` marks the ticket so
  // the processing-fee spreads below (and `priceComputedCart`'s) give it no
  // share, and so the order records why a priced ticket carries no fee.
  //
  // A ticket discounted to any amount above $0 is untouched: its fee is
  // still the fee on its list price.
  const discountedToZero = ticketsDiscountedToZero(
    orderItems.map((orderItem) => ({
      ticketTypeId: orderItem.ticketTypeId ?? null,
      unitPriceCents: orderItem.amountCents ?? 0,
    })),
    options.discounts ?? [],
  );
  for (let i = 0; i < orderItems.length; i++) {
    if (!discountedToZero[i]) {
      continue;
    }
    const meta = orderItems[i]!.meta as Record<string, unknown>;
    const fee = meta.platformFeePerTicketCents as number;
    meta.discountedToZero = true;
    meta.platformFeePerTicketCents = 0;
    feesPlatformCents -= fee;
    // The buyer was funding this fee (PASS_THROUGH), so it comes off the
    // buyer's side too. The ABSORB arm is unreachable for a new sale.
    if (effectiveFeeMode === FeeMode.PASS_THROUGH) {
      meta.buyerTotalCents = (meta.buyerTotalCents as number) - fee;
      meta.buyerUnitTotalCents = meta.buyerTotalCents;
      buyerFeesCents -= fee;
    }
  }
  // What each ticket weighs when a fee is shared out or its rounding
  // remainder placed: its price, or 0 when a discount brought it to $0.
  const feeBearingPrices = orderItems.map((orderItem, i) =>
    discountedToZero[i] ? 0 : (orderItem.amountCents ?? 0),
  );

  // ── Order-level platform fee cap ──────────────────────────────────
  // maxPlatformFeeCents caps the TOTAL platform fees across all tickets
  // in the order.  The per-ticket maxFeeCents (on the policy) caps each
  // ticket individually; this is the order-wide safety valve.
  const maxPlatformFeeCents = context.feePolicy.maxPlatformFeeCents;
  if (maxPlatformFeeCents != null && feesPlatformCents > maxPlatformFeeCents) {
    const reduction = feesPlatformCents - maxPlatformFeeCents;
    feesPlatformCents = maxPlatformFeeCents;
    // Buyer-side reduction ONLY when the buyer was funding the fee
    // (PASS_THROUGH) — same guard as the fee waiver below. In ABSORB the
    // buyer never paid the platform fee, so there is nothing to give back:
    // subtracting unconditionally drove buyerFeesCents NEGATIVE, and the
    // charge base (gross + buyerFees + tax) then UNDERCHARGED the buyer by
    // the capped-off amount. The floor is belt-and-braces: in PASS_THROUGH
    // buyerFeesCents === pre-cap feesPlatformCents, so reduction can never
    // exceed it.
    if (effectiveFeeMode === FeeMode.PASS_THROUGH) {
      buyerFeesCents = Math.max(0, buyerFeesCents - reduction);
    }

    // Also reduce per-item metadata proportionally so refund math stays correct.
    // We scale each item's platformFeePerTicketCents down by the same ratio.
    if (orderItems.length > 0) {
      const scale =
        feesPlatformCents > 0
          ? maxPlatformFeeCents / (maxPlatformFeeCents + reduction)
          : 0;
      // Every ticket's capped fee is floored; the cents left over go to the
      // LAST PAID ticket, never to a $0 ticket that happens to be last (a $0
      // ticket, or one a discount brought to $0, has no fee to cap: its
      // floored share is 0 and stays 0). For a cart of paid tickets that is
      // the last ticket, as before.
      const remainderIndex = feeRemainderItemIndex(feeBearingPrices);
      const cappedFees = orderItems.map((orderItem, i) =>
        i === remainderIndex
          ? 0
          : Math.floor(
              ((orderItem.meta as Record<string, unknown>)
                .platformFeePerTicketCents as number) * scale,
            ),
      );
      cappedFees[remainderIndex] =
        maxPlatformFeeCents - cappedFees.reduce((sum, fee) => sum + fee, 0);
      for (let i = 0; i < orderItems.length; i++) {
        const meta = orderItems[i]!.meta as Record<string, unknown>;
        const origPlatform = meta.platformFeePerTicketCents as number;
        const newPlatform = cappedFees[i]!;
        const diff = origPlatform - newPlatform;
        meta.platformFeePerTicketCents = newPlatform;
        // Buyer totals move only in PASS_THROUGH — in ABSORB they are the
        // face price and must not dip below it (same rule as the waiver).
        if (effectiveFeeMode === FeeMode.PASS_THROUGH) {
          meta.buyerTotalCents = (meta.buyerTotalCents as number) - diff;
          meta.buyerUnitTotalCents = meta.buyerTotalCents;
        }
        meta.platformFeeCapped = true;
      }
    }
  }

  // ── Fee waiver ────────────────────────────────────────────────────
  // Zeroes the platform fee on `waivedTickets` whole tickets. Deliberately
  // applied AFTER the order-level cap, so a waiver reduces what the buyer
  // would otherwise actually owe, and BEFORE the processor solve, so the
  // gross-up is computed on the real (reduced) base.
  //
  // Whole tickets only — no fractional fees — which keeps the per-item
  // rounding invariant below integral by construction.
  //
  // Only the platform fee is waived. Stripe's processor fee still applies:
  // we cannot waive a cost the processor charges us.
  let feesWaivedCents = 0;
  let waivedTicketCount = 0;
  const waivedTickets = options.waivedTickets ?? 0;

  if (waivedTickets > 0 && !isFreeOrder) {
    // Rank fee-bearing tickets most-expensive-first. This ordering is
    // load-bearing: FeeWaiversRepo.reserve is handed the same ladder and
    // prices a partial reservation off the same first-N, so both sides must
    // agree. Ties break on index to stay deterministic.
    const ranked = orderItems
      .map((oi, index) => ({
        index,
        fee: (oi.meta as Record<string, unknown>)
          .platformFeePerTicketCents as number,
      }))
      .filter((entry) => entry.fee > 0)
      .sort((a, b) => b.fee - a.fee || a.index - b.index);

    for (const entry of ranked.slice(0, waivedTickets)) {
      const meta = orderItems[entry.index]!.meta as Record<string, unknown>;
      meta.platformFeePerTicketCents = 0;
      meta.platformFeeWaivedCents = entry.fee;

      // In PASS_THROUGH the buyer was funding this fee, so the buyer's total
      // drops. In ABSORB the buyer never saw it — the organiser simply keeps
      // more, via the lower feesPlatformCents feeding the settlement basis.
      if (effectiveFeeMode === FeeMode.PASS_THROUGH) {
        meta.buyerTotalCents = (meta.buyerTotalCents as number) - entry.fee;
        meta.buyerUnitTotalCents = meta.buyerTotalCents;
      }

      feesWaivedCents += entry.fee;
      waivedTicketCount += 1;
    }

    feesPlatformCents -= feesWaivedCents;
    if (effectiveFeeMode === FeeMode.PASS_THROUGH) {
      buyerFeesCents -= feesWaivedCents;
    }
  }

  // ── Processor fee (once per order) ───────────────────────────────────
  // The processor fee is what Stripe charges on the PaymentIntent:
  //
  //   processorFee = ceil(baseCents × pct + fixedCents)
  //
  // where baseCents = amountGrossCents + feesPlatformCents (everything
  // the buyer is paying for goods + platform fee, before processor fee).
  //
  // IMPORTANT: The processor fee is NOT included in buyerFeesCents or
  // per-item buyerTotalCents. create-checkout grosses it up onto the
  // PaymentIntent in PASS_THROUGH; in ABSORB it isn't charged to anyone —
  // Stripe takes it from the platform's balance (separate charges and
  // transfers), not from the organiser's transfer. The fee is computed here
  // for informational / checkout-UI display purposes only.
  //
  // NOTE: Tax is added *after* this computation in create-checkout.ts.
  // If the checkout UI needs to show the processor fee inclusive of tax,
  // create-checkout can re-solve using the raw rate exposed below.
  const processorPct = pricingAgreement.policy.processsorFeePct;
  const processorFixedCents = pricingAgreement.policy.processorFixedCents;

  // Base amount before processor fees (tax not known yet). Free orders
  // never reach Stripe, so we skip the processor-fee math entirely —
  // otherwise the fixed component (`processorFixedCents`, typically
  // $0.30) would surface on the order summary even though no card is
  // ever charged.
  const baseCents = amountGrossCents + feesPlatformCents;
  const processorFeeCents =
    baseCents > 0
      ? solveProcessingFee(baseCents, processorPct, processorFixedCents)
      : 0;

  // Distribute the processor fee across items as an informational audit
  // trail (processorFeeShareCents) but do NOT inflate buyerTotalCents.
  //
  // By each ticket's buyer total, floored; the cents left over go to the LAST
  // PAID ticket. A $0 ticket's buyer total is 0, so its share is 0, and it
  // never takes the remainder for being last (owner ruling 2026-10-10: a $0
  // ticket carries no fee, so no processing-fee share either). A ticket a
  // discount brought to $0 weighs 0 the same way, though its buyer total is
  // still its pre-discount price.
  if (processorFeeCents > 0 && orderItems.length > 0) {
    const buyerWeights = orderItems.map((orderItem, i) =>
      discountedToZero[i]
        ? 0
        : ((orderItem.meta as Record<string, unknown>)
            .buyerTotalCents as number),
    );
    const totalBuyerPaid = buyerWeights.reduce(
      (sum, weight) => sum + weight,
      0,
    );
    const remainderIndex = feeRemainderItemIndex(feeBearingPrices);
    const shares = buyerWeights.map((itemBuyerCents, i) => {
      if (i === remainderIndex || totalBuyerPaid <= 0) {
        return 0;
      }
      return Math.floor((itemBuyerCents / totalBuyerPaid) * processorFeeCents);
    });
    shares[remainderIndex] =
      processorFeeCents - shares.reduce((sum, share) => sum + share, 0);

    for (let i = 0; i < orderItems.length; i++) {
      const meta = orderItems[i]!.meta as Record<string, unknown>;
      meta.processorFeeShareCents = shares[i]!; // audit trail only — not added to buyerTotalCents
    }
  }

  // ── Rounding invariants ────────────────────────────────────────────
  // Verify that distributed per-item amounts sum back to their totals.
  // These guards catch any rounding drift before data reaches the DB.
  const itemGrossSum = orderItems.reduce(
    (s, oi) => s + (oi.amountCents ?? 0),
    0,
  );
  if (itemGrossSum !== amountGrossCents) {
    throw {
      code: "internal" as const,
      message: `rounding_invariant: item gross sum ${itemGrossSum} !== amountGrossCents ${amountGrossCents}`,
    };
  }

  const itemPlatformFeeSum = orderItems.reduce(
    (s, oi) =>
      s +
      ((oi.meta as Record<string, unknown>)
        .platformFeePerTicketCents as number),
    0,
  );
  if (itemPlatformFeeSum !== feesPlatformCents) {
    throw {
      code: "internal" as const,
      message: `rounding_invariant: item platform fee sum ${itemPlatformFeeSum} !== feesPlatformCents ${feesPlatformCents}`,
    };
  }

  return {
    amountGrossCents,
    feesPlatformCents,
    feesWaivedCents,
    waivedTicketCount,
    buyerFeesCents,
    processorPct,
    processorFixedCents,
    processorFeeCents,
    effectiveFeeMode,
    paymentIntentAmountCents: amountGrossCents + buyerFeesCents,
    nonRefundable: allAdjustable && hasAdjustableItem,
    items: orderItems,
    ticketLines,
  };
}

/**
 * True for a ticket item a discount brought down to $0 (set by
 * `computeOrderAmounts({ discounts })`): it carries no platform fee and takes
 * no share of the processing fee.
 */
export function isTicketDiscountedToZero(
  item: OrderComputation["items"][number],
): boolean {
  // One reader of the mark, shared with the refund weight
  // (`lib/orders/refund-weight.ts`).
  return item.kind === "ticket" && isItemDiscountedToZero(item);
}

/**
 * The platform fee of every fee-bearing ticket on an order, sorted DESCENDING —
 * the ladder `FeeWaiversRepo.reserve` prices a (possibly partial) reservation
 * against. Build it from a computation run WITHOUT a waiver, then feed the
 * granted count back through `computeOrderAmounts({ waivedTickets })`.
 */
export function collectWaivableTicketFees(
  computation: OrderComputation,
): number[] {
  return computation.items
    .map(
      (oi) =>
        (oi.meta as Record<string, unknown>)
          .platformFeePerTicketCents as number,
    )
    .filter((fee) => fee > 0)
    .sort((a, b) => b - a);
}

export function buildPricingPayoutTermsContext(context: PayoutTermsContext) {
  const { agreement, lines, feePolicy } = context;
  return {
    id: agreement.id,
    feeMode: agreement.feeMode as FeeMode | null,
    lines: lines.map((line) => ({
      id: line.id,
      payeeId: line.payeeId,
      percent: line.percent,
      floorCents: line.floorCents,
      capPercent: line.capPercent,
      priority: line.priority,
      rounding: line.rounding,
    })),
    policy: {
      id: feePolicy.id,
      version: feePolicy.version,
      feeMode: feePolicy.feeMode as FeeMode,
      processsorFeePct: feePolicy.processsorFeePct,
      processorFixedCents: feePolicy.processorFixedCents,
      payoutPct: feePolicy.payoutPct,
      payoutFixedCents: feePolicy.payoutFixedCents,
      monthlyPayoutCents: feePolicy.monthlyPayoutCents,
      buyerFeePct: feePolicy.buyerFeePct,
      maxFeeCents: feePolicy.maxFeeCents,
      minFeeCents: feePolicy.minFeeCents,
      platformFixedCents: feePolicy.platformFixedCents,
    },
  };
}

export function buildFeePolicySnapshot(context: PayoutTermsContext, now: Date) {
  return {
    payoutTermsId: context.agreement.id,
    payoutTermsVersion: context.agreement.version,
    agreementId: context.agreement.id,
    agreementVersion: context.agreement.version,
    feePolicyId: context.feePolicy.id,
    feePolicyVersion: context.feePolicy.version,
    // The mode this sale was PRICED under, not the rows' stored modes: the
    // order page reads it back (`computeBuyerChargeBreakdown`), so a stray
    // ABSORB row here would describe a pass-through charge as absorbed.
    feeMode: SALE_FEE_MODE,
    // The rule this sale credits the organiser under. `computeAgreementBasis`
    // reads it back from the order; an order without it keeps the pre-ruling
    // credit (price minus the platform fee).
    organiserCredit: SALE_ORGANISER_CREDIT,
    computedAt: now.toISOString(),
  };
}

export function extractSeatIdsFromMeta(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") {
    return [];
  }

  const seatIds = (meta as { seatIds?: unknown }).seatIds;
  if (seatIds === undefined) {
    return [];
  }

  if (!Array.isArray(seatIds)) {
    throw fail("SEAT_IDS_INVALID");
  }

  const filtered: string[] = [];
  for (const candidate of seatIds) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw fail("SEAT_IDS_INVALID");
    }
    filtered.push(candidate);
  }

  const unique = new Set(filtered);
  if (unique.size !== filtered.length) {
    throw fail("SEAT_IDS_DUPLICATE");
  }

  return filtered;
}

/**
 * Every requested seat's stored price override, read WITHOUT a lock, for
 * `computeOrderAmounts({ seatPrices })` (seat-price-overrides spec FR-002).
 *
 * Why a separate unlocked read: checkout must price the cart (fee-waiver
 * reservation, promos, credit, tax) before it takes the capacity lock, and the
 * capacity lock must precede every Seat lock (startPosSale takes them in that
 * order; the reverse deadlocks). So the price is read here first and made
 * binding later: `holdSeatsForCheckout` re-reads each seat FOR UPDATE and
 * refuses the order with `seat_price_changed` if the override moved in
 * between (D-006/D-007). A price the client sends (`seatQuotes`) is only
 * compared against the priced lines (`_shared/seat-quotes.ts`), never read
 * here and never charged.
 *
 * A requested seat this event does not have is refused (`SEAT_NOT_FOUND`),
 * the same answer the locked read gives.
 */
export async function readSeatPriceOverrides(
  tx: Pick<TxRepos, "seats">,
  params: { eventId: string; items: ReadonlyArray<AggregatedItem> },
): Promise<SeatPrices> {
  const seatIds = params.items.flatMap((item) => item.seatIds);
  const prices = new Map<string, number | null>();
  if (seatIds.length === 0) {
    return prices;
  }
  const rows = await tx.seats.findPriceOverridesByIds({
    seatIds,
    eventId: params.eventId,
  });
  for (const row of rows) {
    prices.set(row.id, seatOverrideCents(row.priceOverride, row.id));
  }
  for (const seatId of seatIds) {
    if (!prices.has(seatId)) {
      throw fail("SEAT_NOT_FOUND");
    }
  }
  return prices;
}

/**
 * The `seatPrices` of a surface that sells no explicitly picked seats (the
 * door: POS card, cash, the Sell-screen quote, and the seed script). Refuses a
 * cart that names seats instead of pricing it at the tier price, so a seated
 * line can never reach `computeOrderAmounts` without its overrides.
 */
export function unseatedSeatPrices(
  items: ReadonlyArray<Pick<AggregatedItem, "ticketTypeId" | "seatIds">>,
): SeatPrices {
  const seated = items.find((item) => item.seatIds.length > 0);
  if (seated) {
    throw fail("INVALID_INPUT", {
      message: "seat_ids_not_supported_on_this_surface",
      meta: { ticketTypeId: seated.ticketTypeId },
    });
  }
  return new Map();
}

/**
 * The held seat a per-ticket order item gets. An explicitly picked seat is
 * the one the item was PRICED for (`meta.seatId`, stamped by
 * `computeOrderAmounts`), so it is used as is; it must be among the seats this
 * checkout holds for the item's type, or the order is refused rather than
 * attaching a price to a different seat. An auto-assigned line (no
 * `meta.seatId`) takes the next held seat in order, `positionalIndex`.
 */
export function heldSeatIdForItem(
  meta: Record<string, unknown>,
  hold: SeatHoldInfo,
  positionalIndex: number,
): string | undefined {
  const pricedSeatId = meta.seatId;
  if (typeof pricedSeatId === "string") {
    if (!hold.seatIds.includes(pricedSeatId)) {
      throw fail("INTERNAL", {
        message: `priced_seat_not_held: ${pricedSeatId}`,
        meta: { seatId: pricedSeatId },
      });
    }
    return pricedSeatId;
  }
  return hold.seatIds[positionalIndex];
}

export async function holdSeatsForCheckout(
  tx: TxRepos,
  params: {
    eventId: string;
    items: AggregatedItem[];
    ticketTypeMap: Map<string, TicketTypeSummary>;
    now: Date;
    ttlSeconds: number;
    /**
     * The overrides the order was PRICED with (`readSeatPriceOverrides`).
     * Each locked row's override must equal its entry, or the order is
     * refused with `seat_price_changed` (seat-price-overrides spec D-006,
     * D-007) and the transaction rolls back with no seat left held.
     */
    seatPrices: SeatPrices;
  },
): Promise<Map<string, SeatHoldInfo>> {
  const expiredBefore = new Date(
    params.now.getTime() - params.ttlSeconds * 1000,
  );
  await tx.seats.releaseExpiredHolds({
    before: expiredBefore,
    releasedAt: params.now,
  });

  const seatRequests = params.items.filter((item) => item.seatIds.length > 0);
  const gaRequests = params.items.filter((item) => item.seatIds.length === 0);

  const holds = new Map<string, SeatHoldInfo>();
  const expiresAt = new Date(params.now.getTime() + params.ttlSeconds * 1000);

  if (seatRequests.length > 0) {
    const allSeatIds = seatRequests.flatMap((item) => item.seatIds);
    const seats = await tx.seats.findByIdsForUpdate({
      seatIds: allSeatIds,
      eventId: params.eventId,
    });

    if (seats.length !== allSeatIds.length) {
      throw fail("SEAT_NOT_FOUND");
    }

    const seatById = new Map<string, LockedSeatRecord>(
      seats.map((seat) => [seat.id, seat]),
    );

    for (const seat of seats) {
      if (seat.status !== "AVAILABLE") {
        throw {
          code: "conflict",
          message: "seat_unavailable",
          seatId: seat.id,
        } as const;
      }
    }

    // ── The priced override must be the locked override (D-006/D-007) ──
    // The cart was priced from an unlocked read; this row is locked until
    // commit, so an organiser's edit either landed before it (and differs
    // here) or waits for this checkout. A difference refuses the order rather
    // than charging a number the buyer was not quoted, and it is thrown
    // before the HELD flip below, so nothing is held when it rolls back.
    for (const seat of seats) {
      if (!params.seatPrices.has(seat.id)) {
        throw fail("INTERNAL", {
          message: `seat_price_missing: ${seat.id}`,
          meta: { seatId: seat.id },
        });
      }
      const pricedCents = params.seatPrices.get(seat.id) ?? null;
      const lockedCents = seatOverrideCents(seat.priceOverride, seat.id);
      if (pricedCents !== lockedCents) {
        throw {
          code: "conflict",
          message: "seat_price_changed",
          seatId: seat.id,
        } as const;
      }
    }

    // Occupancy, not history: a REFUNDED or INVALID ticket keeps its `seatId`
    // and must NOT block the seat — that dead row is what made a refunded
    // reserved seat unsellable forever. The repo already filters by status;
    // this repeats the predicate in memory so the rule is enforced (and
    // testable) on this side of the port too.
    const existingTickets = await tx.tickets.findBySeatIds(allSeatIds);
    const takenTicket = existingTickets.find(
      (ticket) => ticket.seatId && ticketOwnsSeat(ticket.status),
    );
    if (takenTicket && takenTicket.seatId) {
      throw {
        code: "conflict",
        message: "seat_taken",
        seatId: takenTicket.seatId,
      } as const;
    }

    for (const request of seatRequests) {
      const ticketType = params.ticketTypeMap.get(request.ticketTypeId);
      if (!ticketType) {
        throw {
          code: "not_found",
          message: "ticket_type_not_found",
          ticketTypeId: request.ticketTypeId,
        } as const;
      }

      if (!ticketType.seatSectionId) {
        throw {
          code: "invalid_input",
          message: "ticket_type_not_seated",
          ticketTypeId: request.ticketTypeId,
        } as const;
      }

      for (const seatId of request.seatIds) {
        const seat = seatById.get(seatId);
        if (!seat) {
          throw fail("SEAT_NOT_FOUND");
        }
        if (seat.seatSectionId !== ticketType.seatSectionId) {
          throw fail("SEAT_SECTION_MISMATCH");
        }
      }
    }

    await tx.seats.updateStatuses({
      seatIds: allSeatIds,
      status: "HELD",
      updatedAt: params.now,
    });

    for (const request of seatRequests) {
      holds.set(request.ticketTypeId, {
        seatIds: [...request.seatIds],
        expiresAt,
      });
    }
  }

  for (const request of gaRequests) {
    const ticketType = params.ticketTypeMap.get(request.ticketTypeId);
    if (!ticketType || !ticketType.seatSectionId) {
      continue;
    }

    const reservedSeats = await tx.seats.reserveForHold({
      seatSectionId: ticketType.seatSectionId,
      eventId: params.eventId,
      qty: request.qty,
      heldAt: params.now,
    });

    if (reservedSeats.length !== request.qty) {
      throw {
        code: "conflict",
        message: "seat_unavailable",
        ticketTypeId: request.ticketTypeId,
      } as const;
    }

    holds.set(request.ticketTypeId, {
      seatIds: reservedSeats.map((seat) => seat.id),
      expiresAt,
    });
  }

  return holds;
}

export async function loadPayoutTermsContext(
  tx: TxRepos,
  eventId: string,
  /**
   * Evaluation instant, from the caller's injected `ClockPort`. REQUIRED so no
   * call site can silently fall back to `Date.now()` inside a money path — it
   * is the `at` the cold-path fee-policy re-resolve below is evaluated against.
   */
  now: Date,
  /**
   * Diagnostics for the two cold branches below. The OBJECT is required (its
   * members are not) so that the compiler, not review, is what stops a call
   * site from dropping it: an omitted reporter here leaves a repo failure in
   * the scope walk unattributed to the scope that broke on the checkout path,
   * which is exactly the defect this parameter was added to fix. Tests that
   * don't care pass `{}` deliberately; every production caller forwards both
   * from its use-case deps.
   */
  options: { logger?: LoggerPort; reportError?: ReporterPort | null },
): Promise<PayoutTermsContext> {
  const terms = await tx.payoutTerms.listByEvent(eventId);
  const primary =
    terms.find((t) => t.kind === "PRIMARY" && t.status === "ACTIVE") ??
    // Backward compat: accept old enum value during migration
    terms.find(
      (t) => (t.kind as string) === "PRIMARY_SPLIT" && t.status === "ACTIVE",
    );

  if (!primary) {
    throw fail("PRIMARY_AGREEMENT_MISSING");
  }

  const [lines, pinnedFeePolicy] = await Promise.all([
    tx.payoutTerms.listLines(primary.id),
    primary.feePolicyId
      ? tx.feePolicies.getById(primary.feePolicyId)
      : Promise.resolve(null),
  ]);

  // ── Dangling pin ──────────────────────────────────────────────────────
  // The terms name a policy id and that row is GONE. This is NOT the
  // free-event case below and must not be repaired by re-resolving: a pin
  // exists precisely so an agreement keeps the economics it was signed under
  // (see the header of lib/pricing/platform-fee-policy.ts), and silently
  // substituting a different VERSION on a money path is a mispricing, not a
  // heal. Behaviour is therefore unchanged from before the free-event work —
  // FEE_POLICY_NOT_FOUND, exactly as it threw then.
  //
  // REACHABILITY, measured rather than assumed: this branch should be DEAD.
  // `PayoutTerms.feePolicyId` carries a foreign key to `FeePolicy.id` with
  // `onDelete: SetNull` (packages/db/prisma/finance.prisma:221 — verified
  // against the live constraint, `confdeltype = 'n'`), so the database itself
  // guarantees the column is either NULL or points at a live row. Deleting a
  // policy (only the e2e reset routes do) NULLS every pin rather than orphaning
  // it, which lands in the unpinned branch below, not here. Versions are
  // ARCHIVED rather than deleted, and `getById` is an unfiltered `findUnique`,
  // so an archived pinned policy still resolves.
  //
  // It is kept, and kept LOUD, because the invariant is one refactor away from
  // breaking: adding `status: "ACTIVE"` to that `findUnique` would make every
  // archived pin read as null and, without this branch, silently re-resolve the
  // sale onto a NEWER policy version. That is a mispricing, and it would be
  // invisible. Here it is a named refusal plus a report. Do not "simplify" this
  // into the cold path below.
  if (primary.feePolicyId && !pinnedFeePolicy) {
    const dangling = new Error(
      `fee_policy_pin_dangling: PayoutTerms ${primary.id} pins FeePolicy ${primary.feePolicyId}, which no longer exists`,
    );
    options?.logger?.error("fee_policy_pin_dangling", {
      eventId,
      payoutTermsId: primary.id,
      feePolicyId: primary.feePolicyId,
      err: dangling,
    });
    reportBestEffort(options?.reportError, dangling, {
      tags: { useCase: "loadPayoutTermsContext", fault: "dangling_pin" },
      extra: {
        eventId,
        payoutTermsId: primary.id,
        feePolicyId: primary.feePolicyId,
      },
    });
    throw fail("FEE_POLICY_NOT_FOUND");
  }

  // ── Cold path: NO pinned policy ───────────────────────────────────────
  // `publishEvent` pins the resolved policy onto the primary terms, so on the
  // hot path `pinnedFeePolicy` is already set and nothing below runs.
  //
  // With the dangling case handled above, the pin can be absent in exactly one
  // situation: a FREE event that published while the platform had NO fee policy
  // at any scope (publishEvent lets that through deliberately — a free event
  // moves no money, and blocking it walled organizers behind a misconfiguration
  // only we can fix). Those events still sell $0 tickets through
  // `claimFreeTickets`, which routes through here, so hard-failing would just
  // relocate the outage from the organizer to the buyer. Re-run the SAME
  // EVENT → ORG → GLOBAL walk publish uses: the moment a GLOBAL policy exists
  // the path heals itself with no data repair.
  //
  // A REPO FAILURE inside the walk is reported at the failing scope and
  // RETHROWN — it never reaches the `AGREEMENT_MISSING_FEE_POLICY` throw below,
  // which is reserved for a clean miss at every scope. The walk used to swallow
  // and continue, which inside this transaction could only ever produce a
  // fabricated `null`, so a Neon blip on the highest-stakes path in the repo
  // surfaced to the buyer as a CONFIGURATION error. `logger` / `reportError`
  // are forwarded so the report names the scope that broke.
  //
  // Deliberately NOT written back to the terms row — this is a read path on
  // checkout, and the resolved version is already snapshotted onto the order by
  // `buildFeePolicySnapshot`.
  //
  // The resolved policy supplies RATES only. Its `feeMode` is never read for
  // pricing (SALE_FEE_MODE), so a legacy ABSORB row resolved here — booking
  // terms finalized unpinned onto a live event, say — still sells fees on top.
  let feePolicy = pinnedFeePolicy;
  if (!feePolicy) {
    const event = await tx.events.getById(eventId);
    feePolicy = await resolveScopedFeePolicy(
      tx,
      { eventId, orgId: event?.orgId ?? null },
      now,
      {
        logger: options?.logger,
        reportError: options?.reportError,
        source: "loadPayoutTermsContext",
      },
    );
  }

  if (!feePolicy) {
    throw fail("AGREEMENT_MISSING_FEE_POLICY");
  }

  if (lines.length === 0) {
    throw fail("AGREEMENT_MISSING_LINES");
  }

  return { agreement: primary, lines, feePolicy };
}

/** @deprecated Use loadPayoutTermsContext */
export const loadAgreementContext = loadPayoutTermsContext;

// ── Shared event validation helpers ─────────────────────────────────────────

/**
 * Loads the event and verifies it is on sale: published AND not yet ended.
 * Sales close at `endsAt` — search already hides started events, so this
 * closes the direct-link / "View Event" purchase path for ended events.
 * Throws `not_found` or `conflict` if the event is missing, unpublished, or over.
 * An event whose owner is banned is refused as unpublished.
 */
export async function ensureEventOnSale(
  tx: TxRepos,
  eventId: string,
  now: Date,
) {
  const event = await tx.events.getById(eventId, { withOwnerStanding: true });
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  // A banned owner's event is hidden (ban-that-sticks, 2026-09-29) and
  // answers exactly like an unpublished one: nothing new is sold for it.
  if (event.status !== "PUBLISHED" || event.ownerBanned === true) {
    throw fail("EVENT_NOT_ON_SALE");
  }
  // Sales close at the event's end. Both start and end are required in
  // practice, but fall back to startsAt if endsAt is ever missing.
  const salesCloseAt = event.endsAt ?? event.startsAt;
  if (salesCloseAt && now.getTime() >= salesCloseAt.getTime()) {
    throw fail("EVENT_SALES_CLOSED");
  }
  return event;
}

/**
 * Ensures the buyer has access to a gated event.
 * For NONE gateType, this is a no-op (no database call).
 * For PASSWORD or APPLICATION gates, checks for an active unlock record.
 */
export async function ensureEventAccessible(
  tx: TxRepos,
  event: EventRecord,
  buyerHumanId: string,
): Promise<void> {
  if (event.gateType === "NONE") {
    return;
  }

  const isUnlocked = await tx.eventUnlocks.isUnlocked(event.id, buyerHumanId);
  if (!isUnlocked) {
    throw fail("FORBIDDEN");
  }
}

/**
 * The gate check for every checkout site (createCheckout's shared-prep and
 * paid transactions and its pre-transaction settle; claimFreeTickets' claim
 * transaction and its pre-transaction settle).
 *
 * An EMBED checkout (`serverContext.embedId`, set only by
 * `createEmbedGuestCheckout`) names its buyer by a TYPED email, so an unlock
 * held by that email's human proves nothing about who is buying: an embed
 * never sells a gated event, unlock or not (owner ruling 2026-10-12). Every
 * other checkout keeps {@link ensureEventAccessible}. The embed use case
 * refuses earlier too; this is the backstop that still holds if the event is
 * gated between that check and this one.
 */
export async function ensureBuyerMayEnterEvent(
  tx: TxRepos,
  event: EventRecord,
  buyerHumanId: string,
  serverContext: CheckoutServerContext,
): Promise<void> {
  if (serverContext.embedId) {
    assertEventUngatedForEmbed(event);
    return;
  }
  await ensureEventAccessible(tx, event, buyerHumanId);
}
