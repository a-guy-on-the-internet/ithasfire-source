/**
 * Which ticket takes the rounding remainder when an order-level fee is spread
 * across the order's tickets.
 *
 * Every spread in the pricing pipeline floors each ticket's share and hands
 * the cents left over to one ticket, so the shares sum exactly to the fee:
 * the order-level platform-fee cap and the processing-fee audit share
 * (`computeOrderAmounts`), and the charged processing fee folded into each
 * ticket's buyer total (`priceCart`). That ticket used to be simply the last
 * one. A $0 ticket last in the cart then picked up a cent or two of a fee it
 * owes none of.
 *
 * Owner ruling, 2026-10-10: "If $0 is the cost of the tickets there shouldn't
 * be any fee." So the remainder goes to the LAST PAID ticket (unit price
 * above $0). A cart of paid tickets only is unchanged: its last paid ticket
 * is its last ticket. And a paid ticket's share in a mixed cart equals its
 * share when the free tickets are left out, because the free tickets weigh 0.
 *
 * Returns the last index when no ticket is paid, so a caller's "shares sum to
 * the fee" invariant still holds for a cart that should not have a fee to
 * spread at all (a free order's fees are zeroed before any spread runs), and
 * `-1` for an empty list.
 */
export function feeRemainderItemIndex(
  unitPricesCents: ReadonlyArray<number | null | undefined>,
): number {
  for (let index = unitPricesCents.length - 1; index >= 0; index--) {
    if ((unitPricesCents[index] ?? 0) > 0) {
      return index;
    }
  }
  return unitPricesCents.length - 1;
}
