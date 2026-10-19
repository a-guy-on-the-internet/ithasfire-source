import type { LoggerPort } from "@th/ports/logger";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventTicketTypeSummary } from "@th/types";
import {
  renderListingPrice,
  resolveListingPrice,
  type ListingPrice,
} from "@th/types/money";

import {
  loadTicketTypeAvailability,
  type AvailabilityBearingTicketType,
} from "../../_helpers/load-ticket-type-availability";
import {
  summarizePricing,
  type FacePricingSummary,
  type SummarizableTicketType,
} from "../../events/_shared/event-pricing";
import {
  loadListingBuyerTotalsByEventId,
  type ListingBuyerTotalEvent,
} from "../../events/_shared/listing-buyer-totals";

/**
 * The ONLY two sales facts the public calendar embed publishes per event
 * (event-calendar-redesign FR-022 / FR-023; docs/specs/2026-09-02).
 *
 * DELIBERATELY NARROW. `embeds.getCalendarEvents` is an UNAUTHENTICATED read
 * served into a third party's iframe, so this carries a boolean and a display
 * string and NOTHING else — no `capacity`, no `issued`/`held` counts, no
 * per-tier breakdown. An organiser's remaining stock is competitive
 * information; "can I still buy this, and from what price" is not.
 */
/**
 * A tier this loader can answer BOTH questions about: priced (for FR-023's
 * label) and stock-bearing (for FR-022's sold-out). `EventTicketTypeSummary`,
 * which `listTicketTypesForEventIds` returns, satisfies both halves — the
 * intersection is spelled out so a narrower projection cannot silently drop
 * `capacity` and turn every event available.
 */
type CalendarTicketType = SummarizableTicketType &
  AvailabilityBearingTicketType &
  EventTicketTypeSummary;

export type CalendarSalesState = {
  /**
   * True only when the event HAS ACTIVE ticket types and EVERY one of them has
   * no remaining stock, on the same `capacity - issued - held` basis the
   * pre-charge gate refuses on (see `_helpers/load-ticket-type-availability.ts`,
   * including why holds count on a remote-buyer surface). RSVP and ticketless
   * listings are never sold out. A free tier is not exempt: one whose capacity
   * is exhausted reports `soldOut`, and the chip shows "Sold out" ahead of the
   * price line.
   */
  soldOut: boolean;
  /**
   * "$25" / "From $25" / "Free" / "Free+" — the ALL-IN figure (ticket + fees +
   * tax, as checkout charges), from the same `resolveListingPrice` rule
   * every listing uses, or `null` when the event has no price to show (FR-023:
   * week rows render a price only when there is one). `null` covers ticketless
   * and RSVP events, events with every tier outside its sales window, and a
   * paid event whose all-in figure cannot be computed (it never falls back to
   * the face). This never emits "$0".
   */
  priceLabel: string | null;
  /**
   * The same price as data (`resolveListingPrice`), so the embed words it in
   * the viewer's language ("Desde $25", "Gratis", "Paga lo que quieras")
   * instead of printing the English `priceLabel`. Null exactly when
   * `priceLabel` is null.
   */
  listingPrice: ListingPrice | null;
};

/** The safe answer for an event we could not resolve — see `loadCalendarSalesState`. */
export const UNKNOWN_CALENDAR_SALES_STATE: CalendarSalesState = {
  soldOut: false,
  priceLabel: null,
  listingPrice: null,
};

