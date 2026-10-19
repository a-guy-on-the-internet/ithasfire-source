/**
 * Stored deal → the calculator's `DealTerms`, and the legacy remainder rule.
 *
 * Storage maps onto the calculator 1:1 (deal-terms.ts): one `PayoutTermsLine`
 * per clause — the per-order lines included, as PERCENT/GROSS clauses — one
 * `PayoutTermsDeduction` per cost off the top, in `sortOrder`, and
 * `PayoutTerms.remainderPayeeId`.
 */
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type {
  DealClauseRecord,
  PayoutTermsDealRecord,
} from "@th/ports/repos/deals";

import type { DealTerms } from "../../../lib/settlement";
import {
  partyOnSide,
  type AgreementSide,
} from "../../booking-agreements/_shared/agreement-access";
import { termsSideForRequest } from "../../booking-agreements/_shared/agreement-editor-side";

/**
 * A stored payout line — what the per-order engine pays (the adapter's
 * FR-005 fence): a PERCENT clause on the GROSS basis, 0% included (a stored
 * 0% line still takes part in the engine's rounding pass).
 */
export function isStoredPerOrderLine(
  clause: Pick<DealClauseRecord, "amountType" | "basis">,
): boolean {
  return clause.amountType === "PERCENT" && clause.basis === "GROSS";
}

export function toDealTerms(
  deal: PayoutTermsDealRecord,
  remainderPayeeId: string,
): DealTerms {
  return {
    clauses: deal.clauses.map((c) => ({
      id: c.id,
      payeeId: c.payeeId,
      amountType: c.amountType,
      amountCents: c.amountCents,
      percent: c.percent,
      basis: c.basis,
      resolution: c.resolution,
      displayLabel: c.displayLabel,
    })),
    deductions: deal.deductions.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      amountCents: d.amountCents,
      percent: d.percent,
      creditedPayeeId: d.creditedPayeeId,
      estimated: d.estimated,
    })),
    remainderPayeeId,
  };
}

// ── The remainder holder, and the LEGACY MAPPING RULE ──────────────────────

/**
 * Where a deal's remainder holder came from. Anything but STORED is derived
 * at read time and labelled, never written back by a read: the remainder
 * holder owes every shortfall, so a guess must never pass for an agreed term
 * (deal-terms.ts header). The first deal write stores an explicit one.
 */
export type DealRemainderSource =
  | "STORED"
  | "LEGACY_EVENT_ORGANISER"
  | "LEGACY_AGREEMENT_EDITOR"
  | "LEGACY_LARGEST_LINE";

export type DealRemainder = {
  payeeId: string;
  source: DealRemainderSource;
};

export type ResolveDealRemainderRepos = Pick<Repos, "payees">;

/**
 * THE LEGACY MAPPING RULE, for terms written before P4b
 * (`remainderPayeeId IS NULL`). First match wins:
 *
 *  1. The event's ORGANISER (its owning org, else its human owner) — the
 *     party the event is accountable to and the merchant of record
 *     (CONTEXT.md "Organiser"). For a booking that minted an event this is
 *     the intent's owner: the venue for a play-here booking, the renter for a
 *     rental — exactly who keeps the door. It is also the right default
 *     owner of door cash (M11).
 *  2. Before any event exists: the booking agreement's EDITOR side (the
 *     venue / organizer, never the act — `termsSideForRequest`).
 *  3. Terms with neither (an org default, an unlinked legacy agreement): the
 *     payee of the largest per-order line, ties by priority (desc) then payee
 *     id (asc) — the per-order engine's own line order.
 *
 * Steps 1–2 only ever READ a Payee row (`getBySubject`); a party with no
 * payee row falls through. Null = nothing matched; callers refuse with
 * DEAL_REMAINDER_UNRESOLVED rather than pick one.
 *
 * Why the choice matters little for money on legacy rows, and why the rule
 * is still explicit: legacy terms are all per-order PERCENT/GROSS lines
 * summing to 100%, so every payee's entitlement on actual numbers is what the
 * engine paid (M9 + the W1 cap) and the sheet settles at $0.00 whoever holds
 * the remainder. The holder still decides who owns un-named door cash (M11)
 * and who would owe any shortfall once a clause settled directly is added.
 */
export async function resolveDealRemainder(
  repos: ResolveDealRemainderRepos,
  input: {
    deal: PayoutTermsDealRecord;
    event?: { orgId: string | null; humanId: string | null } | null;
    agreement?: AgreementRecord | null;
    bookingRequest?: BookingRequestRecord | null;
  },
): Promise<DealRemainder | null> {
  if (input.deal.remainderPayeeId) {
    return { payeeId: input.deal.remainderPayeeId, source: "STORED" };
  }

  const event = input.event ?? null;
  if (event) {
    const subject = event.orgId
      ? { type: "ORGANIZATION" as const, id: event.orgId }
      : event.humanId
        ? { type: "HUMAN" as const, id: event.humanId }
        : null;
    if (subject) {
      const payee = await repos.payees.getBySubject(subject);
      if (payee) return { payeeId: payee.id, source: "LEGACY_EVENT_ORGANISER" };
    }
  }

  const agreement = input.agreement ?? null;
  if (agreement && input.bookingRequest) {
    for (const side of ["proposer", "counterparty"] as AgreementSide[]) {
      if (termsSideForRequest(input.bookingRequest, agreement, side) !== "editor") {
        continue;
      }
      const party = partyOnSide(agreement, side);
      const payee = await repos.payees.getBySubject({
        type: party.type === "human" ? "HUMAN" : "ORGANIZATION",
        id: party.id,
      });
      if (payee) return { payeeId: payee.id, source: "LEGACY_AGREEMENT_EDITOR" };
    }
  }

  const largest = input.deal.clauses
    .filter(isStoredPerOrderLine)
    .sort(
      (a, b) =>
        (b.percent ?? 0) - (a.percent ?? 0) ||
        b.priority - a.priority ||
        (a.payeeId < b.payeeId ? -1 : a.payeeId > b.payeeId ? 1 : 0),
    )[0];
  if (largest) return { payeeId: largest.payeeId, source: "LEGACY_LARGEST_LINE" };

  return null;
}

/** Σ percent of the stored per-order lines — 100 on a well-formed deal. */
export function perOrderPercentTotal(deal: PayoutTermsDealRecord): number {
  return deal.clauses
    .filter(isStoredPerOrderLine)
    .reduce((sum, c) => sum + (c.percent ?? 0), 0);
}
