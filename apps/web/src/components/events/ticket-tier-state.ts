/**
 * Per-tier ticket sale state (FR-010) and the scheduled-price copy (Q-002),
 * as pure derivations over the payload core already resolved.
 *
 * LIVES HERE, not in the public event page's `_components`, even though it is a
 * SIBLING of `deriveEventDetailMode` and shares its contract (pure, no clock,
 * no i18n, unit-tested). Three components consume it — `TicketsSection`, the
 * embed widget's `EmbedTicketTypeList`, and the public page through
 * `EventContent` — and two of them are shared/design-system code. A shared
 * component reaching into `app/events/[...slug]/_components` would mean that
 * renaming a route breaks the ticket list. `event-detail.helpers.ts` re-exports
 * both symbols so the event page's established import path still works.
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-010,
 * FR-007, Q-002, NFR-001.
 */

/**
 * Why a single tier can or cannot be bought right now.
 *
 * A SUPERSET of the event page's `EventSellabilityReason`, because an
 * event-wide refusal is still the honest answer for each of that event's tiers.
 * Core composes the two (`resolveTicketTypeSellability`), so what arrives here
 * is already the COMPLETE answer for the row — it never needs ANDing with the
 * event-level flag.
 */
export type TicketTierSellabilityReason =
  // The five EVENT-WIDE reasons, mirroring `EventSellabilityReason` in the
  // event page's helpers. Spelled out rather than imported so this module has
  // no dependency on a route folder at all — and pinned against drift by the
  // compile-time assertion at the bottom of `event-detail.helpers.ts`, which
  // fails the build if the two ever disagree.
  | "ok"
  | "free"
  | "no_payee"
  | "stripe_not_connected"
  | "sales_closed"
  // …plus the two FR-010 introduces, which are per-TIER facts.
  | "not_yet_on_sale"
  | "sales_ended";

/**
 * Mirrors `ticketTypeSellabilitySchema` in
 * `packages/core/src/lib/orders/ticket-type-sellability.ts`. Instants are typed
 * `Date | string` because this helper is called from both the server payload
 * (real `Date`s over superjson) and from tests/stories that hand it ISO text.
 */
export type TicketTierSellability = {
  available: boolean;
  reason: TicketTierSellabilityReason;
  opensAt?: Date | string | null;
  closedAt?: Date | string | null;
};

export type TicketTierPriceChange = {
  toPriceCents: number;
  at: Date | string;
};

export type TicketTierStateInput = {
  /** Omitted entirely by a caller that predates FR-010 — see the return doc. */
  sellability?: TicketTierSellability | null;
  /** Already null once the flip has passed; core never sends a stale one. */
  upcomingPriceChange?: TicketTierPriceChange | null;
};

export type TicketTierState = {
  /** Can this specific tier be bought right now? */
  isBuyable: boolean;
  /**
   * The per-tier notice to render on the row, or null.
   *
   * NULL FOR EVERY EVENT-WIDE REASON, deliberately. `no_payee`,
   * `stripe_not_connected` and the event's own `sales_closed` are already
   * bannered once at the top of the page by `deriveEventDetailMode`; repeating
   * "Sales ended" on all four rows underneath it is noise, and it would read as
   * four separate problems rather than one.
   */
  availability:
    | { reason: "not_yet_on_sale"; opensAt: Date }
    | { reason: "sales_ended"; closedAt: Date | null }
    | null;
  /** "$12 until Fri, Oct 3, 8:00 PM CDT" — null when no flip is pending. */
  priceChange: { toPriceCents: number; at: Date } | null;
};

/**
 * Derive one ticket row's state from the payload core resolved.
 *
 * BACKWARD COMPATIBLE BY OMISSION (NFR-001): with `sellability` absent — a
 * cached payload from before FR-010, a story, an embed that hasn't threaded it
 * yet — the row is buyable with no notice, which is exactly today's render.
 * The unwindowed, unscheduled tier that is ~every row takes the same path,
 * because core reports it as `{ available: true, reason: "ok" }`.
 *
 * This helper NEVER computes availability itself and never reads a clock. Core
 * resolved both against the injected `ClockPort` at the same instant it
 * resolved the price; re-deriving here from the browser's clock is how a page
 * ends up saying "on sale in 3 minutes" beside a Buy button that works, or
 * offering "until Friday" copy next to the post-flip price.
 */
