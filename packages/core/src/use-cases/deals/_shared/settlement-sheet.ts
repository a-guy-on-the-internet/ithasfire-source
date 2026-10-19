/**
 * The settlement sheet of one event (FR-004): the stored deal, the real ticket
 * money from the ledger, and what was typed in after the show — run through
 * `computeDealSettlement` in ACTUAL mode; or, once marked settled, the frozen
 * copy, never recomputed.
 *
 * ── THE LEDGER QUERY behind the ticket money and "paid through Ithas Fire"
 * (deal-terms.ts `paidThroughPlatform` sourcing rule; adapter
 * `DealsRepo.readEventTicketLedger`):
 *
 *   ORDER SET   the event's orders with kind = TICKETING and source = PRIMARY
 *               that carry at least one SETTLEMENT_CREDIT ledger entry — the
 *               orders the per-order engine paid out. Resale (other terms),
 *               comps and memberships are outside it by construction; the
 *               order → event link is `Order.eventId`, never
 *               `Settlement.eventId` (a Settlement row can span events).
 *   PAID        per payee: Σ SETTLEMENT_CREDIT − Σ REFUND_DEBIT over the
 *               order set (`PayeeLedgerEntry.orderId`). Nothing else: no
 *               MANUAL_ADJUSTMENT, no dispute entries, no TRANSFER_REVERSAL_
 *               CREDIT (it repays a REFUND_DEBIT the payee already returned —
 *               `retainedCreditByPayee`'s reading). Every split there was made
 *               from a PERCENT/GROSS line: the adapter's per-order fence is the
 *               only way a line reaches `computeOrderSplits`.
 *   GROSS (M8)  Σ computeAgreementBasis(order) over the order set — the
 *               number per-order splits divide. Each order is read under its
 *               own rule (`feePolicySnapshot.organiserCredit`): the full
 *               ticket money on a FULL_PRICE order, that minus the platform
 *               fee on an order sold before the 2026-10-11 ruling;
 *               minus Σ REFUND_DEBIT over the same set (a refund debit is
 *               taken from that basis, never from the fee or tax).
 *   orderCount  |order set| + distinct (order, refund) pairs — each moves a
 *               per-order line by under a cent (W3).
 *   COVERAGE    PRIMARY ticketing orders that took money (SUCCEEDED,
 *               PART_REFUNDED, REFUNDED, DISPUTED) with a positive basis but
 *               NO settlement credit are outside the order set; the sheet
 *               reports them (count + basis) instead of counting them as $0
 *               — except CASH sales (POS, `paymentChannel = CASH`), money the
 *               platform never held, reported apart as cash sales on record.
 *   DISPUTES    not taken off PAID (the sourcing rule); reported by outcome.
 *   LEDGER-ONLY a payee PAID names who is not in the deal any more (a split
 *               edited after tickets sold) is passed to the calculator as a
 *               ledger-only payee: entitled to what it was paid, so it nets
 *               to $0 on its own labelled row.
 */
import { z } from "zod";

import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type {
  PayoutTermsDealRecord,
  SettlementSheetRecord,
} from "@th/ports/repos/deals";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrgRole } from "@th/ports/repos/authz";
import { fail } from "@th/errors";

import { isEventPast } from "../../../lib/event-ended";
import { ORG_ADMIN_ROLES, ORG_EDIT_OR_FINANCE_ROLES } from "../../../lib/rbac";
import {
  DEAL_SETTLEMENT_ENGINE_VERSION,
  DealSettlementInvariantError,
  assertDealSettlementInvariants,
  assertFrozenSheetIdentities,
  computeDealSettlement,
  dealParticipantIds,
  dealTermsSchema,
  type DealSettlementInputs,
  type DealSettlementResult,
  type DealTerms,
} from "../../../lib/settlement";
import { computeAgreementBasis } from "../../orders/finalize-from-payment-intent";
import {
  partyOnSide,
  type AgreementParty,
} from "../../booking-agreements/_shared/agreement-access";
import {
  resolveDealRemainder,
  toDealTerms,
  type DealRemainder,
} from "./deal-from-storage";
import { resolveDealViewer, type DealViewer } from "./deal-visibility";

