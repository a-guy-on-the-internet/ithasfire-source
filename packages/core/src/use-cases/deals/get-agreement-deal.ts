import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { PayoutTermsDealRecord } from "@th/ports/repos/deals";

import { parseInput } from "../../lib/io";
import { classifyClauseForStage1 } from "../../lib/settlement";
import {
  agreementPartyTypeSchema,
  partyKey,
  resolvePartyDisplayNames,
} from "../booking-agreements/list-booking-agreements";
import { payoutLineConfirmationStatusSchema } from "../booking-agreements/get-booking-agreement";
import { loadAgreementDealContext } from "./_shared/agreement-deal-context";
import { dealFreezeViewSchema, loadDealFreezeView } from "./_shared/deal-freeze-view";
import {
  isStoredPerOrderLine,
  perOrderPercentTotal,
  type DealRemainder,
} from "./_shared/deal-from-storage";
import type { DealViewer } from "./_shared/deal-visibility";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getAgreementDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
  })
  .strict();

export const dealRemainderSourceSchema = z.enum([
  "STORED",
  "LEGACY_EVENT_ORGANISER",
  "LEGACY_AGREEMENT_EDITOR",
  "LEGACY_LARGEST_LINE",
]);

export const agreementDealClauseSchema = z
  .object({
    id: z.string(),
    payeeId: z.string(),
    amountType: z.enum(["FIXED", "PERCENT", "FIXED_AND_PERCENT"]),
    amountCents: z.number().int().nullable(),
    percent: z.number().int().nullable(),
    basis: z.enum(["GROSS", "NET_POOL"]),
    resolution: z.enum(["SUM", "GREATER_OF"]).nullable(),
    displayLabel: z.string().nullable(),
    /**
     * FR-005: PAID_PER_ORDER = Ithas Fire pays it as tickets sell;
     * SETTLED_DIRECTLY = "Settled directly — Ithas Fire shows the math, the
     * organiser pays it".
     */
    stage1: z.enum(["PAID_PER_ORDER", "SETTLED_DIRECTLY"]),
    /**
     * REMAINDER_PER_ORDER = the remainder holder's own per-order line: "the
     * rest" of each order, derived by every deal write, not a term anyone
     * types. CLAUSE = everything else.
     */
    role: z.enum(["CLAUSE", "REMAINDER_PER_ORDER"]),
    requiresConfirmation: z.boolean(),
    confirmationStatus: payoutLineConfirmationStatusSchema.nullable(),
  })
  .strict();

export const agreementDealDeductionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["RENTAL", "EXPENSE", "HOUSE_NUT"]),
    label: z.string(),
    amountCents: z.number().int().nullable(),
    percent: z.number().int().nullable(),
    creditedPayeeId: z.string(),
    estimated: z.boolean(),
  })
  .strict();

export const dealPayeeSchema = z
  .object({
    payeeId: z.string(),
    subjectType: agreementPartyTypeSchema,
    subjectId: z.string(),
    displayName: z.string().nullable(),
  })
  .strict();

export const getAgreementDealOutputSchema = z
  .object({
    agreementId: z.uuid(),
    payoutTermsId: z.uuid(),
    /** FULL = a party (M5); OWN_LINE = a payee who is not a party. */
    visibility: z.enum(["FULL", "OWN_LINE"]),
    mayEdit: z.boolean(),
    /** Null for an OWN_LINE viewer, or when no rule could name one. */
    remainder: z
      .object({ payeeId: z.string(), source: dealRemainderSourceSchema })
      .strict()
      .nullable(),
    clauses: z.array(agreementDealClauseSchema),
    deductions: z.array(agreementDealDeductionSchema),
    /**
     * Σ percent of the per-order lines — 100 on a well-formed deal. Anything
     * else means a legacy line edit has drifted from the deal (the editor
     * warns). Null for an OWN_LINE viewer.
     */
    perOrderPercentTotal: z.number().int().nullable(),
    payees: z.array(dealPayeeSchema),
    /**
     * The freeze on the event this deal belongs to (freeze-the-deal FR-001);
     * null when the deal has no event yet. See `_shared/deal-freeze-view.ts`.
     */
    dealFreeze: dealFreezeViewSchema,
  })
  .strict();

export type GetAgreementDealInput = z.infer<typeof getAgreementDealInputSchema>;
export type GetAgreementDealOutput = z.infer<typeof getAgreementDealOutputSchema>;

