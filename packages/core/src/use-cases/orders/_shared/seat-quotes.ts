/**
 * The buyer's quoted per-seat price, travelling with a checkout request as an
 * ASSERTION (seat-price-overrides spec D-007, FR-004).
 *
 * The client may say, per picked seat, the unit price it showed the buyer.
 * The server never charges from it: it prices every seat itself
 * (`computeOrderAmounts`) and then compares. A difference refuses the order
 * with `seat_price_changed`, the same conflict `holdSeatsForCheckout` throws
 * when an override moves between the unlocked read and the lock. Together the
 * two checks bind quote = priced = locked.
 *
 *   - Absent quote (older web build, mobile, the door): no comparison, the
 *     seat is charged its locked price as before (FR-004 must not block on a
 *     client release).
 *   - A pay-what-you-want (ADJUSTABLE) line: no comparison. The buyer names
 *     that price (`donationAmountCents`), and a seat override does not apply
 *     to it (D-004).
 *   - Equality, not "at most": a quote BELOW the price refuses too, so a
 *     client can never talk a seat down, and a quote above refuses rather than
 *     charging a number the buyer did not see.
 */
import { z } from "zod";

/**
 * Ceiling of a quoted unit price: Postgres INT4, the column type every stored
 * price (TicketType.priceCents, OrderItem.unitPriceCents) has. No seat or tier
 * can be priced above it, so a larger quote can only be garbage.
 */
export const MAX_SEAT_QUOTE_CENTS = 2_147_483_647;

/**
 * Most seats one checkout item may name, for `seatIds` and `seatQuotes`
 * alike: the organiser's own bulk cap (`setSeatPriceOverrides` takes at most
 * 500 seats), the largest seat count any schema here bounds.
 */
export const MAX_SEATS_PER_CHECKOUT_ITEM = 500;

export const seatQuoteSchema = z
  .object({
    seatId: z.uuid(),
    unitPriceCents: z.number().int().min(0).max(MAX_SEAT_QUOTE_CENTS),
  })
  .strict();

/**
 * Item-level rule for `seatQuotes`: every quoted seat is one of THIS item's
 * `seatIds`, at most once. That bounds the list by the item's own seats, and
 * a quote can never name a seat the request does not buy. A subset is
 * allowed: an unquoted seat is charged its locked price (FR-004).
 */
export function refineSeatQuotes(
  item: {
    seatIds?: ReadonlyArray<string> | null;
    seatQuotes?: ReadonlyArray<{ seatId: string }>;
  },
  ctx: z.RefinementCtx,
): void {
  if (!item.seatQuotes || item.seatQuotes.length === 0) {
    return;
  }
  const itemSeatIds = new Set(item.seatIds ?? []);
  const seen = new Set<string>();
  item.seatQuotes.forEach((quote, index) => {
    if (!itemSeatIds.has(quote.seatId)) {
      ctx.addIssue({
        code: "custom",
        message: "seat_quote_not_in_item",
        path: ["seatQuotes", index, "seatId"],
      });
    }
    if (seen.has(quote.seatId)) {
      ctx.addIssue({
        code: "custom",
        message: "seat_quote_duplicate",
        path: ["seatQuotes", index, "seatId"],
      });
    }
    seen.add(quote.seatId);
  });
}

/** seatId → quoted unit price, across every item of one request. */
export type SeatQuotes = ReadonlyMap<string, number>;

/**
 * The request's quotes as one map. Safe to flatten: `refineSeatQuotes` pins
 * each quote to its own item's seats, and `aggregateItems` refuses a seat
 * named twice in one request.
 */
export function collectSeatQuotes(
  items: ReadonlyArray<{
    seatQuotes?: ReadonlyArray<{ seatId: string; unitPriceCents: number }>;
  }>,
): SeatQuotes {
  const quotes = new Map<string, number>();
  for (const item of items) {
    for (const quote of item.seatQuotes ?? []) {
      quotes.set(quote.seatId, quote.unitPriceCents);
    }
  }
  return quotes;
}

/**
 * Refuses the order with `seat_price_changed` when a quoted seat's priced
 * line differs from its quote.
 *
 * Compares against the lines `computeOrderAmounts` produced, the very numbers
 * that are charged, so the assertion cannot drift from the charge: each
 * seated line carries `meta.seatId` and its resolved `unitPriceCents` (the
 * override, or the tier's scheduled-resolved price). Call it right after the
 * first `computeOrderAmounts` and before any hold, reservation or payment, so
 * a refusal leaves nothing behind when the transaction rolls back.
 */
export function assertSeatQuotesMatch(
  orderItems: ReadonlyArray<{
    kind: string;
    ticketTypeId?: string | null;
    unitPriceCents: number;
    meta?: unknown;
  }>,
  quotes: SeatQuotes,
  ticketTypes: ReadonlyMap<string, { pricingMode: "FIXED" | "ADJUSTABLE" }>,
): void {
  if (quotes.size === 0) {
    return;
  }
  for (const item of orderItems) {
    if (item.kind !== "ticket" || !item.ticketTypeId) {
      continue;
    }
    const meta = item.meta as Record<string, unknown> | null | undefined;
    const seatId = meta?.seatId;
    if (typeof seatId !== "string") {
      continue;
    }
    const quoted = quotes.get(seatId);
    if (quoted === undefined) {
      continue;
    }
    if (ticketTypes.get(item.ticketTypeId)?.pricingMode === "ADJUSTABLE") {
      continue;
    }
    if (item.unitPriceCents !== quoted) {
      throw {
        code: "conflict",
        message: "seat_price_changed",
        seatId,
      } as const;
    }
  }
}
