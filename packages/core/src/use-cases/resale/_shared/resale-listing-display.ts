import { z } from "zod";

import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { FeePolicyRecord } from "@th/types/repos/fee-policies";
import type { ResaleSharePayer } from "@th/types/repos/payout-terms";

import { resolveUnitPriceCents } from "../../../lib/orders/door-pricing";
import { resaleAmountsFromShare } from "../../../lib/pricing/resale-pricing";
import { solveResaleCharge } from "../../../lib/pricing/resale-charge";
import type { TaxImposition } from "../../../lib/pricing/tax-impositions";

// ── What a resale listing read says about the share (spec FR-004, FR-007,
// FR-013, NFR-002) ──
//
// A listing carries its priced share (`eventShareCents`, `sharePayer`) from
// the moment it was made. These helpers turn that record into the numbers a
// page shows, so no client adds the share up itself.

/**
 * The ticket type's CURRENT list price and pricing mode (FIXED, or ADJUSTABLE
 * = pay what you want above `minimumCents`). Facts for wording the original
 * price of a comp ($0 recorded) or pay-what-you-want ticket; nothing is
 * priced from them.
 */
export const ticketTypePricingFactsSchema = z.object({
  listPriceCents: z.number().int().nonnegative(),
  pricingMode: z.enum(["FIXED", "ADJUSTABLE"]),
  minimumCents: z.number().int().nonnegative().nullable(),
});
export type TicketTypePricingFacts = z.infer<
  typeof ticketTypePricingFactsSchema
>;

/**
 * The type's list price in force at `now` (a scheduled price change counts,
 * via the one resolver) with its mode. `type` is a stored ticket type.
 */
export function ticketTypePricingFacts(
  type: Parameters<typeof resolveUnitPriceCents>[0] & {
    pricingMode: "FIXED" | "ADJUSTABLE";
    minimumCents: number | null;
  },
  now: Date,
): TicketTypePricingFacts {
  return {
    listPriceCents: resolveUnitPriceCents(type, { now }),
    pricingMode: type.pricingMode,
    minimumCents: type.minimumCents,
  };
}

/** Output fields every resale listing read carries (spec FR-005, FR-007). */
export const resaleListingShareOutputShape = {
  /** What the ticket first sold for (FR-007); null on a pre-share listing. */
  originalPriceCents: z.number().int().nonnegative().nullable(),
  /** To the people who put on the night; null on a pre-share listing. */
  eventShareCents: z.number().int().nonnegative().nullable(),
  /** Who pays the share; null on a pre-share listing. */
  sharePayer: z.enum(["SELLER", "BUYER"]).nullable(),
  /**
   * What the buyer pays for the ticket: ask, plus the share when the buyer
   * pays it. BEFORE processing and tax, which checkout adds; null on a
   * pre-share listing.
   */
  buyerTotalBeforeFeesCents: z.number().int().nonnegative().nullable(),
  /**
   * Processing on the ticket total BEFORE tax (the listing's own value).
   * Checkout grosses processing up over the whole charge, tax included
   * (owner 2026-10-14), so with tax the charged processing is a little
   * higher; `estimatedProcessingCents` on the single-listing read carries
   * that figure.
   */
  processingPassThroughCents: z.number().int().nonnegative(),
  /**
   * The all-in price before tax (FR-009): `buyerTotalBeforeFeesCents` plus
   * `processingPassThroughCents`, exactly what checkout charges when there
   * is no tax; null on a pre-share listing. With tax, checkout adds the tax
   * and the processing on it.
   */
  buyerTotalBeforeTaxCents: z.number().int().nonnegative().nullable(),
  /** The ticket type's list price and mode, for wording a comp or PWYW. */
  ticketTypePricing: ticketTypePricingFactsSchema.nullable(),
};

type ListingShare = {
  askPriceCents: number;
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
};

