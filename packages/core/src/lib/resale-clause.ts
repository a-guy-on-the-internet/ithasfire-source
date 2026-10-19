import { fail } from "@th/errors";
import type { PayoutTermsRecord } from "@th/types/repos/payout-terms";

import {
  resaleShareClauseSchema,
  type ResaleShareClause,
} from "./pricing/resale-pricing";

// ── The resale clause on a PayoutTerms row (organiser-resale-share FR-001) ──
//
// The clause lives on RESALE PayoutTerms: an event's (`Event.resalePayoutTermsId`)
// and an org's default (`Organization.defaultResalePayoutTermsId`, which new
// events clone). `resaleShareType` null means "not set"; zero (PERCENT 0) is
// a set clause.

type ClauseColumns = Pick<
  PayoutTermsRecord,
  "id" | "resaleShareType" | "resaleShareBps" | "resaleShareCents" | "resaleSharePayer"
>;

/**
 * The clause stored on a terms row, or null when it is not set. Throws
 * INTERNAL when the columns do not parse: the
 * `PayoutTerms_resale_share_shape_check` CHECK makes that unreachable.
 */
export function resaleClauseOfTerms(terms: ClauseColumns): ResaleShareClause | null {
  if (terms.resaleShareType == null) return null;
  const parsed = resaleShareClauseSchema.safeParse(
    terms.resaleShareType === "PERCENT"
      ? { type: "PERCENT", bps: terms.resaleShareBps, payer: terms.resaleSharePayer ?? "SELLER" }
      : { type: "FLAT", cents: terms.resaleShareCents, payer: terms.resaleSharePayer ?? "SELLER" },
  );
  if (!parsed.success) {
    throw fail("INTERNAL", {
      message: `resale_clause_invalid: terms ${terms.id}`,
      meta: { payoutTermsId: terms.id },
    });
  }
  return parsed.data;
}

/** Same clause (type, amount, payer)? Two unset clauses are the same. */
export function sameResaleClause(
  a: ResaleShareClause | null,
  b: ResaleShareClause | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type || a.payer !== b.payer) return false;
  return a.type === "PERCENT"
    ? a.bps === (b as typeof a).bps
    : a.cents === (b as typeof a).cents;
}

/** The four columns a write stores for `clause` (null = clear it). */
export function resaleClauseColumns(clause: ResaleShareClause | null): {
  resaleShareType: "PERCENT" | "FLAT" | null;
  resaleShareBps: number | null;
  resaleShareCents: number | null;
  resaleSharePayer: "SELLER" | "BUYER";
} {
  if (clause === null) {
    // The payer column is NOT NULL with a SELLER default; "not set" is the
    // type alone.
    return {
      resaleShareType: null,
      resaleShareBps: null,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
    };
  }
  return {
    resaleShareType: clause.type,
    resaleShareBps: clause.type === "PERCENT" ? clause.bps : null,
    resaleShareCents: clause.type === "FLAT" ? clause.cents : null,
    resaleSharePayer: clause.payer,
  };
}

/**
 * The FR-001 gates (resale switched on for a ticket type; an event that
 * allows resale publishing): refused while the event's clause is not set
 * (RESALE_TERMS_MISSING) or its RESALE terms carry no payout line to split
 * the share over (AGREEMENT_MISSING_LINES; every listing would be refused).
 *
 * Takes the RESALE terms row lock FIRST and reads under it. Every writer of
 * that row (`setResaleClause`, `updateEventSplits`) holds the same lock, so a
 * clause cleared or a last line removed concurrently is either seen here or
 * sees this caller's switch: never both missed. Call it inside the caller's
 * transaction. Satisfied by `TxRepos`.
 *
 * Lock order: Event row before RESALE terms. `publishEvent` holds the event
 * FOR UPDATE and then calls this; a caller that goes on to INSERT a row
 * referencing the event (a TicketType's FK takes FOR KEY SHARE on it) must
 * take `events.lockRows({ ids: [event.id], mode: "share" })` BEFORE calling
 * this, or the two orders deadlock (40P01). `updateTicketType` needs no event
 * lock: its UPDATE leaves the FK column alone, so it takes no lock on Event.
 */
export async function requireEventResaleClauseSet(
  repos: {
    deals: { lockTerms(id: string): Promise<boolean> };
    payoutTerms: {
      getById(id: string): Promise<PayoutTermsRecord | null>;
      listLines(id: string): Promise<readonly unknown[]>;
    };
  },
  event: { id: string; resalePayoutTermsId?: string | null },
): Promise<void> {
  const termsId = event.resalePayoutTermsId ?? null;
  if (!termsId) {
    throw fail("RESALE_TERMS_MISSING", {
      meta: { eventId: event.id, reason: "resale_terms_missing" },
    });
  }
  const locked = await repos.deals.lockTerms(termsId);
  const terms = locked ? await repos.payoutTerms.getById(termsId) : null;
  if (!terms || resaleClauseOfTerms(terms) === null) {
    throw fail("RESALE_TERMS_MISSING", {
      meta: { eventId: event.id, payoutTermsId: termsId, reason: "resale_clause_not_set" },
    });
  }
  if ((await repos.payoutTerms.listLines(termsId)).length === 0) {
    throw fail("AGREEMENT_MISSING_LINES", {
      meta: { eventId: event.id, payoutTermsId: termsId, reason: "resale_lines_missing" },
    });
  }
}
