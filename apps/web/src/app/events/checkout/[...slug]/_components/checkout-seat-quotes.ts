/**
 * The buyer's quoted per-seat price, attached to checkout items as
 * `seatQuotes` (seat-price-overrides spec D-007, FR-004).
 *
 * The server never charges from a quote. It prices each seat itself and
 * refuses the order with `seat_price_changed` when its price differs from the
 * quote, so a seat's price cannot change between what the buyer saw and what
 * is charged without the buyer seeing it first.
 *
 * Two sources, by step:
 *   - THE HOLD quotes what the seat map shows: `mapSeatQuotes`, override seats
 *     only. The map refetches after a seat refusal, so an override number
 *     stays fresh; a plain seat's tier price came with the page and nothing
 *     refreshes it, so quoting it would refuse every retry after a tier edit
 *     until a reload. Unquoted seats are charged their locked price (FR-004),
 *     and the hold's answer is what the next step shows.
 *   - PAY quotes what the held summary shows: `heldSeatQuotes`, every held
 *     seat line, the server's own numbers. A refusal there re-holds (see
 *     useCheckoutState), which re-prices from scratch, so it cannot lock out.
 *
 * Pay-what-you-want seats are never quoted: the buyer names that price, and
 * the server ignores quotes there.
 */
import { isPayWhatYouWant } from "@/lib/pricing/pay-what-you-want";

export type SeatQuote = { seatId: string; unitPriceCents: number };

/** seatId → quoted unit price. */
export type SeatQuoteMap = ReadonlyMap<string, number>;

type QuotableTicketType = {
  id: string;
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
  minimumCents?: number | null;
  suggestedCents?: number | null;
};

type MapSeat = {
  id: string;
  priceOverride?: { priceCents: number } | null;
};

type HeldLine = {
  kind: string;
  ticketTypeId: string | null;
  unitPriceCents: number;
  meta?: unknown;
};

const isQuotableCents = (cents: number) =>
  Number.isSafeInteger(cents) && cents >= 0;

const fixedPriceIds = (ticketTypes: readonly QuotableTicketType[]) =>
  new Set(
    ticketTypes.filter((tt) => !isPayWhatYouWant(tt)).map((tt) => tt.id),
  );

/** The hold's quotes: each map seat that shows an override, at that override. */
export function mapSeatQuotes(
  seats: readonly MapSeat[] | undefined,
): SeatQuoteMap {
  const quotes = new Map<string, number>();
  for (const seat of seats ?? []) {
    const cents = seat.priceOverride?.priceCents;
    if (cents !== undefined && isQuotableCents(cents)) {
      quotes.set(seat.id, cents);
    }
  }
  return quotes;
}

/**
 * Pay's quotes: each held ticket line priced for one seat (`meta.seatId`, or
 * a one-seat `meta.seatIds`), at the line's `unitPriceCents`, which is what
 * the held summary renders. A line covering several seats says nothing about
 * any one of them, so it is not quoted.
 */
export function heldSeatQuotes(
  lines: readonly HeldLine[] | undefined,
): SeatQuoteMap {
  const quotes = new Map<string, number>();
  for (const line of lines ?? []) {
    if (line.kind !== "ticket" || !isQuotableCents(line.unitPriceCents)) {
      continue;
    }
    const meta = (line.meta ?? {}) as { seatId?: unknown; seatIds?: unknown };
    const seatId =
      typeof meta.seatId === "string"
        ? meta.seatId
        : Array.isArray(meta.seatIds) &&
            meta.seatIds.length === 1 &&
            typeof meta.seatIds[0] === "string"
          ? meta.seatIds[0]
          : null;
    if (seatId) quotes.set(seatId, line.unitPriceCents);
  }
  return quotes;
}

/**
 * The items with `seatQuotes` for their picked seats that `quotes` names.
 * Pay-what-you-want items and unseated items go out unchanged.
 */
export function withSeatQuotes<
  T extends { ticketTypeId: string; seatIds?: string[] },