/** Statuses of an order that took the buyer's money (coverage only). */
const MONEY_TAKING_STATUSES = new Set([
  "SUCCEEDED",
  "PART_REFUNDED",
  "REFUNDED",
  "DISPUTED",
]);

export type SheetRepos = Pick<
  Repos,
  "events" | "deals" | "agreements" | "bookingRequests" | "payees" | "authz"
>;

// ── Who may do what (the organiser side) ──────────────────────────────────

export type OrganiserAccess = {
  /** Enter / clear what was typed in (door cash, actuals, direct payments). */
  canEdit: boolean;
  /** "Mark settled" and reopen. */
  canSettle: boolean;
};

/**
 * The organiser side of an event's money. An org-owned event: a member with
 * an edit or finance role may type into the sheet (ORG_EDIT_OR_FINANCE_ROLES
 * — "agreements … and other edit+finance workflows"); only OWNER/ADMIN may
 * mark it settled or reopen it (the 09-28 ruling that refunds — money
 * decisions — need OWNER/ADMIN). A human-owned event: the owner only, for
 * both — PAYOUT ROUTING STAYS OWNER-ONLY (`ensurePayoutRoutingActor`): an
 * edit-role delegate does not touch the principal's money.
 */
export async function organiserAccess(
  repos: Pick<Repos, "authz">,
  event: Pick<EventRecord, "orgId" | "humanId">,
  actorHumanId: string,
): Promise<OrganiserAccess> {
  if (event.orgId) {
    const membership = await repos.authz.getOrgMembership({
      orgId: event.orgId,
      humanId: actorHumanId,
    });
    const role: OrgRole | null = membership?.role ?? null;
    return {
      canEdit: role !== null && ORG_EDIT_OR_FINANCE_ROLES.includes(role),
      canSettle: role !== null && ORG_ADMIN_ROLES.includes(role),
    };
  }
  const owner = event.humanId !== null && event.humanId === actorHumanId;
  return { canEdit: owner, canSettle: owner };
}

export function refuseOrganiserAction(event: Pick<EventRecord, "orgId">): never {
  if (event.orgId) throw fail("INSUFFICIENT_ROLE");
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
}

// ── Loading ───────────────────────────────────────────────────────────────

export type SheetContext = {
  event: EventRecord;
  agreement: AgreementRecord | null;
  deal: PayoutTermsDealRecord;
  remainder: DealRemainder;
  terms: DealTerms;
  sheet: SettlementSheetRecord | null;
  viewer: DealViewer;
  access: OrganiserAccess;
  eventEnded: boolean;
};

/**
 * Event + deal + sheet, and who the actor is to it. Authorizes BEFORE any
 * deal-specific refusal, so an outsider learns nothing about the deal.
 *
 * Parties who see the whole sheet (M5, M13): the event's organiser, and both
 * parties of the booking agreement finalized onto the event — an org party
 * through an edit or finance role (OWNER/ADMIN/EDITOR/FINANCE), never a
 * VIEWER or SCANNER. A payee on the deal who is none of these sees their
 * line (M14).
 */
