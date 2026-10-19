import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import { fail as failApp } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { requireAgreementParty } from "./_shared/agreement-access";
import { guaranteeIsSetByDeal } from "./_shared/agreement-deal-guarantee";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import { requireDraftBookingAgreement } from "./_shared/agreement-lines";
import { agreementStatusSchema } from "./list-booking-agreements";
import {
  assertDealScopeUnchanged,
  assertDealWritable,
  bookingDealScope,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
  type DealFence,
} from "../deals/_shared/deal-freeze";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_FIELDS = [
  "title",
  "description",
  "proposedDate",
  "proposedEndDate",
  "guaranteeCents",
  "expiresAt",
] as const;

/**
 * `undefined` = leave unchanged; `null` clears a nullable field.
 * The transport derives its input via `.omit({ actorHumanId: true })` on the
 * pre-refine base object (`.omit()` can't be applied after `.refine()`).
 */
export const updateBookingAgreementHeaderBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    title: plainTextRequired(200).pipe(z.string().min(3)).optional(),
    description: plainTextMultilineOptional(5000).nullable().optional(),
    proposedDate: z.coerce.date().nullable().optional(),
    proposedEndDate: z.coerce.date().nullable().optional(),
    /** Integer cents — never floats. */
    guaranteeCents: z.number().int().min(0).nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes the
     * guarantee (money) of a booking whose event's deal is frozen (every
     * payee is told). Without it such a change is refused (DEAL_FROZEN). The
     * other header fields are not the deal and are never fenced.
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const updateBookingAgreementHeaderInputSchema =
  updateBookingAgreementHeaderBaseSchema.refine(
    (value) => HEADER_FIELDS.some((field) => value[field] !== undefined),
    { message: "no_fields_to_update", path: [] },
  );

export const updateBookingAgreementHeaderOutputSchema = z
  .object({
    agreementId: z.uuid(),
    status: agreementStatusSchema,
    title: z.string(),
    description: z.string().nullable(),
    proposedDate: z.date().nullable(),
    proposedEndDate: z.date().nullable(),
    guaranteeCents: z.number().int().nullable(),
    expiresAt: z.date().nullable(),
    updatedAt: z.date(),
  })
  .strict();

export type UpdateBookingAgreementHeaderInput = z.infer<
  typeof updateBookingAgreementHeaderInputSchema
