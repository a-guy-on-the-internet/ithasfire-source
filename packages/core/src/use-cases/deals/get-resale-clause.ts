import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  ORG_ADMIN_ROLES,
  ORG_EDIT_OR_FINANCE_ROLES,
  requireOrgMembership,
} from "../../lib/rbac";
import { resaleClauseOfTerms } from "../../lib/resale-clause";
import {
  loadAgreementDealContext,
  type AgreementDealContextRepos,
} from "./_shared/agreement-deal-context";
import {
  dealTargetSchema,
  mayRouteEventPayouts,
  ownerParties,
  type DealTarget,
} from "./_shared/deal-target";
import { resolveDealViewer } from "./_shared/deal-visibility";
import { resaleClauseViewSchema, toClauseView } from "./_shared/resale-terms-view";

// ─────────────────────────────────────────────────────────────────────────────
// getResaleClause — the resale clause on a target, on its own
// (organiser-resale-share FR-011, FR-012; board RC1 / DA1)
//
// `getTermsDeal` carries the same clause, but only once the target has a
// PRIMARY deal: an event before its first deal save, or a group with no
// ticket-sales default (most groups), reads as PAYOUT_TERMS_NOT_FOUND, and
// the clause with it. The clause is its own terms row and its own write
// (`setResaleClause`), so it gets its own read: the clause, the version to
// send back, whether this viewer may change it (and why not, in the same
// order `setResaleClause` refuses), and who receives the share (the RESALE
// payout lines, with names) for the editor's worked example.
//
// Gates mirror the deal read: EVENT — edit-or-finance on the event's org, or
// its human owner, sees it all; a payee on the RESALE lines sees the clause
// only. BOOKING_AGREEMENT — the agreement's deal gate (`loadAgreementDealContext`).
// ORG_DEFAULT — edit-or-finance on the group.
// ─────────────────────────────────────────────────────────────────────────────

export const getResaleClauseInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    target: dealTargetSchema,
  })
  .strict();

/** Why `mayEdit` is false, in the order `setResaleClause` would refuse. */
export const resaleClauseNotEditableReasonSchema = z.enum([
  /** Not an editor of this target (finance, a viewer, the act, a payee). */
  "not_payout_editor",
  /** BOOKING: not a DRAFT any more, or the act's side (the organiser writes it). */
  "booking_not_editable",
  /** BOOKING: the agreement has no event yet, so no RESALE terms to write. */
  "agreement_has_no_event_yet",
  /** EVENT: a booking that is not finalized holds the event's clause. */
  "resale_owned_by_booking",
  "event_archived",
  "event_cancelled",
  /** The RESALE terms row is pointed at by something else too. */
  "terms_shared",
  /** The RESALE terms row is a shared default or archived. */
  "terms_locked",
  "org_inactive",
  /**
   * EVENT / BOOKING: nobody receives resale money yet (no RESALE terms, or
   * terms with no lines). The write refuses a clause then
   * (AGREEMENT_MISSING_LINES), so the recipients come first.
   */
  "no_recipients_yet",
]);
export type ResaleClauseNotEditableReason = z.infer<
  typeof resaleClauseNotEditableReasonSchema
>;

const recipientSchema = z
  .object({
    lineId: z.string(),
    payeeId: z.string(),
    kind: z.enum(["org", "human"]).nullable(),
    name: z.string().nullable(),
    /** The line's share of the resale share, 0..100 (`PayoutTermsLine.percent`). */
    percent: z.number(),
    capPercent: z.number().nullable(),
    priority: z.number().int(),
    rounding: z.enum(["FLOOR", "NEAREST"]),
    /** Null = every ticket type. */
    ticketTypeId: z.string().nullable(),
  })
  .strict();

export const getResaleClauseOutputSchema = z
  .object({
    target: dealTargetSchema,
    /** The RESALE terms row; null when the target has none yet, and for OWN_LINE. */
    payoutTermsId: z.uuid().nullable(),
    /** Send back as `setResaleClause.expectedVersion`. Null = no terms yet (send null). */
    version: z.number().int().nullable(),
    /** Null = not set. Shown to every viewer (sellers and buyers see it anyway). */
    clause: resaleClauseViewSchema.nullable(),
    mayEdit: z.boolean(),
    notEditableReason: resaleClauseNotEditableReasonSchema.nullable(),
    /** The booking that holds this clause: the BOOKING target's, or the one an EVENT is anchored by. */
    agreementId: z.uuid().nullable(),
    /**
     * Who receives the share: the RESALE payout lines, in the order
     * `computeOrderSplits` takes them. Null for OWN_LINE; [] for a default
     * (lines are composed per event) and for an event with no lines yet.
     */
    recipients: z.array(recipientSchema).nullable(),
    /**
     * Ticket types on the event that allow resale. While any does, the
     * clause cannot be cleared (RESALE_SHARE_IN_USE). Null for a default and
     * for OWN_LINE.
     */
    resaleOnTicketTypes: z.number().int().nullable(),
  })
  .strict();

