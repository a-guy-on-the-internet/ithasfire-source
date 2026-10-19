import { fail } from "@th/errors";
import type { PayoutTermsRepo } from "@th/ports/repos/payout-terms";
import type {
  CreateOrderItemInput,
  OrderItemRecord,
} from "@th/types/repos/orders";

import { resaleShareClauseSchema } from "../../../lib/pricing/resale-pricing";

// ── The resale clause a ticket records at its first sale ──
// organiser-resale-share spec FR-003 (owner rulings R2, R10 "Fixed", R15).
//
// Every primary sale writes, on each ticket's OrderItem, the resale clause in
// force on the event's RESALE PayoutTerms at that sale, plus the ticket's
// original unit price. A resale copies the record from the seller's purchase
// item onto the buyer's item (`copyTicketResaleClause`), so the clause and the
// original price travel down the chain unchanged; changing the event's clause
// applies only to tickets sold afterwards.
//
// The shape matches the OrderItem CHECKs
// (`OrderItem_resale_clause_shape_check`, `OrderItem_resale_clause_complete_check`):
//   * a set clause carries amount, payer, terms id + version and the original price;
//   * an unset clause records no terms id or version, but the original price is
//     still recorded on every ticket (FR-007's cap floor reads it).

/** The clause columns of the FR-003 record, as read once per order. */
export type TicketResaleClause = {
  resaleClauseType: "PERCENT" | "FLAT" | null;
  resaleClauseBps: number | null;
  resaleClauseCents: number | null;
  resaleClausePayer: "SELLER" | "BUYER" | null;
  resaleClauseTermsId: string | null;
  resaleClauseTermsVersion: number | null;
};

/** The full FR-003 record written onto one ticket's OrderItem. */
export type TicketResaleClauseRecord = TicketResaleClause & {
  originalUnitPriceCents: number | null;
};

/** No clause: what a sale records while the event's clause is not set. */
export const NO_RESALE_CLAUSE: TicketResaleClause = Object.freeze({
  resaleClauseType: null,
  resaleClauseBps: null,
  resaleClauseCents: null,
  resaleClausePayer: null,
  resaleClauseTermsId: null,
  resaleClauseTermsVersion: null,
});

/** Satisfied by both `Repos` and `TxRepos`. */
export type ResolveTicketResaleClauseRepos = {
  payoutTerms: Pick<PayoutTermsRepo, "getById">;
};

export type ResolveTicketResaleClauseEvent = {
  id: string;
  resalePayoutTermsId: string | null;
};

/**
 * The resale clause in force on the event's RESALE terms right now: read ONCE
 * per order, then applied to each ticket item with `stampTicketResaleClause`.
 *
 * Call it with the transaction that creates (or re-prices) the order, beside
 * the primary terms read, so the clause recorded is one that was in force
 * while the order was written. No lock: the record has no invariant spanning
 * the two rows, and an edit that commits after the read simply applies to the
 * tickets sold after it (FR-003).
 *
 * Returns `NO_RESALE_CLAUSE` when the event has no RESALE terms or their
 * clause is not set. Throws INTERNAL when the event names terms that cannot
 * be read, or a clause that does not parse: both are unreachable under the FK
 * and the `PayoutTerms_resale_share_shape_check` CHECK, and recording nothing
 * instead would let a later listing stamp a different clause than the one in
 * force at this sale.
 */
export async function resolveTicketResaleClause(
  repos: ResolveTicketResaleClauseRepos,
  event: ResolveTicketResaleClauseEvent,
): Promise<TicketResaleClause> {
  if (!event.resalePayoutTermsId) return NO_RESALE_CLAUSE;

  const terms = await repos.payoutTerms.getById(event.resalePayoutTermsId);
  if (!terms) {
    throw fail("INTERNAL", {
      message: `resale_terms_missing: event ${event.id} names resale terms ${event.resalePayoutTermsId}`,
      meta: {
        eventId: event.id,
        resalePayoutTermsId: event.resalePayoutTermsId,
      },
    });
  }
  if (terms.resaleShareType == null) return NO_RESALE_CLAUSE;

  const parsed = resaleShareClauseSchema.safeParse({
    type: terms.resaleShareType,
    bps: terms.resaleShareBps ?? null,
    cents: terms.resaleShareCents ?? null,
    payer: terms.resaleSharePayer ?? "SELLER",
  });
  if (!parsed.success) {
    throw fail("INTERNAL", {
      message: `resale_clause_invalid: terms ${terms.id}`,
      meta: { eventId: event.id, payoutTermsId: terms.id },
    });
  }
  const clause = parsed.data;
  return {
    resaleClauseType: clause.type,
    resaleClauseBps: clause.type === "PERCENT" ? clause.bps : null,
    resaleClauseCents: clause.type === "FLAT" ? clause.cents : null,
    resaleClausePayer: clause.payer,
    resaleClauseTermsId: terms.id,
    resaleClauseTermsVersion: terms.version,
  };
}

/**
 * Writes the FR-003 record onto every `ticket` item of a primary sale: the
 * clause read by `resolveTicketResaleClause`, and `originalUnitPriceCents` =
 * that item's own `unitPriceCents` (the organiser's price at this sale: seat
 * override, pay-what-you-want amount and time-based price included; a promo
 * is a separate `discount` item and a comp is 0). Other kinds are returned
 * unchanged and record nothing. Returns new item objects; the input is not
 * mutated.
 */
export function stampTicketResaleClause<
  T extends { kind: CreateOrderItemInput["kind"]; unitPriceCents: number },
>(
  items: readonly T[],
  clause: TicketResaleClause,
): Array<T & Partial<TicketResaleClauseRecord>> {
  return items.map((item) =>
    item.kind === "ticket"
      ? { ...item, ...clause, originalUnitPriceCents: item.unitPriceCents }
      : item,
  );
}

/**
 * The FR-003 record a resale buyer's item carries: copied from the seller's
 * purchase item (`Ticket.orderItemId`), never re-read from the event's live
 * clause, so the first sale's clause and original price hold on every hop. A
 * legacy purchase item with no record copies nulls (FR-004's fill at first
 * listing is a separate step).
 */
export function copyTicketResaleClause(
  purchaseItem: Pick<
    OrderItemRecord,
    | "resaleClauseType"
    | "resaleClauseBps"
    | "resaleClauseCents"
    | "resaleClausePayer"
    | "resaleClauseTermsId"
    | "resaleClauseTermsVersion"
    | "originalUnitPriceCents"
  >,
): TicketResaleClauseRecord {
  return {
    resaleClauseType: purchaseItem.resaleClauseType ?? null,
    resaleClauseBps: purchaseItem.resaleClauseBps ?? null,
    resaleClauseCents: purchaseItem.resaleClauseCents ?? null,
    resaleClausePayer: purchaseItem.resaleClausePayer ?? null,
    resaleClauseTermsId: purchaseItem.resaleClauseTermsId ?? null,
    resaleClauseTermsVersion: purchaseItem.resaleClauseTermsVersion ?? null,
    originalUnitPriceCents: purchaseItem.originalUnitPriceCents ?? null,
  };
}
