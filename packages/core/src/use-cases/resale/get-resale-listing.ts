import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { FeePolicyRecord } from "@th/types/repos/fee-policies";
import { parseInput } from "../../lib/io";
import { resolvePurchasedUnitPriceCents } from "../orders/_shared/resolve-purchased-unit-price";
import { fail } from "@th/errors";
import { resolveTaxImpositions } from "../../lib/pricing/tax-impositions";
import { resolveEventTaxSitus } from "../events/_shared/resolve-event-tax-rate";
import { resolveQuoteTaxRate } from "../events/_shared/resolve-quote-tax-rate";
import {
  listingShareFigures,
  loadListingFeePolicies,
  reportMissingOriginalPrice,
  resaleBuyerTaxEstimate,
  resaleListingShareOutputShape,
  ticketFactsFromRows,
  withCurrentProcessing,
} from "./_shared/resale-listing-display";

// ── Schemas ────────────────────────────────────────────────────────────────

export const getResaleListingInputSchema = z.object({
  listingId: z.string().uuid(),
  /**
   * The signed-in viewer, if any. Set by the transport from the session,
   * never by the client (the router omits it from its input).
   */
  viewerHumanId: z.string().uuid().nullable().optional(),
});

export const getResaleListingOutputSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  /**
   * True when the viewer is the seller. Stands in for the seller's id and
   * the ticket id, which this public read no longer returns.
   */
  isOwnListing: z.boolean(),
  askPriceCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  expiresAt: z.string().datetime().nullable(),
  source: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // ── Enriched context (loaded from ticket → ticketType / seat → section) ──
  ticketTypeName: z.string().nullable(),
  facePriceCents: z.number().int().nullable(),
  sectionName: z.string().nullable(),
  sectionId: z.string().uuid().nullable(),
  seatLabel: z.string().nullable(),
  seatRow: z.string().nullable(),
  seatNumber: z.number().int().nullable(),
  ...resaleListingShareOutputShape,
  /**
   * The tax checkout will add, estimated from the venue's rate the way the
   * ticket checkout's estimate is (the event's stamped rate, else the venue's
   * cached one; never a tax-provider call on this public read), on the same
   * base `createResaleCheckout` taxes. Null when the rate is not known without
   * asking the provider, the read of the venue failed, or the listing was
   * priced before the share existed: the page then says tax is added at
   * checkout and claims no total. Never a 0 standing in for an unknown rate.
   */
  estimatedTaxCents: z.number().int().nonnegative().nullable(),
  /**
   * The processing checkout will charge: grossed up over the whole charge,
   * tax included (owner 2026-10-14), so at a non-zero rate it is a little
   * above the listing's pre-tax `processingPassThroughCents`. Null exactly
   * when `estimatedTaxCents` is.
   */
  estimatedProcessingCents: z.number().int().nonnegative().nullable(),
  /**
   * `buyerTotalBeforeFeesCents` + `estimatedProcessingCents` +
   * `estimatedTaxCents`: what the buyer is expected to be charged. Null
   * exactly when `estimatedTaxCents` is.
   */
  estimatedTotalCents: z.number().int().nonnegative().nullable(),
  // ── Event context (for display on checkout page) ──
  eventName: z.string().nullable(),
  eventSlug: z.string().nullable(),
  eventStartsAt: z.string().datetime().nullable(),
  eventLocationLabel: z.string().nullable(),
});

export type GetResaleListingInput = z.infer<typeof getResaleListingInputSchema>;
export type GetResaleListingOutput = z.infer<
  typeof getResaleListingOutputSchema
>;