export async function loadSheetContext(
  repos: SheetRepos,
  input: { eventId: string; actorHumanId: string; now: Date },
): Promise<SheetContext> {
  const event = await repos.events.getById(input.eventId);
  if (!event) throw fail("EVENT_NOT_FOUND");

  const agreement = await repos.agreements.getByEventId(event.id);
  const bookingRequest = agreement
    ? await repos.bookingRequests.findByAgreementId(agreement.id)
    : null;
  const deal = event.payoutTermsId
    ? await repos.deals.getTermsDeal(event.payoutTermsId)
    : null;
  const remainder = deal
    ? await resolveDealRemainder(repos, { deal, event, agreement, bookingRequest })
    : null;

  const parties: AgreementParty[] = [];
  if (event.orgId) parties.push({ type: "organization", id: event.orgId });
  else if (event.humanId) parties.push({ type: "human", id: event.humanId });
  if (agreement) {
    parties.push(partyOnSide(agreement, "proposer"), partyOnSide(agreement, "counterparty"));
  }
  const viewer = await resolveDealViewer(repos, {
    actorHumanId: input.actorHumanId,
    parties,
    partyOrgRoles: ORG_EDIT_OR_FINANCE_ROLES,
    payeeIds: deal
      ? [
          ...deal.clauses.map((c) => c.payeeId),
          ...deal.deductions.map((d) => d.creditedPayeeId),
          ...(remainder ? [remainder.payeeId] : []),
        ]
      : [],
  });
  if (!viewer) throw fail("INSUFFICIENT_ROLE");

  if (!deal) throw fail("PRIMARY_AGREEMENT_MISSING");
  if (!remainder) throw fail("DEAL_REMAINDER_UNRESOLVED");

  return {
    event,
    agreement,
    deal,
    remainder,
    terms: toDealTerms(deal, remainder.payeeId),
    sheet: await repos.deals.getSheetByEventId(event.id),
    viewer,
    access: await organiserAccess(repos, event, input.actorHumanId),
    eventEnded: isEventPast(event, input.now),
  };
}

// ── The computation ───────────────────────────────────────────────────────

