import type { OrderEstimateCartItem } from "@/lib/pricing/order-estimate";
import {
  shownCartLines,
  shownLineCentsByTicketType,
  withSeatQuotes,
  type ShownCartLine,
} from "@/app/events/checkout/[...slug]/_components/checkout-seat-quotes";
import {
  defaultChosenAmountCents,
  isChosenAmountValid,
  isPayWhatYouWant,
  type PayWhatYouWantTier,
} from "@/lib/pricing/pay-what-you-want";

import type { CartItem } from "./embed-types";

type EmbedTier = PayWhatYouWantTier & {
  id: string;
  priceCents: number;
  buyerUnitTotalCents?: number | null;
};

/** The amount a PWYW cart line is priced at: the buyer's, else the default. */
const chosenAmountFor = (tier: EmbedTier, item: CartItem | undefined) =>
  item?.donationAmountCents ?? defaultChosenAmountCents(tier);

/** The seats the cart quotes, in the seat map's shape: each at its quote. */
const quotedCartSeats = (cart: readonly CartItem[]) =>
  cart.flatMap((item) =>
    (item.seatQuotes ?? []).map((quote) => ({
      id: quote.seatId,
      priceOverride: { priceCents: quote.unitPriceCents },
    })),
  );

/**
 * The cart at the prices the buyer was shown, line by line, in cart order —
 * main checkout's `shownCartLines` rule (seat-price-overrides FR-003):
 *   - pay-what-you-want: one line at the buyer's amount (an override never
 *     applies there, spec D-004);
 *   - fixed price: each picked seat the seat picker showed an override for
 *     (`seatQuotes`), at that override, and the rest at the tier price.
 * Unknown ticket types contribute nothing.
 */
export function embedShownLines(
  cart: readonly CartItem[],
  ticketTypes: readonly EmbedTier[],
): ShownCartLine[] {
  const byId = new Map(ticketTypes.map((tt) => [tt.id, tt]));
  const seats = quotedCartSeats(cart);
  return cart.flatMap((item) => {
    const tt = byId.get(item.ticketTypeId);
    if (!tt) return [];
    return shownCartLines(
      [tt],
      { [tt.id]: item.qty },
      { [tt.id]: item.seatIds ?? [] },
      seats,
      (tier) => chosenAmountFor(tier, item),
    );
  });
}

/**
 * Face × qty per ticket type at the shown prices (`embedShownLines`): what
 * each summary line prints, so the lines add up to the estimate's subtotal
 * and an override seat reads at its own price.
 */
export function embedShownLineCents(
  cart: readonly CartItem[],
  ticketTypes: readonly EmbedTier[],
): Record<string, number> {
  return shownLineCentsByTicketType(embedShownLines(cart, ticketTypes));
}

/**
 * The embed cart as `estimateCartTotal` items (`embedShownLines`). A
 * pay-what-you-want line, or an override seat, carries its amount as
 * `chosenAmountCents`, so it is priced like a fixed ticket of that amount
 * (fees and tax on top) — the owner's rule, and the way `computeOrderAmounts`
 * charges it.
 *
 * Without it the estimator compared the PWYW row (now priced at the tier's
 * floor) against the tier's stored $0 `priceCents`, its stale-price guard
 * fired, and any cart holding a PWYW line read "Calculating total…" forever.
 */
export function embedEstimateItems(
  cart: readonly CartItem[],
  ticketTypes: readonly EmbedTier[],
): OrderEstimateCartItem[] {
  return embedShownLines(cart, ticketTypes);
}

/**
 * Ticket types for the embed's LINE displays (the mobile tray and the order
 * sidebar). A PWYW line shows the buyer's amount: its face becomes that
 * amount and its "all-in" unit is the same amount (fees and tax appear in the
 * estimated total, as on the main checkout). Without this the line quoted the
 * tier FLOOR's all-in, which is not what this buyer chose.
 */
export function withEmbedChosenLinePrices<T extends EmbedTier>(
  ticketTypes: readonly T[],
  cart: readonly CartItem[],
): T[] {
  const itemById = new Map(cart.map((item) => [item.ticketTypeId, item]));
  return ticketTypes.map((tt) => {
    if (!isPayWhatYouWant(tt)) return tt;
    const cents = chosenAmountFor(tt, itemById.get(tt.id));
    return { ...tt, priceCents: cents, buyerUnitTotalCents: cents };
  });
}

/**
 * The cart as the guest checkout's `items`: a pay-what-you-want line carries
 * the buyer's amount as `donationAmountCents` (the server prices the ticket
 * at it, fees and tax on top — the shared schema caps it at $10,000); a
 * fixed-price line never carries one. Lines with no quantity are dropped.
 *
 * A fixed-price line's picked seats that showed an override carry it as
 * `seatQuotes` (spec D-007): the server refuses `seat_price_changed` rather
 * than charge a different number. Plain seats and pay-what-you-want lines are
 * never quoted (see checkout-seat-quotes.ts for why).
 */
export function embedCheckoutItems(
  cart: readonly CartItem[],
  ticketTypes: readonly EmbedTier[],
): Array<{
  ticketTypeId: string;
  qty: number;
  seatIds?: string[];
  donationAmountCents?: number;
  seatQuotes?: Array<{ seatId: string; unitPriceCents: number }>;
}> {
  const byId = new Map(ticketTypes.map((tt) => [tt.id, tt]));
  const quotes = new Map(
    cart.flatMap((item) =>
      (item.seatQuotes ?? []).map(
        (quote) => [quote.seatId, quote.unitPriceCents] as const,
      ),
    ),
  );
  const items = cart
    .filter((item) => item.qty > 0)
    .map((item) => {
      const tt = byId.get(item.ticketTypeId);
      return {
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
        ...(item.seatIds && item.seatIds.length > 0
          ? { seatIds: item.seatIds }
          : {}),
        ...(tt && isPayWhatYouWant(tt)
          ? { donationAmountCents: chosenAmountFor(tt, item) }
          : {}),
      };
    })
    // One fixed order, whatever order the cart lists its lines in. The
    // server's idempotency hash reads the lines in the order they arrive,
    // while the widget keeps its checkout key for any cart `isSameEmbedCart`
    // calls the same purchase (line order aside). Sent as the cart listed
    // them, a retry of the same purchase under the kept key could be refused
    // as a conflict instead of replaying its order.
    .sort(
      (a, b) =>
        compareText(a.ticketTypeId, b.ticketTypeId) ||
        compareText(seatsKey(a.seatIds), seatsKey(b.seatIds)),
    );
  return withSeatQuotes(items, ticketTypes, quotes);
}

/** Code-unit order: the same on every browser and locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function seatsKey(seatIds: readonly string[] | undefined): string {
  return [...(seatIds ?? [])].sort().join(",");
}

/** A selected pay-what-you-want line whose amount the server would refuse. */
export function embedInvalidDonationTier<T extends EmbedTier>(
  cart: readonly CartItem[],
  ticketTypes: readonly T[],
): T | null {
  const byId = new Map(ticketTypes.map((tt) => [tt.id, tt]));
  for (const item of cart) {
    if (item.qty <= 0) continue;
    const tt = byId.get(item.ticketTypeId);
    if (tt && isPayWhatYouWant(tt) && !isChosenAmountValid(tt, chosenAmountFor(tt, item))) {
      return tt;
    }
  }
  return null;
}
