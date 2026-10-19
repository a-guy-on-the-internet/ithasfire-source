import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PayoutSchedule } from "@th/ports/repos/payout-terms";
import { fail as failApp } from "@th/errors";

import { fail } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";
import {
  ensureEntityDefaultPrimaryTerms,
  getEntityDefaultPayoutSchedule,
} from "../agreements/_shared/ensure-entity-default-primary-terms";
import {
  assertDealWritable,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
  type DealFence,
} from "./_shared/deal-freeze";
import {
  dealTargetSchema,
  isOwnerPayee,
  isOwnerRef,
  mayRouteEventPayouts,
  otherDefaultTermsReferences,
  otherEventTermsReferences,
  refuseBookingOwnedTerms,
  type TermsOwner,
} from "./_shared/deal-target";
import {
  dealWriteInputSchema,
  remainderRefOf,
  setBookingAgreementDeal,
  writeDealOnLockedTerms,
  type WrittenDeal,
} from "./set-agreement-deal";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setTermsDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    target: dealTargetSchema,
    deal: dealWriteInputSchema,
    /**
     * The `dealFingerprint` the editor's `getTermsDeal` read returned, or null
     * when that read found no deal yet (PAYOUT_TERMS_NOT_FOUND). Compared
     * under the terms lock: a deal changed since the read is refused
     * (conflict `deal_terms_changed`), so a stale save never deletes a clause
     * someone else added. Required.
     */
    expectedDealFingerprint: z.string().max(64).nullable(),
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes a frozen
     * deal (every payee is told). Without it a frozen EVENT or booking deal
     * is refused (DEAL_FROZEN). An org default is never frozen.
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const setTermsDealOutputSchema = z
  .object({
    target: dealTargetSchema,
    payoutTermsId: z.uuid(),
    remainderPayeeId: z.uuid(),
    clauseIds: z.array(z.string()),
    deductionIds: z.array(z.string()),
    /** The remainder holder's per-order share ("the rest"), 0 when none. */
    remainderPerOrderPercent: z.number().int(),
    /** The fingerprint of the deal as written: the next save's expectation. */
    dealFingerprint: z.string(),
  })
  .strict();

export type SetTermsDealInput = z.input<typeof setTermsDealInputSchema>;
export type SetTermsDealOutput = z.infer<typeof setTermsDealOutputSchema>;

export type SetTermsDealDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "payoutTerms"
    | "deals"
    | "payees"
    | "humans"
    | "organizations"
    | "authz"
    | "audit"
    | "bookingRequests"
    | "events"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

type ParsedInput = z.infer<typeof setTermsDealInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the whole deal (FR-003) on any of the three PRIMARY terms the deal
 * builder edits — see `_shared/deal-target.ts`. The deal itself — clause
 * shapes, presets, the FR-005 per-order fence, the derived remainder line,
 * confirmations, the audit row — is `writeDealOnLockedTerms`, the same code
 * for every target. What differs is the gate and the terms row:
 *
 *   BOOKING_AGREEMENT — `setAgreementDeal`, unchanged.
 *   EVENT             — the event's payout-routing editors
 *                       ({@link mayRouteEventPayouts}); terms owned by a
 *                       booking agreement refused (AGREEMENT_FINALIZED, meta
 *                       points at the agreement); no terms yet → a PRIMARY
 *                       draft is minted and linked, as `updateEventSplits`
 *                       does. The remainder holder must be the event's owner.
 *   ORG_DEFAULT       — ORG_ADMIN_ROLES on an ACTIVE org; the default is
 *                       provisioned when missing (PAYEE_NOT_READY without a
 *                       payout-ready payee). The remainder holder must be the
 *                       org. The default is never linked to an event, so the
 *                       write changes no live event's money.
 *
 * The remainder holder owes every shortfall, so it is always a party to the
 * terms — never a third party who did not agree to that.
 */
