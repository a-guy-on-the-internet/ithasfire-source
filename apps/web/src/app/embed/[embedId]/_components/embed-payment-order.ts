import type { CartItem } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// The order behind the embed's payment step
//
// `createGuestCheckout` prices ONE cart into an order and a PaymentIntent. The
// payment form charges that PaymentIntent, so the widget opens the payment
// step only while the cart is the one the order was priced from. Any other
// cart is a different purchase: the widget discards the order and rotates the
// checkout key rather than print the new cart's figures over the old order's
// payment form.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether two carts are the same purchase: the same ticket types, quantities,
 * picked seats and pay-what-you-want amounts. Lines and seats listed in a
 * different order are the same purchase (the seat picker rebuilds its line on
 * every confirm), and a line at quantity zero is no line at all.
 * `embedCheckoutItems` sends the lines in one fixed order and drops the empty
 * ones for the same reason: the server's idempotency hash reads the lines in
 * the order they arrive, so two carts this function calls the same must hash
 * the same, or a retry under the kept key is refused as a conflict.
 *
 * Seat quotes and the section a seat was picked from are left out on purpose.
 * They do not change WHAT is bought, and once an order exists every figure on
 * screen comes from the server, so a re-quote is no reason to discard it.
 *
 * The server's idempotency hash is narrower than this (it does not cover seat
 * ids), which is why the widget rotates its key on this comparison and never
 * relies on the server refusing a changed cart.
 */
export function isSameEmbedCart(
  a: readonly CartItem[],
  b: readonly CartItem[],
): boolean {
  return cartKey(a) === cartKey(b);
}

function cartKey(cart: readonly CartItem[]): string {
  return JSON.stringify(
    cart
      .filter((item) => item.qty > 0)
      .map(lineKey)
      .sort(),
  );
}