export type GetResaleClauseInput = z.infer<typeof getResaleClauseInputSchema>;
export type GetResaleClauseOutput = z.infer<typeof getResaleClauseOutputSchema>;

export type GetResaleClauseDeps = {
  repos: AgreementDealContextRepos &
    Pick<Repos, "organizations" | "payoutTerms" | "humans">;
};

/** A booking in one of these is over: it no longer holds the event's clause. */
const BOOKING_ENDED: ReadonlySet<string> = new Set(["CANCELLED", "DECLINED", "EXPIRED"]);

type TermsRow = NonNullable<Awaited<ReturnType<Repos["payoutTerms"]["getById"]>>>;

export async function getResaleClause(
  deps: GetResaleClauseDeps,
  rawInput: unknown,
): Promise<GetResaleClauseOutput> {
  const input = parseInput(getResaleClauseInputSchema, rawInput);
  const { target, actorHumanId } = input;
  const { repos } = deps;

  switch (target.kind) {
    case "EVENT":
      return readOnEvent(deps, target, actorHumanId);
    case "BOOKING_AGREEMENT": {
      const ctx = await loadAgreementDealContext(repos, {
        agreementId: target.agreementId,
        actorHumanId,
      });
      const agreement = ctx.agreement;
      // The write's event: the DRAFT's minted event. A finalized booking
      // reads its event's clause back (read-only from here).
      const eventId = ctx.eventId;
      const event = eventId ? await repos.events.getById(eventId) : null;
      const terms = await termsById(repos, event?.resalePayoutTermsId ?? null);
      const lines = terms ? await repos.payoutTerms.listLines(terms.id) : [];
      const full = ctx.viewer.visibility === "FULL";
      let reason: ResaleClauseNotEditableReason | null = null;
      if (!ctx.mayEdit) reason = full ? "booking_not_editable" : "not_payout_editor";
      else if (!agreement.draftEventId || !event) reason = "agreement_has_no_event_yet";
      else reason = await eventTermsReason(repos, event, terms, lines.length);
      return shape({
        target,
        terms,
        full,
        reason,
        agreementId: agreement.id,
        recipients: full ? await namedRecipients(repos, lines) : null,
        resaleOn: full && event ? await resaleOnCount(repos, event.id) : null,
      });
    }
    case "ORG_DEFAULT": {
      const org = await repos.organizations.getById(target.orgId);
      if (!org) throw fail("ORGANIZATION_NOT_FOUND");
      const membership = await requireOrgMembership({
        repos,
        orgId: org.id,
        actorHumanId,
        roles: ORG_EDIT_OR_FINANCE_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });
      const terms = await termsById(repos, org.defaultResalePayoutTermsId ?? null);
      let reason: ResaleClauseNotEditableReason | null = null;
      if (!ORG_ADMIN_ROLES.includes(membership.role)) reason = "not_payout_editor";
      else if (org.status !== "ACTIVE") reason = "org_inactive";
      else if (terms && terms.status === "ARCHIVED") reason = "terms_locked";
      else if (
        terms &&
        (await repos.deals.listTermsReferences(terms.id)).some(
          (r) => !(r.kind === "ORG_DEFAULT_RESALE" && r.id === org.id),
        )
      ) {
        reason = "terms_shared";
      }
      return shape({
        target,
        terms,
        full: true,
        reason,
        agreementId: null,
        recipients: [],
        resaleOn: null,
      });
    }
  }
}

async function readOnEvent(
  deps: GetResaleClauseDeps,
  target: Extract<DealTarget, { kind: "EVENT" }>,
  actorHumanId: string,
): Promise<GetResaleClauseOutput> {
  const { repos } = deps;
  const event = await repos.events.getById(target.eventId);
  if (!event) throw fail("EVENT_NOT_FOUND");
  const owner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
  const terms = await termsById(repos, event.resalePayoutTermsId ?? null);
  const lines = terms ? await repos.payoutTerms.listLines(terms.id) : [];

  const viewer = await resolveDealViewer(repos, {
    actorHumanId,
    parties: ownerParties(owner),
    partyOrgRoles: ORG_EDIT_OR_FINANCE_ROLES,
    payeeIds: lines.map((l) => l.payeeId),
  });
  if (!viewer) throw fail("INSUFFICIENT_ROLE");
  const full = viewer.visibility === "FULL";

  // The booking holding this event, if it is still being agreed.
  const booking = await repos.agreements.findByLinkedEventId(event.id);
  const holdingBooking =
    booking && booking.eventId === null && !BOOKING_ENDED.has(booking.status)
      ? booking
      : null;

  let reason: ResaleClauseNotEditableReason | null = null;
  if (!full || !(await mayRouteEventPayouts(repos.authz, owner, actorHumanId))) {
    reason = "not_payout_editor";
  } else if (holdingBooking) {
    reason = "resale_owned_by_booking";
  } else {
    reason = await eventTermsReason(repos, event, terms, lines.length);
  }

  return shape({
    target,
    terms,
    full,
    reason,
    agreementId: holdingBooking?.id ?? null,
    recipients: full ? await namedRecipients(repos, lines) : null,
    resaleOn: full ? await resaleOnCount(repos, event.id) : null,
  });
}

