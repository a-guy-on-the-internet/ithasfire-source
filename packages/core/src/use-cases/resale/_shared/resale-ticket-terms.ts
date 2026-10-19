import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type {
  OrderItemRecord,
  OrderRecord,
  ResaleClauseFillInput,
} from "@th/types/repos/orders";

import { getMetaString } from "../../../lib/orders/meta";
import {
  reportBestEffort,
  resolveScopedFeePolicy,
} from "../../../lib/payments/resolve-scoped-fee-policy";
import {
  checkResaleAskWithinCap,
  computeResaleShare,
  highestAskWithinCapCents,
  RESALE_LISTING_MAX_ASK_CENTS,
  resaleClauseFromRecord,
  type ResaleShare,
  type ResaleShareClause,
} from "../../../lib/pricing/resale-pricing";
import { resolveTicketResaleClause } from "../../orders/_shared/resolve-ticket-resale-clause";

// ── The terms one resale of a ticket is priced under ──
// organiser-resale-share spec FR-002, FR-004, FR-005, FR-007, FR-013.
//
// A ticket's resale clause and original price are the record on the OrderItem
// it is held by (`Ticket.orderItemId`), written at its first sale (FR-003)
// and copied down the chain. The listing, the seller's estimate and the
// checkout all read it here, so every amount a seller or buyer sees comes
// from the same functions the server charges with (NFR-002).

/** Satisfied by both `Repos` and `TxRepos`. */
export type ResaleTermsRepos = Pick<
  TxRepos,
  "orderItems" | "orders" | "payoutTerms"
>;

export type ResaleTicketTerms = {
  /** The clause this resale is priced under. */
  clause: ResaleShareClause;
  /** "Original price" (FR-007): the organiser's unit price at the first sale. */
  originalUnitPriceCents: number;
  /**
   * The FR-004 record to write onto the purchase item, when it records no
   * clause yet; null when the item already carries one. Written only by the
   * listing (`fillResaleTermsOnce`); the estimate reports what it would be.
   */
  fill: ResaleClauseFillInput | null;
};

/** The longest resale chain walked back for an original price. */
const MAX_CHAIN_HOPS = 1000;

/**
 * The organiser's price at the ticket's first sale (R15), for a purchase item
 * that records none: a ticket sold before the record existed.
 *
 *  - bought at a first sale (any order source but RESALE): that item's own
 *    `unitPriceCents`, the same number a primary sale stamps (FR-003);
 *  - bought on resale: walked back through each resale item's
 *    `meta.resaleOriginalOrderItemId` (the seller's item, written by every
 *    resale checkout) to the first-sale item. An item on the way that
 *    already records an original price answers for the rest of the chain.
 *
 * Null when the chain breaks (an item or order that cannot be read, a resale
 * item with no link back, a cycle): the true original is then unknown, and
 * the caller refuses rather than record the previous resale price as the
 * organiser's.
 */
export async function resolveOriginalUnitPriceCents(
  repos: Pick<TxRepos, "orderItems" | "orders">,
  purchaseItem: Pick<
    OrderItemRecord,
    "id" | "unitPriceCents" | "meta" | "originalUnitPriceCents"
  >,
  purchaseOrder: Pick<OrderRecord, "source">,
): Promise<number | null> {
  if (purchaseItem.originalUnitPriceCents != null) {
    return purchaseItem.originalUnitPriceCents;
  }
  if (purchaseOrder.source !== "RESALE") return purchaseItem.unitPriceCents;

  const seen = new Set<string>([purchaseItem.id]);
  let previousItemId = getMetaString(
    purchaseItem.meta,
    "resaleOriginalOrderItemId",
  );
  for (let hop = 0; hop < MAX_CHAIN_HOPS && previousItemId; hop++) {
    if (seen.has(previousItemId)) return null;
    seen.add(previousItemId);
    const item = await repos.orderItems.getById(previousItemId);
    if (!item) return null;
    if (item.originalUnitPriceCents != null) return item.originalUnitPriceCents;
    const order = await repos.orders.getById(item.orderId);
    if (!order) return null;
    if (order.source !== "RESALE") return item.unitPriceCents;
    previousItemId = getMetaString(item.meta, "resaleOriginalOrderItemId");
  }
  return null;
}

