import {
  resolveUnitPriceCents,
  type PriceResolvableTicketType,
} from "../../lib/orders/door-pricing";

/**
 * THE one place a POS line's unit price is decided.
 *
 * The cash/comp till path (`recordCashSale`) prices its own lines here
 * rather than going through `computeOrderAmounts`. That fork predates this
 * file. The CARD path (`startPosSale`) no longer does: it prices through
 * `priceCart`, as online checkout does (door-sales spec FR-001/FR-002), and
 * cash follows in that spec's step 4. A FIXED line
 * resolves through the same `resolveUnitPriceCents` as online checkout, so the
 * door sells at the price the event page shows (door-sales-same-price-and-tax
 * spec FR-012: there is no separate door price).
 *
 * What the fork originally dropped was the other half of `computeOrderAmounts`'
 * pricing rule: ADJUSTABLE ("pay what you can") ticket types are BUYER-priced,
 * so no resolver output applies to them.
 *
 * Before this helper, both paths called `resolveUnitPriceCents` unconditionally.
 * For an ADJUSTABLE type that returns `priceCents`, which `upsertTicketType`
 * deliberately stores as `0` ("For ADJUSTABLE mode, priceCents is ignored — use
 * 0 as the stored value"). So a pay-what-you-can tier sold at a door charged
 * $0 on the card path and reported `expectedDueCents: 0` on the cash path,
 * while `startPosSale`'s schema had documented a `donationAmountCents` field
 * since it shipped — accepted, validated by Zod, and then never read.
 *
 * The validation here mirrors `computeOrderAmounts` (checkout-helpers.ts)
 * exactly, including the two error shapes, so the door and the web agree about
 * what a missing or below-floor amount means.
 *
 * Pure: no repo, no clock of its own. `now` comes from the caller's single
 * per-sale instant, the same one the capacity gate and the sales-window gate
 * used, so one cart cannot straddle a scheduled-price flip.
 */
export type PosPricedTicketType = PriceResolvableTicketType & {
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
  /** ADJUSTABLE only — the floor the operator-entered amount must clear. */
  minimumCents?: number | null;
};

export type PosPricedLineRequest = {
  ticketTypeId: string;
  /**
   * Operator/buyer-named amount PER TICKET for an ADJUSTABLE type. Required
   * when the resolved type is ADJUSTABLE; ignored entirely when FIXED — a
   * stray value on a FIXED line must never override the resolved price.
   */
  donationAmountCents?: number | undefined;
};

/**
 * Effective per-ticket price in cents for one POS line.
 *
 * @throws `{ code: "invalid_input", message: "donation_amount_required" }`
 *         when an ADJUSTABLE type is sold without an amount.
 * @throws `{ code: "invalid_input", message: "donation_below_minimum" }`
 *         when the named amount is under the tier's floor.
 */
export function resolvePosUnitPriceCents(
  ticketType: PosPricedTicketType,
  line: PosPricedLineRequest,
  now: Date,
): number {
  if (ticketType.pricingMode !== "ADJUSTABLE") {
    // FIXED: the same resolved price as online checkout (FR-012).
    return resolveUnitPriceCents(ticketType, { now });
  }

  if (line.donationAmountCents == null) {
    throw {
      code: "invalid_input",
      message: "donation_amount_required",
      ticketTypeId: line.ticketTypeId,
    } as const;
  }

  const minimumCents = ticketType.minimumCents ?? 0;
  if (line.donationAmountCents < minimumCents) {
    throw {
      code: "invalid_input",
      message: "donation_below_minimum",
      ticketTypeId: line.ticketTypeId,
      minimumCents,
    } as const;
  }

  return line.donationAmountCents;
}
