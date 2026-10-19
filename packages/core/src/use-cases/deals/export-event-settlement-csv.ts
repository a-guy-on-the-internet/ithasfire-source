import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { formatMoneyCents } from "@th/types/money";

import { parseInput } from "../../lib/io";
import type { DealClauseResolutionDetail } from "../../lib/settlement";
import {
  currentSheet,
  loadSheetContext,
  type DisputeOutcome,
  type SheetIncompleteReason,
} from "./_shared/settlement-sheet";
import {
  buildSettlementView,
  type GetEventSettlementOutput,
} from "./get-event-settlement";

export const exportEventSettlementCsvInputSchema = z
  .object({ actorHumanId: z.uuid(), eventId: z.uuid() })
  .strict();

export const exportEventSettlementCsvOutputSchema = z
  .object({
    filename: z.string(),
    contentType: z.literal("text/csv"),
    csv: z.string(),
  })
  .strict();
export type ExportEventSettlementCsvOutput = z.infer<
  typeof exportEventSettlementCsvOutputSchema
>;

export type ExportEventSettlementCsvDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "deals"
    | "agreements"
    | "bookingRequests"
    | "payees"
    | "authz"
    | "humans"
    | "organizations"
  >;
  clock: ClockPort;
  reportError?: ReporterPort;
};

/**
 * The settlement sheet as CSV (FR-004 export; PDF later). Built from the SAME
 * viewer-shaped read as the page (M5): a party gets the whole sheet, a payee
 * who is not a party gets their own line, nobody else gets anything. Cents
 * go through the shared money formatter; anything not typed in reads
 * "Not entered", never $0.00 (NFR-002).
 *
 * The copy is English: a file someone hands their accountant, built where no
 * translator exists.
 */
export async function exportEventSettlementCsv(
  deps: ExportEventSettlementCsvDeps,
  rawInput: unknown,
): Promise<ExportEventSettlementCsvOutput> {
  const input = parseInput(exportEventSettlementCsvInputSchema, rawInput);
  const ctx = await loadSheetContext(deps.repos, {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    now: deps.clock.now(),
  });
  const computed = await currentSheet(deps.repos, ctx, { reportError: deps.reportError });
  const view = await buildSettlementView(deps.repos, ctx, computed);
  const currency = ctx.event.currency ?? "usd";
  // People named on the sheet (who settled it, who confirmed it incomplete)
  // by display name, resolved here — never a raw id in a file people share.
  const humanIds = [
    view.settled?.byHumanId,
    view.settled?.acknowledgedIncomplete?.byHumanId,
  ].filter((id): id is string => typeof id === "string");
  const people = new Map<string, string>();
  if (humanIds.length > 0) {
    for (const h of await deps.repos.humans.getByIds([...new Set(humanIds)])) {
      if (h.name) people.set(h.id, h.name);
    }
  }

  return exportEventSettlementCsvOutputSchema.parse({
    filename: `settlement-${ctx.event.id}.csv`,
    contentType: "text/csv",
    csv: settlementCsv(view, currency, people),
  });
}

// ── CSV ───────────────────────────────────────────────────────────────────

const NOT_ENTERED = "Not entered";

