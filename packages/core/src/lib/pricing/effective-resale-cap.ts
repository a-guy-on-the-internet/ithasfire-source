/**
 * The resale cap that applies to ONE ticket, in cents.
 *
 * Owner ruling 2026-10-10 (seat-price-overrides spec, Q-001):
 *   "Each section has a generalized price by that section and has the ability
 *    to have it's own custom price. The way ticket resells work is by that
 *    associated ticket price."
 *   "Resale cap is determined by ticke ttype so yes."
 *
 * Read as: the cap is set on the ticket type (`TicketType.resaleCapCents`),
 * and a ticket's cap never falls below what that ticket itself was priced at.
 * A seat with a $50 seat price override sold through a $30 ticket type whose
 * resale cap is $35 can be listed for up to $50. A ticket bought at the type's
 * own $30 keeps the $35 cap.
 *
 * This is the ONLY place the rule lives. Every site that refuses an ask over
 * the cap, clamps a suggested ask to it, or sends the cap to a seller calls
 * this function; none compares against `TicketType.resaleCapCents` directly.
 *
 * `ticketUnitPriceCents` is the ticket's own price: the `unitPriceCents` of
 * the OrderItem `Ticket.orderItemId` points at, the same number resale calls
 * face value (`resolvePurchasedUnitPriceCents`). It is the list price of the
 * sale that put the ticket in its holder's hands, before fees, tax and promo
 * discounts:
 *   - bought online or at the door: the price charged for that ticket (the
 *     seat price override when the seat has one, else the ticket type's price
 *     at that moment);
 *   - bought on resale: the ask it was bought at, not the first sale's price
 *     (`reassignForResale` repoints the ticket at the resale buyer's item);
 *   - comp, volunteer reward, door comp: 0, so the type's cap applies as is;
 *   - transferred: unchanged, a transfer keeps the ticket's order item.
 *
 * `originalUnitPriceCents` (organiser-resale-share spec, FR-007, owner ruling
 * R15: "Original price" = the organiser's price at the first sale, always):
 * when the key is given (not `undefined`), it REPLACES `ticketUnitPriceCents`
 * as the floor, so a ticket bought on resale is floored at its first-sale
 * price, never the previous resale ask. It is the `originalUnitPriceCents`
 * the ticket's OrderItem recorded at the first sale (FR-003) and carried down
 * the chain. Given as `null` (no record) it is unknown, and unknown never
 * raises the cap: the type's cap applies, it does NOT fall back to the
 * purchased price. Omitted, the purchased price is the floor, as before.
 *
 * Returns:
 *   - `null` when the ticket type has no cap. A ticket's own price never
 *     creates a cap on its own;
 *   - the type's cap when the ticket's own price is unknown (`null`,
 *     `undefined` or not a finite number: a ticket with no reachable
 *     OrderItem). Unknown never raises the cap;
 *   - otherwise the larger of the type's cap and the ticket's own price.
 *
 * A type cap that is set but not a finite number (NaN, ±Infinity; the column
 * is an integer, so this is a caller's arithmetic gone wrong) fails CLOSED:
 * the cap is the ticket's own price, or 0 when that is unknown too. The
 * organizer set a cap and its amount is unreadable, so the only ceiling left
 * to defend is the one the rule guarantees every ticket. Passing the value
 * through would fail open instead: `Math.max(NaN, x)` is NaN, and `ask > NaN`
 * is false for every ask, so nothing would ever be refused.
 */
export function effectiveResaleCapCents(input: {
  /** `TicketType.resaleCapCents`. `null`/`undefined` = the type has no cap. */
  ticketTypeResaleCapCents: number | null | undefined;
  /** The ticket's own price (see above). `null`/`undefined` = unknown. */
  ticketUnitPriceCents: number | null | undefined;
  /**
   * The organiser's price at the ticket's first sale (FR-007). When the key
   * is present it is the floor instead of `ticketUnitPriceCents`; `null` =
   * unknown (see above).
   */
  originalUnitPriceCents?: number | null;
}): number | null {
  const typeCapCents = input.ticketTypeResaleCapCents ?? null;
  if (typeCapCents == null) return null;

  const floorSourceCents =
    input.originalUnitPriceCents !== undefined
      ? input.originalUnitPriceCents
      : input.ticketUnitPriceCents;
  const ownPriceCents =
    floorSourceCents != null && Number.isFinite(floorSourceCents)
      ? floorSourceCents
      : null;

  if (!Number.isFinite(typeCapCents)) {
    return Math.max(0, ownPriceCents ?? 0);
  }
  if (ownPriceCents == null) return typeCapCents;

  return Math.max(typeCapCents, ownPriceCents);
}
