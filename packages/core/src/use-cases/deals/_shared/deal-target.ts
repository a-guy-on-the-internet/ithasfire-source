/**
 * WHERE a deal lives (deal-terms FR-003): the same deal builder writes and
 * reads three kinds of PRIMARY payout terms.
 *
 *   BOOKING_AGREEMENT — the agreement's own terms (a DRAFT agreement, edited
 *                       by the terms-editor side). Unchanged from P4b.
 *   EVENT             — `Event.payoutTermsId` of an event with NO booking:
 *                       the event's payout-routing editors (the splits
 *                       editor's rule). Terms owned by a booking agreement
 *                       are refused and pointed at the agreement.
 *   ORG_DEFAULT       — `Organization.defaultPrimaryPayoutTermsId`, the org's
 *                       reusable default (never linked to an event):
 *                       ORG_ADMIN_ROLES to write.
 *
 * Every rule resolves the owning org / human FROM THE ROW (the event, the
 * org), never from anything the client sent beyond the id it names.
 */
import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  PayoutTermsDealRecord,
  PayoutTermsReference,
} from "@th/ports/repos/deals";
import { fail } from "@th/errors";

import { actorHoldsEventEditRole } from "../../../lib/event-edit-rights";
import {
  ORG_ADMIN_ROLES,
  ORG_EDIT_OR_FINANCE_ROLES,
  requireOrgMembership,
} from "../../../lib/rbac";
import type { AgreementParty } from "../../booking-agreements/_shared/agreement-access";
import {
  loadAgreementDealContext,
  type AgreementDealContextRepos,
} from "./agreement-deal-context";
import { resolveDealRemainder, type DealRemainder } from "./deal-from-storage";
import { resolveDealViewer, type DealViewer } from "./deal-visibility";
import type { DealPayeeRef } from "./payee-refs";

// ─────────────────────────────────────────────────────────────────────────────
// The target
// ─────────────────────────────────────────────────────────────────────────────

export const dealTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BOOKING_AGREEMENT"), agreementId: z.uuid() }).strict(),
  z.object({ kind: z.literal("EVENT"), eventId: z.uuid() }).strict(),
  z.object({ kind: z.literal("ORG_DEFAULT"), orgId: z.uuid() }).strict(),
]);

export type DealTarget = z.infer<typeof dealTargetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Owners and gates (shared by the read and the write)
// ─────────────────────────────────────────────────────────────────────────────

export type TermsOwner = { orgId: string | null; humanId: string | null };

/** The one party to event / org-default terms: their owner. */
export function ownerParties(owner: TermsOwner): AgreementParty[] {
  if (owner.orgId) return [{ type: "organization", id: owner.orgId }];
  if (owner.humanId) return [{ type: "human", id: owner.humanId }];
  return [];
}

/** Is `ref` the owner itself (org ref ↔ orgId, human ref ↔ humanId)? */
export function isOwnerRef(owner: TermsOwner, ref: DealPayeeRef): boolean {
  if (owner.orgId) return ref.kind === "org" && ref.id === owner.orgId;
  if (owner.humanId) return ref.kind === "human" && ref.id === owner.humanId;
  return false;
}

/** Is `payee` the owner's own payee? Its per-order line needs no confirmation. */
export function isOwnerPayee(
  owner: TermsOwner,
  payee: { subjectType: "HUMAN" | "ORGANIZATION"; subjectId: string },
): boolean {
  if (owner.orgId) {
    return payee.subjectType === "ORGANIZATION" && payee.subjectId === owner.orgId;
  }
  if (owner.humanId) {
    return payee.subjectType === "HUMAN" && payee.subjectId === owner.humanId;
  }
  return false;
}

/**
 * May the actor change who an EVENT pays? `actorHoldsEventEditRole` (the one
 * editor rule; `canEditEvent` is a thin wrapper over it) — ORG_EDIT_ROLES on
 * the event's org, or the human owner / an edit-role delegate — narrowed by
 * PAYOUT ROUTING (owner ruling 2026-09-28): on a human-owned event only the
 * owner. So it admits the same actors as `canEditEvent` or fewer, matching
 * `updateEventSplits` (`canEditEvent` + `ensurePayoutRoutingActor`). An
 * ownerless (community) event has no payout editor. The owner comes from the
 * event row.
 */
