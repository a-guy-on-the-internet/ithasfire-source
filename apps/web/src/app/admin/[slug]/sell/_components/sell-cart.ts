/**
 * The till's cart, as pure data.
 *
 * What the operator has rung up lives here rather than in a component, for
 * one reason: the unit tests in this repo mock the design system away, so
 * anything expressed as JSX is effectively untested.
 *
 * This module does NOT total the cart. The total a buyer pays at the door is
 * online checkout's (ticket, platform fee, processing fee on a card, tax), so
 * it comes from `pos.quoteCart` and nowhere else; a client `unit × qty` total
 * here showed a card buyer a number the reader would then not ask for. What is
 * left is the cart itself: quantities, pay-what-you-can amounts, and the wire
 * shape the quote and the sale both take.
 */

import { amountSliderMaxCents } from "@/lib/pricing/pay-what-you-want";

/**
 * The subset of a `pos.listSellableItems` row this module needs.
 *
 * `sellability` mirrors `ticketTypeSellabilitySchema` in core, and its boolean
 * is named `available` — NOT `onSale`. That distinction cost a full render of
 * this screen: an earlier version of this type called it `onSale`, so
 * `item.sellability.onSale` was `undefined` on every row, every tier read as
 * unsellable, and every stepper was disabled. The till could not sell
 * anything. `tsc` never saw it because the query result was being cast to this
 * type with `as`, which is precisely what a cast buys you.
 *
 * So: no `as` at the call site, and this shape is structural, which means a
 * rename in core's schema now fails the assignment instead of silently
 * producing `undefined`.
 */
export type SellableItem = {
  ticketTypeId: string;
  name: string;
  unitPriceCents: number;
  pricingMode: "FIXED" | "ADJUSTABLE";
  minimumCents: number | null;
  suggestedCents: number | null;
  capacityRemaining: number;
  sellability: {
    available: boolean;
    reason: string;
    opensAt: Date | null;
    closedAt: Date | null;
  };
};

/** One ticket type's presence in the cart. */
export type CartLine = {
  qty: number;
  /**
   * Per-ticket amount for an ADJUSTABLE tier, in cents. Undefined for FIXED
   * lines and never sent for them — a stray value on a fixed tier would be a
   * client trying to name its own price, which the server ignores.
   */
  donationAmountCents?: number;
};

/** ticketTypeId → line. Absent key means "not in the cart". */
export type Cart = Record<string, CartLine>;

export type CartEntry = {
  item: SellableItem;
  line: CartLine;
  /** Per-ticket face price this line is sold at (before fees and tax). */
  unitPriceCents: number;
};

/**
 * The default pay-what-you-can amount for a tier: the organiser's suggestion
 * when there is one, otherwise the floor.
 *
 * Never 0-unless-the-floor-is-0. A tier with a $5 floor that prefilled to $0
 * would put the operator one tap away from a sale the server refuses, at a
 * door, with someone waiting.
 */
export function defaultAdjustableAmountCents(item: SellableItem): number {
  const floor = item.minimumCents ?? 0;
  const suggested = item.suggestedCents;
  if (suggested == null) return floor;
  return Math.max(suggested, floor);
}

/**
 * Per-ticket price for a line. ADJUSTABLE tiers are buyer-priced; everything
 * else takes the price the server resolved into `unitPriceCents` (the same
 * price the event page shows).
 *
 * Mirrors `resolvePosUnitPriceCents` in core, and is also the amount sent as
 * `donationAmountCents` for an ADJUSTABLE line. When the two disagree the
 * server's quote is the real one.
 */
export function lineUnitPriceCents(
  item: SellableItem,
  line: CartLine,
): number {
  if (item.pricingMode !== "ADJUSTABLE") return item.unitPriceCents;
  return line.donationAmountCents ?? defaultAdjustableAmountCents(item);
}

/** Cart entries in catalogue order, skipping ticket types with qty 0. */
export function cartEntries(cart: Cart, items: SellableItem[]): CartEntry[] {
  const entries: CartEntry[] = [];
  for (const item of items) {
    const line = cart[item.ticketTypeId];
    if (!line || line.qty <= 0) continue;
    const unitPriceCents = lineUnitPriceCents(item, line);
    entries.push({ item, line, unitPriceCents });
  }
  return entries;
}

/** How many tickets the cart would mint. */
export function cartTicketCount(cart: Cart, items: SellableItem[]): number {
  return cartEntries(cart, items).reduce((sum, entry) => sum + entry.line.qty, 0);
}

/** True when there is nothing to charge for. */
export function isCartEmpty(cart: Cart, items: SellableItem[]): boolean {
  return cartEntries(cart, items).length === 0;
}

/**
 * Can this ticket type be added to the cart at all?
 *
 * WINDOWED tiers stay VISIBLE and become unbuyable, deliberately:
 * `listSellableItems` lists them rather than filtering them, because "VIP
 * opens at 8pm" is information, and a missing row is how a door team concludes
 * the tier was never configured.
 *
 * SOLD-OUT tiers are a different story — `listSellableItems` filters
 * `capacityRemaining > 0` server-side, so they never reach this function. The
 * capacity arm below is defence in depth against a stale cached catalogue, not
 * a case that renders today. Said out loud so nobody hunts for the "Sold out"
 * row it implies.
 */
