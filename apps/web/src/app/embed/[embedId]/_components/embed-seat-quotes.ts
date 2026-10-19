/**
 * The embed cart's per-seat quotes (seat-price-overrides D-007, FR-004).
 *
 * The seat picker shows an override seat at its own price; the cart keeps
 * that price (`CartItem.seatQuotes`) so the summary prices the seat at it and
 * checkout sends it as `seatQuotes`. Only seats that show an override are
 * quoted, as on main checkout's hold (checkout-seat-quotes.ts): a plain
 * seat's tier price came with the page and nothing here refreshes it.
 *
 * When the server refuses `seat_price_changed`, the quotes are re-read from
 * fresh seat data (`withRefreshedSeatQuotes`), so the summary shows the new
 * price and the next attempt quotes it. The buyer's seats are kept.
 */
import { mapSeatQuotes } from "@/app/events/checkout/[...slug]/_components/checkout-seat-quotes";

import type { CartItem } from "./embed-types";

type MapSeat = {
  id: string;
  priceOverride?: { priceCents: number } | null;
};

type SeatQuote = { seatId: string; unitPriceCents: number };

/** Each picked seat the seat data shows an override for, at that override. */
export function pickedSeatQuotes(
  seats: readonly MapSeat[] | undefined,
  pickedSeatIds: readonly string[],
): SeatQuote[] {
  const overrides = mapSeatQuotes(seats);
  return pickedSeatIds.flatMap((seatId) => {
    const cents = overrides.get(seatId);
    return cents === undefined ? [] : [{ seatId, unitPriceCents: cents }];
  });
}

/**
 * The cart line a seat-picker confirmation stores: the picked seats, their
 * section, and each shown override as a quote. `null` when nothing is picked.
 *
 * A picked seat `seats` does not list keeps its quote from `previousQuotes`
 * (the line being replaced): the price the buyer was last shown for it. A
 * seat `seats` does list is quoted from `seats` alone — fresh data wins, and a
 * seat that no longer shows an override is no longer quoted.
 */
export function seatPickCartItem(
  ticketTypeId: string,
  seatSectionId: string,
  pickedSeatIds: readonly string[],
  seats: readonly MapSeat[] | undefined,
  previousQuotes: readonly SeatQuote[] = [],
): CartItem | null {
  if (pickedSeatIds.length === 0) return null;
  const listed = new Set((seats ?? []).map((seat) => seat.id));
  const fresh = new Map(
    pickedSeatQuotes(seats, pickedSeatIds).map((q) => [q.seatId, q]),
  );
  const previous = new Map(previousQuotes.map((q) => [q.seatId, q]));
  const seatQuotes = pickedSeatIds.flatMap((seatId) => {
    const quote = listed.has(seatId)
      ? fresh.get(seatId)
      : previous.get(seatId);
    return quote ? [quote] : [];
  });
  return {
    ticketTypeId,
    qty: pickedSeatIds.length,
    seatIds: [...pickedSeatIds],
    seatSectionId,
    ...(seatQuotes.length > 0 ? { seatQuotes } : {}),
  };
}

/** The sections whose seat data a refresh needs, once each. */
export function seatSectionsInCart(cart: readonly CartItem[]): string[] {
  return [
    ...new Set(
      cart.flatMap((item) =>
        item.seatIds?.length && item.seatSectionId ? [item.seatSectionId] : [],
      ),
    ),
  ];
}

/**
 * The cart with every seated line's quotes re-read from `seatsBySection`
 * (fresh seat data after a `seat_price_changed` refusal): a seat that now
 * shows an override is quoted at it, one that no longer does is unquoted.
 * A line whose section is missing from the map (its refetch failed) is left
 * as it was: the next attempt is refused again rather than charged at a price
 * the buyer was not shown, and re-opening the seat picker re-reads it.
 */
export function withRefreshedSeatQuotes(
  cart: readonly CartItem[],
  seatsBySection: ReadonlyMap<string, readonly MapSeat[]>,
): CartItem[] {
  return cart.map((item) => {
    if (!item.seatIds?.length || !item.seatSectionId) return item;
    const seats = seatsBySection.get(item.seatSectionId);
    if (!seats) return item;
    const { seatQuotes: _stale, ...rest } = item;
    const seatQuotes = pickedSeatQuotes(seats, item.seatIds);
    return seatQuotes.length > 0 ? { ...rest, seatQuotes } : rest;
  });
}