/** The write's refusals on an event's RESALE terms, as a reason. */
async function eventTermsReason(
  repos: GetResaleClauseDeps["repos"],
  event: { id: string; status: string },
  terms: TermsRow | null,
  lineCount: number,
): Promise<ResaleClauseNotEditableReason | null> {
  if (event.status === "ARCHIVED") return "event_archived";
  if (event.status === "CANCELLED") return "event_cancelled";
  // No terms or no lines: the write refuses a clause (AGREEMENT_MISSING_LINES).
  if (!terms) return "no_recipients_yet";
  if (terms.isDefault || terms.status === "ARCHIVED") return "terms_locked";
  const others = (await repos.deals.listTermsReferences(terms.id)).filter(
    (r) => r.kind !== "SETTLEMENT" && !(r.kind === "EVENT_RESALE" && r.id === event.id),
  );
  if (others.length > 0) return "terms_shared";
  return lineCount === 0 ? "no_recipients_yet" : null;
}

async function termsById(
  repos: GetResaleClauseDeps["repos"],
  id: string | null,
): Promise<TermsRow | null> {
  if (!id) return null;
  const terms = await repos.payoutTerms.getById(id);
  return terms && terms.kind === "RESALE" ? terms : null;
}

async function resaleOnCount(
  repos: GetResaleClauseDeps["repos"],
  eventId: string,
): Promise<number> {
  return (await repos.events.listTicketTypes(eventId)).filter((tt) => tt.resaleAllowed === true)
    .length;
}

async function namedRecipients(
  repos: GetResaleClauseDeps["repos"],
  lines: readonly PayoutTermsLineRecord[],
): Promise<z.infer<typeof recipientSchema>[]> {
  if (lines.length === 0) return [];
  const payees = await repos.payees.getByIds([...new Set(lines.map((l) => l.payeeId))]);
  const payeeById = new Map(payees.map((p) => [p.id, p]));
  const orgIds = payees.filter((p) => p.subjectType === "ORGANIZATION").map((p) => p.subjectId);
  const humanIds = payees.filter((p) => p.subjectType === "HUMAN").map((p) => p.subjectId);
  const [orgs, humans] = await Promise.all([
    orgIds.length ? repos.organizations.getByIds(orgIds) : Promise.resolve([]),
    humanIds.length ? repos.humans.getByIds(humanIds) : Promise.resolve([]),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const humanName = new Map(humans.map((h) => [h.id, h.name]));
  return lines.map((l) => {
    const payee = payeeById.get(l.payeeId);
    const kind = payee ? (payee.subjectType === "ORGANIZATION" ? "org" : "human") : null;
    const name = payee
      ? ((payee.subjectType === "ORGANIZATION"
          ? orgName.get(payee.subjectId)
          : humanName.get(payee.subjectId)) ?? null)
      : null;
    return {
      lineId: l.id,
      payeeId: l.payeeId,
      kind,
      name,
      percent: l.percent,
      capPercent: l.capPercent ?? null,
      priority: l.priority ?? 0,
      rounding: l.rounding ?? "FLOOR",
      ticketTypeId: l.ticketTypeId ?? null,
    };
  });
}

function shape(args: {
  target: DealTarget;
  terms: TermsRow | null;
  full: boolean;
  reason: ResaleClauseNotEditableReason | null;
  agreementId: string | null;
  recipients: z.infer<typeof recipientSchema>[] | null;
  resaleOn: number | null;
}): GetResaleClauseOutput {
  const clause = args.terms ? resaleClauseOfTerms(args.terms) : null;
  return getResaleClauseOutputSchema.parse({
    target: args.target,
    payoutTermsId: args.full ? (args.terms?.id ?? null) : null,
    version: args.full ? (args.terms?.version ?? null) : null,
    clause: clause ? toClauseView(clause) : null,
    mayEdit: args.reason === null,
    notEditableReason: args.reason,
    agreementId: args.agreementId,
    recipients: args.recipients,
    resaleOnTicketTypes: args.resaleOn,
  });
}