export type CalendarSalesStateDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "tickets"
    // The all-in price label (fee context + venue situs).
    | "payoutTerms"
    | "feePolicies"
    | "places"
    | "savedLocations"
  >;
  /**
   * Required by the CLAUDE.md swallow convention: this loader degrades rather
   * than throwing (see below), so the failure has to reach Sentry some way
   * other than the request blowing up.
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

/**
 * Format one event's pricing rollup as the calendar's price label.
 *
 * REUSES the platform's shared pieces rather than re-deriving a price rule:
 * `summarizePricing` (ACTIVE-only and sales-window aware) for the tier counts,
 * `loadListingBuyerTotalsByEventId` for the all-in figure over the same tiers,
 * and `resolveListingPrice` (`@th/types/money`) for the price, carried both
 * as English (`priceLabel`) and as data (`listingPrice`) for the embed to word
 * in the viewer's language.
 *
 * Two deliberate differences from the card badge:
 *   - nothing on sale is `null`: ticketless, or every tier outside its sales
 *     window. A nullable field is how the calendar payload says "there isn't
 *     a price", so the card's "See details" fallback is `null` here. Free-only
 *     reads "Free" (owner ruling 2026-10-05, FR-023 example list),
 *     free + paid reads "Free+", and a floor-0 pay-what-you-want tier reads
 *     "Pay what you want" (owner ruling 2026-10-06, F2), all straight from
 *     `resolveListingPrice`;
 *   - a multi-tier figure reads "From $15" (the FR-023 week-row copy, see
 *     `embed-calendar-helpers.ts`), where the card prints a bare "$15".
 *
 * CURRENCY comes from the event row (`Event.currency`), never assumed: an
 * embed on a Canadian venue's site must not read "$45" in USD glyphs for a CAD
 * event. `null` (pre-currency rows) falls back to the formatter's own default.
 */
function formatCalendarPrice(
  pricing: FacePricingSummary,
  lowestBuyerTotalCents: number | null,
  currency: string | null,
): Pick<CalendarSalesState, "priceLabel" | "listingPrice"> {
  // `resolveListingPrice` decides: "Free" for a free-only event, "Pay what you
  // want" for a floor-0 PWYW tier, null when no tier is on sale (ticketless,
  // or every ACTIVE tier outside its window). Never "$0".
  const listingPrice = resolveListingPrice({
    ...pricing,
    lowestBuyerTotalCents,
    currency,
    multiTier: "from",
  });
  return {
    priceLabel: listingPrice ? renderListingPrice(listingPrice) : null,
    listingPrice,
  };
}

/**
 * Batch-resolve {@link CalendarSalesState} for a WHOLE PAGE of calendar events.
 *
 * A FIXED number of queries for the page, regardless of how many events are on it:
 *   1. `events.listTicketTypesForEventIds` — every event's tiers at once;
 *   2. `loadTicketTypeAvailability` — ONE lock-free `countCapacityUsage…` call
 *      covering every ACTIVE tier of every event (zero when there are none);
 *   3. `loadListingBuyerTotalsByEventId` — the all-in figure: one situs read
 *      per distinct venue plus the batched fee-context reads.
 *
 * Same batching posture as `loadPricingByEventId` and `list-my-events.ts`'s
 * `getPopularityStats`: an N+1 here would be N+1 on an unauthenticated,
 * third-party-triggered endpoint with a 200-item page.
 *
 * NOT A GATE. Display only, no lock — enforcement stays with
 * `assertTicketTypeCapacity` inside `repos.tx()`.
 *
 * DEGRADES, AND IN THE SAFE DIRECTION. Both reads are enrichment: neither is
 * needed to render a calendar. If either throws, the whole page falls back to
 * `UNKNOWN_CALENDAR_SALES_STATE` — `soldOut: false`, `priceLabel: null` — so a
 * failed availability read paints an unpriced but LIVE chip. The opposite
 * default would let a transient database blip tell every visitor a partner's
 * on-sale event was sold out, which is unrecoverable revenue rather than a
 * degraded pixel. Per CLAUDE.md the swallow reports through `reportError`
 * (plus a `logger.error`, which `warn` would not have given us).
 */
