import { z } from "zod";

import { parseInput } from "../../lib/io";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  otherSide,
  partyOnSide,
  requireAgreementParty,
} from "./_shared/agreement-access";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import {
  bookingThreadSideForAgreementSide,
  findLedgerRequestForAgreement,
} from "./_shared/booking-ledger";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import { notifyAgreementParty } from "./_shared/notify-party";
import { agreementStatusSchema } from "./list-booking-agreements";
import type { BookingAgreementTransitionDeps } from "./send-booking-agreement-for-review";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The statuses an editor may walk away from. Everything else is already
 * terminal (DECLINED / CANCELLED / FULFILLED / EXPIRED / DISPUTED) or, for
 * COUNTERED, a status nothing in the codebase ever writes — refusing it keeps
 * this list honest rather than pre-approving an invented transition.
 */
export const CANCELLABLE_AGREEMENT_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "ACCEPTED",
] as const;

/**
 * `reason` is REQUIRED and sanitized exactly like the act's decline reason
 * (`respondToBookingAgreementBaseSchema.declineReason`): strip markup and
 * bidi/zero-width controls FIRST, then apply the 3-char floor to the CLEANED
 * value, so a markup-only "reason" collapses to `""` and fails. It is copied
 * onto the booking ledger where both parties read it.
 */
export const cancelBookingAgreementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    reason: plainTextMultilineRequired(1000).pipe(z.string().min(3)),
  })
  .strict();

/** Same projection `respond` returns, so the UI can share one row updater. */
export const cancelBookingAgreementOutputSchema = z
  .object({
    agreementId: z.uuid(),
    status: agreementStatusSchema,
    acceptedAt: z.date().nullable(),
    declinedAt: z.date().nullable(),
  })
  .strict();

export type CancelBookingAgreementInput = z.infer<
  typeof cancelBookingAgreementInputSchema
>;
export type CancelBookingAgreementOutput = z.infer<
  typeof cancelBookingAgreementOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The terms editor's terminal exit: DRAFT | PROPOSED | ACCEPTED → CANCELLED.
 *
 * This is the counterpart of the act's DECLINE, split by side on purpose
 * (`_shared/agreement-editor-side.ts`): the act declines a PROPOSED
 * agreement through `respond`; the editor cancels through here, from any
 * live status, and `respond` is never widened back to both sides.
 *
 * Rules, in gate order:
 * - Not a party / viewer-role org member → `NOT_AGREEMENT_PARTY`.
 * - The act side can never cancel → `TERMS_EDITOR_ONLY`.
 * - Finalized (`eventId` stamped) can NEVER cancel — the linked event settles
 *   money on these terms. Checked BEFORE status (reopen's precedent) so the
 *   caller gets `AGREEMENT_FINALIZED`, not a misleading status error.
 * - Any status outside {@link CANCELLABLE_AGREEMENT_STATUSES} →
 *   `AGREEMENT_NOT_CANCELLABLE`.
 *
 * What it deliberately does NOT touch:
 * - `declinedAt` / `declinedReason` — those are the act's fields; the reason
 *   lives on the ledger entry (and in the audit row) instead.
 * - The BookingRequest, its holds, and the payout terms — the request stays
 *   ACCEPTED with its agreement link (a linked agreement stays linked — see
 *   `termsSideForRequest`); a follow-up draft, if any, is a product decision
 *   for later, not a side effect here.
 * - `draftEventId` — left stamped. A DRAFT event minted from an ACCEPTED
 *   agreement is therefore ORPHANED by a cancel: it stays in the organizer's
 *   drafts, and `createEventFromAgreement` already refuses terminal statuses
 *   so it can never be re-linked or finalized. Cleaning it up is the
 *   organizer's call (delete the draft), same as any other abandoned draft.
 *
 * CAS via `expectedFrom` + `expectEventIdNull` (a concurrent finalize KEEPS
 * the row on ACCEPTED while stamping `eventId`, so a status-only CAS would
 * cancel a just-finalized agreement). The other party gets a best-effort
 * in-app ping after commit.
 */
export async function cancelBookingAgreement(
  deps: BookingAgreementTransitionDeps,
  rawInput: unknown,
): Promise<CancelBookingAgreementOutput> {
  const input = parseInput(cancelBookingAgreementInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }

  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  if (agreement.eventId !== null) {
    throw fail("AGREEMENT_FINALIZED");
  }
  if (!isCancellableStatus(agreement.status)) {
    throw fail("AGREEMENT_NOT_CANCELLABLE");
  }

  const now = deps.clock.now();

  const updated = await deps.repos.tx(async (tx) => {
    const next = await tx.agreements.updateStatus({
      id: agreement.id,
      status: "CANCELLED",
      expectedFrom: [...CANCELLABLE_AGREEMENT_STATUSES],
      expectEventIdNull: true,
    });

    // Ledger entry, same tx as the CAS. Reason COPIED onto the entry — the
    // agreement has no column for it, and the ledger is what both sides read.
    const request = await findLedgerRequestForAgreement(tx, agreement.id);
    if (request) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_agreement.cancelled",
        data: {
          agreementId: next.id,
          actorSide: bookingThreadSideForAgreementSide(
            request,
            agreement,
            party.side,
          ),
          reason: input.reason,
        },
        actorHumanId: input.actorHumanId,
      });
    }

    await tx.audit.log({
      entity: "booking_agreement",
      entityId: next.id,
      action: "booking_agreement.cancelled",
      data: {
        actorHumanId: input.actorHumanId,
        actorSide: party.side,
        fromStatus: agreement.status,
        reason: input.reason,
      },
      at: now,
    });

    return next;
  });

  // Post-commit, best-effort (never fails the mutation).
  await notifyAgreementParty(deps, {
    party: partyOnSide(updated, otherSide(party.side)),
    actorHumanId: input.actorHumanId,
    agreementId: updated.id,
    eventKey: "cancelled",
    title: "Agreement cancelled",
    body: `"${updated.title}" was cancelled.`,
  });

  deps.logger?.info("booking_agreements.cancelled", {
    agreementId: updated.id,
    fromStatus: agreement.status,
    actorHumanId: input.actorHumanId,
  });

  return cancelBookingAgreementOutputSchema.parse({
    agreementId: updated.id,
    status: updated.status,
    acceptedAt: updated.acceptedAt,
    declinedAt: updated.declinedAt,
  });
}

function isCancellableStatus(
  status: string,
): status is (typeof CANCELLABLE_AGREEMENT_STATUSES)[number] {
  return (CANCELLABLE_AGREEMENT_STATUSES as readonly string[]).includes(status);
}
