import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PayoutTermsReference } from "@th/ports/repos/deals";
import { fail as failApp } from "@th/errors";

import { fail } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { resaleShareClauseSchema, type ResaleShareClause } from "../../lib/pricing/resale-pricing";
import { ORG_ADMIN_ROLES, ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import {
  resaleClauseColumns,
  resaleClauseOfTerms,
  sameResaleClause,
} from "../../lib/resale-clause";
import { requireAgreementParty } from "../booking-agreements/_shared/agreement-access";
import { requireAgreementTermsEditor } from "../booking-agreements/_shared/agreement-editor-side";
import { requireDraftBookingAgreement } from "../booking-agreements/_shared/agreement-lines";
import {
  assertDealWritable,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
  type DealScope,
  type RecordedDealChange,
} from "./_shared/deal-freeze";
import { dealTargetSchema, mayRouteEventPayouts, type TermsOwner } from "./_shared/deal-target";
import { resaleClauseViewSchema, toClauseView } from "./_shared/resale-terms-view";

// ─────────────────────────────────────────────────────────────────────────────
// The resale clause (organiser-resale-share FR-001, FR-002, FR-011)
//
// The clause lives on RESALE PayoutTerms, a different row from the PRIMARY
// terms the deal write (`setTermsDeal`) locks. Where each target reaches it:
//
//   EVENT             — `Event.resalePayoutTermsId`. Event-owned on every
//                       event, booked or not: a booking agreement carries
//                       only PRIMARY terms and finalize links only those, so
//                       a booked event's RESALE terms are still the event's
//                       (`updateEventSplits` RESALE writes their lines).
//                       Gate: the event's payout-routing editors, as A1.
//                       While a booking that is not finalized (and not
//                       cancelled, declined or expired) anchors the event,
//                       the booking owns the clause: an EVENT write is
//                       refused (`event_resale_owned_by_booking`) so it
//                       cannot skip the booking's DRAFT and terms-editor
//                       gates. Once finalized, EVENT writes are allowed.
//   BOOKING_AGREEMENT — the RESALE terms of the agreement's draft event
//                       (`Agreement.draftEventId`). Gate: A1's booking gate
//                       (DRAFT, an edit-level party, the terms-editor side).
//                       No draft event yet → refused: there is no RESALE row
//                       to write until the event exists.
//   ORG_DEFAULT       — `Organization.defaultResalePayoutTermsId`, the
//                       template new events clone (clause included).
//                       Gate: ORG_ADMIN_ROLES on an ACTIVE org, as A1. Minted
//                       on the first set, as `setDefaultAgreement` does.
//
// A set clause on an event needs at least one RESALE payout line: the share is
// split over them, and a listing on lineless terms is refused
// (AGREEMENT_MISSING_LINES). This write does not create lines (it does not
// know the payees); the splits editor's Resale tab does. A default is a
// template whose lines are composed per event, so it has no such check.
//
// Clearing the clause on an event is refused while any of its ticket types
// allows resale (RESALE_SHARE_IN_USE): the switch-on and publish gates
// (`requireEventResaleClauseSet`) would otherwise be undone after the fact.
// Both sides take the terms lock, so neither can slip past the other.
//
// Every change of the clause bumps `PayoutTerms.version` in the same UPDATE:
// a ticket records the clause keyed by terms id + version (FR-003). An
// unchanged clause writes nothing.
// ─────────────────────────────────────────────────────────────────────────────

export const setResaleClauseInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    target: dealTargetSchema,
    /** Null clears the clause ("not set"). Refuses bps > 1000 and FLAT 0. */
    clause: resaleShareClauseSchema.nullable(),
    /**
     * The `version` the editor's read returned (`getTermsDeal.resaleTerms`),
     * or null when it found no RESALE terms. A clause changed since the read
     * is refused (conflict `resale_clause_changed`).
     */
    expectedVersion: z.number().int().min(1).nullable(),
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes a frozen
     * deal's resale clause (every payee is told). Without it the event's
     * frozen clause is refused (DEAL_FROZEN). An org default is never frozen.
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const setResaleClauseOutputSchema = z
  .object({
    target: dealTargetSchema,
    payoutTermsId: z.uuid().nullable(),
    version: z.number().int().nullable(),
    clause: resaleClauseViewSchema.nullable(),
    /** False when the stored clause already matched (nothing written). */
    changed: z.boolean(),
  })
  .strict();

export type SetResaleClauseInput = z.input<typeof setResaleClauseInputSchema>;
export type SetResaleClauseOutput = z.infer<typeof setResaleClauseOutputSchema>;

export type SetResaleClauseDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "bookingRequests"
    | "authz"
    | "organizations"
    | "events"
    | "payoutTerms"
    | "deals"
    | "audit"
    | "payees"
    | "humans"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

type ParsedInput = z.infer<typeof setResaleClauseInputSchema>;
type Applied = {
  payoutTermsId: string | null;
  version: number | null;
  changed: boolean;
  /** freeze-the-deal: the recorded frozen change, told after the commit. */
  frozenChange?: RecordedDealChange | null;
};

/**
 * Write (or clear) the resale clause on a target's RESALE terms. See the
 * header for where each target's terms are and who may write them.
 */
export async function setResaleClause(
  deps: SetResaleClauseDeps,
  rawInput: unknown,
): Promise<SetResaleClauseOutput> {
  const input = parseInput(setResaleClauseInputSchema, rawInput);
  const { target } = input;

  let applied: Applied;
  switch (target.kind) {
    case "EVENT":
      applied = await setOnEvent(deps, input, target.eventId);
      break;
    case "BOOKING_AGREEMENT":
      applied = await setOnBooking(deps, input, target.agreementId);
      break;
    case "ORG_DEFAULT":
      applied = await setOnOrgDefault(deps, input, target.orgId);
      break;
  }

  // freeze-the-deal FR-006: after the commit. Best effort: never throws.
  if (applied.frozenChange) await notifyDealChange(deps, applied.frozenChange);

  deps.logger?.info("deals.resale_clause_set", {
    target: target.kind,
    payoutTermsId: applied.payoutTermsId,
    changed: applied.changed,
    actorHumanId: input.actorHumanId,
  });

  return setResaleClauseOutputSchema.parse({
    target,
    payoutTermsId: applied.payoutTermsId,
    version: applied.version,
    clause: input.clause ? toClauseView(input.clause) : null,
    changed: applied.changed,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT
// ─────────────────────────────────────────────────────────────────────────────

async function setOnEvent(
  deps: SetResaleClauseDeps,
  input: ParsedInput,
  eventId: string,
): Promise<Applied> {
  const event = await deps.repos.events.getById(eventId);
  if (!event) throw failApp("EVENT_NOT_FOUND");
  const owner: TermsOwner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
  if (!(await mayRouteEventPayouts(deps.repos.authz, owner, input.actorHumanId))) {
    throw failApp("INSUFFICIENT_ROLE");
  }

  const now = deps.clock.now();
  return deps.repos.tx(async (tx) => {
    // The read above is a fast-fail; the gate ran against THAT owner.
    const txEvent = await tx.events.getById(eventId);
    if (!txEvent) throw failApp("EVENT_NOT_FOUND");
    if ((txEvent.orgId ?? null) !== owner.orgId || (txEvent.humanId ?? null) !== owner.humanId) {
      fail("conflict", "deal_event_owner_changed");
    }
    return writeOnEventResaleTerms(tx, {
      event: txEvent,
      reread: async () => tx.events.getById(eventId),
      scope: { kind: "EVENT", eventId },
      refuseWhileBookingOwns: true,
      input,
      audit: { actorHumanId: input.actorHumanId, eventId },
      now,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING_AGREEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function setOnBooking(
  deps: SetResaleClauseDeps,
  input: ParsedInput,
  agreementId: string,
): Promise<Applied> {
  // A1's booking gate (`setBookingAgreementDeal`), unchanged.
  const agreement = await requireDraftBookingAgreement(deps.repos.agreements, agreementId);
  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  const eventId = agreement.draftEventId ?? null;
  if (!eventId) {
    throw failApp("AGREEMENT_NOT_EDITABLE", {
      meta: { reason: "agreement_has_no_event_yet", agreementId },
    });
  }

  const now = deps.clock.now();
  return deps.repos.tx(async (tx) => {
    const txEvent = await tx.events.getById(eventId);
    if (!txEvent) throw failApp("EVENT_NOT_FOUND");
    return writeOnEventResaleTerms(tx, {
      event: txEvent,
      // Under the lock: the agreement is still a DRAFT on this event, and the
      // event still names these terms.
      reread: async () => {
        const fresh = await requireDraftBookingAgreement(tx.agreements, agreementId);
        if ((fresh.draftEventId ?? null) !== eventId) fail("conflict", "deal_terms_changed");
        return tx.events.getById(eventId);
      },
      scope: { kind: "BOOKING_AGREEMENT", eventId, agreementId },
      // This IS the booking's gate.
      refuseWhileBookingOwns: false,
      input,
      audit: { actorHumanId: input.actorHumanId, agreementId, eventId },
      now,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared by EVENT and BOOKING_AGREEMENT: the event's own RESALE terms
// ─────────────────────────────────────────────────────────────────────────────

function refuseClosedEvent(status: string): void {
  if (status === "ARCHIVED") throw failApp("EVENT_ARCHIVED");
  if (status === "CANCELLED") throw failApp("EVENT_CANCELLED");
}

async function writeOnEventResaleTerms(
  tx: TxRepos,
  args: {
    event: { id: string; status: string; resalePayoutTermsId?: string | null };
    /** Re-checks under the locks; returns the event as it stands now. */
    reread: () => Promise<{ status: string; resalePayoutTermsId?: string | null } | null>;
    /** Whose deal this is, for the freeze (FR-004). */
    scope: DealScope;
    /**
     * EVENT target: refuse while a booking agreement on this event is still
     * being agreed (not finalized, not ended). The act sees the clause on the
     * booking (R13, FR-011); the event's editors must not change it under
     * them. After finalize, EVENT writes stay allowed (owner question open).
     */
    refuseWhileBookingOwns: boolean;
    input: ParsedInput;
    audit: Record<string, unknown>;
    now: Date;
  },
): Promise<Applied> {
  const { event, input } = args;
  // A cancelled or archived event's money is settled or being refunded. A
  // fast-fail here; the binding check is the one under the locks below.
  refuseClosedEvent(event.status);

  const termsId = event.resalePayoutTermsId ?? null;
  if (!termsId) {
    // Nothing to lock or write: no RESALE terms means no resale lines either.
    if (input.expectedVersion !== null) fail("conflict", "resale_clause_changed");
    if (input.clause === null) return { payoutTermsId: null, version: null, changed: false };
    throw failApp("AGREEMENT_MISSING_LINES", {
      meta: { reason: "resale_terms_missing", eventId: event.id },
    });
  }

  // freeze-the-deal: the event row before the terms row (the order in
  // deal-freeze.ts). "share": this write never UPDATEs the Event row.
  await lockDealEvent(tx, args.scope);
  if (!(await tx.deals.lockTerms(termsId))) throw failApp("PAYOUT_TERMS_NOT_FOUND");
  const locked = await args.reread();
  if (!locked || (locked.resalePayoutTermsId ?? null) !== termsId) {
    fail("conflict", "deal_terms_changed");
  }
  // Under both locks: an event archived or cancelled while this write waited
  // is seen, and refused.
  refuseClosedEvent(locked.status);

  if (args.refuseWhileBookingOwns) {
    // Mirrors `refuseBookingOwnedTerms`: read under the lock, so a booking
    // linked while this write waited is seen.
    const booking = await tx.agreements.findByLinkedEventId(event.id);
    if (booking && booking.eventId === null && !BOOKING_ENDED.has(booking.status)) {
      throw failApp("AGREEMENT_NOT_EDITABLE", {
        meta: { reason: "event_resale_owned_by_booking", agreementId: booking.id },
      });
    }
  }

  const others = (await tx.deals.listTermsReferences(termsId)).filter(
    (r: PayoutTermsReference) =>
      r.kind !== "SETTLEMENT" && !(r.kind === "EVENT_RESALE" && r.id === event.id),
  );
  if (others.length > 0) {
    throw failApp("AGREEMENT_NOT_EDITABLE", {
      meta: { reason: "event_terms_shared", references: others },
    });
  }

  // freeze-the-deal FR-004: under the event row and RESALE terms locks.
  const fence = await assertDealWritable(tx, {
    scope: args.scope,
    frozenChange: input.frozenChange,
  });

  const applied = await applyOnLockedTerms(tx, {
    termsId,
    input,
    requireLines: true,
    refuseDefaultRow: true,
    eventId: event.id,
    audit: args.audit,
    now: args.now,
  });
  const frozenChange = await recordDealChange(tx, fence, {
    actorHumanId: input.actorHumanId,
    at: args.now,
  });
  return { ...applied, frozenChange };
}

/** A booking in one of these is over: it no longer holds the event's clause. */
const BOOKING_ENDED: ReadonlySet<string> = new Set(["CANCELLED", "DECLINED", "EXPIRED"]);

// ─────────────────────────────────────────────────────────────────────────────
// ORG_DEFAULT
// ─────────────────────────────────────────────────────────────────────────────

async function setOnOrgDefault(
  deps: SetResaleClauseDeps,
  input: ParsedInput,
  orgId: string,
): Promise<Applied> {
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

  const now = deps.clock.now();
  const audit = { actorHumanId: input.actorHumanId, orgId: org.id };
  return deps.repos.tx(async (tx) => {
    const termsId = (await tx.organizations.getById(org.id))?.defaultResalePayoutTermsId ?? null;

    if (!termsId) {
      if (input.expectedVersion !== null) fail("conflict", "resale_clause_changed");
      if (input.clause === null) return { payoutTermsId: null, version: null, changed: false };
      // First clause on this org: mint the template and pin it, guarded so a
      // concurrent minter (this or `setDefaultAgreement`) that linked first
      // wins and this one conflicts; its row rolls back with the transaction.
      const created = await tx.payoutTerms.createDraft({
        kind: "RESALE",
        settlementCurrency: "usd",
        ...resaleClauseColumns(input.clause),
      });
      const linked = await tx.deals.linkOrgDefaultResaleTermsIfUnset({
        orgId: org.id,
        payoutTermsId: created.id,
      });
      if (!linked) fail("conflict", "deal_terms_changed");
      await logClauseAudit(tx, {
        termsId: created.id,
        before: null,
        after: input.clause,
        version: created.version,
        audit,
        now,
      });
      return { payoutTermsId: created.id, version: created.version, changed: true };
    }

    if (!(await tx.deals.lockTerms(termsId))) throw failApp("PAYOUT_TERMS_NOT_FOUND");
    const locked = await tx.organizations.getById(org.id);
    if ((locked?.defaultResalePayoutTermsId ?? null) !== termsId) {
      fail("conflict", "deal_terms_changed");
    }
    // The org's pointer must be the only thing on its template: a place's or
    // an event's pointer on the same row would have its clause changed too.
    const others = (await tx.deals.listTermsReferences(termsId)).filter(
      (r: PayoutTermsReference) => !(r.kind === "ORG_DEFAULT_RESALE" && r.id === org.id),
    );
    if (others.length > 0) {
      throw failApp("AGREEMENT_NOT_EDITABLE", {
        meta: { reason: "default_terms_shared", references: others },
      });
    }

    return applyOnLockedTerms(tx, {
      termsId,
      input,
      requireLines: false,
      refuseDefaultRow: false,
      // A template sells nothing: clearing it changes no ticket's record.
      eventId: null,
      audit,
      now,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The write, on a locked RESALE terms row
// ─────────────────────────────────────────────────────────────────────────────

async function applyOnLockedTerms(
  tx: TxRepos,
  args: {
    termsId: string;
    input: ParsedInput;
    requireLines: boolean;
    refuseDefaultRow: boolean;
    /** The event the terms belong to (EVENT, BOOKING); null for a default. */
    eventId: string | null;
    audit: Record<string, unknown>;
    now: Date;
  },
): Promise<Applied> {
  const { termsId, input } = args;
  const terms = await tx.payoutTerms.getById(termsId);
  if (!terms) throw failApp("PAYOUT_TERMS_NOT_FOUND");
  if (terms.kind !== "RESALE") {
    throw failApp("AGREEMENT_NOT_EDITABLE", { meta: { reason: "not_resale_terms", payoutTermsId: termsId } });
  }
  if (terms.status === "ARCHIVED") {
    throw failApp("AGREEMENT_NOT_EDITABLE", { meta: { reason: "terms_archived", payoutTermsId: termsId } });
  }
  // Never write through an event onto a shared default row.
  if (args.refuseDefaultRow && terms.isDefault) throw failApp("AGREEMENT_NOT_EDITABLE");
  if (input.expectedVersion !== terms.version) fail("conflict", "resale_clause_changed");

  const before = resaleClauseOfTerms(terms);
  if (sameResaleClause(before, input.clause)) {
    return { payoutTermsId: termsId, version: terms.version, changed: false };
  }

  // Never clear the clause while resale is on (FR-001, R10). A ticket sold
  // while it is clear records no clause, and its first listing would then
  // stamp whatever clause is set later (FR-004), not the one in force at
  // its sale. Under this terms lock: the ticket-type gates take the same
  // lock before they read the clause, so the two serialize.
  if (input.clause === null && args.eventId) {
    const resaleOn = (await tx.events.listTicketTypes(args.eventId)).filter(
      (tt) => tt.resaleAllowed === true,
    );
    if (resaleOn.length > 0) {
      throw failApp("RESALE_SHARE_IN_USE", {
        meta: {
          reason: "resale_on_for_ticket_types",
          payoutTermsId: termsId,
          ticketTypeIds: resaleOn.map((tt) => tt.id),
        },
      });
    }
  }

  if (input.clause !== null && args.requireLines) {
    const lines = await tx.payoutTerms.listLines(termsId);
    if (lines.length === 0) {
      throw failApp("AGREEMENT_MISSING_LINES", {
        meta: { reason: "resale_lines_missing", payoutTermsId: termsId },
      });
    }
  }

  // One UPDATE: the clause and the version move together.
  const updated = await tx.payoutTerms.updateDraft({
    payoutTermsId: termsId,
    ...resaleClauseColumns(input.clause),
    bumpVersion: true,
  });
  await logClauseAudit(tx, {
    termsId,
    before,
    after: input.clause,
    version: updated.version,
    audit: args.audit,
    now: args.now,
  });
  return { payoutTermsId: termsId, version: updated.version, changed: true };
}

async function logClauseAudit(
  tx: Pick<TxRepos, "audit">,
  args: {
    termsId: string;
    before: ResaleShareClause | null;
    after: ResaleShareClause | null;
    version: number;
    audit: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.audit.log({
    entity: "payoutTerms",
    entityId: args.termsId,
    action: "resale_clause_set",
    data: { ...args.audit, before: args.before, after: args.after, version: args.version },
    at: args.now,
  });
}
