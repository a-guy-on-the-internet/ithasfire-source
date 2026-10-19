import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput } from "../../lib/io";
import { resaleClaimWindowClosesAt } from "../../lib/resale-claim-window";
import {
  buyerTotalBeforeFeesCents,
  buyerTotalBeforeTaxCents,
  loadListingFeePolicies,
  sellerReceivesCents,
  ticketTypePricingFacts,
  ticketTypePricingFactsSchema,
  withCurrentProcessing,
} from "./_shared/resale-listing-display";

// ── Schemas ────────────────────────────────────────────────────────────────

export const listMyResaleListingsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  status: z
    .array(z.enum(["ACTIVE", "HELD", "SOLD", "CANCELLED", "EXPIRED"]))
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const listMyResaleListingsOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      ticketId: z.string().uuid(),
      eventId: z.string().uuid(),
      askPriceCents: z.number().int(),
      faceValueCents: z.number().int().nullable(),
      /**
       * The share the sale pays the people who put on the night (FR-005)
       * and who pays it; null on a listing priced under the removed markup
       * split.
       */
      eventShareCents: z.number().int().nullable(),
      sharePayer: z.enum(["SELLER", "BUYER"]).nullable(),
      /** What the ticket first sold for (FR-007); null on a pre-share listing. */
      originalPriceCents: z.number().int().nonnegative().nullable(),
      /** The ask less the share when the seller pays it; null pre-share. */
      sellerReceivesCents: z.number().int().nonnegative().nullable(),
      /**
       * What the buyer pays for the ticket (ask, plus the share when the
       * buyer pays it), BEFORE processing and tax; null pre-share.
       */
      buyerTotalBeforeFeesCents: z.number().int().nonnegative().nullable(),
      /** The ticket total plus processing, before tax; null pre-share. */
      buyerTotalBeforeTaxCents: z.number().int().nonnegative().nullable(),
      /** The ticket type's list price and mode, for wording a comp or PWYW. */
      ticketTypePricing: ticketTypePricingFactsSchema.nullable(),
      processingPassThroughCents: z.number().int(),
      currency: z.string(),
      status: z.string(),
      saleCutoffAt: z.string().datetime().nullable(),
      payoutReleaseAt: z.string().datetime().nullable(),
      buyerOrderId: z.string().uuid().nullable(),
      expiresAt: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export type ListMyResaleListingsInput = z.infer<
  typeof listMyResaleListingsInputSchema
>;
export type ListMyResaleListingsOutput = z.infer<
  typeof listMyResaleListingsOutputSchema
>;

export type ListMyResaleListingsDeps = {
  repos: Repos;
  /** Resolves the ticket type's list price (a scheduled change counts). */
  clock: ClockPort;
  /**
   * Reports a failed or missing fee-policy read, where the stored processing
   * figure is shown instead. Best-effort; a throwing reporter never changes
   * behaviour.
   */
  reportError?: ReporterPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function listMyResaleListings(
  deps: ListMyResaleListingsDeps,
  rawInput: unknown,
): Promise<ListMyResaleListingsOutput> {
  const input = parseInput(listMyResaleListingsInputSchema, rawInput);

  const result = await deps.repos.resaleListings.listBySeller({
    sellerHumanId: input.actorHumanId,
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });

  // Release dates shown to the seller are clamped to the claim window's
  // close, measured from the event's CURRENT end: a listing snapshotted under
  // a release shorter than the window (allowed before the floor existed), or
  // whose event has since moved later, would otherwise show a date before the
  // money can actually move (the ledger re-checks the same window). Every web
  // surface that shows this date (/sell/listings, /sell/payouts, the resell
  // form) reads it from here.
  const eventIds = [
    ...new Set(
      result.items
        .filter((listing) => listing.payoutReleaseAt)
        .map((listing) => listing.eventId),
    ),
  ];
  const events =
    eventIds.length > 0 ? await deps.repos.events.findManyByIds(eventIds) : [];
  const claimCloseByEvent = new Map(
    events.map((event) => [event.id, resaleClaimWindowClosesAt(event)]),
  );
  const effectiveRelease = (listing: {
    eventId: string;
    payoutReleaseAt: Date | null;
  }): Date | null => {
    if (!listing.payoutReleaseAt) return null;
    const close = claimCloseByEvent.get(listing.eventId);
    return close && close.getTime() > listing.payoutReleaseAt.getTime()
      ? close
      : listing.payoutReleaseAt;
  };

  const now = deps.clock.now();

  // Pre-tax processing is derived from each LIVE listing's frozen fee policy
  // (one batched read), so an ACTIVE or HELD listing made under the older
  // markup shows what checkout charges now. A SOLD, CANCELLED or EXPIRED row
  // keeps its stored value: for a sold row it describes what was charged then.
  const isLive = (listing: { status: string }) =>
    listing.status === "ACTIVE" || listing.status === "HELD";
  const policies = await loadListingFeePolicies(
    deps,
    "listMyResaleListings",
    result.items.filter(isLive),
  );
  const items = result.items.map((stored) =>
    isLive(stored) ? withCurrentProcessing(stored, policies) : stored,
  );

  return {
    items: items.map((listing) => ({
      id: listing.id,
      ticketId: listing.ticketId,
      eventId: listing.eventId,
      askPriceCents: listing.askPriceCents,
      faceValueCents: listing.faceValueCents,
      eventShareCents: listing.eventShareCents ?? null,
      sharePayer: listing.sharePayer ?? null,
      originalPriceCents: listing.originalPriceCents ?? null,
      sellerReceivesCents: sellerReceivesCents(listing),
      buyerTotalBeforeFeesCents: buyerTotalBeforeFeesCents(listing),
      buyerTotalBeforeTaxCents: buyerTotalBeforeTaxCents(listing),
      ticketTypePricing: listing.ticketTypePricing
        ? ticketTypePricingFacts(listing.ticketTypePricing, now)
        : null,
      processingPassThroughCents: listing.processingPassThroughCents,
      currency: listing.currency,
      status: listing.status,
      saleCutoffAt: listing.saleCutoffAt
        ? listing.saleCutoffAt.toISOString()
        : null,
      payoutReleaseAt: effectiveRelease(listing)?.toISOString() ?? null,
      buyerOrderId: listing.buyerOrderId,
      expiresAt: listing.expiresAt ? listing.expiresAt.toISOString() : null,
      createdAt: listing.createdAt.toISOString(),
    })),
    total: result.pageInfo.total,
  };
}
