import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PayeeLedgerEntryRecord } from "@th/types/repos/payee-ledger";

import { parseInput } from "../../lib/io";
import { resolveDisputeReleaseRelations } from "./_shared/dispute-release-relations";
import { ledgerEntryBalanceDeltaCents } from "./_shared/ledger-entry-delta";
import { normaliseLedgerCurrency } from "./_shared/maturity-netting";
import { payeeStatementEntrySchema } from "./get-payee-statement";

// ─────────────────────────────────────────────────────────────────────────────
// exportPayeeLedger — EVERY ledger entry of one payee, oldest first, for the
// "Download CSV" button on the Payouts page (spec
// docs/specs/2026-10-14/payouts-ledger-export.spec.yaml). The server returns
// rows; the web app builds the file, because its headers are translated.
//
// NO CAP, NO TRUNCATION (R1). The statement stops paging at 1,000 rows; this
// is how the rest leaves. docs/pro-social.md lists "a person's data ...
// history ... made harder to export" as enshittification, so a row limit
// here would be the thing the feature exists to undo.
//
// ALL OR NOTHING. Unlike the statement, nothing here degrades: a failed page,
// dispute-debit or event read fails the whole export and the UI offers a
// retry. A file with a missing page, or a balance column that is right until
// the row where a lookup failed, is a wrong money record that looks right.
// The ONE swallow is the audit write (below), which describes the export and
// is not part of it.
//
// SNAPSHOT, AND WHAT IT PROMISES. The newest entry's (createdAt, id) is read
// first; the walk then pages oldest first under that bound, keyset-style
// (each page starts strictly after the previous page's last row, no OFFSET).
// The file holds every row committed when the cursor was read, plus any
// late commit that happens to sort AHEAD of the walk position when its page
// is read. It is not a point-in-time snapshot: `createdAt` is stamped at
// insert, not at commit, so a transaction that commits mid-walk can land a
// row BEHIND the position, and that row is left out. It is never read twice
// — under OFFSET it would have shifted the next page and been counted twice
// in the running balance. Rows stamped after the cursor are always out.
// (Ledger rows are append-only, so nothing is removed from under the walk.)
// No REPEATABLE READ transaction, on purpose: holding one open across a
// whole-ledger walk is a cost the export does not need for this guarantee.
//
// BALANCE AFTER walks FORWARD from 0, one accumulator per currency (C1). The
// ledger opened at zero, and the nightly drift sweep (`listRollupDrift`)
// defines the balance as the signed sum of entries, so each currency's last
// row equals that currency's balance on a drift-free ledger without reading
// the rollup at all. Change per row is `ledgerEntryBalanceDeltaCents`, the
// statement's own arithmetic, with DISPUTE_RELEASE signs resolved by the
// same shared lookup the statement uses.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows per `listEntries` call (spec NFR-001). */
export const PAYEE_LEDGER_EXPORT_PAGE_SIZE = 500;

/** Order ids per `getEventAttributionByIds` call (spec FR-006). */
export const PAYEE_LEDGER_EXPORT_ATTRIBUTION_CHUNK = 500;

export type ExportPayeeLedgerDeps = {
  repos: Pick<Repos, "payeeLedger" | "payees" | "orders" | "audit">;
  authz: Pick<AuthZPort, "canFinanceOrg">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports the one swallow: a failed audit write. Guarded — a throwing or
   * missing reporter never changes the result.
   */
  reportError?: ReporterPort;
};

export const exportPayeeLedgerInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /**
     * Provide for an ORG-owned payee (gated by `canFinanceOrg`). OMIT for
     * the actor's OWN human-owned payee. Same two options as the statement,
     * and the same absence of a third: no input names another human.
     */
    orgId: z.string().uuid().optional(),
  })
  .strict();

export type ExportPayeeLedgerInput = z.infer<typeof exportPayeeLedgerInputSchema>;

export const payeeLedgerExportRowSchema = z
  .object({
    id: z.string(),
    /** The entry type, verbatim — the statement's enum, not a copy of it. */
    type: payeeStatementEntrySchema.shape.type,
    /** The stored text, verbatim (C2). */
    description: z.string(),
    orderId: z.string().nullable(),
    /**
     * The order's event title. Null when the entry has no order, or the
     * order has no event (a membership invoice, a deleted event).
     */
    eventName: z.string().nullable(),
    createdAt: z.date(),
    /** When a credit starts counting toward the payable; null otherwise. */
    availableAt: z.date().nullable(),
    /** Normalised: trimmed, lower case. */
    currency: z.string(),
    /** POSITIVE integer cents, as stored. Direction lives in `type`. */
    amountCents: z.number().int(),
    /** SIGNED effect on the ledger balance; 0 for holds and reserves. */
    changeCents: z.number().int(),
    /** Running balance of THIS row's currency only, after this row. */
    balanceAfterCents: z.number().int(),
  })
  .strict();

export type PayeeLedgerExportRow = z.infer<typeof payeeLedgerExportRowSchema>;

