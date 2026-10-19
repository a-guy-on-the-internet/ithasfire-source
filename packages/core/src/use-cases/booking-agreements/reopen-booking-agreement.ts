import { z } from "zod";

import { parseInput } from "../../lib/io";
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

export const reopenBookingAgreementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
  })
  .strict();

export const reopenBookingAgreementOutputSchema = z
  .object({
    agreementId: z.uuid(),
    status: agreementStatusSchema,
  })
  .strict();

export type ReopenBookingAgreementInput = z.infer<
  typeof reopenBookingAgreementInputSchema
>;
export type ReopenBookingAgreementOutput = z.infer<
  typeof reopenBookingAgreementOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ACCEPTED (unfinalized) → DRAFT so editing can resume — the escape hatch
 * when a per-line COUNTER/DECLINE blocks finalize and the parties need to
 * adjust economics.
 *
 * Rules:
 * - Finalized agreements (`eventId` stamped) can NEVER reopen — the linked
 *   event settles money on these terms (checked explicitly before status so
 *   the caller gets `agreement_finalized`, not a misleading status error).
 * - Only the terms editor may reopen (symmetric with send-for-review /
 *   pull-back — `_shared/agreement-editor-side.ts`); org parties need an
 *   edit-level role.
 * - `acceptedAt` is kept as history (matching how pull-back keeps
 *   `proposedAt`) — `status` is authoritative; a re-accept re-stamps it.
 * - Line confirmations are NOT reset here: reopening only unfreezes editing.
 *   Economics edits in the draft reset affected lines to PENDING themselves.
 *
 * CAS via `expectedFrom: ["ACCEPTED"]`; the other party gets a best-effort
 * in-app ping.
 */
export async function reopenBookingAgreement(
  deps: BookingAgreementTransitionDeps,
  rawInput: unknown,
): Promise<ReopenBookingAgreementOutput> {
  const input = parseInput(reopenBookingAgreementInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  if (agreement.eventId !== null) {
    throw fail("AGREEMENT_FINALIZED");
  }
  if (agreement.status !== "ACCEPTED") {
    throw fail("AGREEMENT_NOT_ACCEPTED");
  }

  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  const now = deps.clock.now();

  const updated = await deps.repos.tx(async (tx) => {
    // Write-time CAS is the authoritative race guard. `expectEventIdNull`
    // matters: a concurrent finalize KEEPS the row on ACCEPTED while
    // stamping `eventId`, so a status-only CAS would happily reopen a
    // just-finalized agreement — the eventId fence closes that window.
    const next = await tx.agreements.updateStatus({
      id: agreement.id,
      status: "DRAFT",
      expectedFrom: ["ACCEPTED"],
      expectEventIdNull: true,
    });

    // Ledger entry, same tx as the CAS.
    const request = await findLedgerRequestForAgreement(tx, agreement.id);
    if (request) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_agreement.reopened",
        data: {
          agreementId: next.id,
          actorSide: bookingThreadSideForAgreementSide(
            request,
            agreement,
            party.side,
          ),
        },
        actorHumanId: input.actorHumanId,
      });
    }

    await tx.audit.log({
      entity: "booking_agreement",
      entityId: next.id,
      action: "booking_agreement.reopened",
      data: {
        actorHumanId: input.actorHumanId,
        actorSide: party.side,
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
    eventKey: "reopened",
    title: "Agreement reopened",
    body: `"${updated.title}" was returned to draft for edits.`,
  });

  deps.logger?.info("booking_agreements.reopened", {
    agreementId: updated.id,
    actorHumanId: input.actorHumanId,
  });

  return reopenBookingAgreementOutputSchema.parse({
    agreementId: updated.id,
    status: updated.status,
  });
}