export function deriveTicketTierState({
  sellability,
  upcomingPriceChange,
}: TicketTierStateInput): TicketTierState {
  const priceChange = (() => {
    if (!upcomingPriceChange) return null;
    const at = toDate(upcomingPriceChange.at);
    if (!at) return null;
    return { toPriceCents: upcomingPriceChange.toPriceCents, at };
  })();

  if (!sellability) {
    return { isBuyable: true, availability: null, priceChange };
  }

  if (sellability.reason === "not_yet_on_sale") {
    const opensAt = toDate(sellability.opensAt);
    return {
      isBuyable: false,
      // An unreadable instant degrades to the ENDED-shaped "unavailable"
      // notice rather than to nothing: the tier is genuinely not purchasable
      // either way, and silently rendering it as buyable would be the one
      // wrong answer.
      availability: opensAt
        ? { reason: "not_yet_on_sale", opensAt }
        : { reason: "sales_ended", closedAt: null },
      priceChange,
    };
  }

  if (sellability.reason === "sales_ended") {
    return {
      isBuyable: false,
      availability: {
        reason: "sales_ended",
        closedAt: toDate(sellability.closedAt),
      },
      priceChange,
    };
  }

  // Every remaining reason is event-wide: the page banners it once, the row
  // says nothing extra, and `isBuyable` still reports the honest answer.
  return {
    isBuyable: sellability.available,
    availability: null,
    priceChange,
  };
}

/**
 * Render an absolute instant on the EVENT's clock — "Fri, Oct 9, 10:00 AM CDT".
 *
 * WHY THE EVENT'S ZONE AND NOT THE BROWSER'S. A sales window is an organizer's
 * wall-clock decision about their venue ("doors tier opens at 8"), stored as an
 * absolute instant. Rendering it in the reader's zone tells a buyer in London
 * that a Nashville show's tier opens at 2 AM, which is true and useless. Same
 * lesson as FR-007's admin read-back, and explicitly NOT the
 * `PAYOUT_TZ`/`REFUND_TZ` shortcut, which hardcodes America/Chicago.
 *
 * `timeZoneName: "short"` is load-bearing, not decoration: without it "10:00
 * AM" is unfalsifiable to a reader in another zone.
 *
 * NOT `formatZonedInstant` from the admin ticket-type editor. That one is the
 * organizer's read-back and shares no option set with this — and importing a
 * public page's formatter out of `admin/[slug]/events/new/_components` would
 * couple the buyer surface to the builder's internals. Deliberately no date
 * library: `Intl` does zone arithmetic, and apps/web has (and adds) none.
 *
 * `formatDateTime` is INJECTED — pass `useFormatters().dateTime` — so the
 * locale comes from the app's translator and this module stays pure and
 * unit-testable.
 *
 * RETURNS NULL WITH NO ZONE — refuse, don't degrade (Phase 1c). Formatting
 * without `timeZone` silently renders on the READER's clock, and because the
 * zone-less option set also drops `timeZoneName`, nothing in the string admits
 * it: a London reader sees "On sale Fri, Oct 9, 4:00 PM" for a Nashville tier
 * that opens at 10:00 AM CDT, and has no way to tell. A wrong time stated
 * confidently is worse than no time — callers already fall back to the
 * zone-free copy ("Not on sale yet" / no price-change line). Same reason the
 * unknown-zone path below returns null, and the two now behave identically
 * instead of oppositely.
 *
 * Also returns null on an unknown zone id (`Intl` throws RangeError on those)
 * rather than taking the ticket list down over one label.
 */
export function formatEventZonedInstant(
  instant: Date,
  timeZone: string | null | undefined,
  formatDateTime: (value: Date, options: Intl.DateTimeFormatOptions) => string,
): string | null {
  if (Number.isNaN(instant.getTime())) return null;
  if (!timeZone) return null;
  try {
    return formatDateTime(instant, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    });
  } catch {
    return null;
  }
}

/** `Date | string | null | undefined` → a valid `Date`, or null. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
