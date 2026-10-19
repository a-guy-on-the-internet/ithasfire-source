/**
 * compute-benefit-break-even — "at what point does a member's discount cost me
 * more than their dues?"
 *
 * Pure, integer cents, no clock, no repos. Its arithmetic is the settlement
 * pipeline's arithmetic for a sale made under the 2026-10-11 ruling
 * (`SALE_ORGANISER_CREDIT`, docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml):
 *
 *  1. THE OWNER IS CREDITED WHAT THE BUYER PAID FOR THE TICKET.
 *     `computeAgreementBasis` returns `amountGrossCents`, the POST-discount
 *     ticket price. At full price that is the face; with a discount `D` it is
 *     `face − D`. So a discounted ticket costs the owner exactly `D`.
 *
 *  2. THE PLATFORM FEE NEVER TOUCHES THE OWNER'S SIDE. The buyer pays it on
 *     top of the ticket price and the platform keeps it once. It is not taken
 *     out of the owner's credit, so no fee term appears in this file.
 *
 *  3. A 100% DISCOUNT COSTS THE FACE. It routes to `claimFreeTickets`: the
 *     order is $0, no fee is charged and the owner is credited nothing, having
 *     given up the full face they would have been credited.
 *
 * This is forward-looking (a setup-time calculator), so it always uses the
 * current rule. Orders sold before the ruling were credited the price minus
 * the platform fee; nothing here re-derives them.
 *
 * THE ORDER SHAPE THIS ASSUMES, stated because it is load-bearing and easy to
 * get wrong: one show = one order = one ticket. That matters because an AMOUNT
 * benefit is "$5 off the ORDER", not "$5 off each ticket" — `clampDiscount`
 * applies it once against the summed eligible lines, and only ONE benefit
 * applies per order. So `discountedTicketsPerPeriod` is really "how many
 * SEPARATE shows a member uses this at", which is the DIY-room case the
 * calculator exists for. A member buying three tickets to one show gets the
 * $5 once, and this calculator would overstate the cost of that.
 *
 * Not modelled, deliberately: per-event fee-policy overrides, fee waivers, and
 * agreement splits with co-payees. This answers the owner's setup-time
 * question about their own take, not a settlement projection.
 */

export type BenefitBreakEvenInput = {
  /** The tier's price for ONE billing period. */
  tierPriceCents: number;
  /**
   * The tier's billing cadence. Every "PerPeriod" number below is denominated
   * in this — a YEAR tier's break-even is tickets per year, not per month.
   * Carried so callers and tests describe the tier rather than a bare number,
   * and so the UI can label the answer without re-deriving it.
   */
  interval: "MONTH" | "YEAR";
  discountKind: "AMOUNT" | "PERCENT";
  /** Cents off (AMOUNT) or percent 1–100 (PERCENT). */
  discountValue: number;
  /** Optional clamp on the computed discount, integer cents. */
  maxDiscountCents?: number | null;
  /** The face price of a ticket the member would use this on. */
  typicalTicketFaceCents: number;
  /** How many discounted tickets the member buys per billing period. */
  discountedTicketsPerPeriod: number;
};

export type BenefitBreakEvenResult = {
  /** Cents the buyer saves on one ticket. */
  discountPerTicketCents: number;
  /**
   * Revenue the owner gives up per discounted ticket, versus that member
   * having paid full price: the discount, which is never more than the face.
   * For a 100% discount it is the whole face.
   */
  ownerCostPerTicketCents: number;
  /**
   * What the owner clears from this member over one billing period: dues minus
   * the revenue given up at `discountedTicketsPerPeriod`. Negative means the
   * member costs more than they pay.
   */
  ownerNetPerMemberCents: number;
  /**
   * The SMALLEST number of discounted tickets per period at which the member
   * stops being profitable — i.e. the first count where given-up revenue
   * strictly exceeds dues. `null` when that never happens (a benefit worth
   * nothing on this ticket, or a free ticket that costs the owner nothing).
   */
  breakEvenTicketsPerPeriod: number | null;
  /** True when the discount cancels the whole face price (the free path). */
  fullyFree: boolean;
};

export function computeBenefitBreakEven(
  input: BenefitBreakEvenInput,
): BenefitBreakEvenResult {
  const face = Math.max(0, Math.trunc(input.typicalTicketFaceCents));
  const tickets = Math.max(0, Math.trunc(input.discountedTicketsPerPeriod));
  const dues = Math.max(0, Math.trunc(input.tierPriceCents));

  const discountPerTicketCents = discountForFace(input, face);
  const fullyFree = face > 0 && discountPerTicketCents >= face;

  // The owner is credited the post-discount ticket price (`amountGrossCents`),
  // so at full price they keep `face` and a discount `D` leaves them
  // `face − D`. Give-up = D on both routes; the fully-free route is D = face
  // (the order is $0 and credits nothing). `discountForFace` already caps D at
  // the face; the `min` states the invariant here rather than relying on it.
  const ownerNetAtFullPriceCents = face;
  const ownerCostPerTicketCents = Math.min(
    discountPerTicketCents,
    ownerNetAtFullPriceCents,
  );

  const ownerNetPerMemberCents = dues - ownerCostPerTicketCents * tickets;

  // Smallest N with cost×N > dues. Zero cost never crosses.
  const breakEvenTicketsPerPeriod =
    ownerCostPerTicketCents > 0
      ? Math.floor(dues / ownerCostPerTicketCents) + 1
      : null;

  return {
    discountPerTicketCents,
    ownerCostPerTicketCents,
    ownerNetPerMemberCents,
    breakEvenTicketsPerPeriod,
    fullyFree,
  };
}

/**
 * The same clamp order `clampDiscount` (checkout-promos.ts) applies to a single
 * eligible line: kind maths with a PERCENT floor, capped at the eligible
 * amount, then the benefit's own `maxDiscountCents`.
 */
function discountForFace(input: BenefitBreakEvenInput, face: number): number {
  const value = Math.max(0, Math.trunc(input.discountValue));
  let discount =
    input.discountKind === "AMOUNT"
      ? Math.min(value, face)
      : Math.min(Math.floor((face * value) / 100), face);

  if (input.maxDiscountCents != null) {
    discount = Math.min(discount, Math.max(0, Math.trunc(input.maxDiscountCents)));
  }

  return discount;
}
