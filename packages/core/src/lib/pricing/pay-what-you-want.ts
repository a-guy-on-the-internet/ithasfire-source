import { z } from "zod";

import {
  resolveUnitPriceCents,
  type PriceResolvableTicketType,
} from "../orders/door-pricing";

/**
 * Pay-what-you-want (ADJUSTABLE) tiers.
 *
 * The buyer's chosen amount IS the ticket price, all of it to the event; the
 * platform fee, processing and tax go on top exactly as for a fixed price of
 * that amount (`computeOrderAmounts` charges the donation as the unit price).
 * The stored `priceCents` of an ADJUSTABLE tier is always 0 and means nothing.
 */

/**
 * The most a buyer may pay for ONE pay-what-you-want ticket: $10,000.00.
 *
 * THE single cap, shared by the checkout schemas (`createCheckout`,
 * `updateOrderItems`, `estimateCheckoutTax`, `previewPromos`) and the web
 * amount field. Without it a typo like "15000" charged $15,000 non-refundable,
 * anything past $999,999.99 failed at Stripe, and anything past 2^31−1 cents
 * overflowed the Int columns into a 500.
 */
export const MAX_DONATION_AMOUNT_CENTS = 1_000_000;

/**
 * The cap as server-side validation text: "$10,000.00". Built FROM the
 * constant so the messages cannot drift from the number they describe. (The
 * web formats it in the buyer's locale and currency; these messages are the
 * API's own, in USD like the rest of its validation copy.)
 */
export const MAX_DONATION_AMOUNT_LABEL = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
}).format(MAX_DONATION_AMOUNT_CENTS / 100);

/** A buyer-chosen PWYW amount, in cents, as every checkout input accepts it. */
export const donationAmountCentsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_DONATION_AMOUNT_CENTS, {
    message: `Pay-what-you-want amount is above the ${MAX_DONATION_AMOUNT_LABEL} per-ticket maximum.`,
  });

/** Validation text for a PWYW minimum / suggestion above the cap. */
export const PWYW_SETTING_ABOVE_CAP_MESSAGE = `Pay-what-you-want amounts are capped at ${MAX_DONATION_AMOUNT_LABEL} per ticket.`;

export type ListingPricedTicketType = PriceResolvableTicketType & {
  pricingMode?: string | null;
  minimumCents?: number | null;
};

/**
 * The price a LISTING quotes a tier at — the least a buyer can pay for it.
 *
 * FIXED: the effective price (`resolveUnitPriceCents`).
 * ADJUSTABLE: its floor, `minimumCents` (0 when unset). Quoting the stored $0
 * advertised a $5-minimum tier as "Free" on the event page, browse cards,
 * search and JSON-LD. A floor of 0 is genuinely free and stays 0.
 *
 * Listing surfaces only. The CHARGE path never calls this — it prices an
 * ADJUSTABLE line at the buyer's `donationAmountCents`.
 */
export function resolveListingPriceCents(
  ticketType: ListingPricedTicketType,
  now: Date,
): number {
  if (ticketType.pricingMode === "ADJUSTABLE") {
    return Math.max(0, ticketType.minimumCents ?? 0);
  }
  return resolveUnitPriceCents(ticketType, { now });
}
