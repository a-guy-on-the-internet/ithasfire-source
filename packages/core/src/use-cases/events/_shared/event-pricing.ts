import { z } from "zod";

import type { EventTicketTypeSummary } from "@th/types";
import type { Repos } from "@th/ports/repos";

import {
  resolveListingPriceCents,
  type ListingPricedTicketType,
} from "../../../lib/pricing/pay-what-you-want";
import {
  isTicketTypeOnSale,
  type PriceResolvableTicketType,
  type SellableTicketType,
} from "../../../lib/orders/door-pricing";
import {
  loadListingBuyerTotalsByEventId,
  type ListingBuyerTotalEvent,
  type ListingBuyerTotalsDeps,
} from "./listing-buyer-totals";

/**
 * Pricing rollup for an event, summarising its ACTIVE ticket types into the
 * minimal shape the transport layer needs to derive a card price label
 * ("Free", "Free+", "Pay what you want", the all-in "$28.62", or
 * "See details" — see
 * `formatListingPriceLabel` in `@th/types/money`). Shared by every DB-backed
 * event listing use case so cards render consistent pricing regardless of the
 * entry point.
 */
export const pricingSummarySchema = z
  .object({
    /** A genuinely free tier (fixed effective price 0) is on sale. */
    hasFreeTier: z.boolean(),
    /**
     * A pay-what-you-want tier with no minimum (floor 0) is on sale. Separate
     * from `hasFreeTier` (owner ruling 2026-10-06, F2): such a tier reads
     * "Pay what you want" on every listing, as it does on the event page and
     * at checkout, never "Free". A PWYW tier with a floor above 0 is a paid
     * tier quoted at its floor and does not set this.
     */
    hasPayWhatYouWantTier: z.boolean(),
    paidTierCount: z.number().int().min(0),
    minPaidPriceCents: z.number().int().min(0).nullable(),
    /**
     * The ALL-IN price of the cheapest paid tier counted above — ticket +
     * platform fee + processing fee + tax, as checkout charges it (see
     * `loadListingBuyerTotalsByEventId`). Null when there is no paid tier, or
     * when the figure cannot be computed honestly (venue situs unreadable,
     * fee read failed). Taxed at the rate the event page quotes
     * (`resolveQuoteTaxRateBps`). A paid card with a null total says
     * "See details", never the face price.
     */
    lowestBuyerTotalCents: z.number().int().min(0).nullable(),
  })
  .strict();

export type PricingSummary = z.infer<typeof pricingSummarySchema>;

/**
 * The face-price half of a {@link PricingSummary} — what {@link summarizePricing}
 * can derive from the tiers alone, with no fee or tax context.
 */
export type FacePricingSummary = Omit<PricingSummary, "lowestBuyerTotalCents">;

/**
 * The minimum a tier must carry to be summarised.
 *
 * `SellableTicketType`'s two bounds are OPTIONAL (both `null` = today's every
 * row), so a projection that predates the columns still type-checks and behaves
 * exactly as before. Every repo projection that feeds this — `listTicketTypes`
 * and `listTicketTypesForEventIds` — carries them explicitly.
 */
export type SummarizableTicketType = PriceResolvableTicketType &
  ListingPricedTicketType &
  SellableTicketType & {
    status: string;
  };

