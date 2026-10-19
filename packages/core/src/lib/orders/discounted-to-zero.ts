import { allocateProportionalCents } from "./allocate-proportional-cents";

/**
 * Which tickets a promo code or a membership benefit brings down to $0.
 *
 * Owner ruling, 2026-10-10: "yes a promo brought down to $0 should have no fee
 * too." It extends the same day's "If $0 is the cost of the tickets there
 * shouldn't be any fee" from a ticket whose PRICE is $0 to a ticket a discount
 * makes $0: that ticket pays no platform fee, and so adds nothing to the
 * processing fee or to a buyer-total tax base, in a paid cart too.
 *
 * ## Why this needs a definition
 *
 * A discount is not stored against a ticket. `evaluatePromoApplications` works
 * out one number per applied code or benefit and the order carries it as one
 * negative `discount` line; nothing says which tickets it came off. "Brought
 * down to $0" therefore has to be defined, and this module is the one
 * definition:
 *
 *   1. Each applied discount is spread over the tickets it applies to: the
 *      tickets of its ticket type when it is scoped to one (`TICKET_TYPE`),
 *      every ticket on the order otherwise (GLOBAL / ORG / HUMAN / EVENT
 *      scopes, and every membership benefit).
 *   2. The spread is IN PROPORTION TO PRICE (to what is left of each ticket's
 *      price after the discounts before it), with the largest-remainder
 *      rounding every other money split here uses
 *      (`allocateProportionalCents`), so the shares sum to the discount to the
 *      cent. Refunds follow this for the tickets it brings to $0, and only
 *      for those. Owner ruling, 2026-10-11: "yeah it should refund 0 because
 *      that's what it cost. Otherwise we will get taken advantage of". A
 *      ticket marked `meta.discountedToZero` weighs 0 in every refund split
 *      (`refund-weight.ts`), so refunding it returns $0 and the paid tickets
 *      beside it carry the whole charge. A ticket discounted to an amount
 *      above $0 is not covered by that ruling: a refund still weighs it by
 *      its pre-discount buyer total, with no regard to which ticket type a
 *      code was scoped to.
 *   3. A ticket is brought down to $0 when its price is above $0 and the
 *      discounts spread onto it add up to that price: the buyer pays $0 for
 *      it.
 *
 * What follows from that, in plain terms:
 *
 *  - 100% off a ticket type zeroes every ticket of that type, and nothing
 *    else.
 *  - A fixed amount off a ticket type zeroes that type's tickets only when the
 *    amount covers all of them ($30 off one $30 ticket: yes; $30 off two $30
 *    tickets: $15 off each, no).
 *  - A discount on the whole order zeroes a ticket only when it zeroes the
 *    order (which is the free path, and was already fee-free), to within the
 *    rounding of a cent (below). $30 off a cart of a $30 and a $50 ticket
 *    takes $11.25 and $18.75 off them; neither is $0.
 *  - A ticket discounted to any amount above $0 keeps its full platform fee,
 *    computed on its list price as before. The ruling is about $0 only.
 *
 * Two edges, stated so they are not a surprise.
 *
 * ROUNDING. Shares are whole cents, so a ticket is brought to $0 whenever its
 * proportional share ROUNDS to its whole price, which is before the discount
 * covers every cent of its tickets. A $99.99 code on two $50.00 tickets
 * leaves one cent, on one ticket; the other is $0 and pays no fee. It is not
 * only the last cent: $99.60 off a cart of a $1.00 and a $99.00 ticket takes
 * $1.00 and $98.60, so the $1.00 ticket is $0 with 40¢ still to pay on the
 * other (its exact share was 99.6¢, and the cent the flooring left over went
 * to the largest remainder, which was its own). The discount is unchanged to
 * the cent either way; what moves is which ticket carries the last cents.
 * Ties between equal remainders go to the earlier ticket, so the answer
 * depends on the tickets' ORDER: every caller passes them in the order the
 * charge builds its order items (`computeOrderAmounts`), the promo preview
 * included.
 *
 * ORDER OF ENTRY. Discounts are spread one after another, each over what the
 * ones before it left, in the order the evaluation applied them: promo codes
 * as the buyer entered them, then the membership benefit. With stackable
 * codes of different scopes that order can decide whether a ticket reaches
 * $0. A $30 and a $50 (VIP) ticket with $10 off the order and $45 off VIP:
 * the order code first leaves $43.75 on VIP, which the VIP code then clears
 * (VIP is $0, no fee); the VIP code first leaves $5.00 on VIP, of which the
 * order code takes $1.43 (VIP is $3.57 and keeps its fee). The buyer's
 * discount is $55.00 both ways; the platform fee differs by VIP's. This is
 * the same order the discount amounts themselves are computed in, so the fee
 * follows the discounts the buyer was actually given rather than a second
 * ordering of its own.
 *
 * The spill in step 1 exists because the evaluation clamps a discount to the
 * ORDER's remaining subtotal, not to its own tickets': two stackable codes on
 * one ticket type can discount more than that type costs. The part that does
 * not fit on its own tickets is spread over the rest of the order, so the
 * shares always sum to the discount.
 */

