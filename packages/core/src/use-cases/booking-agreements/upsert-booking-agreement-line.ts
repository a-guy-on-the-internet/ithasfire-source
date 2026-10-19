import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  PayoutTermsLineInput,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";

import {
  agreementLineInputSchema,
  normalizeLines,
  validateLines,
  type NormalizedAgreementLine,
} from "../agreements/_shared/upsert-agreement-shared";
import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { requireAgreementParty } from "./_shared/agreement-access";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import {
  isAgreementPartyPayee,
  payeeRefToSubjectType,
  requireDraftBookingAgreement,
  requirePayoutTermsId,
  toPreservedLineInput,
} from "./_shared/agreement-lines";
import { payoutLineConfirmationStatusSchema } from "./get-booking-agreement";
import {
  assertDealScopeUnchanged,
  assertDealWritable,
  bookingDealScope,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
} from "../deals/_shared/deal-freeze";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const upsertBookingAgreementLineInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    /** Present = update that line; absent = add a new line. */
    lineId: z.uuid().optional(),
    /** Platform entity to pay — resolved to a Payee (created PENDING if new). */
    payeeRef: z
      .object({
        kind: z.enum(["human", "org"]),
        id: z.uuid(),
      })
      .strict(),
    /** Integer percent of the basis — never floats. */
    percent: z.coerce.number().int().min(0).max(100),
    /** Integer cents — never floats. */
    floorCents: z.coerce.number().int().min(0).default(0),
    capPercent: z
      .union([z.coerce.number().int().min(0).max(100), z.null()])
      .optional()
      .transform((value) => (value === undefined ? null : value)),
    priority: z.coerce.number().int().default(0),
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes the deal of
     * a frozen event (every payee is told). Without it a booking whose event
     * is frozen is refused (DEAL_FROZEN). A booking whose event is not frozen,
     * or that has no event yet, writes as before (F4).
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const upsertBookingAgreementLineOutputSchema = z
  .object({
    agreementId: z.uuid(),
    payoutTermsId: z.uuid(),
    lineId: z.uuid(),
    payeeId: z.uuid(),
    percent: z.number().int(),
    floorCents: z.number().int(),
    capPercent: z.number().int().nullable(),
    priority: z.number().int(),
    requiresConfirmation: z.boolean(),
    confirmationStatus: payoutLineConfirmationStatusSchema.nullable(),
  })
  .strict();

export type UpsertBookingAgreementLineInput = z.infer<
  typeof upsertBookingAgreementLineInputSchema
>;
export type UpsertBookingAgreementLineOutput = z.infer<
  typeof upsertBookingAgreementLineOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type BookingAgreementLineDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "payoutTerms"
    | "payees"
    | "humans"
    | "organizations"
    | "authz"
    | "audit"
    // Resolves which party is the act (terms-editor gate).
    | "bookingRequests"
    // The freeze read and the frozen-change notice (freeze-the-deal).
    | "events"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add or edit a payout line on a DRAFT booking agreement (spec FR-004/FR-005).
 * Only the terms editor — the non-act party of the originating request — may
 * edit (org parties need an edit-level role); see
 * `_shared/agreement-editor-side.ts`. Unlinked agreements keep either-party.
 *
 * Payee resolution: the input is a platform entity ref (human/org), resolved
 * via `payees.upsertForSubject`. A payee with no Stripe Connect account yet
 * is created PENDING — that's deliberately allowed while drafting (payees
 * onboard Stripe later); ACTIVE + payouts/charges enabled is enforced at
 * FINALIZE time (`payee_not_ready`), not at line-add time.
 *
 * Confirmation rule (see `isAgreementPartyPayee`): lines paying one of the
 * two agreement parties are implied by whole-agreement acceptance
 * (`requiresConfirmation = false`); third-party lines start
 * `requiresConfirmation = true, confirmationStatus = PENDING`. Editing a
 * confirmed line's economics (percent / floorCents / capPercent) resets it
 * to PENDING so the payee must re-confirm — intended (finance.prisma note).
 *
 * Validation reuses the PayoutTerms engine's shared helpers:
 * `sum(percent) ≤ 100`, one line per payee, integer-only money.
 */
