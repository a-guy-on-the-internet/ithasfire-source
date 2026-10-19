import { createHash } from "node:crypto";

import type {
  DealDeductionRecord,
  PayoutTermsDealRecord,
} from "@th/ports/repos/deals";

/**
 * What a stored deal SAYS, normalised: the remainder holder, every clause's
 * id, payee and economics (sorted by id), every cost off the top in waterfall
 * order. It leaves out a payee's ANSWER (confirmation status, counter): a
 * deal write keeps an answer on every line it keeps, so an answer is not a
 * change to the deal.
 *
 * Two readers share it so they can never disagree about what "the deal" is:
 * {@link dealFingerprint} hashes it, and the freeze's change record
 * (`deal-freeze.ts`, freeze-the-deal FR-005) stores it as the before / after.
 */
export type NormalisedDealClause = {
  id: string;
  payeeId: string;
  amountType: string;
  amountCents: number | null;
  percent: number | null;
  basis: string;
  resolution: string | null;
  displayLabel: string | null;
  ticketTypeId: string | null;
  floorCents: number;
  capPercent: number | null;
  priority: number;
  rounding: string;
};

export type NormalisedDealDeduction = {
  id: string;
  kind: string;
  label: string;
  amountCents: number | null;
  percent: number | null;
  creditedPayeeId: string;
  estimated: boolean;
};

export type NormalisedDeal = {
  remainderPayeeId: string | null;
  clauses: NormalisedDealClause[];
  deductions: NormalisedDealDeduction[];
};

export function normaliseDeal(
  deal: Pick<PayoutTermsDealRecord, "remainderPayeeId" | "clauses" | "deductions">,
): NormalisedDeal {
  return {
    remainderPayeeId: deal.remainderPayeeId,
    clauses: [...deal.clauses]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({
        id: c.id,
        payeeId: c.payeeId,
        amountType: c.amountType,
        amountCents: c.amountCents,
        percent: c.percent,
        basis: c.basis,
        resolution: c.resolution,
        displayLabel: c.displayLabel,
        ticketTypeId: c.ticketTypeId,
        floorCents: c.floorCents,
        capPercent: c.capPercent,
        priority: c.priority,
        rounding: c.rounding,
      })),
    deductions: normaliseDeductions(deal.deductions),
  };
}

function normaliseDeductions(
  deductions: readonly DealDeductionRecord[],
): NormalisedDealDeduction[] {
  return [...deductions]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      amountCents: d.amountCents,
      percent: d.percent,
      creditedPayeeId: d.creditedPayeeId,
      estimated: d.estimated,
    }));
}

/**
 * A short, stable fingerprint of a stored deal: what an editor loaded, so a
 * whole-deal write can refuse when the deal changed underneath it (lost
 * update: admin A saves a stale clause list over admin B's new clause).
 *
 * Covers exactly {@link normaliseDeal}. The digest input keeps its original
 * array form, so fingerprints an editor already holds stay valid.
 *
 * `dealDeductionsFingerprint` is the costs-off-the-top part alone, for a
 * payee's answer to a NET_POOL clause (its value depends on the deductions).
 */
export function dealFingerprint(deal: PayoutTermsDealRecord): string {
  const n = normaliseDeal(deal);
  return digest({
    remainderPayeeId: n.remainderPayeeId,
    clauses: n.clauses.map((c) => [
      c.id,
      c.payeeId,
      c.amountType,
      c.amountCents,
      c.percent,
      c.basis,
      c.resolution,
      c.displayLabel,
      c.ticketTypeId,
      c.floorCents,
      c.capPercent,
      c.priority,
      c.rounding,
    ]),
    deductions: deductionRows(n.deductions),
  });
}

/** The costs off the top, in waterfall order. See {@link dealFingerprint}. */
export function dealDeductionsFingerprint(
  deductions: readonly DealDeductionRecord[],
): string {
  return digest({ deductions: deductionRows(normaliseDeductions(deductions)) });
}

function deductionRows(deductions: readonly NormalisedDealDeduction[]) {
  return deductions.map((d) => [
    d.id,
    d.kind,
    d.label,
    d.amountCents,
    d.percent,
    d.creditedPayeeId,
    d.estimated,
  ]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