export async function mayRouteEventPayouts(
  authz: Repos["authz"],
  event: Pick<EventRecord, "orgId" | "humanId">,
  actorHumanId: string,
): Promise<boolean> {
  const owner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
  if (!(await actorHoldsEventEditRole(authz, owner, actorHumanId))) return false;
  // ensurePayoutRoutingActor, as a predicate.
  if (owner.orgId) return true;
  return owner.humanId !== null && owner.humanId === actorHumanId;
}

/** The splits editor's refusal: booking-owned terms belong to the agreement. */
export async function refuseBookingOwnedTerms(
  agreements: Pick<Repos["agreements"], "getByPayoutTermsId">,
  payoutTermsId: string,
): Promise<void> {
  const bookingAgreement = await agreements.getByPayoutTermsId(payoutTermsId);
  if (bookingAgreement) {
    // Same code as `updateEventSplits`; the meta points the editor at the
    // booking's own deal (target BOOKING_AGREEMENT).
    throw fail("AGREEMENT_FINALIZED", {
      meta: { reason: "event_terms_owned_by_booking", agreementId: bookingAgreement.id },
    });
  }
}

/**
 * Who ELSE points at an event's terms. Settlements recorded against them are
 * normal for a live event and are left out; anything else (another event, a
 * default, …) means the row is shared and a deal write would change their
 * money too. Shared by the write (refusal) and the read (`mayEdit`).
 */
export function otherEventTermsReferences(
  refs: readonly PayoutTermsReference[],
  eventId: string,
): PayoutTermsReference[] {
  return refs.filter(
    (r) => r.kind !== "SETTLEMENT" && !(r.kind === "EVENT_PRIMARY" && r.id === eventId),
  );
}

/** Who ELSE points at an org's default: anything but the org's own pointer. */
export function otherDefaultTermsReferences(
  refs: readonly PayoutTermsReference[],
  orgId: string,
): PayoutTermsReference[] {
  return refs.filter((r) => !(r.kind === "ORG_DEFAULT_PRIMARY" && r.id === orgId));
}

/**
 * Why `mayEdit` is false, so the editor can say so. Null when it is true.
 * A booking's own terms reached through an EVENT target are not a reason
 * here: that read is refused with AGREEMENT_FINALIZED and the agreement's id,
 * so the editor opens the booking's deal instead.
 */
export const dealNotEditableReasonSchema = z.enum([
  "not_payout_editor",
  "booking_not_editable",
  "terms_is_default",
  "event_archived",
  "event_cancelled",
  "event_terms_shared",
  "org_inactive",
  "default_terms_shared",
]);
export type DealNotEditableReason = z.infer<typeof dealNotEditableReasonSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The read context
// ─────────────────────────────────────────────────────────────────────────────

export type TermsDealContextRepos = AgreementDealContextRepos &
  Pick<Repos, "organizations" | "payoutTerms">;

export type TermsDealContext = {
  target: DealTarget;
  /** Set for a BOOKING_AGREEMENT target only. */
  agreementId: string | null;
  payoutTermsId: string;
  deal: PayoutTermsDealRecord;
  /** The event whose ticket types default the projection's tiers. */
  eventId: string | null;
  remainder: DealRemainder | null;
  viewer: DealViewer;
  mayEdit: boolean;
  notEditableReason: DealNotEditableReason | null;
};

/**
 * Load the deal on a target and decide what the actor may see of it (M5) and
 * whether they may change it.
 *
 *   BOOKING_AGREEMENT — exactly `loadAgreementDealContext`.
 *   EVENT             — FULL for edit-or-finance roles on the event's org, or
 *                       the human owner (payout routing: not their
 *                       delegates); OWN_LINE for a payee on the terms.
 *                       mayEdit = {@link mayRouteEventPayouts}.
 *   ORG_DEFAULT       — FULL for edit-or-finance roles on the org; nobody else
 *                       (a default is the org's template, not a live deal).
 *                       mayEdit = ORG_ADMIN_ROLES on an ACTIVE org.
 *
 * No terms yet (an event before its first save / an org before its default
 * is provisioned) → PAYOUT_TERMS_NOT_FOUND, only AFTER the actor passed the
 * gate, so an outsider learns nothing.
 */