function amountsOf(listing: ListingShare) {
  const share = listing.eventShareCents;
  if (share == null || !listing.sharePayer) return null;
  return resaleAmountsFromShare({
    askCents: listing.askPriceCents,
    shareCents: share,
    payer: listing.sharePayer,
  });
}

/**
 * What the buyer pays for the ticket itself: the ask, plus the share when the
 * buyer pays it (BUYER payer). It does NOT include processing or tax. Null
 * for a listing priced before the share existed.
 */
export function buyerTotalBeforeFeesCents(listing: ListingShare): number | null {
  return amountsOf(listing)?.basisCents ?? null;
}

/**
 * What the buyer pays before tax: the ticket total plus the listing's
 * pre-tax processing pass-through, the exact value checkout charges when
 * there is no tax. With tax, checkout adds the tax and the processing on it
 * (`solveResaleCharge`). Null for a listing priced before the share existed.
 */
export function buyerTotalBeforeTaxCents(
  listing: ListingShare & { processingPassThroughCents: number },
): number | null {
  const basis = buyerTotalBeforeFeesCents(listing);
  return basis == null ? null : basis + listing.processingPassThroughCents;
}

/**
 * The tax, processing and total a resale buyer is charged on this listing,
 * from the listing's own amounts, the venue's tax lines and the processor
 * rate of the fee policy the listing froze. The SAME solve
 * `createResaleCheckout` charges with (`solveResaleCharge`): the basis (ask,
 * plus a buyer-paid share) is the taxable gross, no platform fee, and
 * processing grossed up over the whole charge, tax included. `impositions`
 * must be resolved exactly as checkout resolves them for this sale.
 *
 * Null for a listing priced before the share existed (checkout refuses it).
 */
export function resaleBuyerTaxEstimate(
  listing: ListingShare,
  impositions: TaxImposition[],
  processor: { pct: number; fixedCents: number },
): { taxCents: number; processingCents: number; totalCents: number } | null {
  const basis = buyerTotalBeforeFeesCents(listing);
  if (basis == null) return null;
  const charge = solveResaleCharge({
    basisCents: basis,
    taxLines: impositions,
    processorPct: processor.pct,
    processorFixedCents: processor.fixedCents,
  });
  return {
    taxCents: charge.taxCents,
    processingCents: charge.processingPassThroughCents,
    totalCents: charge.totalCents,
  };
}

type ListingWithPolicyRef = ListingShare & {
  id: string;
  processingPassThroughCents: number;
  processingFeeConfigRef: string | null;
};

/**
 * The fee policies the listings froze, in ONE batched read, for
 * {@link withCurrentProcessing}. A listing priced before the share has no total
 * to show and is skipped. A failed read, or a share listing whose policy is
 * missing, is a deliberate swallow (the reader falls back to the stored
 * figure): reported once per response, guarded, so a throwing reporter never
 * changes a read.
 */
export async function loadListingFeePolicies(
  deps: { repos: Repos; reportError?: ReporterPort },
  useCase: string,
  listings: ReadonlyArray<ListingWithPolicyRef>,
): Promise<Map<string, FeePolicyRecord>> {
  const priced = listings.filter(
    (l) => l.eventShareCents != null && l.sharePayer,
  );
  const refs = [
    ...new Set(
      priced
        .map((l) => l.processingFeeConfigRef)
        .filter((ref): ref is string => ref != null),
    ),
  ];
  let policies = new Map<string, FeePolicyRecord>();
  let failure: unknown = null;
  if (refs.length > 0) {
    try {
      policies = await deps.repos.feePolicies.getByIds(refs);
    } catch (err) {
      failure = err;
    }
  }
  const missing = priced.filter(
    (l) =>
      l.processingFeeConfigRef == null ||
      !policies.has(l.processingFeeConfigRef),
  );
  if (failure != null || missing.length > 0) {
    try {
      deps.reportError?.(
        failure ??
          new Error(
            `${useCase}: resale listing fee policy missing; showing the stored processing`,
          ),
        {
          tags: { useCase },
          extra: {
            stage: "listing_processing",
            count: missing.length,
            listingIds: missing.slice(0, 20).map((l) => l.id),
          },
        },
      );
    } catch {
      // Reporting is best-effort; a read must not break on it.
    }
  }
  return policies;
}