const count = (n: number, noun: string) =>
  `${n} ${n === 1 ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;

const INCOMPLETE_COPY: Record<SheetIncompleteReason, string> = {
  NOT_ENTERED_OFF_PLATFORM: "off-platform money not entered",
  ESTIMATED_COSTS: "costs still estimated",
  STALE_ENTRIES: "entries the deal can no longer place",
  UNCREDITED_ORDERS: "orders with no per-order payout on record",
  CASH_SALES_NOT_ENTERED: "cash sales on record, door cash not entered",
  DISPUTES_OPEN: "a dispute is still undecided",
};

const DISPUTE_COPY: Record<DisputeOutcome, string> = {
  OPEN: "undecided",
  WON: "won",
  LOST: "lost",
  WARNING: "fraud warning, no money moved",
};

/**
 * One cell. Quoted when it holds a quote, comma or line break. A TEXT cell
 * that a spreadsheet would read as a formula (=, +, -, @, tab, CR) is
 * prefixed with an apostrophe: labels and names are typed by people. Money
 * cells are ours (a formatted amount may start with "-") and pass through.
 */
export function csvCell(value: string, kind: "text" | "money" = "text"): string {
  const guarded = kind === "text" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

type Row = { section: string; item: string; party: string; amount: string; details: string };

export function settlementCsv(
  view: GetEventSettlementOutput,
  currency: string,
  people: ReadonlyMap<string, string> = new Map(),
): string {
  const person = (humanId: string) => people.get(humanId) ?? "Unnamed person";
  const money = (cents: number) => formatMoneyCents(cents, { currency: currency.toUpperCase() });
  const names = new Map(view.payees.map((p) => [p.payeeId, p.displayName ?? "Unnamed payee"]));
  const name = (payeeId: string) => names.get(payeeId) ?? "Unnamed payee";
  const rows: Row[] = [];
  const row = (section: string, item: string, party: string, amount: string, details = "") =>
    rows.push({ section, item, party, amount, details });

  row(
    "Status",
    view.status === "SETTLED" ? "Settled" : "Draft",
    "",
    "",
    view.settled ? `Settled ${view.settled.at.toISOString()} by ${person(view.settled.byHumanId)}` : "",
  );
  if (view.completeness && !view.completeness.complete) {
    row("Status", "Incomplete", "", "", view.completeness.reasons.map((r) => INCOMPLETE_COPY[r]).join("; "));
  }
  if (view.settled?.acknowledgedIncomplete) {
    row("Status", "Settled while incomplete, on purpose", "", "", `Confirmed by ${person(view.settled.acknowledgedIncomplete.byHumanId)}`);
  }

  const sheet = view.sheet;
  if (sheet.visibility === "FULL") {
    const r = sheet.result;
    const w = r.waterfall;
    row(
      "Ticket money",
      "Gross: ticket money net of refunds",
      "",
      money(w.grossCents),
      view.ledger ? `${count(view.ledger.orderCount, "order")}, ${count(view.ledger.refundCount, "refund")}` : "",
    );
    row("Ticket money", "Paid per order before costs", "", money(w.perOrderPaidFirstCents));
    // W1: paid per order under a line the deal no longer has.
    for (const l of r.ledgerOnly ?? []) {
      row(
        "Ticket money",
        "Paid per order, no longer in the deal",
        name(l.payeeId),
        money(l.paidCents),
        "Entitled to what was paid; nets to $0",
      );
    }
    for (const s of w.steps) {
      row(
        "Off the top",
        s.label,
        name(s.creditedPayeeId),
        money(s.amountCents),
        [
          `Recouped ${money(s.recoupedCents)}`,
          `Not recovered ${money(s.notRecoveredCents)}`,
          s.amountSource === "ESTIMATE" ? "Estimated" : s.amountSource === "ACTUAL" ? "Actual" : "Agreed",
        ].join("; "),
      );
    }
    row("Pool", "Pool after costs off the top", "", money(w.netPoolCents));
    for (const c of r.clauses) {
      row("Clause", c.displayLabel ?? describeHow(c.how, money), name(c.payeeId), money(c.entitlementCents), clauseDetails(c, money));
    }
    row("Remainder", "What's left after every clause", name(r.remainder.payeeId), money(r.remainder.shareCents));
    for (const o of r.offPlatform.rows) {
      row(
        "Off-platform money",
        o.label,
        `Held by ${name(o.heldByPayeeId)}`,
        o.entered && o.amountCents !== undefined ? money(o.amountCents) : NOT_ENTERED,
        `Belongs to ${name(o.ownerPayeeId)}${o.entered ? "" : "; excluded from every total"}`,
      );
    }
    for (const d of view.entries.directPayments) {
      row("Paid directly", d.label, `${name(d.fromPayeeId)} to ${name(d.toPayeeId)}`, money(d.amountCents), d.note ?? "");
    }
    for (const p of r.payees) {
      positionRows(p, name(p.payeeId), money, row);
    }
    if (r.shortfall) {
      for (const o of r.shortfall.owedTo) {
        row("Shortfall", `${name(r.shortfall.owedByPayeeId)} owes ${name(o.payeeId)}`, name(o.payeeId), money(o.cents));
      }
    }
    if (r.completeness.notEnteredOffPlatformIds.length > 0 || r.completeness.estimatedDeductionIds.length > 0) {
      row("Note", "Totals exclude anything not entered; estimated costs stay estimates until an actual is entered", "", "");
    }
    // W2: every exclusion, stated — what the sheet does NOT contain.
    if (view.staleEntryIds.length > 0) {
      row("Left out", "Entries the deal can no longer place", "", "", count(view.staleEntryIds.length, "entry"));
    }
    if (view.ledger) {
      if (view.ledger.uncreditedOrderCount > 0) {
        row(
          "Left out",
          "Card orders with no per-order payout on record",
          "",
          money(view.ledger.uncreditedBasisCents),
          count(view.ledger.uncreditedOrderCount, "order"),
        );
      }
      if (view.ledger.cashSales.count > 0) {
        row(
          "Left out",
          "Cash sales on record (money taken at the door, never held by Ithas Fire)",
          "",
          money(view.ledger.cashSales.amountCents),
          `${count(view.ledger.cashSales.count, "sale")}; counted only through door cash entered above`,
        );
      }
      for (const d of view.ledger.disputes) {
        row(
          "Left out",
          `Disputed orders: ${DISPUTE_COPY[d.outcome]}`,
          "",
          money(d.amountCents),
          `${count(d.count, "dispute")}; not taken off "Paid through Ithas Fire"`,
        );
      }
    }
  } else {
    for (const c of sheet.clauses) {
      // M14: a payee's own line shows the number its percentage is of.
      row("Clause", c.displayLabel ?? describeHow(c.how, money), name(c.payeeId), money(c.entitlementCents), clauseDetails(c, money));
    }
    for (const s of sheet.costsCredited) {
      row(
        "Off the top",
        s.label,
        name(s.creditedPayeeId),
        money(s.amountCents),
        `Recouped ${money(s.recoupedCents)}; Not recovered ${money(s.notRecoveredCents)}${s.estimated ? "; Estimated" : ""}`,
      );
    }
    for (const o of sheet.offPlatform) {
      row(
        "Off-platform money",
        o.label,
        `Held by ${name(o.heldByPayeeId)}`,
        o.entered && o.amountCents !== undefined ? money(o.amountCents) : NOT_ENTERED,
        o.entered ? "" : "Excluded from every total",
      );
    }
    for (const p of sheet.positions) {
      positionRows(p, name(p.payeeId), money, row);
    }
    for (const s of sheet.shortfallDue) {
      row("Shortfall", `${name(s.owedByPayeeId)} owes ${name(s.payeeId)}`, name(s.payeeId), money(s.cents));
    }
  }

  const header = ["Section", "Item", "Party", "Amount", "Details"].map((h) => csvCell(h)).join(",");
  const body = rows.map((r) =>
    [csvCell(r.section), csvCell(r.item), csvCell(r.party), csvCell(r.amount, "money"), csvCell(r.details)].join(","),
  );
  return [header, ...body].join("\r\n") + "\r\n";
}

function positionRows(
  p: {
    entitlementCents: number;
    paidThroughPlatformCents: number | null;
    settleDirectlyCents: number | null;
    projectedPaidPerOrderCents: number | null;
    projectedSettleDirectlyCents: number | null;
    heldOffPlatformCents: number;
    notRecoveredCents: number;
  },
  party: string,
  money: (cents: number) => string,
  row: (section: string, item: string, party: string, amount: string, details?: string) => void,
) {
  row("Position", "Entitled", party, money(p.entitlementCents));
  const paid = p.paidThroughPlatformCents ?? p.projectedPaidPerOrderCents;
  if (paid !== null) row("Position", "Paid through Ithas Fire", party, money(paid));
  if (p.heldOffPlatformCents > 0) row("Position", "Holds off-platform money", party, money(p.heldOffPlatformCents));
  if (p.notRecoveredCents > 0) row("Position", "Costs not recovered", party, money(p.notRecoveredCents));
  const balance = p.settleDirectlyCents ?? p.projectedSettleDirectlyCents;
  if (balance !== null) {
    row(
      "Position",
      "Settle directly",
      party,
      money(balance),
      balance > 0 ? "Owed to them" : balance < 0 ? "They owe" : `Settles at ${money(0)}`,
    );
  }
}

function describeHow(how: DealClauseResolutionDetail, money: (cents: number) => string): string {
  const of = (basis: "GROSS" | "NET_POOL") => (basis === "GROSS" ? "ticket money" : "the pool");
  switch (how.kind) {
    case "FIXED":
      return `${money(how.fixedCents)} guarantee`;
    case "PERCENT":
      return `${how.percent}% of ${of(how.percentOf.basis)}`;
    case "SUM":
      return `${money(how.fixedCents)} plus ${how.percent}% of ${of(how.percentOf.basis)}`;
    case "GREATER_OF":
      return `${money(how.fixedCents)} vs ${how.percent}% of ${of(how.percentOf.basis)}, whichever is greater`;
  }
}

function clauseDetails(
  c: { how: DealClauseResolutionDetail; stage1: string; uncoveredCents: number; cappedFromCents?: number | null },
  money: (cents: number) => string,
): string {
  const parts: string[] = [];
  if (c.how.kind !== "FIXED") {
    parts.push(`${c.how.percent}% of ${money(c.how.percentOf.basisCents)} = ${money(c.how.percentCents)}`);
  }
  if (c.how.kind === "GREATER_OF") {
    parts.push(c.how.picked === "PERCENT" ? "percentage is greater" : "guarantee is greater");
  }
  if (c.cappedFromCents !== null && c.cappedFromCents !== undefined) {
    parts.push(`capped from ${money(c.cappedFromCents)}: the remainder takes what is left`);
  }
  if (c.uncoveredCents > 0) parts.push(`${money(c.uncoveredCents)} not covered by the pool`);
  parts.push(c.stage1 === "PAID_PER_ORDER" ? "Paid through Ithas Fire per order" : "Settled directly");
  return parts.join("; ");
}