function lineKey(item: CartItem): string {
  return JSON.stringify([
    item.ticketTypeId,
    item.qty,
    [...(item.seatIds ?? [])].sort(),
    item.donationAmountCents ?? null,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// An order the buyer has left
//
// The widget asks the server to release an order it leaves behind
// (`embeds.releaseGuestOrder`, see release-embed-order.ts), and its tickets
// go back on sale at once. What follows is for the order that could NOT be
// released: the call failed or was never answered, the server kept the
// order, or the widget did not ask because a payment on it may have gone
// through. That order stays PENDING on the server, and its tickets stay
// reserved, until the server's own clean-up reaches it. That is NOT when the
// order's 15-minute countdown (`holdExpiresAt`, the time the buyer has to
// pay) runs out. It is later:
//
//  - Picked seats stay HELD until the cart reaper cancels the order: it is
//    eligible 20 minutes after it was created (`DEFAULT_CART_TTL_SECONDS`)
//    and cancelled on the reaper's next pass, every 30 minutes
//    (`CART_REAPER_PERIOD_SECONDS`). The seat-hold reaper leaves the seats
//    of an open order alone, and checkout takes only AVAILABLE seats.
//  - Unseated tickets count against capacity for 80 minutes from creation
//    (`CAPACITY_HELD_WINDOW_SECONDS`: 20 + 2 × 30).
//
// So for up to 80 minutes after such an order was created, its tickets can
// show as unavailable to the very buyer who reserved them. Usually it is
// over by 50 minutes: the 20 the order must be old, plus one reaper period
// for the pass that reaches it. The widget says both, as clock times (a time
// on the clock stays right however long the notice is on screen; "up to 80
// minutes" reads as 80 minutes from now), while they can be true, and stops
// afterwards. embed-reserved-window.test.ts holds these numbers to the
// server's constants.
// ─────────────────────────────────────────────────────────────────────────────

/** How long from its creation an order left behind can keep its tickets. */
export const LEFT_ORDER_RESERVED_MINUTES = 80;
/** How long from its creation it usually has: one clean-up pass on time. */
export const LEFT_ORDER_USUALLY_RESERVED_MINUTES = 50;
/** The order's time to pay (`holdExpiresAt` is its creation plus this). */
const TIME_TO_PAY_MINUTES = 15;

/**
 * When an order left behind will have let go of its tickets, from the end of
 * its time to pay. Null when that is unknown or unreadable.
 */
export function leftOrderReservedUntil(
  holdExpiresAt: string | null,
): string | null {
  if (!holdExpiresAt) return null;
  const payBy = new Date(holdExpiresAt).getTime();
  if (Number.isNaN(payBy)) return null;
  return new Date(
    payBy + (LEFT_ORDER_RESERVED_MINUTES - TIME_TO_PAY_MINUTES) * 60_000,
  ).toISOString();
}

/**
 * When an order left behind usually lets go of its tickets, from the latest
 * time it can (`leftOrderReservedUntil`). Null when that is unreadable.
 */
export function leftOrderUsuallyReleasedBy(
  reservedUntil: string | null,
): string | null {
  if (!reservedUntil) return null;
  const latest = new Date(reservedUntil).getTime();
  if (Number.isNaN(latest)) return null;
  return new Date(
    latest -
      (LEFT_ORDER_RESERVED_MINUTES - LEFT_ORDER_USUALLY_RESERVED_MINUTES) *
        60_000,
  ).toISOString();
}

/**
 * An order the buyer left, as the widget remembers it:
 *
 * - "releasing": the server has been asked to release it and has not
 *   answered. Nothing is said about its tickets yet, either way.
 * - "reserved": it was not released (see the note above), so its tickets can
 *   stay reserved until `reservedUntil` (`leftOrderReservedUntil`; null when
 *   the order carried no time).
 * - "released": the server let it go. It holds nothing; it is kept only so
 *   the buyer can be told its tickets are back on sale.
 */
export type LeftEmbedOrder = {
  /** The event the order was for. */
  eventId: string;
  reservedUntil: string | null;
  status: "releasing" | "reserved" | "released";
};

/**
 * The orders the buyer left, each under its PaymentIntent's client secret.
 * Per ORDER, not one time per event: releasing one order says nothing about
 * another the buyer left for the same event.
 */
export type LeftEmbedOrders = Readonly<Record<string, LeftEmbedOrder>>;

const timeOf = (at: string | null): number =>
  at === null ? Number.NaN : new Date(at).getTime();

/**
 * `orders` without the ones that no longer say anything: a "reserved" order
 * whose time is up at `now`, or that has no readable time. The SAME object
 * when nothing was dropped.
 */
export function withoutLapsedLeftOrders(
  orders: LeftEmbedOrders,
  now: number,
): LeftEmbedOrders {
  const kept = Object.entries(orders).filter(
    ([, order]) =>
      order.status !== "reserved" || timeOf(order.reservedUntil) > now,
  );
  return kept.length === Object.keys(orders).length
    ? orders
    : Object.fromEntries(kept);
}

/**
 * When the tickets of the orders left for one event stop being reserved: the
 * latest end among its "reserved" orders, whether or not it has passed (the
 * caller watches the clock). Null when the event has none with a readable
 * time.
 */
export function leftOrdersReservedUntil(
  orders: LeftEmbedOrders,
  eventId: string,
): string | null {
  let latest: string | null = null;
  for (const order of Object.values(orders)) {
    if (order.eventId !== eventId || order.status !== "reserved") continue;
    const end = timeOf(order.reservedUntil);
    if (Number.isNaN(end)) continue;
    if (latest === null || end > timeOf(latest)) latest = order.reservedUntil;
  }
  return latest;
}

/** Whether an order the buyer left for this event was released. */
export function hasReleasedLeftOrder(
  orders: LeftEmbedOrders,
  eventId: string,
): boolean {
  return Object.values(orders).some(
    (order) => order.eventId === eventId && order.status === "released",
  );
}

/**
 * `orders` without the released ones of one event: what was said about them
 * (their tickets are back on sale) is about a moment that has passed once
 * the buyer has a new order for the event, or opens it again. The SAME
 * object when there were none.
 */
export function withoutReleasedLeftOrders(
  orders: LeftEmbedOrders,
  eventId: string,
): LeftEmbedOrders {
  const kept = Object.entries(orders).filter(
    ([, order]) => !(order.eventId === eventId && order.status === "released"),
  );
  return kept.length === Object.keys(orders).length
    ? orders
    : Object.fromEntries(kept);
}