/**
 * The clause and original price one resale of this ticket is priced under.
 *
 * The purchase item's own record when it has one, whatever the event's
 * clause says now (R10 "Fixed"). Otherwise (FR-004) the event's clause at
 * this moment with the original price from `resolveOriginalUnitPriceCents`,
 * returned as `fill` for the listing to write once.
 *
 * Refuses, never guesses:
 *  - RESALE_TERMS_MISSING: no record and the event's clause is not set (a
 *    resale needs a clause, FR-001);
 *  - RESALE_PURCHASE_PRICE_UNKNOWN (`original_price_unknown`): no record and
 *    the chain back to the first sale is broken. The record cannot be written
 *    without an original price (`OrderItem_resale_clause_complete_check`).
 */
export async function resolveResaleTicketTerms(
  repos: ResaleTermsRepos,
  params: {
    event: Pick<EventRecord, "id" | "resalePayoutTermsId">;
    purchaseItem: OrderItemRecord;
    purchaseOrder: Pick<OrderRecord, "source">;
  },
): Promise<ResaleTicketTerms> {
  const { event, purchaseItem, purchaseOrder } = params;

  const recorded = resaleClauseFromRecord(purchaseItem);
  if (recorded) {
    if (purchaseItem.originalUnitPriceCents == null) {
      // Unreachable under `OrderItem_resale_clause_complete_check`.
      throw fail("INTERNAL", {
        message: `resale_clause_record_without_original_price: order item ${purchaseItem.id}`,
        meta: { orderItemId: purchaseItem.id },
      });
    }
    return {
      clause: recorded,
      originalUnitPriceCents: purchaseItem.originalUnitPriceCents,
      fill: null,
    };
  }

  const eventClause = await resolveTicketResaleClause(repos, event);
  if (
    eventClause.resaleClauseType == null ||
    eventClause.resaleClausePayer == null ||
    eventClause.resaleClauseTermsId == null ||
    eventClause.resaleClauseTermsVersion == null
  ) {
    throw fail("RESALE_TERMS_MISSING", {
      meta: { eventId: event.id, reason: "resale_share_clause_missing" },
    });
  }

  const originalUnitPriceCents = await resolveOriginalUnitPriceCents(
    repos,
    purchaseItem,
    purchaseOrder,
  );
  if (originalUnitPriceCents == null) {
    throw fail("RESALE_PURCHASE_PRICE_UNKNOWN", {
      meta: {
        orderItemId: purchaseItem.id,
        reason: "original_price_unknown",
      },
    });
  }

  const fill: ResaleClauseFillInput = {
    resaleClauseType: eventClause.resaleClauseType,
    resaleClauseBps: eventClause.resaleClauseBps,
    resaleClauseCents: eventClause.resaleClauseCents,
    resaleClausePayer: eventClause.resaleClausePayer,
    resaleClauseTermsId: eventClause.resaleClauseTermsId,
    resaleClauseTermsVersion: eventClause.resaleClauseTermsVersion,
    originalUnitPriceCents,
  };
  const clause = resaleClauseFromRecord({ id: purchaseItem.id, ...fill });
  if (!clause) {
    throw fail("INTERNAL", {
      message: `resale_clause_fill_unparsed: order item ${purchaseItem.id}`,
      meta: { orderItemId: purchaseItem.id },
    });
  }
  return { clause, originalUnitPriceCents, fill };
}

/**
 * FR-004: writes `terms.fill` onto the purchase item, once, inside the
 * listing transaction (`fillResaleClauseIfUnset`, a conditional write on
 * `resaleClauseType IS NULL`). Returns the terms the item now records:
 *  - this call wrote the fill: the fill;
 *  - a concurrent listing wrote one first (the write matched nothing): the
 *    item is read again and ITS record is used, so a ticket is priced under
 *    one clause however many listings race for it.
 * No-op when there is nothing to fill.
 */
export async function fillResaleTermsOnce(
  tx: Pick<TxRepos, "orderItems">,
  purchaseItemId: string,
  terms: ResaleTicketTerms,
): Promise<ResaleTicketTerms> {
  if (!terms.fill) return terms;
  const wrote = await tx.orderItems.fillResaleClauseIfUnset(
    purchaseItemId,
    terms.fill,
  );
  if (wrote) return terms;

  const item = await tx.orderItems.getById(purchaseItemId);
  const clause = item ? resaleClauseFromRecord(item) : null;
  if (!item || !clause || item.originalUnitPriceCents == null) {
    // The write matched no row although the item was read without a clause
    // in this transaction: the item is gone, or a write cleared the record.
    throw fail("INTERNAL", {
      message: `resale_clause_fill_lost: order item ${purchaseItemId}`,
      meta: { orderItemId: purchaseItemId },
    });
  }
  return {
    clause,
    originalUnitPriceCents: item.originalUnitPriceCents,
    fill: null,
  };
}

