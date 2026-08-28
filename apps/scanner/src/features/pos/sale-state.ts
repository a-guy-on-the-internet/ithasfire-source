/**
 * Per-tier sale-window copy for the Sell screen
 * (docs/specs/2026-08-10/time-based-ticket-pricing.spec.yaml FR-010).
 *
 * WHY THIS EXISTS. Phase 2a armed the till to REFUSE a tier outside its sales
 * window — `assertTicketTypeOnSale` runs inside `startPosSale` and
 * `recordCashSale` — but left `pos.listSellableItems` time-blind, so the Sell
 * screen happily listed a tier that opens at 8pm with a working stepper and a
 * Charge button. Fail-closed, and a bad door experience: the operator finds out
 * with the customer's card already in their hand.
 *
 * SURFACING ONLY. Nothing here decides whether a sale is allowed — the server
 * does, and it is the only thing that may. This turns the server's answer into
 * something the operator can read a step earlier.
 *
 * NO DATE LIBRARY, and no reading of the device's zone. A sales window is an
 * organizer's wall-clock decision about their venue, so the instant renders in
 * the EVENT's timezone, which `pos.listSellableItems` now carries. A door
 * tablet is usually in the venue's zone — "usually" is not a correctness
 * argument, and a touring operator's iPad is the case that breaks it.
 */

/** The subset of `sellability` this screen consumes. */
export type SellableTierState = {
  available: boolean;
  reason: string;
  opensAt?: string | Date | null;
  closedAt?: string | Date | null;
};

export type SaleStateLabel = {
  /** False ⇒ the row dims and its stepper is inert. */
  isSellable: boolean;
  /** Short operator-facing line, or null when the tier is plainly sellable. */
  note: string | null;
};

const SELLABLE: SaleStateLabel = { isSellable: true, note: null };

/**
 * Turn the server's per-tier verdict into a row label.
 *
 * A tier with no `sellability` at all — an older API build, a cached response —
 * is treated as SELLABLE. That is the pre-FR-010 behaviour and it is also the
 * fail-safe direction for a UX-only hint: the till still refuses the sale
 * server-side, whereas graying out every row because a field was missing would
 * take the door offline over a deploy skew.
 */
export function describeSaleState(
  sellability: SellableTierState | null | undefined,
  timeZone: string | null | undefined,
): SaleStateLabel {
  if (!sellability || sellability.available) return SELLABLE;

  if (sellability.reason === "not_yet_on_sale") {
    const at = formatInEventZone(sellability.opensAt, timeZone);
    return {
      isSellable: false,
      note: at ? `On sale ${at}` : "Not on sale yet",
    };
  }

  if (sellability.reason === "sales_ended") {
    // No date: a deadline that has already passed is not actionable at a door.
    return { isSellable: false, note: "Sales ended" };
  }

  // The POS passes an event-level PERMIT into the resolver (no event-wide
  // close at a till, and cash needs no connected payee), so no other refusal
  // is reachable today. Handled anyway rather than falling through to
  // "sellable" — an unknown refusal must still stop the tap.
  return { isSellable: false, note: "Not available" };
}

/**
 * "Fri, Oct 9, 8:00 PM CDT" on the EVENT's clock. Null when the instant or the
 * zone id is unreadable — a missing label beats a crashed Sell tab, and the
 * caller falls back to zone-free copy.
 */
function formatInEventZone(
  value: string | Date | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // NO ZONE ⇒ REFUSE, don't degrade. Formatting without `timeZone` renders on
  // the DEVICE's clock, and the zone-less option set also drops
  // `timeZoneName`, so nothing in the string admits it — a touring operator's
  // iPad still on home time would read "On sale 8:00 PM" for a window that
  // opens at 8 PM in the venue's zone, hours away. The caller's fallback
  // ("Not on sale yet") is the honest answer. Matches the unrecognized-zone
  // path below, which already refuses.
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    // `Intl` throws RangeError on an unrecognized zone id.
    return null;
  }
}