export const exportPayeeLedgerOutputSchema = z
  .object({
    /** Null when the subject has no Payee row; `rows` is then empty. */
    payeeId: z.string().nullable(),
    /** When the export started. */
    asOf: z.date(),
    /** Every entry up to the snapshot, oldest first by (createdAt, id). */
    rows: z.array(payeeLedgerExportRowSchema),
  })
  .strict();

export type ExportPayeeLedgerOutput = z.infer<typeof exportPayeeLedgerOutputSchema>;

export async function exportPayeeLedger(
  deps: ExportPayeeLedgerDeps,
  rawInput: unknown,
): Promise<ExportPayeeLedgerOutput> {
  const logger = deps.logger?.child({ useCase: "exportPayeeLedger" });
  const input = parseInput(exportPayeeLedgerInputSchema, rawInput);

  // RBAC first, before any ledger read — the statement's gate, unchanged.
  if (input.orgId) {
    const permission = await deps.authz.canFinanceOrg({
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
    });
    if (!permission.allowed) {
      throw fail("FORBIDDEN");
    }
  }

  const asOf = deps.clock.now();
  const subject = input.orgId
    ? ({ type: "ORGANIZATION", id: input.orgId } as const)
    : ({ type: "HUMAN", id: input.actorHumanId } as const);

  const payeeRef = await deps.repos.payees.getBySubject(subject);
  // No Payee row: never sold anything, so the file is the header row alone.
  // No audit row either — the audit is keyed on the payee, and there is no
  // payee to key it on, nor any money record that left.
  if (!payeeRef) {
    return { payeeId: null, asOf, rows: [] };
  }
  const payeeId = payeeRef.id;
  const ledger = deps.repos.payeeLedger;

  // ── Snapshot cursor, then the paged walk ─────────────────────────────────
  const [newest] = await ledger.listEntries(payeeId, { limit: 1, offset: 0 });
  const entries: PayeeLedgerEntryRecord[] = [];
  if (newest) {
    const atOrBefore = { createdAt: newest.createdAt, id: newest.id };
    let after: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await ledger.listEntries(payeeId, {
        atOrBefore,
        ...(after ? { after } : {}),
        order: "asc",
        limit: PAYEE_LEDGER_EXPORT_PAGE_SIZE,
      });
      entries.push(...page);
      const last = page.at(-1);
      if (!last || page.length < PAYEE_LEDGER_EXPORT_PAGE_SIZE) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  // ── Change and balance after, per currency ───────────────────────────────
  const relatedTypeById = await resolveDisputeReleaseRelations(ledger, entries);

  // ── Event names, batched ─────────────────────────────────────────────────
  const orderIds = [
    ...new Set(
      entries.map((e) => e.orderId).filter((id): id is string => id !== null),
    ),
  ];
  const eventNameByOrderId = new Map<string, string | null>();
  for (let i = 0; i < orderIds.length; i += PAYEE_LEDGER_EXPORT_ATTRIBUTION_CHUNK) {
    const chunk = orderIds.slice(i, i + PAYEE_LEDGER_EXPORT_ATTRIBUTION_CHUNK);
    const attribution = await deps.repos.orders.getEventAttributionByIds(chunk);
    for (const [orderId, a] of attribution) {
      eventNameByOrderId.set(orderId, a.eventTitle);
    }
  }

  const balanceByCurrency = new Map<string, number>();
  const rows: PayeeLedgerExportRow[] = entries.map((entry) => {
    const currency = normaliseLedgerCurrency(entry.currency);
    const changeCents = ledgerEntryBalanceDeltaCents({
      type: entry.type,
      amountCents: entry.amountCents,
      idempotencyKey: entry.idempotencyKey,
      relatedEntryType: entry.relatedEntryId
        ? (relatedTypeById.get(entry.relatedEntryId) ?? null)
        : null,
    });
    const balanceAfterCents = (balanceByCurrency.get(currency) ?? 0) + changeCents;
    balanceByCurrency.set(currency, balanceAfterCents);
    return {
      id: entry.id,
      type: entry.type,
      description: entry.description,
      orderId: entry.orderId,
      eventName: entry.orderId
        ? (eventNameByOrderId.get(entry.orderId) ?? null)
        : null,
      createdAt: entry.createdAt,
      availableAt: entry.availableAt,
      currency,
      amountCents: entry.amountCents,
      changeCents,
      balanceAfterCents,
    };
  });

  // ── Audit: AFTER the rows exist, and never blocking ──────────────────────
  // Written last so a failed read never records an export that did not
  // happen. A failed write is reported, not thrown: the person asked for
  // their own money record, and an audit outage must not withhold it.
  try {
    await deps.repos.audit.log({
      entity: "payee",
      entityId: payeeId,
      action: "payee_ledger_export",
      data: {
        orgId: input.orgId ?? null,
        actorHumanId: input.actorHumanId,
        rowCount: rows.length,
        currencies: [...balanceByCurrency.keys()].sort(),
      },
      at: deps.clock.now(),
    });
  } catch (err) {
    logger?.error("exportPayeeLedger.auditLogFailed", { err });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "exportPayeeLedger", step: "auditLog" },
        extra: { payeeId },
      });
    } catch {
      // Reporting is fire-and-forget.
    }
  }

  return { payeeId, asOf, rows };
}