export type PricedResaleAsk = {
  share: ResaleShare;
  /** The ticket's cap (`effectiveResaleCapCents`), null when uncapped. */
  capCents: number | null;
  /** The basis (ask, plus the share when the buyer pays it) fits the cap. */
  withinCap: boolean;
  /**
   * The highest ask whose basis fits the cap (FR-002), never above
   * RESALE_LISTING_MAX_ASK_CENTS; null when the ticket is uncapped.
   */
  highestFittingAskCents: number | null;
};

/**
 * Prices one asking price under the ticket's clause and checks it against
 * the ticket's cap (FR-002). `capCents` is the caller's
 * `effectiveResaleCapCents` result, floored at the ticket's ORIGINAL price
 * (FR-007), never the previous resale price; every caller computes it there
 * so the cap rule stays in one place (`resale-cap-invariant.test.ts`). With a
 * BUYER clause the basis (ask + share) must fit the cap; with SELLER the ask
 * alone.
 */
export function priceResaleAsk(input: {
  askCents: number;
  clause: ResaleShareClause;
  /** `effectiveResaleCapCents(...)`; null = uncapped. */
  capCents: number | null;
}): PricedResaleAsk {
  const { capCents } = input;
  const share = computeResaleShare({
    askCents: input.askCents,
    clause: input.clause,
  });
  const check = checkResaleAskWithinCap({
    askCents: input.askCents,
    clause: input.clause,
    capCents,
  });
  const highestFittingAskCents =
    capCents == null
      ? null
      : Math.min(
          highestAskWithinCapCents({ clause: input.clause, capCents }) ?? 0,
          RESALE_LISTING_MAX_ASK_CENTS,
        );
  return { share, capCents, withinCap: check.ok, highestFittingAskCents };
}

/**
 * The fee policy a resale's processing pass-through is priced from (FR-013):
 * the one a PRIMARY sale of the event uses. That is the policy pinned on the
 * event's ACTIVE primary terms when there is one (`publishEvent` pins it),
 * else the EVENT → ORG → GLOBAL walk (`resolveScopedFeePolicy`), exactly as
 * `loadPayoutTermsContext` resolves it. Never the RESALE terms' own fee
 * policy: a resale no longer needs its agreement to carry one.
 *
 * FEE_POLICY_NOT_FOUND when a pin names a policy that is gone (reported, as
 * in `loadPayoutTermsContext`) or no policy is in force at any scope.
 */
export async function resolveResaleFeePolicy(
  tx: Pick<TxRepos, "payoutTerms" | "feePolicies">,
  event: Pick<EventRecord, "id" | "orgId">,
  now: Date,
  options: { logger?: LoggerPort; reportError?: ReporterPort | null },
): Promise<FeePolicyRecord> {
  const terms = await tx.payoutTerms.listByEvent(event.id);
  const primary =
    terms.find((t) => t.kind === "PRIMARY" && t.status === "ACTIVE") ??
    // The legacy enum value `loadPayoutTermsContext` still accepts.
    terms.find(
      (t) => (t.kind as string) === "PRIMARY_SPLIT" && t.status === "ACTIVE",
    );

  if (primary?.feePolicyId) {
    const pinned = await tx.feePolicies.getById(primary.feePolicyId);
    if (pinned) return pinned;
    const dangling = new Error(
      `fee_policy_pin_dangling: PayoutTerms ${primary.id} pins FeePolicy ${primary.feePolicyId}, which no longer exists`,
    );
    options.logger?.error("resale_fee_policy_pin_dangling", {
      eventId: event.id,
      payoutTermsId: primary.id,
      feePolicyId: primary.feePolicyId,
      err: dangling,
    });
    reportBestEffort(options.reportError, dangling, {
      tags: { useCase: "resolveResaleFeePolicy", fault: "dangling_pin" },
      extra: {
        eventId: event.id,
        payoutTermsId: primary.id,
        feePolicyId: primary.feePolicyId,
      },
    });
    throw fail("FEE_POLICY_NOT_FOUND", { meta: { scope: "resale" } });
  }

  const resolved = await resolveScopedFeePolicy(
    tx as TxRepos,
    { eventId: event.id, orgId: event.orgId ?? null },
    now,
    {
      logger: options.logger,
      reportError: options.reportError,
      source: "resolveResaleFeePolicy",
    },
  );
  if (!resolved) {
    throw fail("FEE_POLICY_NOT_FOUND", { meta: { scope: "resale" } });
  }
  return resolved;
}