/**
 * The listing with its pre-tax processing derived NOW from the fee policy it
 * froze: the figure `createResaleCheckout` charges at zero tax
 * (`solveResaleCharge`). A listing made before the processing gross-up stored
 * the older, lower markup; reading it this way shows old and new listings the
 * same number checkout charges. Falls back to the stored value when the
 * listing has no total or its policy was not read (reported by the loader).
 */
export function withCurrentProcessing<T extends ListingWithPolicyRef>(
  listing: T,
  policies: ReadonlyMap<string, FeePolicyRecord>,
): T {
  const basis = buyerTotalBeforeFeesCents(listing);
  const policy = listing.processingFeeConfigRef
    ? policies.get(listing.processingFeeConfigRef)
    : undefined;
  if (basis == null || !policy) return listing;
  const { processingPassThroughCents } = solveResaleCharge({
    basisCents: basis,
    taxLines: [],
    processorPct: policy.processsorFeePct,
    processorFixedCents: policy.processorFixedCents,
  });
  return { ...listing, processingPassThroughCents };
}

/**
 * What the seller nets before payout timing: the ask, less the share when the
 * seller pays it. Null for a listing priced before the share existed.
 */
export function sellerReceivesCents(listing: ListingShare): number | null {
  return amountsOf(listing)?.sellerReceivesCents ?? null;
}

/** The three buyer-facing figures every public listing read carries. */
export function listingShareFigures(
  listing: ListingShare & { processingPassThroughCents: number },
) {
  return {
    eventShareCents: listing.eventShareCents ?? null,
    sharePayer: listing.sharePayer ?? null,
    processingPassThroughCents: listing.processingPassThroughCents,
    buyerTotalBeforeFeesCents: buyerTotalBeforeFeesCents(listing),
    buyerTotalBeforeTaxCents: buyerTotalBeforeTaxCents(listing),
  };
}

/**
 * The ticket's original price and its type's pricing facts, from rows a read
 * already holds (no fetch).
 *
 * `originalPriceCents` is the recorded `OrderItem.originalUnitPriceCents` of
 * the ticket's purchase item: the organiser's price at the FIRST sale, copied
 * down every resale hop, never the previous resale price. Any listing priced
 * under the share has it (the listing writes the record, FR-004). Null for a
 * listing made before the share existed, whose item may record none.
 */
export function ticketFactsFromRows(
  rows: {
    purchaseItem: { originalUnitPriceCents?: number | null } | null;
    ticketType:
      | (Parameters<typeof resolveUnitPriceCents>[0] & {
          pricingMode: "FIXED" | "ADJUSTABLE";
          minimumCents: number | null;
        })
      | null;
  },
  now: Date,
): {
  originalPriceCents: number | null;
  ticketTypePricing: TicketTypePricingFacts | null;
} {
  return {
    originalPriceCents: rows.purchaseItem?.originalUnitPriceCents ?? null,
    ticketTypePricing: rows.ticketType
      ? ticketTypePricingFacts(rows.ticketType, now)
      : null,
  };
}

/**
 * A listing priced under the share whose ticket records no original price is
 * a data defect (the listing writes the record, FR-004). Reports it, guarded:
 * a throwing reporter never changes a read.
 */
export function reportMissingOriginalPrice(
  reportError: ReporterPort | undefined,
  useCase: string,
  listingIds: string[],
  extra: Record<string, unknown> = {},
): void {
  if (listingIds.length === 0) return;
  try {
    reportError?.(
      new Error(`${useCase}: listing priced under a share has no original price`),
      {
        tags: { useCase },
        extra: { ...extra, count: listingIds.length, listingIds: listingIds.slice(0, 20) },
      },
    );
  } catch {
    // Reporting is best-effort; a read must not break on it.
  }
}
