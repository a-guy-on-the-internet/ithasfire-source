/**
 * The held order, with the platform fee the SERVER states for it.
 *
 * A held order carries the fee it was last priced with, and that is not
 * always the fee the next `createCheckout` takes:
 *
 *  - a fresh hold was priced with no promo, so it still carries the fee of a
 *    ticket a code brings down to $0, which the charge does not take (owner
 *    ruling 2026-10-10: "yes a promo brought down to $0 should have no fee
 *    too");
 *  - a cart `createCheckout` already priced (a declined card, a reloaded
 *    payment step) was priced WITH the promo, so that fee is already gone
 *    from it;
 *  - a fee waiver covers the tickets with the largest fees, so when a code
 *    frees one of them the waiver moves to another ticket.
 *
 * No subtraction on the page is right for all three (taking a "fee
 * reduction" off the order's fee quoted the second case one fee too low and
 * the third a few cents too low). So the page does no arithmetic on the fee:
 * `promos.preview` answers with `heldCartFees`, the fee the charge will take
 * for this cart with these codes, computed by the charge's own code
 * (`packages/core/src/use-cases/orders/_shared/held-cart-fees.ts`), and this
 * puts that figure on the order every held surface reads: the summary's and
 * the tray's platform-fee row, the "fee waived" note, the held charge solve
 * (tax and processing on top of it) and the tax fallback. One order object,
 * so the rows and the total cannot disagree.
 *
 * A statement is for one set of codes. While the server has not answered for
 * a changed set, the page shows no discount, and `useCheckoutPromoPreview`
 * hands this the cart's NO-DISCOUNT fee instead (the statement's
 * `withoutDiscounts`, remembered from the last answer for the same cart): the
 * fee that belongs beside "no discount". Same shape, so it goes on the order
 * the same way.
 *
 * Nothing stated at all (`null`: no answer has ever arrived for this cart, or
 * the server could not price it): the order is returned AS IS, the same
 * object, and the page shows what it showed before. See the core module for
 * what that figure is worth in each case.
 *
 * Only in PASS_THROUGH, where the buyer funds the platform fee
 * (`buyerFeesCents === feesPlatformCents`). In any other mode the buyer pays
 * no platform fee and there is nothing to restate.
 */
export type StatedHeldFees = {
  /** The order's `buyerFeesCents` as `createCheckout` will stamp it. */
  buyerPlatformFeeCents: number;
  /** The platform fee a fee waiver takes off, as the charge will apply it. */
  platformFeeWaivedCents: number;
};

export function withStatedHeldFees<
  O extends {
    feesPlatformCents: number;
    buyerFeesCents: number;
    feeWaivedCents?: number;
  },
>(
  order: O | null,
  stated: StatedHeldFees | null | undefined,
  feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined,
): O | null {
  if (!order || !stated || feeMode !== "PASS_THROUGH") {
    return order;
  }
  if (
    order.buyerFeesCents === stated.buyerPlatformFeeCents &&
    order.feesPlatformCents === stated.buyerPlatformFeeCents &&
    order.feeWaivedCents === stated.platformFeeWaivedCents
  ) {
    return order;
  }
  return {
    ...order,
    feesPlatformCents: stated.buyerPlatformFeeCents,
    buyerFeesCents: stated.buyerPlatformFeeCents,
    feeWaivedCents: stated.platformFeeWaivedCents,
  };
}
