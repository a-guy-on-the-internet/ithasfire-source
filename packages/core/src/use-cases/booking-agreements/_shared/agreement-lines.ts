import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayeeRecord, PayeeSubjectType } from "@th/ports/repos/payees";
import type {
  PayoutTermsLineInput,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";
import type { Repos } from "@th/ports/repos";

import type { AgreementPartyRef } from "./agreement-access";
import { fail } from "@th/errors";

/** Editor-facing payee reference (kind mirrors Agreement party types). */
export type PayeeRefKind = "human" | "org";

export function payeeRefToSubjectType(kind: PayeeRefKind): PayeeSubjectType {
  return kind === "human" ? "HUMAN" : "ORGANIZATION";
}

/**
 * The booking-agreement confirmation rule:
 *
 * A payout line requires per-payee confirmation iff its payee subject is NOT
 * one of the two agreement parties. Lines paying the proposer or the
 * counterparty are implied by their whole-agreement acceptance
 * (DRAFT→PROPOSED→ACCEPTED), so they never gate finalize; third-party payees
 * never accept the agreement itself, so their line carries its own
 * requiresConfirmation + confirmationStatus lifecycle (spec FR-005).
 */
export function isAgreementPartyPayee(
  agreement: AgreementPartyRef,
  payee: Pick<PayeeRecord, "subjectType" | "subjectId">,
): boolean {
  const subjectPartyType =
    payee.subjectType === "HUMAN" ? "human" : "organization";
  return (
    (agreement.proposerType === subjectPartyType &&
      agreement.proposerId === payee.subjectId) ||
    (agreement.counterpartyType === subjectPartyType &&
      agreement.counterpartyId === payee.subjectId)
  );
}

/**
 * Identity-preserving repo input for an existing line. `replaceLines` is a
 * delete-and-recreate, so every untouched line must carry its confirmation
 * state through the rewrite explicitly or it would silently reset.
 */
export function toPreservedLineInput(
  line: PayoutTermsLineRecord,
): PayoutTermsLineInput {
  return {
    id: line.id,
    payeeId: line.payeeId,
    ticketTypeId: line.ticketTypeId,
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent,
    priority: line.priority,
    rounding: line.rounding,
    requiresConfirmation: line.requiresConfirmation,
    confirmationStatus: line.confirmationStatus,
    confirmedAt: line.confirmedAt,
    counterPercentBps: line.counterPercentBps,
    counterNote: line.counterNote,
  };
}

/**
 * Load the agreement or throw, and require it to be line/header-editable.
 * Header + line edits are collaborative while the agreement is DRAFT (per
 * spec: both sides shape the draft); a PROPOSED agreement must be pulled
 * back to DRAFT before editing resumes.
 */
export async function requireDraftBookingAgreement(
  agreements: Repos["agreements"],
  agreementId: string,
): Promise<AgreementRecord> {
  const agreement = await agreements.getById(agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  // Defense in depth: a finalized agreement (eventId stamped) is immutable
  // even if its status were somehow DRAFT again — the linked event settles
  // money on these terms, so line/header edits must never reopen them.
  if (agreement.eventId !== null) {
    throw fail("AGREEMENT_FINALIZED");
  }
  if (agreement.status !== "DRAFT") {
    throw fail("AGREEMENT_NOT_DRAFT");
  }
  return agreement;
}

/** payoutTermsId is nullable in schema; line operations require it. */
export function requirePayoutTermsId(agreement: AgreementRecord): string {
  if (!agreement.payoutTermsId) {
    throw fail("AGREEMENT_MISSING_PAYOUT_TERMS");
  }
  return agreement.payoutTermsId;
}