/**
 * Roll a set of ticket types (one event's worth) into a {@link PricingSummary}
 * at the instant `now`.
 *
 * THE one place the "$25+" family of card labels is derived. It existed in four
 * near-identical copies before FR-004 — here, twice inside `build-search-index`
 * and once as `summarizeTicketPricing` in `get-embed-for-widget` — which is the
 * shape that lets a browse card and a search card disagree about the same
 * event. Time-varying prices make that disagreement a matter of which surface
 * you look at rather than a rare edit race, so the copies are collapsed.
 *
 * FR-004: each tier's contribution is its EFFECTIVE price at `now`
 * (`resolveUnitPriceCents`), never the raw `priceCents` — the same price
 * checkout and the door charge.
 *
 * Only ACTIVE tiers contribute. A tier whose effective price is <= 0 marks the
 * event as having a free tier rather than contributing a paid minimum — so a
 * tier scheduled to become FREE at T correctly moves the event from "$25" to
 * "Free" once T passes. The exception is a pay-what-you-want tier with no
 * minimum: it sets `hasPayWhatYouWantTier`, not `hasFreeTier`, so listings
 * say "Pay what you want" like the event page (owner ruling 2026-10-06, F2).
 *
 * FR-010: a tier OUTSIDE its sales window contributes NOTHING, because a card
 * label is a price CLAIM and this one would be a claim about a tier the buyer
 * cannot buy. Two live failures this closes, both display-only but both the
 * exact shape Q-001 rejected on the price axis ("search would advertise a price
 * that is not yet purchasable"):
 *
 *   * "Early RSVP — free, opens Monday" beside "General — $30, no window" made
 *     the browse card say **Free** all weekend while the only purchasable tier
 *     was $30 and checkout correctly threw TICKET_TYPE_NOT_YET_ON_SALE.
 *   * An ELAPSED $5 early-bird pinned "from $5" on the card forever.
 *
 * THE EMPTY CASE IS DELIBERATE, NOT AN ACCIDENT. An event whose tiers are ALL
 * outside their windows summarises to `{ hasFreeTier: false,
 * hasPayWhatYouWantTier: false, paidTierCount: 0, minPaidPriceCents: null }`,
 * which `formatListingPriceLabel` already renders as its "See details"
 * fallback — the same label a ticketless listing gets. That is the honest
 * answer: we decline to quote a price nobody can buy, and the click
 * lands on the detail page, which as of FR-010 says exactly when the tier
 * opens. The rejected alternative was a "from $5 on Monday" label variant: the
 * card price is a single short string materialised into the search index as a
 * NUMBER (`lowestPriceCents`), so there is nowhere to put a date without a
 * second indexed field carrying the same staleness problem — and it would
 * still be advertising a price that is not yet purchasable.
 *
 * THE HOVER PANEL BEHIND THE SAME BADGE agrees, and that took a second change:
 * `ticket-tiers-for-card.ts` feeds the price-reveal panel from its own read of
 * the tier list, so filtering here alone would have produced a card whose badge
 * said "from $30" beside a panel listing an elapsed "Early bird $5" as an
 * ordinary row. That use case now stamps `onSale` per tier, sorts out-of-window
 * tiers last (so its `tiers[0]` still matches this badge) and the panel dims
 * them. It DIMS rather than filters on purpose: the panel's job is to show what
 * the event offers, and a lone number needs its context more than the badge does.
 *
 * KNOWN GAP, flagged not fixed here: search-index-backed cards keep the
 * pre-window label until the event is re-indexed. Nothing writes to the row at
 * a window boundary, exactly as nothing writes at a price flip — which Q-001
 * answered with the `search.reindex-scheduled-price-flips` window scan. That
 * scan looks at `scheduledPriceAt` only; extending it to `salesOpenAt` /
 * `salesCloseAt` is the durable fix. Until then the nightly full reindex bounds
 * staleness at ~24h, and every read-time surface (the DB-backed listings that
 * call `loadPricingByEventId`, the public ticket list, embeds, POS, checkout)
 * is correct immediately.
 */
