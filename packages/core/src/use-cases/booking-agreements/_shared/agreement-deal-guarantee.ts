import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { DealClauseRecord } from "@th/ports/repos/deals";

import { fail } from "../../../lib/errors";
import {
  partyOnSide,
  type AgreementParty,
  type AgreementSide,
} from "./agreement-access";
import { termsSideForRequest } from "./agreement-editor-side";
import type { LedgerAgreementRef } from "./booking-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// The header guarantee, derived from The deal (deal-terms-and-settlement
// FR-001: `Agreement.guaranteeCents` "stays as the header summary but is
// derived from the sender's clause when one exists").
//
// WHOSE CLAUSE. The header guarantee has always been the ACT'S number: the
// pitch seeds it from the act's own ask (`pitch-seed.ts`), and the column is
// the "artist minimum" (agreement.prisma). M6 says the guarantee "is owed to
// the sender, who pays the acts they brought" — on a request to play
// (TO_VENUE) the sender IS the act side (the request's performer-owner pair).
// On a TO_PERFORMER request the sender is the organiser, who pays; the
// guarantee is still owed to the act it asked. So "the sender's clause" is
// read as: the clauses paying the agreement's ACT-SIDE party, resolved the
// way every terms gate resolves it (`termsSideForRequest` → "act").
//
// THE NUMBER. The fixed part (`amountCents`) of every FIXED or
// FIXED_AND_PERCENT clause paying that party, summed (a deal may pay one
// party more than one fixed amount). Null when none has a fixed part.
//
// WHEN IT APPLIES. Only on an agreement linked to its booking request (the
// only way to know which party is the act) whose terms carry a stored deal
// (`remainderPayeeId` set by a deal write). An unlinked legacy agreement keeps
// its typed header.
// ─────────────────────────────────────────────────────────────────────────────

/** `Agreement.guaranteeCents` is an INT column. */
const MAX_HEADER_GUARANTEE_CENTS = 2_147_483_647;

/** The agreement party on the act side of its booking request, or null. */
export function actPartyOf(
  agreement: LedgerAgreementRef,
  request: BookingRequestRecord | null,
): AgreementParty | null {
  if (!request) return null;
  for (const side of ["proposer", "counterparty"] as AgreementSide[]) {
    if (termsSideForRequest(request, agreement, side) === "act") {
      return partyOnSide(agreement, side);
    }
  }
  return null;
}

/**
 * True when the header guarantee is The deal's, not typed: the agreement is
 * linked to its request and its terms carry a stored deal. The header write
 * refuses a change then, and the read labels the number.
 */
export function guaranteeIsSetByDeal(
  terms: { remainderPayeeId?: string | null } | null,
  linkedToRequest: boolean,
): boolean {
  return linkedToRequest && !!terms?.remainderPayeeId;
}

/** Σ the fixed parts of the clauses paying `payeeId`; null when there are none. */
export function fixedPartTotalCents(
  clauses: ReadonlyArray<Pick<DealClauseRecord, "payeeId" | "amountType" | "amountCents">>,
  payeeId: string,
): number | null {
  let total: number | null = null;
  for (const c of clauses) {
    if (c.payeeId !== payeeId) continue;
    if (c.amountType !== "FIXED" && c.amountType !== "FIXED_AND_PERCENT") continue;
    if (c.amountCents === null) continue;
    total = (total ?? 0) + c.amountCents;
  }
  if (total !== null && total > MAX_HEADER_GUARANTEE_CENTS) {
    fail("invalid_input", "deal_guarantee_too_large");
  }
  return total;
}

/**
 * The header guarantee The deal implies: the fixed part of the act side's
 * clauses, or null (no act side, the act has no payee row, or no clause of
 * theirs has a fixed part).
 */
export async function deriveAgreementGuaranteeCents(
  repos: Pick<Repos, "payees">,
  args: {
    agreement: LedgerAgreementRef;
    request: BookingRequestRecord | null;
    clauses: ReadonlyArray<Pick<DealClauseRecord, "payeeId" | "amountType" | "amountCents">>;
  },
): Promise<number | null> {
  const act = actPartyOf(args.agreement, args.request);
  if (!act) return null;
  const payee = await repos.payees.getBySubject({
    type: act.type === "human" ? "HUMAN" : "ORGANIZATION",
    id: act.id,
  });
  if (!payee) return null;
  return fixedPartTotalCents(args.clauses, payee.id);
}
