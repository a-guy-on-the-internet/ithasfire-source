import { z } from "zod";
import { resolveListingPriceCents } from "../../lib/pricing/pay-what-you-want";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { loadTicketTypeAvailability } from "../_helpers/load-ticket-type-availability";
import { resolveTaxImpositions } from "../../lib/pricing/tax-impositions";
import { estimateBuyerTicketPricingForEvent } from "./_shared/estimate-buyer-ticket-pricing";
import { resolveEventTaxSitus } from "./_shared/resolve-event-tax-rate";
import { isTicketTypeOnSale } from "../../lib/orders/door-pricing";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ticketTiersForCardInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

const ticketTierForCardSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /**
     * Fee-inclusive buyer total (gross + platform + processor + admission tax),
     * in cents. NULL when tax is unresolved (`event.admissionTaxRateBps == null`)
     * for a PAID tier — checkout does a LIVE tax lookup for null-stamp events, so
     * an estimate computed with tax=0 would UNDERSTATE what is actually charged.
     * The panel degrades to face value in that case rather than promising a
     * number lower than the buyer will pay. This mirrors the card badge's
     * `lowestBuyerTotalCents: null` guard exactly. Free ($0) tiers stay 0.
     */
    buyerTotalCents: z.number().int().nonnegative().nullable(),
    /** Face value in cents — always present, so the panel always has a figure. */
    faceCents: z.number().int().nonnegative(),
    soldOut: z.boolean(),
    /**
     * FR-010: is this tier inside its sales window right now?
     *
     * The card BADGE stopped quoting out-of-window tiers when `summarizePricing`
     * gained the same filter, and the panel is the hover surface behind that
     * exact badge — leaving it unfiltered made the two disagree on the same
     * card ("from $30" beside a listed "Early bird $5" that nobody can buy).
     *
     * SHOWN, NOT HIDDEN. The panel exists to tell a buyer what tiers this event
     * has; deleting the row would answer "why is the badge $30 when I saw $5?"
     * by removing the evidence. It renders dimmed instead — the same treatment
     * sold-out rows already get, and the same "dim, never hide" call the public
     * ticket list makes. A boolean rather than the full `sellability` shape on
     * purpose: an 11px, four-row, `pointer-events: none` hover teaser has
     * nowhere to put "On sale Fri, Oct 9, 10:00 AM CDT", and the event page one
     * click away says it properly.
     *
     * Constant `true` for the unwindowed rows that are every row today, so
     * NFR-001 holds by construction.
     */
    onSale: z.boolean(),
  })
  .strict();

export const ticketTiersForCardOutputSchema = z
  .object({
    tiers: z.array(ticketTierForCardSchema),
  })
  .strict();

export type TicketTiersForCardInput = z.infer<
  typeof ticketTiersForCardInputSchema