export function isItemSellable(item: SellableItem): boolean {
  return item.sellability.available && item.capacityRemaining > 0;
}

/** The cart with `ticketTypeId` moved by `delta`, clamped to [0, capacity]. */
export function stepQuantity(
  cart: Cart,
  item: SellableItem,
  delta: number,
): Cart {
  const existing = cart[item.ticketTypeId];
  const current = existing?.qty ?? 0;
  const next = Math.max(
    0,
    Math.min(current + delta, Math.max(0, item.capacityRemaining)),
  );

  if (next === 0) {
    // Drop the key entirely rather than keeping a qty-0 line. A lingering
    // line would carry its pay-what-you-can amount back into the next sale
    // for the same tier — the operator would see a price they never set.
    const { [item.ticketTypeId]: _removed, ...rest } = cart;
    return rest;
  }

  return {
    ...cart,
    [item.ticketTypeId]: {
      qty: next,
      // First time an ADJUSTABLE tier enters the cart, seed its amount so the
      // operator is adjusting a real number rather than starting from zero.
      donationAmountCents:
        item.pricingMode === "ADJUSTABLE"
          ? (existing?.donationAmountCents ?? defaultAdjustableAmountCents(item))
          : undefined,
    },
  };
}

/**
 * The cart with a pay-what-you-can amount set for one tier.
 *
 * Clamped UP to the floor but deliberately NOT clamped down at the top: the
 * slider's ceiling is a convenience, not a limit, and someone typing $200 into
 * a $5-floor tier means it.
 */
export function setAdjustableAmount(
  cart: Cart,
  item: SellableItem,
  amountCents: number,
): Cart {
  const existing = cart[item.ticketTypeId];
  if (!existing) return cart;
  const floor = item.minimumCents ?? 0;
  return {
    ...cart,
    [item.ticketTypeId]: {
      ...existing,
      donationAmountCents: Math.max(floor, Math.round(amountCents)),
    },
  };
}

/** Wire shape for `pos.quoteCart`, `pos.startSale` and `pos.recordCashSale`. */
export type SaleItemInput = {
  ticketTypeId: string;
  qty: number;
  donationAmountCents?: number;
};

/**
 * The cart as the sell procedures want it.
 *
 * `donationAmountCents` is emitted ONLY for ADJUSTABLE tiers. Sending it on a
 * FIXED line is harmless server-side (it is ignored) but it would be a lie
 * about intent in the request log, and the next person to read it would
 * reasonably assume fixed tiers were client-priced.
 */
export function toSaleItems(
  cart: Cart,
  items: SellableItem[],
): SaleItemInput[] {
  return cartEntries(cart, items).map(({ item, line, unitPriceCents }) =>
    item.pricingMode === "ADJUSTABLE"
      ? {
          ticketTypeId: item.ticketTypeId,
          qty: line.qty,
          donationAmountCents: unitPriceCents,
        }
      : { ticketTypeId: item.ticketTypeId, qty: line.qty },
  );
}

/**
 * Slider ceiling for a pay-what-you-can tier.
 *
 * Four times the standard (or 20× the floor when there is no standard), so
 * the suggested amount sits about a quarter of the way along and there is
 * obvious room above it. Floored at $50 so a $2 tier still gets a draggable
 * range rather than a one-pixel track.
 */
export function adjustableSliderMaxCents(item: SellableItem): number {
  // One rule for the box office and the buyer's checkout slider.
  return amountSliderMaxCents(item);
}

/**
 * Parse a typed dollar amount into cents, or null when it isn't a number.
 *
 * Returns null (rather than 0) for empty or junk input so the caller can leave
 * the previous amount alone while someone is mid-edit, instead of snapping the
 * price to zero between keystrokes.
 */
export function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Cents as a bare editable dollar string — "2000" → "20", "1750" → "17.50". */
export function centsToEditableDollars(cents: number): string {
  if (cents % 100 === 0) return String(cents / 100);
  return (cents / 100).toFixed(2);
}

/**
 * A stable-per-attempt idempotency key for one sale.
 *
 * Both sell procedures key on `pos:{actorHumanId}:{clientKey}` with a 2-minute
 * window and a payload-hash collision check, so this must be stable across
 * retries of the SAME sale (a double-tapped Charge button, a dropped response
 * the operator retries) and different for the next one. Generated once when a
 * sale is committed to and thrown away on reset.
 */
export function newSaleClientKey(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) return `sell-${globalCrypto.randomUUID()}`;
  // `randomUUID` needs a secure context. A door tablet on plain http over
  // venue wifi is exactly the case that loses it, and a till that throws
  // instead of selling is worse than a weaker key — this one is still
  // per-operator scoped and only needs to be unique within two minutes.
  return `sell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
