import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";
import { fail } from "@th/errors";
import { getMetaNumber, getMetaString } from "../../lib/orders/meta";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";

/**
 * The seller's share of a RESALE order, resolved at finalize.
 *
 * `createResaleCheckout` stamps the pricing onto the order's ticket item: the
 * organiser's resale share (organiser-resale-share spec FR-005),
 * `eventShareCents` + `sharePayer`, from `computeResaleShare`
 * (`lib/pricing/resale-pricing.ts`). The basis is the ask (SELLER pays the
 * share) or ask + share (BUYER pays it):
 *
 *      seller         = basis − share   (SELLER: ask − share; BUYER: ask)
 *      organiser side = share
 *
 * An item with no share was priced under the markup split, which is gone
 * with its columns (FR-014). Such an order can only be one that was already
 * CANCELLED before the split was removed (the removing migration refuses to
 * run while one is unfinished), so finalize normally refuses it earlier with
 * ORDER_NOT_PROCESSABLE. If one gets here anyway it is refused
 * (RESALE_PURCHASE_PRICE_UNKNOWN): never paid out on a guessed split.
 *
 * Seller + organiser side = the agreement basis, to the cent, and
 * the platform takes nothing on a resale order (owner ruling R11; the order's
 * `feesPlatformCents` is 0). Finalize writes the seller as ONE OrderSplit row
 * for exactly `sellerCents`, and runs the event's RESALE payout-terms lines
 * over `organiserShareCents` only. Writing the seller as a split (rather than a side-channel credit) is
 * what makes every downstream path treat them like any other payee with no
 * resale special case:
 *   - `createCreditsFromOrder` mints their SETTLEMENT_CREDIT under the same
 *     `settlement-credit:${orderId}:${payeeId}` key, with the same resale hold;
 *   - every refund path (`writeRefundDebitsForOrder` and the external-amount
 *     writer) debits each credited payee, so the seller's credit unwinds with
 *     the organiser's;
 *   - the dispute lifecycle allocates holds and loss debits over the splits;
 *   - the payable query's open-claim exclusion keys on the order, so the
 *     seller's credit is frozen by a claim like everyone else's;
 *   - the ledger completeness sweep compares credits against splits.
 *
 * Before this existed the whole ask went over the RESALE lines, so the
 * organiser was credited the seller's money and the seller got nothing.
 */
export type ResaleSellerSplit = {
  listingId: string;
  sellerHumanId: string;
  sellerPayeeId: string;
  /** Exact: basis − share. */
  sellerCents: number;
  /** What the RESALE payout-terms lines split: basis − sellerCents. */
  organiserShareCents: number;
  /**
   * True when the seller had no HUMAN payee at finalize and a PENDING
   * placeholder was created to hold their credit. The CALLER reports it after
   * its transaction commits (so a rolled-back or retried finalize never
   * reports a placeholder that does not exist).
   */
  placeholderPayeeCreated: boolean;
  /**
   * The RESALE payout terms the listing was priced against
   * (`listing.resalePayoutTermsId`, snapshotted from the event at listing
   * time). `createResaleCheckout` prices against
   * `listing.resalePayoutTermsId ?? event.resalePayoutTermsId`; finalize must
   * split over the same terms, so it applies the same fallback.
   */
  listingResalePayoutTermsId: string | null;
};

