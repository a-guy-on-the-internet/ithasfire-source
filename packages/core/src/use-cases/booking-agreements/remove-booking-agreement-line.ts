import { z } from "zod";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { requireAgreementParty } from "./_shared/agreement-access";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import {
  requireDraftBookingAgreement,
  requirePayoutTermsId,
  toPreservedLineInput,
} from "./_shared/agreement-lines";
import type { BookingAgreementLineDeps } from "./upsert-booking-agreement-line";
import {
  assertDealScopeUnchanged,
  assertDealWritable,
  bookingDealScope,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
} from "../deals/_shared/deal-freeze";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const removeBookingAgreementLineInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    lineId: z.uuid(),
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes the deal of
     * a frozen event (every payee is told). Without it a booking whose event
     * is frozen is refused (DEAL_FROZEN). A booking whose event is not frozen,
     * or that has no event yet, writes as before (F4).
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const removeBookingAgreementLineOutputSchema = z
  .object({
    agreementId: z.uuid(),
    payoutTermsId: z.uuid(),
    lineId: z.uuid(),
    removed: z.literal(true),
  })
  .strict();

export type RemoveBookingAgreementLineInput = z.infer<
  typeof removeBookingAgreementLineInputSchema
>;
export type RemoveBookingAgreementLineOutput = z.infer<
  typeof removeBookingAgreementLineOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove a payout line from a DRAFT booking agreement. Same access rules as
 * `upsertBookingAgreementLine` (terms editor only, edit-level org role, DRAFT
 * only). Remaining lines carry their confirmation state through the rewrite.
 */
export async function removeBookingAgreementLine(
  deps: BookingAgreementLineDeps,
  rawInput: unknown,
): Promise<RemoveBookingAgreementLineOutput> {
  const input = parseInput(removeBookingAgreementLineInputSchema, rawInput);

  const agreement = await requireDraftBookingAgreement(
    deps.repos.agreements,
    input.agreementId,
  );
  requirePayoutTermsId(agreement);
  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  const now = deps.clock.now();
  const lockedTermsId = requirePayoutTermsId(agreement);
  const lockedScope = bookingDealScope(agreement);

  const result = await deps.repos.tx(async (tx) => {
    // freeze-the-deal: the row of the booking's event first, before the
    // terms lock (the order in deal-freeze.ts).
    await lockDealEvent(tx, lockedScope);
    // ── P4b (deal terms) ── then the terms row lock (review B1, round 2):
    // every writer of PayoutTermsLine takes it before reading the lines it
    // rewrites, so a legacy line edit and a deal write can never interleave
    // — the later one reads what the earlier one committed.
    if (!(await tx.deals.lockTerms(lockedTermsId))) {
      throw fail("PAYOUT_TERMS_NOT_FOUND");
    }
    const fresh = await requireDraftBookingAgreement(
      tx.agreements,
      input.agreementId,
    );
    const payoutTermsId = requirePayoutTermsId(fresh);
    if (payoutTermsId !== lockedTermsId) {
      throw { code: "conflict", message: "agreement_terms_changed" } as const;
    }
    assertDealScopeUnchanged(lockedScope, bookingDealScope(fresh));

    // freeze-the-deal FR-004, under the event row and terms locks.
    const fence = await assertDealWritable(tx, {
      scope: bookingDealScope(fresh),
      frozenChange: input.frozenChange,
    });

    const lines = await tx.payoutTerms.listLines(payoutTermsId);
    const target = lines.find((line) => line.id === input.lineId);
    if (!target) {
      throw fail("AGREEMENT_LINE_NOT_FOUND");
    }

    await tx.payoutTerms.replaceLines(
      payoutTermsId,
      lines
        .filter((line) => line.id !== input.lineId)
        .map(toPreservedLineInput),
    );

    await tx.audit.log({
      entity: "booking_agreement_line",
      entityId: target.id,
      action: "booking_agreement.line_removed",
      data: {
        actorHumanId: input.actorHumanId,
        agreementId: fresh.id,
        payoutTermsId,
        payeeId: target.payeeId,
        removed: {
          percent: target.percent,
          floorCents: target.floorCents,
          capPercent: target.capPercent,
          priority: target.priority,
        },
      },
      at: now,
    });

    const change = await recordDealChange(tx, fence, {
      actorHumanId: input.actorHumanId,
      at: now,
    });

    return { agreementId: fresh.id, payoutTermsId, lineId: target.id, change };
  });

  deps.logger?.info("booking_agreements.line_removed", {
    agreementId: result.agreementId,
    lineId: result.lineId,
    actorHumanId: input.actorHumanId,
  });

  // freeze-the-deal FR-006: after the commit. Best effort: never throws.
  const { change, ...out } = result;
  if (change) await notifyDealChange(deps, change);

  return removeBookingAgreementLineOutputSchema.parse({
    ...out,
    removed: true,
  });
}