>;
export type TicketTiersForCardOutput = z.infer<
  typeof ticketTiersForCardOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type TicketTiersForCardDeps = {
  repos: Pick<
    Repos,
    // `places` / `savedLocations`: the venue situs decides the TAXABLE BASE, and
    // this panel quotes a tax-inclusive buyer total — it has to agree with
    // checkout. See `resolveEventTaxSitus`.
    | "events"
    | "payoutTerms"
    | "feePolicies"
    | "tickets"
    | "places"
    | "savedLocations"
  >;
  /**
   * Required (FR-003) — both the face value below and the shared estimator this
   * use case forwards `deps` to resolve prices at `now`.
   */
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public discovery data source for the event-card price-reveal panel.
 *
 * Composes two things that already exist:
 *  1. Names + face price + capacity come from `events.listTicketTypes` (the
 *     same source `listEventTicketTypes` uses).
 *  2. Fee-inclusive buyer totals come from `estimateBuyerTicketPricingForEvent`
 *     — the single source of buyer-facing arithmetic, shared with the badge and
 *     checkout. Money math is NOT recomputed here.
 *
 * Sold-out is live inventory via `loadTicketTypeAvailability` —
 * `capacity - issued - held`, the SAME basis the event page shows and the
 * pre-charge gate refuses on. It deliberately does NOT mirror POS
 * `list-sellable-items` (issued-only): that surface serves a door operator who
 * can see the room, whereas this one serves a remote buyer who is about to
 * click through to a page that will apply the stricter rule. Disagreeing with
 * the destination is how a card advertises a tier the next screen refuses.
 * It is DELIBERATELY not indexed — sold-out changes on every purchase, so
 * freshness requires a live read.
 *
 * Tiers are ordered ON-SALE FIRST, then cheapest-first by buyer total (falling
 * back to face when the buyer total is null), so `tiers[0]` matches the badge's
 * "lowest" figure — which, since FR-010, is drawn only from tiers inside their
 * sales window (`summarizePricing`). Out-of-window tiers are still returned;
 * the panel dims them rather than hiding what the event offers.
 *
 * Read-only, no auth required (public discovery). The transport gates visibility
 * with the same decision the sibling public `listEventTicketTypes` /
 * `getCheckoutFeeRates` queries use, through its non-throwing form
 * (`hasFullEventReadAccessByEventId`): a gate-failing viewer never reaches this
 * use case and is answered `{ tiers: [] }` instead of FORBIDDEN.
 */
export async function ticketTiersForCard(
  deps: TicketTiersForCardDeps,
  rawInput: unknown,
): Promise<TicketTiersForCardOutput> {
  const logger = deps.logger?.child({ useCase: "ticketTiersForCard" });

  const execute = async () => {
    const input = parseInput(ticketTiersForCardInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_ON_SALE");
    }

    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
    const activeTicketTypes = ticketTypes.filter(
      (ticketType) => ticketType.status === "ACTIVE",
    );

    // Nothing purchasable → empty panel (the card renders its badge fallback).
    if (activeTicketTypes.length === 0) {
      return ticketTiersForCardOutputSchema.parse({ tiers: [] });
    }

    // Fee-inclusive buyer totals from the shared estimator (same math as the
    // badge and checkout). This also surfaces the resolved tax rate.
    const estimate = await estimateBuyerTicketPricingForEvent(
      deps,
      event,
      activeTicketTypes,
      {
        taxImpositions: resolveTaxImpositions({
          situs: await resolveEventTaxSitus(deps.repos, event),
          salesTaxRateBps: event.admissionTaxRateBps ?? 0,
        }),
      },
    );
    const buyerTotalByTicketType = new Map(
      estimate.perTicketEstimates.map((entry) => [
        entry.ticketTypeId,
        entry.buyerUnitTotalCents,
      ]),
    );

    // Tax-unresolved rule (money-critical): when the event has no stamped
    // admission-tax rate, checkout resolves tax LIVE, so any inclusive figure
    // computed with tax=0 would understate the charge. Null the buyer total for
    // PAID tiers (panel shows face value) — identical to the badge's null guard.
    const taxUnresolved = estimate.admissionTaxRateBps == null;

    // Same instant the estimator above used for its buyer totals, so face and
    // inclusive total can never straddle a flip within one panel — and the same
    // instant the availability read below judges holds against.
    const now = deps.clock.now();

    // Live inventory per tier, on the SAME `capacity - issued - held` basis the
    // event page and the pre-charge gate use.
    //
    // This used to count issued-only, via a per-tier `Promise.all` fan-out
    // justified by "there is no batched issued-count repo method". Both halves
    // of that are now wrong. The fan-out is one round trip per tier on the
    // hottest hover path, and issued-only made this the THIRD sold-out basis in
    // the product: once the event page started telling the truth, a card could
    // render a tier un-struck while the page it links to said "Sold out" —
    // capacity 10, 7 issued, 3 in another buyer's live cart. Two of our own
    // surfaces disagreeing in front of a buyer is worse than either answer.
    //
    // Still deliberately un-indexed and un-cached: sold-out must be fresh.
    const availability = await loadTicketTypeAvailability(deps.repos, {
      ticketTypes: activeTicketTypes,
      now,
    });

    const tiers = activeTicketTypes.map((ticketType) => {
      // FR-004: effective face value at `now`, not the stored list price.
      // A pay-what-you-want tier is quoted at its floor, never its stored $0
      // (which listed a $5-minimum tier as "Free").
      const faceCents = resolveListingPriceCents(ticketType, now);
      const estimated = buyerTotalByTicketType.get(ticketType.id);

      let buyerTotalCents: number | null;
      if (faceCents === 0) {
        // Free tier — no fee or tax applies to $0. The estimator returns 0;
        // never null a genuine 0 (the panel should show "Free", not blank).
        buyerTotalCents = estimated ?? 0;
      } else if (taxUnresolved) {
        // Paid tier with an unresolved tax rate — degrade to face value.
        buyerTotalCents = null;
      } else {
        // Paid tier with a known rate — use the estimator's inclusive total.
        // Absent estimate (shouldn't happen for an active tier) → null.
        buyerTotalCents = estimated ?? null;
      }

      // Absent entry would mean the loader saw no such tier — impossible, it is
      // keyed off this same list — but default to NOT sold out rather than
      // hiding sellable stock on a lookup miss.
      const soldOut = availability.get(ticketType.id)?.soldOut ?? false;

      return {
        id: ticketType.id,
        name: ticketType.name,
        buyerTotalCents,
        faceCents,
        // Same `now` as the face value above, so a tier can never be priced
        // on one side of a window boundary and judged on the other.
        onSale: isTicketTypeOnSale(ticketType, now),
        soldOut,
      };
    });

    // OUT-OF-WINDOW TIERS SORT LAST, then cheapest-first by buyer total
    // (falling back to face when null). The first clause is what keeps
    // `tiers[0]` matching the badge, whose `summarizePricing` now skips
    // out-of-window tiers: without it an elapsed $5 early-bird would still
    // head a panel whose badge reads "from $30". It also decides which rows
    // survive the panel's four-row cap — buyable ones, which is the useful
    // half. A constant `true` for every unwindowed tier leaves the existing
    // price-only order untouched (NFR-001).
    tiers.sort(
      (a, b) =>
        Number(b.onSale) - Number(a.onSale) ||
        (a.buyerTotalCents ?? a.faceCents) - (b.buyerTotalCents ?? b.faceCents),
    );

    return ticketTiersForCardOutputSchema.parse({ tiers });
  };

  if (logger) {
    return logger.withTime("ticketTiersForCard", execute);
  }

  return execute();
}