export async function loadCalendarSalesState(
  deps: CalendarSalesStateDeps,
  input: {
    events: readonly {
      id: string;
      currency: string | null;
      /**
       * The event row the all-in figure is computed from. `null` (no row —
       * index lag) ⇒ no all-in figure ⇒ a paid event shows no price.
       */
      row: ListingBuyerTotalEvent | null;
    }[];
    now: Date;
  },
): Promise<Map<string, CalendarSalesState>> {
  const byEventId = new Map<string, CalendarSalesState>();
  if (input.events.length === 0) return byEventId;

  // Dedupe: a leg may hand us the same event more than once, and both reads
  // below are keyed by id.
  const currencyByEventId = new Map<string, string | null>();
  const rows: ListingBuyerTotalEvent[] = [];
  for (const event of input.events) {
    if (!currencyByEventId.has(event.id)) {
      currencyByEventId.set(event.id, event.currency);
      if (event.row) rows.push(event.row);
    }
  }
  const eventIds = [...currencyByEventId.keys()];

  try {
    const ticketTypes =
      await deps.repos.events.listTicketTypesForEventIds(eventIds);

    // ACTIVE tiers only, bucketed per event. An archived/draft tier is neither
    // buyable nor a reason to call an event sold out, so it contributes to
    // neither signal.
    const activeByEventId = new Map<string, CalendarTicketType[]>();
    for (const ticketType of ticketTypes) {
      if (ticketType.status !== "ACTIVE") continue;
      const bucket = activeByEventId.get(ticketType.eventId) ?? [];
      bucket.push(ticketType);
      activeByEventId.set(ticketType.eventId, bucket);
    }

    const activeTiers = [...activeByEventId.values()].flat();
    const availabilityById = await loadTicketTypeAvailability(deps.repos, {
      ticketTypes: activeTiers,
      now: input.now,
    });
    // Degrades on its own (null totals, reported) — a failed fee or venue read
    // costs the page its prices, never its sold-out signal.
    const buyerTotals = await loadListingBuyerTotalsByEventId(
      deps,
      rows,
      activeByEventId,
      input.now,
      { useCase: "getEmbedCalendarEvents" },
    );

    for (const eventId of eventIds) {
      const tiers = activeByEventId.get(eventId);
      if (!tiers || tiers.length === 0) {
        // No ACTIVE tiers at all — RSVP listings, community listings, and
        // draft-tier events. Not sold out, and nothing to quote.
        byEventId.set(eventId, UNKNOWN_CALENDAR_SALES_STATE);
        continue;
      }
      byEventId.set(eventId, {
        // A tier the helper somehow did not answer for reads as AVAILABLE
        // here — the inverse of `getEmbedEventDetail`'s per-tier default, and
        // deliberately so: there the unknown is one tier's stepper (fail
        // closed, do not offer), here it is the whole event's chip (fail open,
        // do not falsely retire a live show).
        soldOut: tiers.every(
          (tier) => availabilityById.get(tier.id)?.soldOut ?? false,
        ),
        ...formatCalendarPrice(
          summarizePricing(tiers, input.now),
          buyerTotals.get(eventId) ?? null,
          currencyByEventId.get(eventId) ?? null,
        ),
      });
    }

    return byEventId;
  } catch (err) {
    deps.logger?.error("embeds.calendar_sales_state_failed", {
      err,
      eventCount: eventIds.length,
    });
    // `safeReporter` rather than a bare `deps.reportError?.(…)`: this branch
    // exists SO THAT the calendar keeps rendering, and a throwing reporter
    // calling out of it would turn a degraded payload back into a 500 — the
    // exact failure `safeReporter`'s doc records on the checkout path. Defence
    // in depth; the composition roots wrap it too.
    if (deps.reportError) {
      safeReporter(deps.reportError)(err, {
        tags: { useCase: "getEmbedCalendarEvents", stage: "salesState" },
        extra: { eventCount: eventIds.length },
      });
    }
    // Empty map ⇒ every caller reads `UNKNOWN_CALENDAR_SALES_STATE`.
    return new Map();
  }
}