export async function resolveResaleSellerSplit(
  tx: Pick<TxRepos, "resaleListings" | "payees">,
  params: {
    order: Pick<OrderRecord, "id" | "eventId" | "items">;
    /** The agreement basis the splits must sum to (`computeAgreementBasis`). */
    basisCents: number;
    logger?: LoggerPort;
  },
): Promise<ResaleSellerSplit> {
  const { order, basisCents, logger } = params;

  // ── The snapshot ─────────────────────────────────────────────────────────
  // A resale order carries exactly one ticket item (refund-order-items
  // refuses RESALE for the same reason). Anything else has no single seller to
  // route the money to, so it fails closed: the throw aborts finalize, the
  // webhook retries and DLQs, and the paid order is left for manual review.
  // That is the precedent `finalizeResalePurchase` sets for
  // RESALE_ORIGINAL_ITEM_REFUNDED: never pay the wrong party to keep a
  // webhook green.
  const ticketItems = order.items.filter((item) => item.kind === "ticket");
  if (ticketItems.length !== 1) {
    return refuse(logger, "RESALE_PURCHASE_PRICE_UNKNOWN", {
      orderId: order.id,
      reason: "resale_order_ticket_item_count",
      ticketItemCount: ticketItems.length,
    });
  }
  const item = ticketItems[0]!;

  const priced = resolveSellerAndShare(item, basisCents);
  if (!priced.ok) {
    return refuse(logger, "RESALE_PURCHASE_PRICE_UNKNOWN", {
      orderId: order.id,
      orderItemId: item.id,
      basisCents,
      ...priced.meta,
    });
  }
  const { sellerCents, organiserShareCents } = priced;

  // ── The seller ───────────────────────────────────────────────────────────
  const listingId =
    item.resaleListingId ?? getMetaString(item.meta, "resaleListingId");
  if (!listingId) {
    return refuse(logger, "LISTING_NOT_FOUND", {
      orderId: order.id,
      orderItemId: item.id,
      reason: "resale_order_missing_listing_id",
    });
  }
  const listing = await tx.resaleListings.getById(listingId);
  if (!listing) {
    return refuse(logger, "LISTING_NOT_FOUND", {
      orderId: order.id,
      listingId,
      reason: "resale_listing_not_found_at_finalize",
    });
  }
  const sellerHumanId = listing.sellerHumanId;

  // `createResaleListing` refuses a seller whose payee can't be paid (no
  // Stripe account or payouts off; SELLER_PAYOUT_NOT_SETUP), so a miss here
  // means the payee went away after listing. The buyer has already paid; the seller's money must neither go
  // to the organiser nor strand the webhook. Same move `update-event-splits`
  // makes for a payout-line target without a payee: create the PENDING
  // placeholder (no Stripe account, payouts disabled). The credit accrues
  // there, `run-batch` skips it as `payee_missing_stripe_account` (reported
  // every night), and it pays out once the seller connects Stripe. No new
  // money state. It is a degraded path that should be unreachable, so the
  // caller reports it (`reportResaleSellerPlaceholder`) AFTER its
  // transaction commits.
  const existingPayee = await tx.payees.getBySubject({
    type: "HUMAN",
    id: sellerHumanId,
  });
  let sellerPayeeId: string;
  let placeholderPayeeCreated = false;
  if (existingPayee) {
    sellerPayeeId = existingPayee.id;
  } else {
    const created = await tx.payees.upsertForSubject({
      subjectType: "HUMAN",
      subjectId: sellerHumanId,
    });
    sellerPayeeId = created.id;
    placeholderPayeeCreated = true;
  }

  return {
    listingId,
    sellerHumanId,
    sellerPayeeId,
    sellerCents,
    organiserShareCents,
    placeholderPayeeCreated,
    listingResalePayoutTermsId: listing.resalePayoutTermsId ?? null,
  };
}

/**
 * Report a placeholder seller payee — call ONLY after the finalize
 * transaction has committed, so the report always describes a payee and a
 * credit that exist. `logger.error` + `reportError` per the CLAUDE.md
 * convention (a deliberate degrade, not a throw); a throwing reporter never
 * changes behaviour.
 */
export function reportResaleSellerPlaceholder(
  deps: { logger?: LoggerPort; reportError?: ReporterPort | null },
  ctx: { orderId: string; eventId: string | null; seller: ResaleSellerSplit },
): void {
  if (!ctx.seller.placeholderPayeeCreated) return;
  const extra = {
    orderId: ctx.orderId,
    eventId: ctx.eventId,
    listingId: ctx.seller.listingId,
    sellerHumanId: ctx.seller.sellerHumanId,
    placeholderPayeeId: ctx.seller.sellerPayeeId,
    sellerCents: ctx.seller.sellerCents,
  };
  const err = new Error("resale_seller_payee_missing_at_finalize");
  deps.logger?.error("finalizePaymentIntent.resale_seller_payee_missing", {
    ...extra,
    err,
  });
  reportBestEffort(deps.reportError, err, {
    tags: {
      useCase: "finalizePaymentIntent",
      reason: "resale_seller_payee_missing",
    },
    extra,
  });
}