export async function setTermsDeal(
  deps: SetTermsDealDeps,
  rawInput: unknown,
): Promise<SetTermsDealOutput> {
  const input = parseInput(setTermsDealInputSchema, rawInput);
  const { target } = input;

  let written: WrittenDeal;
  switch (target.kind) {
    case "BOOKING_AGREEMENT": {
      const out = await setBookingAgreementDeal(
        deps,
        {
          actorHumanId: input.actorHumanId,
          agreementId: target.agreementId,
          deal: input.deal,
          ...(input.frozenChange !== undefined ? { frozenChange: input.frozenChange } : {}),
        },
        { expectedDealFingerprint: input.expectedDealFingerprint },
      );
      const { agreementId: _agreementId, ...rest } = out;
      written = rest;
      break;
    }
    case "EVENT":
      written = await setEventDeal(deps, input, target.eventId);
      break;
    case "ORG_DEFAULT":
      written = await setOrgDefaultDeal(deps, input, target.orgId);
      break;
  }

  return setTermsDealOutputSchema.parse({ target, ...written });
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT
// ─────────────────────────────────────────────────────────────────────────────

async function setEventDeal(
  deps: SetTermsDealDeps,
  input: ParsedInput,
  eventId: string,
): Promise<WrittenDeal> {
  const event = await deps.repos.events.getById(eventId);
  if (!event) throw failApp("EVENT_NOT_FOUND");
  const owner: TermsOwner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
  if (!(await mayRouteEventPayouts(deps.repos.authz, owner, input.actorHumanId))) {
    throw failApp("INSUFFICIENT_ROLE");
  }

  const remainderRef = remainderRefOf(input.deal);
  if (!isOwnerRef(owner, remainderRef)) {
    fail("invalid_input", "deal_remainder_not_the_event_owner");
  }

  const now = deps.clock.now();
  const result = await deps.repos.tx(async (tx) => {
    // freeze-the-deal: the event row FIRST, before any terms lock (the order
    // in deal-freeze.ts). "update": a first write mints and links the
    // event's terms, an UPDATE of this row.
    await lockDealEvent(tx, { kind: "EVENT", eventId }, "update");
    // Re-read inside the transaction: the read above is a fast-fail. The
    // gate ran against THAT owner, so an owner change since is a conflict.
    const txEvent = await tx.events.getById(eventId);
    if (!txEvent) throw failApp("EVENT_NOT_FOUND");
    if ((txEvent.orgId ?? null) !== owner.orgId || (txEvent.humanId ?? null) !== owner.humanId) {
      fail("conflict", "deal_event_owner_changed");
    }
    // A cancelled or archived event's money is settled or being refunded;
    // its deal is history (`upsertAgreementLine` refuses the same way).
    if (txEvent.status === "ARCHIVED") throw failApp("EVENT_ARCHIVED");
    if (txEvent.status === "CANCELLED") throw failApp("EVENT_CANCELLED");

    let payoutTermsId = txEvent.payoutTermsId ?? null;
    const minted = payoutTermsId === null;
    // freeze-the-deal FR-004. Existing terms: fenced below, under the event
    // row lock and the terms lock. No terms yet: fenced here, BEFORE the mint,
    // so a frozen change's "before" records the PRIMARY terms as absent
    // (null), not as the empty row minted just below.
    let fence: DealFence | null = null;
    if (payoutTermsId) {
      // FIRST, the terms row lock (B1): every writer of PayoutTermsLine.
      if (!(await tx.deals.lockTerms(payoutTermsId))) {
        throw failApp("PAYOUT_TERMS_NOT_FOUND");
      }
      // Under the lock: still this event's terms (finalizeBookingAgreement
      // re-points an event at its booking's terms).
      const locked = await tx.events.getById(eventId);
      if ((locked?.payoutTermsId ?? null) !== payoutTermsId) {
        fail("conflict", "deal_terms_changed");
      }
      await refuseBookingOwnedTerms(tx.agreements, payoutTermsId);
      // Only this event may point at these terms (settlements recorded
      // against them excepted): a row shared with another event or an
      // entity default would change their money too.
      const others = otherEventTermsReferences(
        await tx.deals.listTermsReferences(payoutTermsId),
        eventId,
      );
      if (others.length > 0) {
        throw failApp("AGREEMENT_NOT_EDITABLE", {
          meta: { reason: "event_terms_shared", references: others },
        });
      }
    } else {
      // Under the event row lock taken first; a refusal writes nothing.
      fence = await assertDealWritable(tx, {
        scope: { kind: "EVENT", eventId },
        frozenChange: input.frozenChange,
      });
      // No terms yet: mint the event's own PRIMARY draft, as the splits
      // editor does, inheriting the owner's default payout schedule.
      const subject = owner.orgId
        ? { type: "ORGANIZATION" as const, id: owner.orgId }
        : { type: "HUMAN" as const, id: owner.humanId as string };
      const inherited: PayoutSchedule | null = await getEntityDefaultPayoutSchedule(tx, subject);
      const created = await tx.payoutTerms.createDraft({
        kind: "PRIMARY",
        settlementCurrency: "usd",
        ...(inherited ? { payoutSchedule: inherited } : {}),
      });
      // Guarded: links only while the event still has no terms. A concurrent
      // writer that linked first wins; this one conflicts (and its draft
      // rolls back with the transaction) instead of overwriting the link.
      const linked = await tx.deals.linkEventPrimaryTermsIfUnset({
        eventId,
        payoutTermsId: created.id,
      });
      if (!linked) fail("conflict", "deal_terms_changed");
      payoutTermsId = created.id;
      if (!(await tx.deals.lockTerms(payoutTermsId))) {
        throw failApp("PAYOUT_TERMS_NOT_FOUND");
      }
    }

    // Never write through an event onto a shared default row.
    const termsRow = await tx.payoutTerms.getById(payoutTermsId);
    if (!termsRow) throw failApp("PAYOUT_TERMS_NOT_FOUND");
    if (termsRow.isDefault) throw failApp("AGREEMENT_NOT_EDITABLE");

    // freeze-the-deal FR-004, under the event row lock and the terms lock
    // (the mint branch was fenced before it minted).
    fence ??= await assertDealWritable(tx, {
      scope: { kind: "EVENT", eventId },
      frozenChange: input.frozenChange,
    });

    const written = await writeDealOnLockedTerms(tx, {
      payoutTermsId,
      deal: input.deal,
      remainderRef,
      isThirdPartyPayee: (payee) => !isOwnerPayee(owner, payee),
      confirmSettledDirectly: true,
      audit: {
        action: "event.deal_set",
        data: { actorHumanId: input.actorHumanId, eventId },
      },
      now,
      fingerprintCheck: { expected: input.expectedDealFingerprint, minted },
    });
    const change = await recordDealChange(tx, fence, {
      actorHumanId: input.actorHumanId,
      at: now,
    });
    return { written, change };
  });

  // FR-006: after the commit. Best effort: never throws.
  if (result.change) await notifyDealChange(deps, result.change);

  deps.logger?.info("deals.event_deal_set", {
    eventId,
    payoutTermsId: result.written.payoutTermsId,
    actorHumanId: input.actorHumanId,
  });
  return result.written;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG_DEFAULT
// ─────────────────────────────────────────────────────────────────────────────

async function setOrgDefaultDeal(
  deps: SetTermsDealDeps,
  input: ParsedInput,
  orgId: string,
): Promise<WrittenDeal> {
  const org = await deps.repos.organizations.getById(orgId);
  if (!org) throw failApp("ORGANIZATION_NOT_FOUND");
  await requireOrgMembership({
    repos: deps.repos,
    orgId: org.id,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
  if (org.status !== "ACTIVE") throw failApp("ORGANIZATION_INACTIVE");

  const owner: TermsOwner = { orgId: org.id, humanId: null };
  const remainderRef = remainderRefOf(input.deal);
  if (!isOwnerRef(owner, remainderRef)) {
    fail("invalid_input", "deal_remainder_not_the_org");
  }

  const now = deps.clock.now();
  const result = await deps.repos.tx(async (tx) => {
    // Did the default exist before this write? If `ensure…` provisions it
    // here, the editor's read saw no deal (expected null).
    const minted = !(await tx.organizations.getById(org.id))?.defaultPrimaryPayoutTermsId;
    const terms = await ensureEntityDefaultPrimaryTerms(
      tx,
      { type: "ORGANIZATION", id: org.id },
      now,
      deps.logger,
    );
    // No payout-ready payee: the platform never fabricates terms without a
    // payout target (`updatePayoutSchedule` refuses the same way).
    if (!terms) throw failApp("PAYEE_NOT_READY");
    if (!(await tx.deals.lockTerms(terms.id))) {
      throw failApp("PAYOUT_TERMS_NOT_FOUND");
    }
    // Under the lock: still the org's default (a schedule change re-points
    // the org at a fresh clone).
    const lockedOrg = await tx.organizations.getById(org.id);
    if ((lockedOrg?.defaultPrimaryPayoutTermsId ?? null) !== terms.id) {
      fail("conflict", "deal_terms_changed");
    }
    // A default is the org's own template: the org's pointer must be the
    // ONLY thing that points at it. An event, agreement or settlement on it
    // would make this write change live money; a place's or another
    // entity's default sharing the row (the dev seed shares one between an
    // org and its place) would have its terms rewritten too. Refused.
    const others = otherDefaultTermsReferences(
      await tx.deals.listTermsReferences(terms.id),
      org.id,
    );
    if (others.length > 0) {
      throw failApp("AGREEMENT_NOT_EDITABLE", {
        meta: { reason: "default_terms_shared", references: others },
      });
    }

    return writeDealOnLockedTerms(tx, {
      payoutTermsId: terms.id,
      deal: input.deal,
      remainderRef,
      isThirdPartyPayee: (payee) => !isOwnerPayee(owner, payee),
      confirmSettledDirectly: true,
      audit: {
        action: "organization.default_deal_set",
        data: { actorHumanId: input.actorHumanId, orgId: org.id },
      },
      now,
      fingerprintCheck: { expected: input.expectedDealFingerprint, minted },
    });
  });

  deps.logger?.info("deals.org_default_deal_set", {
    orgId: org.id,
    payoutTermsId: result.payoutTermsId,
    actorHumanId: input.actorHumanId,
  });
  return result;
}
