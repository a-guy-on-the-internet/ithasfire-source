import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type { ResaleListingReleaseResult } from "@th/ports/repos/resale-listings";
import type { OrderRecord } from "@th/types/repos/orders";

import { getMetaString } from "../../../lib/orders/meta";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";

export type ReleaseResaleListingHoldsResult = {
  /** Listings whose hold this call released, whatever status they went to. */
  releasedListingIds: string[];
  /** Per released listing, where it went (ACTIVE, or closed and why). */
  outcomes: Array<{
    listingId: string;
    result: Extract<ResaleListingReleaseResult, { released: true }>;
  }>;
  /**
   * Resale items whose hold could not be fenced (no listing id, or no
   * parseable `meta.holdExpiresAt`). Reported; the stale-hold sweep in
   * `expireResaleListings` frees the listing later.
   */
  unfencedItemIds: string[];
};

/**
 * Gives back the listing hold of every resale item on an order that THIS
 * transaction just cancelled.
 *
 * Call it only after the order's cancel CAS matched, in the same
 * transaction: the order row is then locked by this transaction and is no
 * longer PENDING, so the listing cannot be finalized under the release.
 * Lock order is the order row, then the listing row, the order finalize and
 * the resale link take them in.
 *
 * The release is fenced on the hold this order took: the buyer and the
 * `heldUntil` that `createResaleCheckout` wrote into the item's
 * `meta.holdExpiresAt` (the same `Date` it passed to `hold`). A newer hold on
 * the same listing, by another buyer or by this buyer's next attempt, never
 * matches, so it is never freed by a stale order. A listing that is no longer
 * HELD (sold, cancelled with its event, already released by the checkout's
 * own unwind) is left as it is.
 *
 * A released listing goes back on sale only if it can still be sold: the
 * adapter closes it instead (CANCELLED or EXPIRED) when its ticket is no
 * longer LISTED, the seller's item was refunded, the event is cancelled or
 * the listing is past `expiresAt`. Those outcomes are logged.
 */
export async function releaseResaleListingHoldsForOrder(
  tx: Pick<TxRepos, "resaleListings">,
  order: Pick<OrderRecord, "id" | "buyerHumanId" | "items">,
  opts: {
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
    caller: string;
    /** Decides the listing's `expiresAt`. Omitted → the adapter's wall clock. */
    now?: Date;
  },
): Promise<ReleaseResaleListingHoldsResult> {
  const result: ReleaseResaleListingHoldsResult = {
    releasedListingIds: [],
    outcomes: [],
    unfencedItemIds: [],
  };

  for (const item of order.items) {
    const listingId =
      item.resaleListingId ?? getMetaString(item.meta, "resaleListingId");
    if (!listingId) continue;

    const holdExpiresAt = getMetaString(item.meta, "holdExpiresAt");
    const heldUntil = holdExpiresAt ? new Date(holdExpiresAt) : null;
    if (!heldUntil || Number.isNaN(heldUntil.getTime())) {
      result.unfencedItemIds.push(item.id);
      opts.logger?.error("release_resale_listing_hold_unfenced", {
        orderId: order.id,
        orderItemId: item.id,
        listingId,
        caller: opts.caller,
      });
      reportBestEffort(
        opts.reportError,
        new Error("release_resale_listing_hold_unfenced"),
        {
          tags: {
            area: "resale",
            step: "releaseResaleListingHoldsForOrder",
            useCase: opts.caller,
          },
          extra: { orderId: order.id, orderItemId: item.id, listingId },
        },
      );
      continue;
    }

    const fence = { buyerHumanId: order.buyerHumanId, heldUntil };
    const released = opts.now
      ? await tx.resaleListings.releaseHold(listingId, fence, { now: opts.now })
      : await tx.resaleListings.releaseHold(listingId, fence);
    if (released.released) {
      result.releasedListingIds.push(listingId);
      result.outcomes.push({ listingId, result: released });
    }
  }

  if (result.outcomes.length > 0) {
    // Non-ACTIVE outcomes carry their reason: a listing closed rather than
    // put back on sale (refunded ticket, cancelled event, past its expiry).
    opts.logger?.info("release_resale_listing_hold_released", {
      orderId: order.id,
      caller: opts.caller,
      outcomes: result.outcomes.map(({ listingId, result: r }) => ({
        listingId,
        listingStatus: r.listingStatus,
        ...("reason" in r ? { reason: r.reason } : {}),
      })),
    });
  }

  return result;
}