export async function loadTermsDealContext(
  repos: TermsDealContextRepos,
  input: { actorHumanId: string; target: DealTarget },
): Promise<TermsDealContext> {
  const { target, actorHumanId } = input;

  if (target.kind === "BOOKING_AGREEMENT") {
    const ctx = await loadAgreementDealContext(repos, {
      agreementId: target.agreementId,
      actorHumanId,
    });
    return {
      target,
      agreementId: ctx.agreement.id,
      payoutTermsId: ctx.payoutTermsId,
      deal: ctx.deal,
      eventId: ctx.eventId,
      remainder: ctx.remainder,
      viewer: ctx.viewer,
      mayEdit: ctx.mayEdit,
      notEditableReason: ctx.mayEdit ? null : "booking_not_editable",
    };
  }

  if (target.kind === "EVENT") {
    const event = await repos.events.getById(target.eventId);
    if (!event) throw fail("EVENT_NOT_FOUND");
    const owner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
    const parties = ownerParties(owner);
    const termsId = event.payoutTermsId ?? null;
    const deal = termsId ? await repos.deals.getTermsDeal(termsId) : null;

    const viewer = await resolveDealViewer(repos, {
      actorHumanId,
      parties,
      partyOrgRoles: ORG_EDIT_OR_FINANCE_ROLES,
      payeeIds: deal
        ? [
            ...deal.clauses.map((c) => c.payeeId),
            ...deal.deductions.map((d) => d.creditedPayeeId),
            ...(deal.remainderPayeeId ? [deal.remainderPayeeId] : []),
          ]
        : [],
    });
    if (!viewer) throw fail("INSUFFICIENT_ROLE");
    if (!termsId || !deal) {
      throw fail("PAYOUT_TERMS_NOT_FOUND", { meta: { reason: "event_has_no_terms_yet" } });
    }
    await refuseBookingOwnedTerms(repos.agreements, termsId);

    const remainder = await resolveDealRemainder(repos, { deal, event: owner });
    // The write's refusals, in the order the editor should explain them.
    let notEditableReason: DealNotEditableReason | null = null;
    if (
      viewer.visibility !== "FULL" ||
      !(await mayRouteEventPayouts(repos.authz, owner, actorHumanId))
    ) {
      notEditableReason = "not_payout_editor";
    } else if ((await repos.payoutTerms.getById(termsId))?.isDefault !== false) {
      notEditableReason = "terms_is_default";
    } else if (event.status === "ARCHIVED") {
      notEditableReason = "event_archived";
    } else if (event.status === "CANCELLED") {
      notEditableReason = "event_cancelled";
    } else if (
      otherEventTermsReferences(await repos.deals.listTermsReferences(termsId), event.id)
        .length > 0
    ) {
      notEditableReason = "event_terms_shared";
    }
    const mayEdit = notEditableReason === null;
    return {
      target,
      agreementId: null,
      payoutTermsId: termsId,
      deal,
      eventId: event.id,
      remainder,
      viewer,
      mayEdit,
      notEditableReason,
    };
  }

  // ORG_DEFAULT
  const org = await repos.organizations.getById(target.orgId);
  if (!org) throw fail("ORGANIZATION_NOT_FOUND");
  const membership = await requireOrgMembership({
    repos,
    orgId: org.id,
    actorHumanId,
    roles: ORG_EDIT_OR_FINANCE_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
  const termsId = org.defaultPrimaryPayoutTermsId ?? null;
  const deal = termsId ? await repos.deals.getTermsDeal(termsId) : null;
  if (!termsId || !deal) {
    throw fail("PAYOUT_TERMS_NOT_FOUND", { meta: { reason: "org_has_no_default_terms_yet" } });
  }
  const remainder = await resolveDealRemainder(repos, {
    deal,
    event: { orgId: org.id, humanId: null },
  });
  const orgReason: DealNotEditableReason | null = !ORG_ADMIN_ROLES.includes(membership.role)
    ? "not_payout_editor"
    : org.status !== "ACTIVE"
      ? "org_inactive"
      : otherDefaultTermsReferences(await repos.deals.listTermsReferences(termsId), org.id)
            .length > 0
        ? "default_terms_shared"
        : null;
  return {
    target,
    agreementId: null,
    payoutTermsId: termsId,
    deal,
    eventId: null,
    remainder,
    viewer: { visibility: "FULL" },
    mayEdit: orgReason === null,
    notEditableReason: orgReason,
  };
}