>;
export type UpdateBookingAgreementHeaderOutput = z.infer<
  typeof updateBookingAgreementHeaderOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateBookingAgreementHeaderDeps = {
  /**
   * `bookingRequests` resolves which party is the act (terms-editor gate).
   * The transaction's `deals` (terms lock) and `payoutTerms` (is there a
   * deal?) guard `guaranteeCents` (FR-001).
   */
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "authz"
    | "audit"
    | "bookingRequests"
    // The frozen-change notice (freeze-the-deal FR-006).
    | "events"
    | "payees"
    | "organizations"
    | "humans"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Header CRUD for the booking-agreement editor (spec FR-004).
 *
 * Editable ONLY while DRAFT, and ONLY by the terms editor — the non-act party
 * of the originating booking request (`_shared/agreement-editor-side.ts`);
 * org parties need an edit-level role. The act side never edits terms. An
 * agreement with no originating request keeps the older either-party rule. A
 * PROPOSED agreement must be pulled back to DRAFT first
 * (`pullBackBookingAgreement`); this keeps "what the other side reviewed"
 * immutable while it's under review. The ONE path that rewrites a non-DRAFT
 * header is `confirmBookingHold` (`booking-holds/confirm-booking-hold.ts`):
 * the confirmed night is the agreed date (owner ruling 2026-08-27), so it
 * moves `proposedDate`/`proposedEndDate` onto that night while the agreement
 * is still negotiable — a system correction, not an edit.
 *
 * The write is a status-guarded CAS in the adapter, so a concurrent
 * DRAFT→PROPOSED transition surfaces as `conflict/agreement_status_changed`
 * instead of mutating a live proposal.
 *
 * GUARANTEE SET BY THE DEAL (deal-terms-and-settlement FR-001): once the
 * agreement's terms carry a deal, `guaranteeCents` is derived from it on every
 * deal save (`setBookingAgreementDeal`), so a CHANGE here is refused with
 * `AGREEMENT_NOT_EDITABLE` (meta.reason `guarantee_set_by_deal`). The same
 * value is accepted, so a form that echoes the field still saves. Checked
 * under the terms row lock the deal write takes, so the two serialize.
 */
export async function updateBookingAgreementHeader(
  deps: UpdateBookingAgreementHeaderDeps,
  rawInput: unknown,
): Promise<UpdateBookingAgreementHeaderOutput> {
  const input = parseInput(updateBookingAgreementHeaderInputSchema, rawInput);

  const agreement = await requireDraftBookingAgreement(
    deps.repos.agreements,
    input.agreementId,
  );
  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  const termsSide = await requireAgreementTermsEditor(
    deps.repos,
    agreement,
    party.side,
  );

  const now = deps.clock.now();

  // A guarantee write may be a deal change (freeze-the-deal FR-004): it
  // takes the row of the booking's event first, before any terms lock (the
  // order in deal-freeze.ts). A header edit that leaves the guarantee alone
  // is not the deal and takes neither.
  const lockedScope =
    input.guaranteeCents !== undefined ? bookingDealScope(agreement) : null;

  const written = await deps.repos.tx(async (tx) => {
    await lockDealEvent(tx, lockedScope);
    // FR-001: a guarantee write then takes the terms row lock every deal
    // write takes, so "is there a deal?" below can't race a deal save.
    // (An agreement with no originating request has no act side to derive
    // a guarantee for: its header stays typed.)
    const lockedTermsId =
      input.guaranteeCents !== undefined && termsSide !== null
        ? agreement.payoutTermsId
        : null;
    if (lockedTermsId !== null) await tx.deals.lockTerms(lockedTermsId);

    // Friendly in-tx re-check; the *authoritative* race guard is the
    // adapter's `expectedFrom` CAS at write time.
    const fresh = await requireDraftBookingAgreement(
      tx.agreements,
      input.agreementId,
    );

    // freeze-the-deal FR-004: the guarantee is money, so CHANGING it on a
    // booking whose event's deal is frozen is fenced, under the terms lock
    // (taken here too when the branch above did not). Title, dates and the
    // other header fields are not the deal. A booking with no event yet has
    // nothing frozen and takes no extra lock (F4).
    let fence: DealFence = { frozen: false };
    const dealScope = bookingDealScope(fresh);
    if (
      dealScope !== null &&
      input.guaranteeCents !== undefined &&
      input.guaranteeCents !== fresh.guaranteeCents
    ) {
      assertDealScopeUnchanged(lockedScope, dealScope);
      if (lockedTermsId === null && fresh.payoutTermsId) {
        await tx.deals.lockTerms(fresh.payoutTermsId);
      }
      fence = await assertDealWritable(tx, {
        scope: dealScope,
        frozenChange: input.frozenChange,
      });
    }

    if (
      lockedTermsId !== null &&
      input.guaranteeCents !== fresh.guaranteeCents
    ) {
      const terms = await tx.payoutTerms.getById(lockedTermsId);
      if (guaranteeIsSetByDeal(terms, true)) {
        throw failApp("AGREEMENT_NOT_EDITABLE", {
          meta: { reason: "guarantee_set_by_deal", agreementId: fresh.id },
        });
      }
    }

    assertDateOrder(fresh, input);

    const next = await tx.agreements.updateHeader({
      id: fresh.id,
      expectedFrom: ["DRAFT"],
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.proposedDate !== undefined
        ? { proposedDate: input.proposedDate }
        : {}),
      ...(input.proposedEndDate !== undefined
        ? { proposedEndDate: input.proposedEndDate }
        : {}),
      ...(input.guaranteeCents !== undefined
        ? { guaranteeCents: input.guaranteeCents }
        : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });

    await tx.audit.log({
      entity: "booking_agreement",
      entityId: next.id,
      action: "booking_agreement.header_updated",
      data: {
        actorHumanId: input.actorHumanId,
        before: snapshotHeader(fresh),
        after: snapshotHeader(next),
      },
      at: now,
    });

    const change = await recordDealChange(tx, fence, {
      actorHumanId: input.actorHumanId,
      at: now,
    });

    return { next, change };
  });

  // freeze-the-deal FR-006: after the commit. Best effort: never throws.
  if (written.change) await notifyDealChange(deps, written.change);
  const updated = written.next;

  deps.logger?.info("booking_agreements.header_updated", {
    agreementId: updated.id,
    actorHumanId: input.actorHumanId,
  });

  return updateBookingAgreementHeaderOutputSchema.parse({
    agreementId: updated.id,
    status: updated.status,
    title: updated.title,
    description: updated.description,
    proposedDate: updated.proposedDate,
    proposedEndDate: updated.proposedEndDate,
    guaranteeCents: updated.guaranteeCents,
    expiresAt: updated.expiresAt,
    updatedAt: updated.updatedAt,
  });
}

/**
 * Validate `proposedEndDate >= proposedDate` against the MERGED header (an
 * end-only edit must still respect the stored start, and vice versa).
 */
function assertDateOrder(
  current: Pick<AgreementRecord, "proposedDate" | "proposedEndDate">,
  input: Pick<
    UpdateBookingAgreementHeaderInput,
    "proposedDate" | "proposedEndDate"
  >,
): void {
  const start =
    input.proposedDate !== undefined
      ? input.proposedDate
      : current.proposedDate;
  const end =
    input.proposedEndDate !== undefined
      ? input.proposedEndDate
      : current.proposedEndDate;

  if (start && end && end.getTime() < start.getTime()) {
    throw {
      code: "invalid_input",
      message: "proposed_end_before_start",
      issues: [
        {
          code: "custom",
          path: ["proposedEndDate"],
          message: "proposedEndDate must be on or after proposedDate",
        },
      ],
    } as const;
  }
}

function snapshotHeader(agreement: AgreementRecord) {
  return {
    title: agreement.title,
    description: agreement.description,
    proposedDate: agreement.proposedDate,
    proposedEndDate: agreement.proposedEndDate,
    guaranteeCents: agreement.guaranteeCents,
    expiresAt: agreement.expiresAt,
  };
}