>(
  items: readonly T[],
  ticketTypes: readonly QuotableTicketType[],
  quotes: SeatQuoteMap,
): Array<T & { seatQuotes?: SeatQuote[] }> {
  if (quotes.size === 0) return [...items];
  const fixed = fixedPriceIds(ticketTypes);
  return items.map((item) => {
    if (!fixed.has(item.ticketTypeId) || !item.seatIds?.length) return item;
    const seatQuotes: SeatQuote[] = [];
    for (const seatId of item.seatIds) {
      const cents = quotes.get(seatId);
      if (cents !== undefined) seatQuotes.push({ seatId, unitPriceCents: cents });
    }
    return seatQuotes.length > 0 ? { ...item, seatQuotes } : item;
  });
}

/**
 * One line of the cart as step 1 prices it, in `estimateCartTotal`'s shape.
 * `chosenAmountCents`, when set, IS the face: the buyer's amount on a
 * pay-what-you-want tier, or a picked seat's override, priced (platform fee,
 * processing, tax) exactly as a fixed ticket of that amount, which is how the
 * charge prices an override seat (per distinct unit price).
 */
export type ShownCartLine = {
  ticketTypeId: string;
  qty: number;
  priceCents: number;
  chosenAmountCents: number | null;
};

/**
 * The cart at the prices the buyer is shown before the hold, so the step-1
 * subtotal, lines and estimated total quote the same number the hold
 * answers (seat-price-overrides FR-003). Per tier with a quantity:
 *   - pay-what-you-want: one line at the buyer's amount (overrides never
 *     apply there, spec D-004);
 *   - fixed price: each picked seat the map shows an override for, at that
 *     override (seats sharing one are one line), and the rest of the quantity
 *     at the tier price.
 * A seat the map has not loaded, or shows no usable override for, is priced
 * at the tier, as the hold charges an unquoted plain seat.
 */
export function shownCartLines<
  T extends QuotableTicketType & { priceCents: number },
>(
  ticketTypes: readonly T[],
  quantities: Readonly<Record<string, number>>,
  selectedSeatIds: Readonly<Record<string, readonly string[]>>,
  seats: readonly MapSeat[] | undefined,
  chosenAmountFor: (ticketType: T) => number,
): ShownCartLine[] {
  const overrides = mapSeatQuotes(seats);
  const lines: ShownCartLine[] = [];
  for (const tt of ticketTypes) {
    const qty = quantities[tt.id] ?? 0;
    if (qty <= 0) continue;
    if (isPayWhatYouWant(tt)) {
      lines.push({
        ticketTypeId: tt.id,
        qty,
        priceCents: tt.priceCents,
        chosenAmountCents: chosenAmountFor(tt),
      });
      continue;
    }
    const qtyByOverride = new Map<number, number>();
    for (const seatId of (selectedSeatIds[tt.id] ?? []).slice(0, qty)) {
      const cents = overrides.get(seatId);
      if (cents !== undefined) {
        qtyByOverride.set(cents, (qtyByOverride.get(cents) ?? 0) + 1);
      }
    }
    let atTierPrice = qty;
    for (const n of qtyByOverride.values()) atTierPrice -= n;
    if (atTierPrice > 0) {
      lines.push({
        ticketTypeId: tt.id,
        qty: atTierPrice,
        priceCents: tt.priceCents,
        chosenAmountCents: null,
      });
    }
    for (const [cents, n] of qtyByOverride) {
      lines.push({
        ticketTypeId: tt.id,
        qty: n,
        priceCents: cents,
        chosenAmountCents: cents,
      });
    }
  }
  return lines;
}

/** Σ face × qty of `shownCartLines`, per ticket type: each step-1 line's amount. */
export function shownLineCentsByTicketType(
  lines: readonly ShownCartLine[],
): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const line of lines) {
    byType[line.ticketTypeId] =
      (byType[line.ticketTypeId] ?? 0) +
      (line.chosenAmountCents ?? line.priceCents) * line.qty;
  }
  return byType;
}
