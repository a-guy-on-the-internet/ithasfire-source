/**
 * Per-tier sale-window copy for the mobile checkout picker
 * (docs/specs/2026-08-10/time-based-ticket-pricing.spec.yaml FR-010).
 *
 * WHY THIS EXISTS. `TicketTypePicker` gated its stepper on `maxQty === 0`
 * alone, so a tier that opens on Friday rendered with a live +/- and a working
 * "Continue" — the server refuses it (`TICKET_TYPE_NOT_YET_ON_SALE`), but only
 * after the buyer has picked a quantity and committed. Same gap the web
 * checkout grid and the POS Sell screen had, same fix: surface the answer the
 * server already sent one step earlier.
 *
 * SURFACING ONLY. Nothing here decides whether a sale is allowed. The server
 * does, and it is the only thing that may.
 *
 * NO DATE LIBRARY, NO DEVICE ZONE. A sales window is an organizer's wall-clock
 * decision about their venue, so the instant renders in the EVENT's timezone,
 * which `getEventSeo` carries. With no zone we render NO time at all rather
 * than silently substituting the phone's — a buyer travelling, or simply in
 * another state, would otherwise read a confidently wrong hour with no
 * abbreviation to give it away.
 *
 * A near-twin of `apps/scanner/src/features/pos/sale-state.ts`. Kept separate
 * rather than shared: the two speak to different audiences (a door operator vs
 * a buyer), and neither app may import the other's source. If a third copy
 * appears, promote it to a package instead of adding one.
 */

/** The subset of `sellability` this screen consumes. */
export type TierSellability = {
  available: boolean;
  reason: string;
  opensAt?: string | Date | null;
  closedAt?: string | Date | null;
};

export type TierSaleState = {
  /** False ⇒ the row dims and its stepper is replaced by the note. */
  isBuyable: boolean;
  /** Short buyer-facing line, or null when the tier is plainly buyable. */
  note: string | null;
};

const BUYABLE: TierSaleState = { isBuyable: true, note: null };

/**
 * Turn the server's per-tier verdict into a row label.
 *
 * A tier with no `sellability` at all — an older API build, a cached response —
 * is treated as BUYABLE. That is the pre-FR-010 behaviour and the fail-safe
 * direction for a UX-only hint: checkout still refuses server-side, whereas
 * greying out every row because a field was missing would break buying
 * entirely over a deploy skew.
 *
 * Event-WIDE refusals (`no_payee`, `stripe_not_connected`, event-level
 * `sales_closed`) are deliberately not spelled out per row: the buyer only
 * reaches this screen through a CTA that is already gated on them, so a
 * per-row explanation would be noise. They still return `isBuyable: false`.
 */
export function describeTierSaleState(
  sellability: TierSellability | null | undefined,
  timeZone: string | null | undefined,
): TierSaleState {
  if (!sellability || sellability.available) return BUYABLE;

  if (sellability.reason === "not_yet_on_sale") {
    const at = formatInEventZone(sellability.opensAt, timeZone);
    return { isBuyable: false, note: at ? `On sale ${at}` : "Not on sale yet" };
  }

  if (sellability.reason === "sales_ended") {
    // No date: a deadline that has already passed is not actionable.
    return { isBuyable: false, note: "Sales ended" };
  }

  return { isBuyable: false, note: "Not available" };
}

/**
 * "Fri, Oct 9, 8:00 PM CDT" on the EVENT's clock. Null when the instant is
 * unreadable, the zone id is unknown (`Intl` throws RangeError), or there is no
 * zone at all — the caller falls back to zone-free copy.
 */
function formatInEventZone(
  value: string | Date | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
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
    return null;
  }
}
