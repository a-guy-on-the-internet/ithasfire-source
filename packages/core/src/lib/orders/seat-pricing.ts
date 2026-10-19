/**
 * Per-seat unit price: the seat-level sibling of `resolveUnitPriceCents`
 * (door-pricing.ts), for docs/specs/2026-08-12/seat-price-overrides.spec.yaml.
 *
 * A seat may carry a stored price override (`Seat.priceOverride`, JSON
 * `{ priceCents, reason? }`). Checkout charges it: `computeOrderAmounts`
 * prices every ticket line through `resolveSeatUnitPriceCents`, and
 * `holdSeatsForCheckout` compares the override it priced with against the row
 * it locks, via `seatOverrideCents`. Both read the number through this file
 * so the comparison cannot drift from the charge.
 *
 * PURE: no repo access, no clock of its own (callers pass `now`).
 */
import { fail } from "@th/errors";

import {
  resolveUnitPriceCents,
  type PriceResolvableTicketType,
  type ResolveUnitPriceOptions,
} from "./door-pricing";

/**
 * The override amount stored on a seat, as integer cents, or `null` when the
 * seat has none.
 *
 * THE one place a seat override's number is read, so the price-read
 * invariant (price-read-invariant.test.ts) has one exempt site for it. The
 * pre-lock read that prices the cart and the comparison against the row
 * locked FOR UPDATE (checkout-helpers.ts) both go through here, as does the
 * display quoter (`quoteSeatPriceOverrides`, which tolerates a refusal) and
 * the promo preview (`previewPromos`, which reports a refusal and prices the
 * seat at its tier). No other path calls it: the seat repo reads `priceOverride` leniently, so mint,
 * the ticket email and the resale listing never fail on it.
 *
 * Presence, never truthiness: `{ priceCents: 0 }` is a FREE seat and returns
 * 0 (spec D-002). Refused with INTERNAL `seat_price_override_invalid`
 * (naming `seatId`) rather than charged or ignored:
 *   - the repo's `{ invalid: true }` marker (a stored value that is neither
 *     absent nor `{ priceCents: number }`);
 *   - a negative, fractional or non-finite amount.
 * `set-seat-price-overrides` never writes either, so reaching it means corrupt
 * data, and either guess would charge a number nobody quoted.
 */
export function seatOverrideCents(
  priceOverride: { priceCents: number } | { invalid: true } | null | undefined,
  seatId: string,
): number | null {
  const cents = classifySeatOverride(priceOverride);
  if (cents !== "invalid") {
    return cents;
  }
  throw fail("INTERNAL", {
    message: "seat_price_override_invalid",
    meta:
      priceOverride == null || "invalid" in priceOverride
        ? { seatId }
        : { seatId, priceCents: String(priceOverride.priceCents) },
  });
}

/**
 * The judgement {@link seatOverrideCents} refuses on, without the throw, for
 * a reader that must judge a stored value rather than refuse a sale (the
 * publish gate): the cents, `null` for no override, or `"invalid"` for the
 * repo's marker or an amount that is not a non-negative safe integer.
 * `seatOverrideCents` throws exactly when this returns `"invalid"`.
 */
export function classifySeatOverride(
  priceOverride: { priceCents: number } | { invalid: true } | null | undefined,
): number | null | "invalid" {
  if (priceOverride == null) {
    return null;
  }
  if ("invalid" in priceOverride) {
    return "invalid";
  }
  const cents = priceOverride.priceCents;
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : "invalid";
}

export type SeatPriceResolvableTicketType = PriceResolvableTicketType & {
  pricingMode: "FIXED" | "ADJUSTABLE";
};

export type ResolveSeatUnitPriceOptions = ResolveUnitPriceOptions & {
  /**
   * The buyer-named amount for an ADJUSTABLE tier. Required for that mode
   * (refused as `donation_amount_required` when absent), ignored otherwise.
   */
  donationAmountCents?: number;
};

/**
 * Unit price of ONE ticket line, given its seat's override (`null` for an
 * unseated line or a seat without one):
 *
 *   ADJUSTABLE tier          → the buyer's `donationAmountCents`; any seat
 *                              override is ignored (D-004).
 *   FIXED, override present  → the override, an ABSOLUTE amount that replaces
 *                              the tier price (D-002) and does not follow the
 *                              tier's schedule (D-003). 0 is a free seat.
 *   FIXED, no override       → `resolveUnitPriceCents(tt, { now })`.
 *
 * `overrideCents` is what `seatOverrideCents` returned; `null` means absent.
 * The check is `!== null`, so a 0 override can never fall through to the
 * tier price.
 */
export function resolveSeatUnitPriceCents(
  ticketType: SeatPriceResolvableTicketType,
  overrideCents: number | null,
  { now, donationAmountCents }: ResolveSeatUnitPriceOptions,
): number {
  if (ticketType.pricingMode === "ADJUSTABLE") {
    if (donationAmountCents == null) {
      throw {
        code: "invalid_input",
        message: "donation_amount_required",
      } as const;
    }
    return donationAmountCents;
  }
  if (overrideCents !== null) {
    return overrideCents;
  }
  return resolveUnitPriceCents(ticketType, { now });
}