export async function upsertBookingAgreementLine(
  deps: BookingAgreementLineDeps,
  rawInput: unknown,
): Promise<UpsertBookingAgreementLineOutput> {
  const input = parseInput(upsertBookingAgreementLineInputSchema, rawInput);

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
    // Friendly in-tx re-check. NOTE: unlike status transitions, line writes
    // live in a different table so they can't carry the agreement-status CAS;
    // a DRAFT→PROPOSED race in the same instant can slip a line edit into a
    // just-proposed agreement. Accepted for v1 — the proposal snapshot is the
    // live lines, and the counterparty re-reviews what they accept.
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

    await ensureSubjectExists(tx, input.payeeRef);

    const payee = await tx.payees.upsertForSubject({
      subjectType: payeeRefToSubjectType(input.payeeRef.kind),
      subjectId: input.payeeRef.id,
    });

    const existingLines = await tx.payoutTerms.listLines(payoutTermsId);

    const normalizedTarget = normalizeLines([
      agreementLineInputSchema.parse({
        lineId: input.lineId,
        payeeId: payee.id,
        percent: input.percent,
        floorCents: input.floorCents,
        // `?? undefined`: the shared schema's coercing union would turn an
        // explicit null into 0 (Number(null)); undefined → null as intended.
        capPercent: input.capPercent ?? undefined,
        priority: input.priority,
        rounding: "FLOOR",
      }),
    ])[0]!;

    const previous = input.lineId
      ? findExistingLine(existingLines, input.lineId, payee.id)
      : assertPayeeNotAssigned(existingLines, payee.id);

    const requiresConfirmation = !isAgreementPartyPayee(fresh, payee);

    const targetLineId = previous?.id ?? randomUUID();
    const economicsChanged =
      previous !== null &&
      (previous.percent !== normalizedTarget.percent ||
        previous.floorCents !== normalizedTarget.floorCents ||
        previous.capPercent !== normalizedTarget.capPercent);

    const targetInput: PayoutTermsLineInput = {
      id: targetLineId,
      payeeId: payee.id,
      ticketTypeId: previous?.ticketTypeId ?? null,
      percent: normalizedTarget.percent,
      floorCents: normalizedTarget.floorCents,
      capPercent: normalizedTarget.capPercent,
      priority: normalizedTarget.priority,
      rounding: normalizedTarget.rounding,
      requiresConfirmation,
      // Economics edits invalidate a prior confirmation — reset to PENDING
      // (with counter fields cleared) so the payee re-confirms.
      ...(requiresConfirmation
        ? previous && !economicsChanged
          ? {
              confirmationStatus: previous.confirmationStatus ?? "PENDING",
              confirmedAt: previous.confirmedAt,
              counterPercentBps: previous.counterPercentBps,
              counterNote: previous.counterNote,
            }
          : {
              confirmationStatus: "PENDING",
              confirmedAt: null,
              counterPercentBps: null,
              counterNote: null,
            }
        : { confirmationStatus: null, confirmedAt: null }),
    };

    // New lines keep `id: undefined` for validation (validateLines rejects
    // ids that don't already belong to this terms instance).
    const nextNormalized: NormalizedAgreementLine[] = [
      ...existingLines
        .filter((line) => line.id !== targetLineId)
        .map(toNormalized),
      { ...normalizedTarget, id: previous?.id },
    ];
    validateLines(nextNormalized, existingLines);

    // replaceLines rewrites the whole set — untouched lines carry their
    // confirmation state through explicitly (delete-and-recreate semantics).
    const persisted: PayoutTermsLineInput[] = [
      ...existingLines
        .filter((line) => line.id !== targetLineId)
        .map(toPreservedLineInput),
      targetInput,
    ];
    await tx.payoutTerms.replaceLines(payoutTermsId, persisted);

    await tx.audit.log({
      entity: "booking_agreement_line",
      entityId: targetLineId,
      action: previous
        ? "booking_agreement.line_updated"
        : "booking_agreement.line_added",
      data: {
        actorHumanId: input.actorHumanId,
        agreementId: fresh.id,
        payoutTermsId,
        payeeId: payee.id,
        before: previous ? snapshotLine(previous) : null,
        after: snapshotLine(targetInput),
        requiresConfirmation,
        confirmationReset: economicsChanged,
      },
      at: now,
    });

    const change = await recordDealChange(tx, fence, {
      actorHumanId: input.actorHumanId,
      at: now,
    });

    return {
      change,
      agreementId: fresh.id,
      payoutTermsId,
      lineId: targetLineId,
      payeeId: payee.id,
      percent: normalizedTarget.percent,
      floorCents: normalizedTarget.floorCents,
      capPercent: normalizedTarget.capPercent,
      priority: normalizedTarget.priority,
      requiresConfirmation,
      confirmationStatus: targetInput.confirmationStatus ?? null,
    };
  });

  deps.logger?.info("booking_agreements.line_upserted", {
    agreementId: result.agreementId,
    lineId: result.lineId,
    actorHumanId: input.actorHumanId,
  });

  // freeze-the-deal FR-006: after the commit. Best effort: never throws.
  const { change, ...out } = result;
  if (change) await notifyDealChange(deps, change);

  return upsertBookingAgreementLineOutputSchema.parse(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guard against minting Payee rows for bogus ids: the subject must be a real
 * platform human / organization before `upsertForSubject` runs.
 */
async function ensureSubjectExists(
  tx: TxRepos,
  payeeRef: { kind: "human" | "org"; id: string },
): Promise<void> {
  if (payeeRef.kind === "human") {
    const humans = await tx.humans.getByIds([payeeRef.id]);
    if (humans.length === 0) {
      throw fail("HUMAN_NOT_FOUND", { meta: { role: "payee" } });
    }
    return;
  }
  const org = await tx.organizations.getById(payeeRef.id);
  if (!org) {
    throw fail("ORGANIZATION_NOT_FOUND", { meta: { role: "payee" } });
  }
}

function findExistingLine(
  lines: PayoutTermsLineRecord[],
  lineId: string,
  payeeId: string,
): PayoutTermsLineRecord {
  const line = lines.find((candidate) => candidate.id === lineId);
  if (!line) {
    throw fail("AGREEMENT_LINE_NOT_FOUND");
  }
  if (line.payeeId !== payeeId) {
    throw fail("PAYEE_CHANGE_NOT_ALLOWED");
  }
  return line;
}

function assertPayeeNotAssigned(
  lines: PayoutTermsLineRecord[],
  payeeId: string,
): null {
  if (lines.some((line) => line.payeeId === payeeId)) {
    throw fail("PAYEE_ALREADY_ASSIGNED");
  }
  return null;
}

function toNormalized(line: PayoutTermsLineRecord): NormalizedAgreementLine {
  return {
    id: line.id,
    payeeId: line.payeeId,
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent,
    priority: line.priority,
    rounding: line.rounding,
  };
}

function snapshotLine(
  line: Pick<
    PayoutTermsLineInput,
    "percent" | "floorCents" | "capPercent" | "priority"
  >,
) {
  return {
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent ?? null,
    priority: line.priority,
  };
}
