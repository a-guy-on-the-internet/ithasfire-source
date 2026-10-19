import { z } from "zod";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { requireAgreementParty } from "./_shared/agreement-access";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import {
  bookingThreadSideForAgreementSide,
  findLedgerRequestForAgreement,
} from "./_shared/booking-ledger";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import { agreementStatusSchema } from "./list-booking-agreements";
import type { BookingAgreementTransitionDeps } from "./send-booking-agreement-for-review";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const pullBackBookingAgreementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
  })
  .strict();

export const pullBackBookingAgreementOutputSchema = z
  .object({
    agreementId: z.uuid(),
    status: agreementStatusSchema,
  })
  .strict();

export type PullBackBookingAgreementInput = z.infer<
  typeof pullBackBookingAgreementInputSchema
>;
export type PullBackBookingAgreementOutput = z.infer<
  typeof pullBackBookingAgreementOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PROPOSED → DRAFT so editing can resume (the other half of the
 * DRAFT ⇄ PROPOSED loop). Only the terms editor may pull a proposal back —
 * symmetric with send-for-review (`_shared/agreement-editor-side.ts`);
 * `proposedAt` is kept as history.
 */
export async function pullBackBookingAgreement(
  deps: BookingAgreementTransitionDeps,
  rawInput: unknown,
): Promise<PullBackBookingAgreementOutput> {
  const input = parseInput(pullBackBookingAgreementInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  if (agreement.status !== "PROPOSED") {
    throw fail("AGREEMENT_NOT_PROPOSED");
  }

  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  const now = deps.clock.now();

  const updated = await deps.repos.tx(async (tx) => {
    const next = await tx.agreements.updateStatus({
      id: agreement.id,
      status: "DRAFT",
      expectedFrom: ["PROPOSED"],
    });

    // Ledger entry, same tx as the CAS ("Pulled back by Dana" needs the actor).
    const request = await findLedgerRequestForAgreement(tx, agreement.id);
    if (request) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_agreement.pulled_back",
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
      action: "booking_agreement.pulled_back",
      data: {
        actorHumanId: input.actorHumanId,
        actorSide: party.side,
      },
      at: now,
    });

    return next;
  });

  deps.logger?.info("booking_agreements.pulled_back", {
    agreementId: updated.id,
    actorHumanId: input.actorHumanId,
  });

  return pullBackBookingAgreementOutputSchema.parse({
    agreementId: updated.id,
    status: updated.status,
  });
}
