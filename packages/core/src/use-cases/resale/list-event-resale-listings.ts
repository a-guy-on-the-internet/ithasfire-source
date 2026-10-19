import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput } from "../../lib/io";
import {
  listingShareFigures,
  loadListingFeePolicies,
  reportMissingOriginalPrice,
  resaleListingShareOutputShape,
  ticketTypePricingFacts,
  withCurrentProcessing,
} from "./_shared/resale-listing-display";

// ── Schemas ────────────────────────────────────────────────────────────────

export const listEventResaleListingsInputSchema = z.object({
  eventId: z.string().uuid(),
  /** Optional section filter — only return listings in this seat section. */
  sectionId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

const enrichedListingItemSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  eventId: z.string().uuid(),
  askPriceCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  // ── Enriched context ──
  ticketTypeName: z.string().nullable(),
  facePriceCents: z.number().int().nullable(),
  sectionName: z.string().nullable(),
  sectionId: z.string().uuid().nullable(),
  seatLabel: z.string().nullable(),
  seatRow: z.string().nullable(),
  seatNumber: z.number().int().nullable(),
  ...resaleListingShareOutputShape,
});

export const listEventResaleListingsOutputSchema = z.object({
  items: z.array(enrichedListingItemSchema),
  total: z.number().int().nonnegative(),
  /** Distinct sections present in the result set (for filter UI). */
  sections: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
});

export type ListEventResaleListingsInput = z.infer<
  typeof listEventResaleListingsInputSchema
>;
export type ListEventResaleListingsOutput = z.infer<
  typeof listEventResaleListingsOutputSchema
>;

export type ListEventResaleListingsDeps = {
  repos: Repos;
  /** Resolves the ticket type's list price (a scheduled change counts). */
  clock: ClockPort;
  /**
   * Reports the degraded rows where the adapter could resolve no historical
   * face value (FR-001) and `facePriceCents` came back null. `getResaleListing`
   * treats the SAME condition as anomalous; without this, the identical data
   * defect would be Sentry-visible when one buyer opens a detail page and
   * silently swallowed when a hundred see it in the browse list.
   * Best-effort; a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Browse ACTIVE resale listings for a specific event.
 * Returns enriched data: ticket type name, section name, and seat label.
 * Available to any user (authed or anonymous).
 */
export async function listEventResaleListings(
  deps: ListEventResaleListingsDeps,
  rawInput: unknown,
): Promise<ListEventResaleListingsOutput> {
  const input = parseInput(listEventResaleListingsInputSchema, rawInput);

  const result = await deps.repos.resaleListings.listByEventEnriched({
    eventId: input.eventId,
    status: ["ACTIVE"],
    // A listing priced under the removed markup split cannot be bought
    // (checkout refuses it): never shown, even before the FR-015 cancel
    // closes it.
    onlyWithShare: true,
    sectionId: input.sectionId,
    limit: input.limit,
    offset: input.offset,
  });

  // Collect distinct sections for the filter dropdown
  const sectionMap = new Map<string, string>();
  for (const listing of result.items) {
    if (listing.sectionId && listing.sectionName) {
      sectionMap.set(listing.sectionId, listing.sectionName);
    }
  }

  const sections = Array.from(sectionMap.entries()).map(([id, name]) => ({
    id,
    name,
  }));

  // One report per response, not per row — a browse page full of the same
  // defect should be one Sentry event carrying the offending ids, not N.
  const missingFaceValueListingIds = result.items
    .filter((listing) => listing.facePriceCents == null)
    .map((listing) => listing.id);
  if (missingFaceValueListingIds.length > 0) {
    try {
      deps.reportError?.(
        new Error(
          "listEventResaleListings: no historical face value for listing(s)",
        ),
        {
          tags: { useCase: "listEventResaleListings" },
          extra: {
            eventId: input.eventId,
            count: missingFaceValueListingIds.length,
            listingIds: missingFaceValueListingIds.slice(0, 20),
          },
        },
      );
    } catch {
      // Reporting is best-effort — a throwing reporter must never break a
      // public browse read.
    }
  }

  // A listing priced under the share always has the original price on its
  // ticket's purchase item (FR-004); one without is a data defect.
  reportMissingOriginalPrice(
    deps.reportError,
    "listEventResaleListings",
    result.items
      .filter(
        (listing) =>
          listing.eventShareCents != null && listing.originalPriceCents == null,
      )
      .map((listing) => listing.id),
    { eventId: input.eventId },
  );

  // Pre-tax processing is derived from each listing's frozen fee policy (one
  // batched read), so a listing made under the older markup shows what checkout
  // charges now.
  const policies = await loadListingFeePolicies(
    deps,
    "listEventResaleListings",
    result.items,
  );

  const listings = result.items.map((stored) =>
    withCurrentProcessing(stored, policies),
  );

  const now = deps.clock.now();
  return {
    items: listings.map((listing) => ({
      id: listing.id,
      ticketId: listing.ticketId,
      eventId: listing.eventId,
      askPriceCents: listing.askPriceCents,
      currency: listing.currency,
      status: listing.status,
      expiresAt: listing.expiresAt ? listing.expiresAt.toISOString() : null,
      createdAt: listing.createdAt.toISOString(),
      ticketTypeName: listing.ticketTypeName,
      facePriceCents: listing.facePriceCents,
      sectionName: listing.sectionName,
      sectionId: listing.sectionId,
      seatLabel: listing.seatLabel,
      seatRow: listing.seatRow,
      seatNumber: listing.seatNumber,
      // Pay-what-you-want: the recorded amount is what the first buyer
      // chose, often the seller's own. A public read never sends it; the
      // page words the original price from the type's minimum instead.
      originalPriceCents:
        listing.ticketTypePricing?.pricingMode === "ADJUSTABLE"
          ? null
          : (listing.originalPriceCents ?? null),
      ...listingShareFigures(listing),
      ticketTypePricing: listing.ticketTypePricing
        ? ticketTypePricingFacts(listing.ticketTypePricing, now)
        : null,
    })),
    total: result.pageInfo.total,
    sections,
  };
}