/**
 * One applied discount, as far as spreading it over tickets goes. Built from
 * a promo evaluation by `ticketDiscountsOf` (orders/checkout-promos.ts), in
 * application order.
 */
export type TicketDiscount = {
  /** The discount this application took off the order, positive cents. */
  discountCents: number;
  /** The ticket type it is scoped to; `null` when it applies to the whole order. */
  ticketTypeId: string | null;
};

type TicketLike = {
  ticketTypeId?: string | null;
  unitPriceCents: number;
};

const indexId = (index: number) => String(index).padStart(8, "0");

/** Spreads `cents` over the tickets at `indexes` in proportion to what is left on each. */
function spread(
  remaining: number[],
  indexes: number[],
  cents: number,
): number {
  const open = indexes.filter((index) => remaining[index]! > 0);
  const pool = open.reduce((sum, index) => sum + remaining[index]!, 0);
  const take = Math.min(cents, pool);
  if (take <= 0) {
    return 0;
  }
  if (take === pool) {
    // Covers everything these tickets have left: each is $0, with no
    // arithmetic for a rounding rule to get between.
    for (const index of open) {
      remaining[index] = 0;
    }
    return take;
  }
  const shares = allocateProportionalCents(
    open.map((index) => ({ id: indexId(index), index })),
    take,
    (entry) => remaining[entry.index]!,
  );
  for (const index of open) {
    // A proportional share never exceeds what is left (see the module doc);
    // the clamp keeps that true whatever the rounding does.
    remaining[index] = Math.max(
      0,
      remaining[index]! - (shares.get(indexId(index)) ?? 0),
    );
  }
  return take;
}

/**
 * The cents of discount spread onto each ticket, in the tickets' own order.
 * `Σ result === min(Σ discounts, Σ prices)`, and no ticket gets more than its
 * price.
 */
export function allocateDiscountsToTickets(
  tickets: ReadonlyArray<TicketLike>,
  discounts: ReadonlyArray<TicketDiscount>,
): number[] {
  const prices = tickets.map((ticket) =>
    Math.max(0, Math.trunc(ticket.unitPriceCents)),
  );
  const remaining = [...prices];
  const all = tickets.map((_, index) => index);

  for (const discount of discounts) {
    const cents = Math.max(0, Math.trunc(discount.discountCents));
    if (cents === 0) {
      continue;
    }
    const scoped =
      discount.ticketTypeId === null
        ? all
        : all.filter(
            (index) => tickets[index]!.ticketTypeId === discount.ticketTypeId,
          );
    const taken = spread(remaining, scoped, cents);
    if (taken < cents) {
      // More than its own tickets had left: the rest comes off the order.
      spread(remaining, all, cents - taken);
    }
  }

  return prices.map((price, index) => price - remaining[index]!);
}

/**
 * For each ticket, whether the discounts bring it down to $0. A ticket whose
 * price is already $0 is `false`: nothing brought it down, and it carries no
 * fee on its own account (`computePlatformFeePerTicketCents`).
 */
export function ticketsDiscountedToZero(
  tickets: ReadonlyArray<TicketLike>,
  discounts: ReadonlyArray<TicketDiscount>,
): boolean[] {
  if (discounts.length === 0) {
    return tickets.map(() => false);
  }
  const allocated = allocateDiscountsToTickets(tickets, discounts);
  return tickets.map(
    (ticket, index) =>
      ticket.unitPriceCents > 0 && allocated[index]! >= ticket.unitPriceCents,
  );
}