export function summarizePricing(
  ticketTypes: readonly SummarizableTicketType[],
  now: Date,
): FacePricingSummary {
  const summary: FacePricingSummary = {
    hasFreeTier: false,
    hasPayWhatYouWantTier: false,
    paidTierCount: 0,
    minPaidPriceCents: null,
  };

  for (const tt of ticketTypes) {
    if (tt.status !== "ACTIVE") continue;
    // Outside its window ⇒ not a price anyone can pay ⇒ not a price we quote.
    // A constant `true` for the unwindowed rows that are every row today, so
    // NFR-001 holds by construction.
    if (!isTicketTypeOnSale(tt, now)) continue;
    // PWYW is quoted at its floor, not its meaningless stored $0 — a
    // $5-minimum tier is not a free tier. See `resolveListingPriceCents`.
    const priceCents = resolveListingPriceCents(tt, now);
    if (priceCents <= 0) {
      // A floor-0 PWYW tier is "Pay what you want", not "Free".
      if (tt.pricingMode === "ADJUSTABLE") {
        summary.hasPayWhatYouWantTier = true;
      } else {
        summary.hasFreeTier = true;
      }
    } else {
      summary.paidTierCount += 1;
      summary.minPaidPriceCents =
        summary.minPaidPriceCents == null
          ? priceCents
          : Math.min(summary.minPaidPriceCents, priceCents);
    }
  }

  return summary;
}

/**
 * Batch-load pricing summaries for a set of events keyed by event id.
 *
 * Only ACTIVE ticket types contribute. Events with no ticket types (e.g.
 * ownerless COMMUNITY/RSVP listings) get no map entry — callers attach `null`,
 * which the transport mapper renders with its default fallback label.
 *
 * `now` is REQUIRED and comes from the caller's injected ClockPort (FR-003).
 * This function feeds the price label on EVERY DB-backed listing surface, so a
 * defaulted clock here would leave browse cards quoting the pre-flip price
 * indefinitely.
 *
 * ALL-IN. Each summary carries `lowestBuyerTotalCents` from
 * `loadListingBuyerTotalsByEventId` over the same tiers and the same `now`, so
 * the card quotes what checkout charges. That loader DEGRADES (null totals,
 * reported through `deps.reportError` and logged) rather than throwing, so a
 * fee or venue read failure costs the page its prices ("See details"), never
 * the page itself — and never falls back to the face price.
 */
export type LoadPricingDeps = Omit<ListingBuyerTotalsDeps, "repos"> & {
  repos: ListingBuyerTotalsDeps["repos"] & {
    events: Pick<Repos["events"], "listTicketTypesForEventIds">;
  };
};

export async function loadPricingByEventId(
  deps: LoadPricingDeps,
  events: readonly ListingBuyerTotalEvent[],
  now: Date,
  opts: { useCase: string },
): Promise<Map<string, PricingSummary>> {
  const result = new Map<string, PricingSummary>();
  if (events.length === 0) return result;

  const ticketTypes = await deps.repos.events.listTicketTypesForEventIds(
    events.map((e) => e.id),
  );

  // Bucket ACTIVE tiers only. An event whose tiers are ALL non-ACTIVE must get
  // NO map entry (not a zeroed one) — callers turn a missing entry into `null`
  // and render their fallback label, and collapsing that into a zeroed summary
  // would silently relabel draft-only events.
  //
  // The FR-010 window filter deliberately lives DOWNSTREAM of this, inside
  // `summarizePricing`: an event whose ACTIVE tiers are all outside their
  // windows keeps its map entry and summarises to a zeroed rollup. Both that
  // and a missing entry render "See details", so the surfaces agree — while the
  // bucket key stays "has ACTIVE tiers at all", a stable fact about the event
  // rather than one that changes at every window boundary.
  const byEventId = new Map<string, (SummarizableTicketType & EventTicketTypeSummary)[]>();
  for (const tt of ticketTypes) {
    if (tt.status !== "ACTIVE") continue;
    const bucket = byEventId.get(tt.eventId) ?? [];
    bucket.push(tt);
    byEventId.set(tt.eventId, bucket);
  }

  const buyerTotals = await loadListingBuyerTotalsByEventId(
    deps,
    events.filter((e) => byEventId.has(e.id)),
    byEventId,
    now,
    opts,
  );

  for (const [eventId, tiers] of byEventId) {
    result.set(eventId, {
      ...summarizePricing(tiers, now),
      lowestBuyerTotalCents: buyerTotals.get(eventId) ?? null,
    });
  }

  return result;
}