export type GetResaleListingDeps = {
  repos: Repos;
  /** Resolves the ticket type's list price (a scheduled change counts). */
  clock: ClockPort;
  /**
   * Reports the degraded branch below where neither the listing snapshot nor
   * the seller's OrderItem yields a face value and `facePriceCents` falls back
   * to null. Best-effort; a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Fetch detail for a single resale listing, enriched with ticket type,
 * seat/section context, and basic event info for buyer-facing display.
 *
 * The direct listing link (/events/resale/[listingId]) is how a holder passes
 * a ticket on, so the event's PASSWORD / APPLICATION gate does NOT apply here
 * (owner ruling 2026-10-13, "Link works"). What does apply, to anyone but the
 * seller, all answered as LISTING_NOT_FOUND so a refusal says nothing more
 * than a wrong id:
 *  - the listing must be on sale or mid-sale: ACTIVE, or HELD (a buyer's
 *    checkout holds it, and that buyer's page re-reads it while they pay;
 *    a released hold goes back to ACTIVE). SOLD only to its buyer, so the
 *    buyer's page still reads after the sale. CANCELLED / EXPIRED: seller
 *    only.
 *  - the event must be one `createResaleCheckout` would sell for: it exists,
 *    is not CANCELLED and is not an RSVP event. Also not a DRAFT, which
 *    checkout does not refuse but cannot carry a listing (unpublishing is
 *    refused once an event has orders). A BANNED owner is deliberately not
 *    refused: ban-that-sticks (2026-09-29) keeps holders' tickets and
 *    resale open, and checkout sells it, so the page must show it.
 */
export async function getResaleListing(
  deps: GetResaleListingDeps,
  rawInput: unknown,
): Promise<GetResaleListingOutput> {
  const input = parseInput(getResaleListingInputSchema, rawInput);

  const listing = await deps.repos.resaleListings.getById(input.listingId);
  if (!listing) {
    throw fail("LISTING_NOT_FOUND");
  }

  const viewerHumanId = input.viewerHumanId ?? null;
  const isOwnListing =
    viewerHumanId !== null && viewerHumanId === listing.sellerHumanId;

  const event = await deps.repos.events.getById(listing.eventId);

  if (!isOwnListing) {
    if (!(await isListingReadableByNonSeller(deps, listing, viewerHumanId))) {
      throw fail("LISTING_NOT_FOUND");
    }
    if (!isEventOpenForResale(event)) {
      throw fail("LISTING_NOT_FOUND");
    }
  }

  // ── Enrich with ticket type, seat, and section context ──────────────
  // `facePriceCents` is HISTORICAL (FR-001): the listing's own frozen
  // snapshot first, then the seller's OrderItem. The live TicketType supplies
  // the display NAME and the seat section, never the price — showing the
  // current price as "face value" misrepresents the markup the buyer is
  // paying and disagrees with the split the money actually took.
  let ticketTypeName: string | null = null;
  let facePriceCents: number | null = listing.faceValueCents ?? null;
  let ticketType: Awaited<
    ReturnType<Repos["tickets"]["getTicketTypeById"]>
  > = null;
  let sectionName: string | null = null;
  let sectionId: string | null = null;
  let seatLabel: string | null = null;
  let seatRow: string | null = null;
  let seatNumber: number | null = null;

  const ticket = listing.ticketId
    ? await deps.repos.tickets.getById(listing.ticketId)
    : null;

  if (ticket) {
    if (facePriceCents == null) {
      facePriceCents = await resolvePurchasedUnitPriceCents(deps.repos, ticket);

      if (facePriceCents == null) {
        // Degraded: we show "face value unknown" rather than the live price.
        // Anomalous for any ticket minted through the normal path, so make it
        // Sentry-visible instead of silently rendering a blank.
        try {
          deps.reportError?.(
            new Error(
              "getResaleListing: no historical face value for listing ticket",
            ),
            {
              tags: { useCase: "getResaleListing" },
              extra: {
                listingId: listing.id,
                ticketId: ticket.id,
                orderItemId: ticket.orderItemId,
              },
            },
          );
        } catch {
          // Reporting is best-effort — a throwing reporter must never break
          // a public read.
        }
      }
    }

    if (ticket.ticketTypeId) {
      ticketType = await deps.repos.tickets.getTicketTypeById(
        ticket.ticketTypeId,
      );
      if (ticketType) {
        ticketTypeName = ticketType.name;

        if (ticketType.seatSectionId) {
          const section = await deps.repos.seats.getSectionById(
            ticketType.seatSectionId,
          );
          if (section) {
            sectionName = section.name;
            sectionId = section.id;
          }
        }
      }
    }

    if (ticket.seatId) {
      // A plain read: a public page must never take (or wait on) the seat
      // lock checkout, the door and mint hold.
      const seats = await deps.repos.seats.findLabelsByIds({
        seatIds: [ticket.seatId],
        eventId: listing.eventId,
      });
      const seat = seats[0];
      if (seat) {
        seatLabel = seat.label;
        seatRow = seat.row;
        seatNumber = seat.number;
        // Fall back to the seat's own section if the type named none.
        if (!sectionId) {
          sectionName = seat.sectionName;
          sectionId = seat.seatSectionId;
        }
      }
    }
  }

  const purchaseItem = ticket?.orderItemId
    ? await deps.repos.orderItems.getById(ticket.orderItemId)
    : null;
  const { originalPriceCents, ticketTypePricing } = ticketFactsFromRows(
    { purchaseItem, ticketType },
    deps.clock.now(),
  );
  if (listing.eventShareCents != null && originalPriceCents == null) {
    reportMissingOriginalPrice(deps.reportError, "getResaleListing", [
      listing.id,
    ]);
  }

  // ── Load basic event context ────────────────────────────────────────
  let eventName: string | null = null;
  let eventSlug: string | null = null;
  let eventStartsAt: string | null = null;
  let eventLocationLabel: string | null = null;

  if (event) {
    eventName = event.title;
    eventSlug = event.slug;
    eventStartsAt =
      event.startsAt instanceof Date
        ? event.startsAt.toISOString()
        : String(event.startsAt);
    eventLocationLabel = event.locationLabel ?? null;
  }

  // Pre-tax processing is derived from the fee policy the listing froze, so an
  // ACTIVE or HELD listing made under the older markup shows what checkout
  // charges now. A SOLD listing keeps its stored value: it describes what was
  // charged then.
  const isLive = listing.status === "ACTIVE" || listing.status === "HELD";
  const policies = await loadListingFeePolicies(
    deps,
    "getResaleListing",
    isLive ? [listing] : [],
  );
  const shown = isLive ? withCurrentProcessing(listing, policies) : listing;

  const taxEstimate = event
    ? await estimateResaleTax(deps, event, listing, policies)
    : null;

  return {
    id: listing.id,
    eventId: listing.eventId,
    isOwnListing,
    askPriceCents: listing.askPriceCents,
    currency: listing.currency,
    status: listing.status,
    expiresAt: listing.expiresAt ? listing.expiresAt.toISOString() : null,
    source: listing.source,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
    ticketTypeName,
    facePriceCents,
    sectionName,
    sectionId,
    seatLabel,
    seatRow,
    seatNumber,
    // Pay-what-you-want: never the first buyer's chosen amount, on a public
    // read (the page words it from the type's minimum).
    originalPriceCents:
      ticketTypePricing?.pricingMode === "ADJUSTABLE"
        ? null
        : originalPriceCents,
    ...listingShareFigures(shown),
    estimatedTaxCents: taxEstimate?.taxCents ?? null,
    estimatedProcessingCents: taxEstimate?.processingCents ?? null,
    estimatedTotalCents: taxEstimate?.totalCents ?? null,
    ticketTypePricing,
    eventName,
    eventSlug,
    eventStartsAt,
    eventLocationLabel,
  };
}

/**
 * The resale buyer's tax, processing and total, or null when the rate is
 * unknown. The rate is the one a pre-checkout quote resolves WITHOUT the tax
 * provider (`resolveQuoteTaxRate` with no lookup: the stamp with the TN
 * instruction exemption, else the venue's cached rate); the lines are
 * resolved as `createResaleCheckout` resolves them, and the processor rate is
 * the fee policy the listing froze, the one checkout charges with.
 *
 * A failed venue read, or a fee policy the listing's read could not load, is a
 * deliberate swallow: the page still shows the listing, with tax "added at
 * checkout" and no total. Reported, guarded (the fee-policy miss by
 * `loadListingFeePolicies`).
 */
async function estimateResaleTax(
  deps: GetResaleListingDeps,
  event: NonNullable<Awaited<ReturnType<Repos["events"]["getById"]>>>,
  listing: Parameters<typeof resaleBuyerTaxEstimate>[0] & {
    id: string;
    processingFeeConfigRef: string | null;
  },
  policies: ReadonlyMap<string, FeePolicyRecord>,
): Promise<{
  taxCents: number;
  processingCents: number;
  totalCents: number;
} | null> {
  // A listing priced before the share has no total to add tax to.
  if (listing.eventShareCents == null || !listing.sharePayer) return null;
  try {
    const situs = await resolveEventTaxSitus(deps.repos, event);
    const quote = await resolveQuoteTaxRate(
      { repos: deps.repos, clock: deps.clock, lookup: null },
      event,
      situs,
    );
    if (!quote.known) return null;
    // Checkout refuses a listing whose fee policy is gone
    // (FEE_POLICY_NOT_FOUND), so there is no total to estimate. A share
    // listing always stores one, so a miss is a data defect; the batched
    // `loadListingFeePolicies` read has already reported it.
    const feePolicy = listing.processingFeeConfigRef
      ? policies.get(listing.processingFeeConfigRef)
      : null;
    if (!feePolicy) return null;
    // Resolve the lines exactly as `createResaleCheckout` does (sale RESALE),
    // or the estimate and the charge part. Minneapolis entertainment tax is
    // not charged on resale (owner ruling 2026-10-05: "Assume not. We will
    // seek counsel later.").
    return resaleBuyerTaxEstimate(
      listing,
      resolveTaxImpositions({
        situs,
        salesTaxRateBps: quote.rateBps,
        sale: "RESALE",
      }),
      {
        pct: feePolicy.processsorFeePct,
        fixedCents: feePolicy.processorFixedCents,
      },
    );
  } catch (err) {
    try {
      deps.reportError?.(err, {
        tags: { useCase: "getResaleListing" },
        extra: { listingId: listing.id, eventId: event.id, stage: "tax_estimate" },
      });
    } catch {
      // Reporting is best-effort; a public read must not break on it.
    }
    return null;
  }
}

/**
 * Whether a viewer who is not the seller may read this listing at its
 * current status. See {@link getResaleListing}.
 */
async function isListingReadableByNonSeller(
  deps: GetResaleListingDeps,
  listing: { status: string; buyerOrderId: string | null },
  viewerHumanId: string | null,
): Promise<boolean> {
  if (listing.status === "ACTIVE" || listing.status === "HELD") return true;
  if (listing.status !== "SOLD" || !viewerHumanId || !listing.buyerOrderId) {
    return false;
  }
  const order = await deps.repos.orders.getById(listing.buyerOrderId);
  return order?.buyerHumanId === viewerHumanId;
}

/**
 * The event states the listing page answers for a non-seller: the ones
 * `createResaleCheckout` sells in (it refuses a missing, CANCELLED or RSVP
 * event), less DRAFT. See {@link getResaleListing}.
 */
function isEventOpenForResale(
  event: { status: string; attendanceMode?: string | null } | null,
): boolean {
  if (!event) return false;
  if (event.status === "CANCELLED" || event.status === "DRAFT") return false;
  return event.attendanceMode !== "RSVP";
}