export const DISPUTE_OUTCOMES = ["OPEN", "WON", "LOST", "WARNING"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/** Stripe's dispute lifecycle → what it means for the sheet (W4). */
export function disputeOutcomeOf(status: string): DisputeOutcome {
  switch (status) {
    case "WON":
      return "WON";
    case "LOST":
      return "LOST";
    case "WARNING_OPEN":
    case "WARNING_UNDER_REVIEW":
    case "WARNING_CLOSED":
      // An early-fraud inquiry: no money has moved.
      return "WARNING";
    default:
      // NEEDS_TRIAGE, OPEN, UNDER_REVIEW — and anything new, which must be
      // read as undecided rather than as an outcome.
      return "OPEN";
  }
}

export const ledgerSummarySchema = z
  .object({
    /** Orders in the order set (credited by the per-order engine). */
    orderCount: z.number().int(),
    refundCount: z.number().int(),
    /**
     * Card / web orders that took money but carry no settlement credit:
     * outside the sheet, and a gap in the platform's own records.
     */
    uncreditedOrderCount: z.number().int(),
    uncreditedBasisCents: z.number().int(),
    /**
     * W3: cash sales recorded at the door (POS, paymentChannel CASH),
     * SUCCEEDED and PART_REFUNDED, each counted net of its refunded items —
     * the cash till report's own netting. The platform never held this
     * money (M8: off-platform money), so it is not a payout gap and not in
     * the gross. Shown, never typed in for the organiser: the organiser
     * counts the cash box and enters THAT total as door cash (which may
     * differ from what POS recorded — a float, a sale not rung up).
     */
    cashSales: z
      .object({ count: z.number().int(), amountCents: z.number().int() })
      .strict()
      .default({ count: 0, amountCents: 0 }),
    /**
     * W4: disputes on the event's orders, by outcome. Not taken off "paid
     * through Ithas Fire" (the sourcing rule counts credits and refund debits
     * only), so the sheet says how much is disputed instead.
     */
    disputes: z
      .array(
        z
          .object({
            outcome: z.enum(DISPUTE_OUTCOMES),
            count: z.number().int(),
            amountCents: z.number().int(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type LedgerSummary = z.infer<typeof ledgerSummarySchema>;

export const SHEET_INCOMPLETE_REASONS = [
  /** An off-platform row (door cash, a bar share) still reads "Not entered". */
  "NOT_ENTERED_OFF_PLATFORM",
  /** A cost off the top is still an estimate. */
  "ESTIMATED_COSTS",
  /** Typed-in rows the deal can no longer place were left out. */
  "STALE_ENTRIES",
  /** Card / web orders took money the ledger has no credit for. */
  "UNCREDITED_ORDERS",
  /**
   * Cash was sold at the door and no door-cash amount is entered yet. ANY
   * entered DOOR_CASH amount clears it: entering the counted cash-box total
   * is how the organiser confirms the cash — the sheet does not second-guess
   * the count against what POS recorded.
   */
  "CASH_SALES_NOT_ENTERED",
  /** A dispute on the event's orders is still undecided (money may move). */
  "DISPUTES_OPEN",
] as const;
export type SheetIncompleteReason = (typeof SHEET_INCOMPLETE_REASONS)[number];

/**
 * W2: whether the sheet holds all the money it should. The calculator's own
 * `completeness` speaks only for its inputs; this adds what was left OUT of
 * them — rows it could not place, orders with no credit, door cash not yet
 * typed in against recorded cash sales.
 */
export const sheetCompletenessSchema = z
  .object({
    complete: z.boolean(),
    reasons: z.array(z.enum(SHEET_INCOMPLETE_REASONS)),
  })
  .strict();
export type SheetCompleteness = z.infer<typeof sheetCompletenessSchema>;

const enteredSchema = {
  enteredByHumanId: z.string(),
  enteredAt: z.coerce.date(),
};
export const sheetEntriesSchema = z
  .object({
    offPlatform: z.array(
      z
        .object({
          id: z.string(),
          kind: z.enum(["DOOR_CASH", "BAR_SHARE", "OTHER"]),
          label: z.string(),
          amountCents: z.number().int().nullable(),
          heldByPayeeId: z.string(),
          ownerPayeeId: z.string().nullable(),
          ...enteredSchema,
        })
        .strict(),
    ),
    deductionActuals: z.array(
      z
        .object({ deductionId: z.string(), amountCents: z.number().int(), ...enteredSchema })
        .strict(),
    ),
    directPayments: z.array(
      z
        .object({
          id: z.string(),
          fromPayeeId: z.string(),
          toPayeeId: z.string(),
          amountCents: z.number().int(),
          label: z.string(),
          note: z.string().nullable(),
          ...enteredSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type SheetEntries = z.infer<typeof sheetEntriesSchema>;

export const acknowledgedIncompleteSchema = z
  .object({
    byHumanId: z.string(),
    reasons: z.array(z.enum(SHEET_INCOMPLETE_REASONS)),
  })
  .strict();

export type ComputedSheet = {
  terms: DealTerms;
  remainder: DealRemainder;
  inputs: DealSettlementInputs;
  result: DealSettlementResult;
  entries: SheetEntries;
  ledger: LedgerSummary;
  /** Typed-in rows the current deal can no longer place (left out, reported). */
  staleEntryIds: string[];
  completeness: SheetCompleteness;
  /** Settled while incomplete, on purpose — who confirmed it, and why it was. */
  acknowledgedIncomplete: z.infer<typeof acknowledgedIncompleteSchema> | null;
};

/**
 * What "Mark settled" freezes. Read back with {@link parseFrozenSheet}.
 * Fields added after the first frozen sheets carry defaults, so a copy
 * frozen earlier still reads (W5).
 */
export const frozenSheetSchema = z
  .object({
    engineVersion: z.number().int(),
    remainder: z
      .object({
        payeeId: z.string(),
        source: z.enum([
          "STORED",
          "LEGACY_EVENT_ORGANISER",
          "LEGACY_AGREEMENT_EDITOR",
          "LEGACY_LARGEST_LINE",
        ]),
      })
      .strict(),
    terms: dealTermsSchema,
    inputs: z.record(z.string(), z.unknown()),
    result: z.custom<DealSettlementResult>(
      (value) => typeof value === "object" && value !== null,
    ),
    entries: sheetEntriesSchema,
    ledger: ledgerSummarySchema,
    staleEntryIds: z.array(z.string()),
    completeness: sheetCompletenessSchema.nullable().default(null),
    acknowledgedIncomplete: acknowledgedIncompleteSchema.nullable().default(null),
  })
  .strict();

/**
 * The sheet on the real numbers, now. Throws (500 + Sentry, never a quiet
 * sheet) when the ledger is inconsistent with itself: a negative basis or
 * payment, more paid than the basis, or more than one currency.
 */
export async function computeDraftSheet(
  repos: Pick<Repos, "deals">,
  ctx: Pick<SheetContext, "event" | "terms" | "remainder" | "sheet">,
  options: { reportError?: ReporterPort } = {},
): Promise<ComputedSheet> {
  const { terms } = ctx;
  const participants = dealParticipantIds(terms);
  const ledger = await repos.deals.readEventTicketLedger(ctx.event.id);
  if (ledger.currencies.length > 1) {
    throw new DealSettlementInvariantError("ledger_mixed_currency", {
      eventId: ctx.event.id,
      currencies: ledger.currencies,
    });
  }

  const credited = ledger.orders.filter((o) => o.credited);
  const orderBasisCents = credited.reduce(
    (sum, o) => sum + computeAgreementBasis(o),
    0,
  );
  const refundDebitCents = ledger.perPayee.reduce((s, p) => s + p.refundDebitCents, 0);
  const basisCents = orderBasisCents - refundDebitCents;
  const paid = new Map<string, number>();
  for (const p of ledger.perPayee) paid.set(p.payeeId, p.creditCents - p.refundDebitCents);
  const totalPaid = [...paid.values()].reduce((s, v) => s + v, 0);
  if (basisCents < 0 || [...paid.values()].some((v) => v < 0) || totalPaid > basisCents) {
    throw new DealSettlementInvariantError("ledger_inconsistent", {
      eventId: ctx.event.id,
      orderBasisCents,
      refundDebitCents,
      totalPaid,
    });
  }

  // W1: the platform paid them per order under lines the deal no longer has
  // (a split edited after tickets sold). Named explicitly to the calculator
  // as ledger-only payees — entitled to what they were paid, so they net to
  // $0 on a labelled row — never refused (that made the sheet unreadable
  // for good) and never folded into anyone else's figure. A payee whose
  // credits were all refunded (net 0) holds nothing and is left out.
  const ledgerOnlyPayeeIds = ledgerOnlyPayeeIdsOf(ledger, participants);
  // Typed rows may name a ledger-only payee too (a direct payment to an act
  // removed from the deal): it is a participant of the SHEET.
  const sheetParticipants = new Set([...participants, ...ledgerOnlyPayeeIds]);

  // W3: cash sold at the door is off-platform money, never a payout gap.
  const isCashSale = (o: (typeof ledger.orders)[number]) =>
    o.paymentChannel === "CASH" && !o.credited;
  const cash = ledger.orders.filter(
    (o) => isCashSale(o) && (o.status === "SUCCEEDED" || o.status === "PART_REFUNDED"),
  );
  const cashNet = (o: (typeof cash)[number]) => Math.max(0, o.amountGrossCents - o.refundedItemCents);
  const uncredited = ledger.orders.filter(
    (o) =>
      !o.credited &&
      !isCashSale(o) &&
      MONEY_TAKING_STATUSES.has(o.status) &&
      computeAgreementBasis(o) > 0,
  );
  const disputes = new Map<DisputeOutcome, { count: number; amountCents: number }>();
  for (const d of ledger.disputes) {
    const outcome = disputeOutcomeOf(d.status);
    const agg = disputes.get(outcome) ?? { count: 0, amountCents: 0 };
    agg.count += 1;
    agg.amountCents += d.amountCents;
    disputes.set(outcome, agg);
  }
  const ledgerSummary: LedgerSummary = {
    orderCount: credited.length,
    refundCount: ledger.refundCount,
    uncreditedOrderCount: uncredited.length,
    uncreditedBasisCents: uncredited.reduce((s, o) => s + computeAgreementBasis(o), 0),
    cashSales: {
      count: cash.length,
      amountCents: cash.reduce((s, o) => s + cashNet(o), 0),
    },
    disputes: DISPUTE_OUTCOMES.filter((o) => disputes.has(o)).map((outcome) => ({
      outcome,
      ...disputes.get(outcome)!,
    })),
  };

  // Typed-in rows, checked against the deal as it stands. Each was valid
  // when entered; one the deal can no longer place is left out and named.
  const estimated = new Set(terms.deductions.filter((d) => d.estimated).map((d) => d.id));
  const sheet = ctx.sheet;
  const stale: string[] = [];
  const keep = <T extends { id: string }>(rows: readonly T[], ok: (row: T) => boolean): T[] =>
    rows.filter((row) => (ok(row) ? true : (stale.push(row.id), false)));
  const offPlatform = keep(
    sheet?.offPlatform ?? [],
    (o) =>
      sheetParticipants.has(o.heldByPayeeId) &&
      (o.ownerPayeeId === null || sheetParticipants.has(o.ownerPayeeId)),
  );
  const deductionActuals = keep(sheet?.deductionActuals ?? [], (a) =>
    estimated.has(a.deductionId),
  );
  const directPayments = keep(
    sheet?.directPayments ?? [],
    (d) => sheetParticipants.has(d.fromPayeeId) && sheetParticipants.has(d.toPayeeId),
  );
  if (stale.length > 0) {
    try {
      options.reportError?.(new Error("settlement_sheet_stale_entries"), {
        tags: { useCase: "settlementSheet" },
        extra: { eventId: ctx.event.id, staleEntryIds: stale },
      });
    } catch {
      // A throwing reporter must never change the sheet.
    }
  }

  const inputs: DealSettlementInputs = {
    ticketRevenue: {
      mode: "ACTUAL",
      basisCents,
      orderCount: credited.length + ledger.refundCount,
    },
    offPlatform: offPlatform.map((o) => ({
      id: o.id,
      kind: o.kind,
      label: o.label,
      amountCents: o.amountCents,
      heldByPayeeId: o.heldByPayeeId,
      ownerPayeeId: o.ownerPayeeId,
    })),
    deductionActuals: deductionActuals.map((a) => ({
      deductionId: a.deductionId,
      amountCents: a.amountCents,
    })),
    // W5: every participant has a figure — 0 when the platform paid it
    // nothing — so "missing" can never read as "$0 paid".
    paidThroughPlatform: [...participants, ...ledgerOnlyPayeeIds].sort().map((payeeId) => ({
      payeeId,
      amountCents: paid.get(payeeId) ?? 0,
    })),
    ledgerOnlyPayeeIds,
    directPayments: directPayments.map((d) => ({
      id: d.id,
      label: d.label,
      fromPayeeId: d.fromPayeeId,
      toPayeeId: d.toPayeeId,
      amountCents: d.amountCents,
    })),
  };

  const result = computeDealSettlement(terms, inputs);
  const reasons: SheetIncompleteReason[] = [];
  if (result.completeness.notEnteredOffPlatformIds.length > 0) reasons.push("NOT_ENTERED_OFF_PLATFORM");
  if (result.completeness.estimatedDeductionIds.length > 0) reasons.push("ESTIMATED_COSTS");
  if (stale.length > 0) reasons.push("STALE_ENTRIES");
  if (ledgerSummary.uncreditedOrderCount > 0) reasons.push("UNCREDITED_ORDERS");
  if (
    ledgerSummary.cashSales.count > 0 &&
    !offPlatform.some((o) => o.kind === "DOOR_CASH" && o.amountCents !== null)
  ) {
    reasons.push("CASH_SALES_NOT_ENTERED");
  }
  if (ledgerSummary.disputes.some((d) => d.outcome === "OPEN")) reasons.push("DISPUTES_OPEN");

  return {
    terms,
    remainder: ctx.remainder,
    inputs,
    result,
    entries: {
      offPlatform: offPlatform.map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        amountCents: o.amountCents,
        heldByPayeeId: o.heldByPayeeId,
        ownerPayeeId: o.ownerPayeeId,
        enteredByHumanId: o.enteredByHumanId,
        enteredAt: o.enteredAt,
      })),
      deductionActuals: deductionActuals.map((a) => ({
        deductionId: a.deductionId,
        amountCents: a.amountCents,
        enteredByHumanId: a.enteredByHumanId,
        enteredAt: a.enteredAt,
      })),
      directPayments: directPayments.map((d) => ({
        id: d.id,
        fromPayeeId: d.fromPayeeId,
        toPayeeId: d.toPayeeId,
        amountCents: d.amountCents,
        label: d.label,
        note: d.note,
        enteredByHumanId: d.enteredByHumanId,
        enteredAt: d.enteredAt,
      })),
    },
    ledger: ledgerSummary,
    staleEntryIds: stale,
    completeness: { complete: reasons.length === 0, reasons },
    acknowledgedIncomplete: null,
  };
}

/**
 * W1: payees the ledger shows the platform paid (net, non-zero) who are not
 * participants of the terms — paid per order under lines the deal no longer
 * has. Shared by the sheet and its writes, so a typed row may name one.
 */
export function ledgerOnlyPayeeIdsOf(
  ledger: { perPayee: ReadonlyArray<{ payeeId: string; creditCents: number; refundDebitCents: number }> },
  participants: ReadonlySet<string>,
): string[] {
  return ledger.perPayee
    .filter((p) => p.creditCents - p.refundDebitCents !== 0 && !participants.has(p.payeeId))
    .map((p) => p.payeeId)
    .sort();
}

/** The JSON "Mark settled" stores. */
export function freezeSheet(computed: ComputedSheet): z.input<typeof frozenSheetSchema> {
  return {
    engineVersion: computed.result.engineVersion,
    remainder: computed.remainder,
    terms: computed.terms,
    inputs: computed.inputs as unknown as Record<string, unknown>,
    result: computed.result,
    entries: computed.entries,
    ledger: computed.ledger,
    staleEntryIds: computed.staleEntryIds,
    completeness: computed.completeness,
    acknowledgedIncomplete: computed.acknowledgedIncomplete,
  };
}

/**
 * A settled sheet as frozen — never recomputed, whatever the engine version
 * now. It is re-checked on every read (a stored sheet that does not balance
 * must never render as if it does), by the rules OF ITS OWN VERSION (W5):
 * a copy frozen by this engine gets every invariant; one frozen by an older
 * engine gets the identities every version has kept
 * (`assertFrozenSheetIdentities`) — a newer engine's checks may test fields
 * an older one never wrote, and must not make a filed sheet unreadable.
 */
export function parseFrozenSheet(snapshot: unknown): ComputedSheet {
  const frozen = frozenSheetSchema.parse(snapshot);
  if (frozen.engineVersion === DEAL_SETTLEMENT_ENGINE_VERSION) {
    assertDealSettlementInvariants(frozen.result);
  } else {
    assertFrozenSheetIdentities(frozen.result);
  }
  return {
    terms: frozen.terms,
    remainder: frozen.remainder,
    inputs: frozen.inputs as unknown as DealSettlementInputs,
    result: frozen.result,
    entries: frozen.entries,
    ledger: frozen.ledger,
    staleEntryIds: frozen.staleEntryIds,
    // A copy frozen before completeness was recorded is read as what it was:
    // whatever its calculator said, plus anything it knew it left out.
    completeness: frozen.completeness ?? {
      complete:
        frozen.result.completeness.complete &&
        frozen.staleEntryIds.length === 0 &&
        frozen.ledger.uncreditedOrderCount === 0,
      reasons: [],
    },
    acknowledgedIncomplete: frozen.acknowledgedIncomplete,
  };
}

/** The sheet as it stands: frozen when settled, else computed now. */
export async function currentSheet(
  repos: Pick<Repos, "deals">,
  ctx: SheetContext,
  options: { reportError?: ReporterPort } = {},
): Promise<ComputedSheet & { frozen: boolean }> {
  if (ctx.sheet?.status === "SETTLED") {
    return { ...parseFrozenSheet(ctx.sheet.snapshot), frozen: true };
  }
  return { ...(await computeDraftSheet(repos, ctx, options)), frozen: false };
}

export { DEAL_SETTLEMENT_ENGINE_VERSION };