/**
 * Fold the seller's row into the organiser-side split rows. OrderSplit is
 * unique on (orderId, payeeId), so a seller who is also on the RESALE lines
 * (e.g. a performer reselling their own ticket) gets ONE row carrying both.
 * A zero seller amount (a free ticket resold for 0) adds nothing.
 */
export function mergeSellerIntoSplits(
  splits: ReadonlyArray<{ payeeId: string; amountCents: number }>,
  seller: { payeeId: string; amountCents: number },
): Array<{ payeeId: string; amountCents: number }> {
  const merged = splits.map((split) => ({ ...split }));
  if (seller.amountCents <= 0) return merged;
  const existing = merged.find((split) => split.payeeId === seller.payeeId);
  if (existing) {
    existing.amountCents += seller.amountCents;
  } else {
    merged.push({ payeeId: seller.payeeId, amountCents: seller.amountCents });
  }
  return merged;
}

type ResaleSnapshotItem = Pick<
  OrderRecord["items"][number],
  "meta" | "eventShareCents" | "sharePayer"
>;

/**
 * The seller's cents and the organiser side's from the item's snapshot,
 * checked to the cent: seller + organiser side = basis, both non-negative
 * integers. A row that breaks it was not written by the checkout, and
 * guessing either share would move real money, so it refuses.
 *
 * It also re-checks the share against the ask it was priced on
 * (`meta.resaleAskPriceCents`, written by every share checkout): the ask is
 * the basis (SELLER) or basis − share (BUYER), and the share is at most 10%
 * of it (FR-002).
 */
function resolveSellerAndShare(
  item: ResaleSnapshotItem,
  basisCents: number,
):
  | { ok: true; sellerCents: number; organiserShareCents: number }
  | { ok: false; meta: Record<string, unknown> } {
  const shareCents = item.eventShareCents ?? null;
  const sharePayer = item.sharePayer ?? null;

  if (shareCents == null && sharePayer == null) {
    // Priced under the markup split, which is gone (FR-014; see the header).
    return {
      ok: false,
      meta: { reason: "resale_share_snapshot_missing" },
    };
  }

  const askCents = getMetaNumber(item.meta, "resaleAskPriceCents");
  const inconsistent = {
    ok: false as const,
    meta: {
      reason: "resale_share_snapshot_inconsistent",
      eventShareCents: shareCents,
      sharePayer,
      resaleAskPriceCents: askCents,
    },
  };
  if (
    shareCents == null ||
    (sharePayer !== "SELLER" && sharePayer !== "BUYER") ||
    !Number.isInteger(shareCents) ||
    !Number.isInteger(basisCents) ||
    shareCents < 0
  ) {
    return inconsistent;
  }
  const sellerCents = basisCents - shareCents;
  const pricedAskCents =
    sharePayer === "BUYER" ? basisCents - shareCents : basisCents;
  if (
    sellerCents < 0 ||
    // FR-002: never more than 10% of the ask it was priced on.
    shareCents * 10 > pricedAskCents ||
    (askCents !== null && askCents !== pricedAskCents) ||
    sellerCents + shareCents !== basisCents
  ) {
    return inconsistent;
  }
  return { ok: true, sellerCents, organiserShareCents: shareCents };
}

function refuse(
  logger: LoggerPort | undefined,
  code: "RESALE_PURCHASE_PRICE_UNKNOWN" | "LISTING_NOT_FOUND",
  meta: Record<string, unknown>,
): never {
  logger?.error("finalizePaymentIntent.resale_seller_unroutable", {
    code,
    ...meta,
  });
  return fail(code, { meta });
}