export type GetAgreementDealDeps = {
  repos: Pick<
    Repos,
    | "agreements"
    | "deals"
    | "bookingRequests"
    | "events"
    | "payees"
    | "authz"
    | "humans"
    | "organizations"
  >;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The deal on a booking agreement (FR-001/FR-003 data): every clause with its
 * stage-1 classification, the costs off the top, the remainder holder (and
 * where it came from), shaped for the viewer (M5). Read-only: never stores a
 * derived remainder.
 */
export async function getAgreementDeal(
  deps: GetAgreementDealDeps,
  rawInput: unknown,
): Promise<GetAgreementDealOutput> {
  const input = parseInput(getAgreementDealInputSchema, rawInput);
  const ctx = await loadAgreementDealContext(deps.repos, input);
  const shaped = await describeDealForViewer(deps.repos, ctx);

  const dealFreeze = await loadDealFreezeView(deps.repos, ctx.eventId);

  return getAgreementDealOutputSchema.parse({
    agreementId: ctx.agreement.id,
    payoutTermsId: ctx.payoutTermsId,
    mayEdit: ctx.mayEdit,
    dealFreeze,
    ...shaped,
  });
}

export type DealForViewer = Pick<
  GetAgreementDealOutput,
  | "visibility"
  | "remainder"
  | "clauses"
  | "deductions"
  | "perOrderPercentTotal"
  | "payees"
>;

/**
 * A stored deal shaped for its viewer (M5): FULL = every clause, cost and the
 * remainder; OWN_LINE = only the viewer's own clauses and costs. Shared by
 * every deal read (booking agreement, event, org default).
 */
export async function describeDealForViewer(
  repos: Pick<Repos, "payees" | "humans" | "organizations">,
  ctx: {
    deal: PayoutTermsDealRecord;
    remainder: DealRemainder | null;
    viewer: DealViewer;
  },
): Promise<DealForViewer> {
  const { deal, remainder, viewer } = ctx;

  const own =
    viewer.visibility === "OWN_LINE" ? new Set(viewer.payeeIds) : null;
  const clauses = deal.clauses
    .filter((c) => own === null || own.has(c.payeeId))
    .map((c) => ({
      id: c.id,
      payeeId: c.payeeId,
      amountType: c.amountType,
      amountCents: c.amountCents,
      percent: c.percent,
      basis: c.basis,
      resolution: c.resolution,
      displayLabel: c.displayLabel,
      stage1: classifyClauseForStage1(c),
      role:
        remainder && c.payeeId === remainder.payeeId && isStoredPerOrderLine(c)
          ? ("REMAINDER_PER_ORDER" as const)
          : ("CLAUSE" as const),
      requiresConfirmation: c.requiresConfirmation,
      confirmationStatus: c.confirmationStatus,
    }));
  const deductions = deal.deductions
    .filter((d) => own === null || own.has(d.creditedPayeeId))
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      amountCents: d.amountCents,
      percent: d.percent,
      creditedPayeeId: d.creditedPayeeId,
      estimated: d.estimated,
    }));

  const payeeIds = new Set<string>([
    ...clauses.map((c) => c.payeeId),
    ...deductions.map((d) => d.creditedPayeeId),
    ...(own === null && remainder ? [remainder.payeeId] : []),
  ]);
  const payees = await describePayees(repos, [...payeeIds]);

  return {
    visibility: viewer.visibility,
    remainder: own === null ? remainder : null,
    clauses,
    deductions,
    perOrderPercentTotal: own === null ? perOrderPercentTotal(deal) : null,
    payees,
  };
}

/** Payee rows → subject + display name (two batched reads, never per row). */
export async function describePayees(
  repos: Pick<Repos, "payees" | "humans" | "organizations">,
  payeeIds: readonly string[],
): Promise<z.infer<typeof dealPayeeSchema>[]> {
  if (payeeIds.length === 0) return [];
  const rows = await repos.payees.getByIds([...new Set(payeeIds)]);
  const refs = rows.map((p) => ({
    type: p.subjectType === "HUMAN" ? ("human" as const) : ("organization" as const),
    id: p.subjectId,
  }));
  const names = await resolvePartyDisplayNames(repos, refs);
  return rows
    .map((p, i) => {
      const ref = refs[i]!;
      return {
        payeeId: p.id,
        subjectType: ref.type,
        subjectId: p.subjectId,
        displayName: names.get(partyKey(ref.type, ref.id)) ?? null,
      };
    })
    .sort((a, b) => (a.payeeId < b.payeeId ? -1 : a.payeeId > b.payeeId ? 1 : 0));
}
