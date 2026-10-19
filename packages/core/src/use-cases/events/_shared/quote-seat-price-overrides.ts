import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord, EventTicketTypeSummary } from "@th/types";

import {
  resolveSeatUnitPriceCents,
  seatOverrideCents,
} from "../../../lib/orders/seat-pricing";
import { resolveTaxImpositions } from "../../../lib/pricing/tax-impositions";
import { estimateBuyerUnitPricesForEvent } from "./estimate-buyer-ticket-pricing";
import { resolveEventTaxSitus } from "./resolve-event-tax-rate";
import { resolveQuoteTaxRateBps } from "./resolve-quote-tax-rate";

export type QuoteSeatPriceOverridesDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "payoutTerms"
    | "feePolicies"
    // The venue situs decides the taxable base behind the ALL-IN figure.
    | "places"
    | "savedLocations"
  >;
  clock: ClockPort;
  /** Best-effort; called when a corrupt stored override is shown as none. */
  reportError?: ReporterPort;
};

/** What a buyer is shown for one overridden seat. NEVER carries `reason`. */
export type QuotedSeatPrice = {
  priceCents: number;
  /** All-in per-ticket estimate; `null` when the tax rate is unknown. */
  buyerTotalCents: number | null;
};

type QuotableSeat = {
  id: string;
  seatSectionId: string;
  priceOverride?: { priceCents: number } | null;
};

/**
 * Quote every overridden seat of a seat map for the BUYER, through the same
 * per-seat resolver the charge uses (`resolveSeatUnitPriceCents`), then the
 * shared fee/tax arithmetic. Seats without a stored override
 * and seats the override does not apply to (an ADJUSTABLE tier names its own
 * price at checkout: spec D-004) are absent from the result, so the picker
 * shows the tier's own behaviour for them.
 *
 * Display stays tolerant: a NEGATIVE or FRACTIONAL stored amount, which
 * `seatOverrideCents` refuses, is shown as no override and reported through
 * `deps.reportError`, so one bad row cannot blank the map. Other corrupt
 * shapes never reach here: the seat repo's display parser already turns a
 * non-number value into `null` silently, and checkout refuses those with a
 * thrown INTERNAL that Sentry already sees. The composition root passes a
 * THROTTLED reporter, since this runs on every public seat-map view.
 */
export async function quoteSeatPriceOverrides(
  deps: QuoteSeatPriceOverridesDeps,
  event: EventRecord,
  seats: readonly QuotableSeat[],
  logger?: LoggerPort,
): Promise<Map<string, QuotedSeatPrice>> {
  const quotes = new Map<string, QuotedSeatPrice>();
  const overridden = seats.filter((seat) => seat.priceOverride != null);
  if (overridden.length === 0) {
    return quotes;
  }

  const now = deps.clock.now();
  const tiersBySection = groupTiersBySection(
    await deps.repos.events.listTicketTypes(event.id),
  );

  const unitBySeat = new Map<string, number>();
  for (const seat of overridden) {
    let cents: number | null;
    try {
      cents = seatOverrideCents(seat.priceOverride, seat.id);
    } catch (err) {
      deps.reportError?.(err, {
        tags: { useCase: "quoteSeatPriceOverrides" },
        extra: { seatId: seat.id, eventId: event.id },
      });
      continue;
    }
    const tiers = tiersBySection.get(seat.seatSectionId) ?? [];
    const fixedTier = tiers.find((tier) => tier.pricingMode === "FIXED");
    if (!fixedTier && tiers.length > 0) {
      // Only pay-what-you-want tiers sell this seat: the override is ignored.
      continue;
    }
    // With a FIXED tier the resolver returns the override; with no active tier
    // for the section there is nothing to ignore it, so the number stands.
    unitBySeat.set(
      seat.id,
      fixedTier
        ? resolveSeatUnitPriceCents(fixedTier, cents, { now })
        : (cents as number),
    );
  }
  if (unitBySeat.size === 0) {
    return quotes;
  }

  // The rate behind the all-in figure: the stamp, or for an unstamped event
  // the cached venue rate / Canada table / 0 with no location; `null` when
  // unknown. This is NOT the same source as the map's regular seats
  // (`getCheckoutFeeRates`), which may look the rate up through the tax
  // provider: on the first view of an unstamped venue with no cached rate, an
  // override seat can get `buyerTotalCents: null` while regular seats already
  // show a looked-up rate. Aligning them means threading the provider lookup
  // into this read; deliberately not done here.
  const situs = await resolveEventTaxSitus(deps.repos, event);
  const salesTaxRateBps = await resolveQuoteTaxRateBps(
    deps,
    event,
    situs,
    logger,
  );
  const estimates = await estimateBuyerUnitPricesForEvent(
    deps,
    event,
    [...unitBySeat.values()],
    {
      taxImpositions: resolveTaxImpositions({
        situs,
        salesTaxRateBps: salesTaxRateBps ?? 0,
      }),
    },
  );
  // Tax-unresolved rule: when even `resolveQuoteTaxRateBps` cannot say what
  // checkout will charge, an all-in figure built at 0% would understate it. A
  // PAID override gets no buyer total: the picker then computes the figure
  // from the seat's tier fee and tax data at the override price, or shows
  // "Calculating total…" when it has none. A $0 override keeps its genuine 0.
  const taxUnresolved = salesTaxRateBps == null;
  for (const [seatId, priceCents] of unitBySeat) {
    const estimate = estimates.get(priceCents);
    quotes.set(seatId, {
      priceCents,
      buyerTotalCents:
        !estimate || (taxUnresolved && priceCents > 0)
          ? null
          : estimate.buyerUnitTotalCents,
    });
  }
  return quotes;
}

function groupTiersBySection(
  ticketTypes: readonly EventTicketTypeSummary[],
): Map<string, EventTicketTypeSummary[]> {
  const bySection = new Map<string, EventTicketTypeSummary[]>();
  for (const tier of ticketTypes) {
    if (tier.status !== "ACTIVE" || !tier.seatSectionId) continue;
    const list = bySection.get(tier.seatSectionId) ?? [];
    list.push(tier);
    bySection.set(tier.seatSectionId, list);
  }
  return bySection;
}
