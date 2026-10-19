import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PayeeLedgerReadBudget } from "@th/ports/repos/payee-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// MATURITY NETTING — the debt walk, shared by the staff and organiser payout
// forecasts.
//
// Extracted from `platform/list-upcoming-payouts.ts` (the original home, and
// still the file to read for the FULL argument) so the org-facing view is one
// payee's slice of the SAME arithmetic rather than a second implementation of
// it. The extraction is behaviour-preserving: that file's test suite passes
// unchanged over it.
//
// THE RULE, restated because it is the thing that must not rot: the ONLY
// netting a maturity forecast may apply is TODAY'S PAYABLE. Every non-credit
// entry — REFUND_DEBIT, PAYOUT, and a DISPUTE_HOLD too — is effective the
// moment it is written: debits and payouts reduce the payable directly, and a
// hold bumps the pending-hold rollup the payable subtracts unconditionally
// every night. So all of them are ALREADY inside today's payable, and the one
// honest way to carry any of them into a future tranche is through that
// number: a payee whose payable is −10,000 today with +50,000 maturing
// receives 40,000, because the batch pays max(0, payable). Netting a debit or
// a hold against a tranche AS WELL counts it twice. The trace that made this
// a rule: credit 7,000 maturing 4 Oct under a 3,000 hold → payable today
// −3,000 → the batch pays 4,000; the walk says 7,000 − 3,000 = 4,000;
// "credit − hold − debt" said 1,000.
//
// `heldCents` therefore never appears in this file. It is an ANNOTATION on the
// tranche, never an operand, and a caller that subtracts it has reintroduced
// the bug above.
//
// The walk is per (payee, NORMALISED currency), soonest tranche first,
// carrying any remainder forward — a debt larger than the first tranche eats
// into the second. Currencies never net against each other. Integer cents
// throughout.
//
// UNKNOWN IS NEVER ZERO. The payable read is BEST-EFFORT: a failure is
// swallowed, logged at ERROR and reported (guarded — ReporterPort convention,
// CLAUDE.md), and every debt-dependent figure comes back NULL so the caller
// renders "could not check debt" rather than a gross figure standing in for a
// net.
// ─────────────────────────────────────────────────────────────────────────────

/** Map key for a (payee, currency) cell. */
export const payeeCurrencyCellKey = (payeeId: string, currency: string) =>
  `${payeeId}|${currency}`;

/**
 * Both ledger reads already normalise (`btrim(lower(...))` in the payable and
 * the maturity queries), so in practice the keys match as-is. The fold is kept
 * as DEFENCE: if a raw-cased row ever reaches this layer — a fake in a test, a
 * future adapter that forgets — a `USD` payable row still finds its `usd`
 * tranches instead of silently applying no debt.
 */
export const normaliseLedgerCurrency = (currency: string) =>
  currency.trim().toLowerCase();

export type MaturityNettingDeps = {
  repos: Pick<Repos, "payeeLedger">;
  logger?: LoggerPort;
  /**
   * Reports the best-effort payable (debt) read failure. Guarded at the call
   * site — a throwing or missing reporter never changes the result.
   */
  reportError?: ReporterPort;
};

/**
 * Caller-supplied naming for the swallow's telemetry, so each view's log line
 * and Sentry tags stay its own. Mirrors `PayeeIdentityTelemetry`.
 */
export type DebtNettingTelemetry = {
  /** `logger.error` event name. */
  logEvent: string;
  /** Sentry `tags.useCase`. */
  useCase: string;
  /** Sentry `tags.step`. */
  step: string;
};

export type DebtPositions =
  | {
      resolved: true;
      /**
       * (payee, normalised currency) → POSITIVE cents of carried-forward debt
       * still to consume. Cells NOT in debt are absent, never zero-valued.
       */
      debtByCell: Map<string, number>;
    }
  | { resolved: false };

export type ReadDebtPositionsInput = {
  asOf: Date;
  /**
   * The payees in the feed. Deduped here, so a caller may pass one id per
   * tranche row. EMPTY short-circuits: no read is issued and the result is
   * resolved-and-empty (no payees means no debt, which is a fact, not a
   * degradation).
   */
  payeeIds: string[];
  /**
   * Statement budget. REQUIRED rather than optional so no caller can issue an
   * unbudgeted whole-ledger aggregate behind an interactive page by omission.
   *
   * NOTE the port contract: a budgeted read MUST be issued on the TOP-LEVEL
   * repos, never inside `repos.tx(...)` — the adapter opens its own
   * transaction to scope `SET LOCAL statement_timeout` to the read and refuses
   * a TransactionClient.
   */
  budget: PayeeLedgerReadBudget;
  telemetry: DebtNettingTelemetry;
};

/**
 * Reads each feed payee's payable and returns the (payee, normalised
 * currency) cells in DEBT — negative signed total — as positive "cents to
 * consume". The SIGNED sum is folded per normalised key FIRST and only then
 * tested for sign: two raw casings of one currency (+5,000 'USD', −3,000
 * 'usd') are one +2,000 cell with no debt, not a 3,000 debt. Best-effort: a
 * failure is swallowed, logged and reported, and the caller renders unknown
 * rather than gross-as-net.
 *
 * Never throws.
 */
export async function readDebtPositions(
  deps: MaturityNettingDeps,
  input: ReadDebtPositionsInput,
): Promise<DebtPositions> {
  const payeeIds = [...new Set(input.payeeIds)];
  if (payeeIds.length === 0) {
    return { resolved: true, debtByCell: new Map() };
  }
  try {
    // Explicit array → narrowed to exactly these payees (an index scan, not
    // the batch's full-ledger aggregate).
    const balances = await deps.repos.payeeLedger.listPayableBalances(
      input.asOf,
      payeeIds,
      input.budget,
    );
    const signedByCell = new Map<string, number>();
    for (const cell of balances) {
      const key = payeeCurrencyCellKey(
        cell.payeeId,
        normaliseLedgerCurrency(cell.currency),
      );
      signedByCell.set(key, (signedByCell.get(key) ?? 0) + cell.payableCents);
    }
    const debtByCell = new Map<string, number>();
    for (const [key, signed] of signedByCell) {
      if (signed < 0) debtByCell.set(key, -signed);
    }
    return { resolved: true, debtByCell };
  } catch (err) {
    deps.logger?.error(input.telemetry.logEvent, {
      err,
      payeeCount: payeeIds.length,
    });
    try {
      deps.reportError?.(err, {
        tags: {
          useCase: input.telemetry.useCase,
          step: input.telemetry.step,
        },
        extra: { payeeCount: payeeIds.length },
      });
    } catch {
      // A broken reporter must never turn a degraded panel into a failed one.
    }
    return { resolved: false };
  }
}

/**
 * The tranche shape the walk needs — a structural subset of
 * `PayeeLedgerUpcomingMaturity`, so a real tranche row is always assignable.
 * `heldCents` is deliberately absent: it is not an operand here.
 */
export interface NettableMaturityRow {
  payeeId: string;
  currency: string;
  maturesAt: Date;
  creditCents: number;
}

export type NettedMaturityRow<TRow extends NettableMaturityRow> = TRow & {
  /**
   * The part of this payee's carried-forward debt (negative payable today)
   * that this tranche is consumed by, soonest tranche first. Null iff the
   * payable read failed.
   */
  debtAppliedCents: number | null;
  /**
   * `max(0, creditCents − debtAppliedCents)`: what the batch would transfer
   * for this tranche before the gates it evaluates on the night (minimum,
   * cap, eligibility, withholding). Null iff the payable read failed — never
   * a gross figure standing in for a net.
   */
  expectedCents: number | null;
};

/**
 * THE ONLY NETTING. Consumes each (payee, currency) cell's debt across its
 * tranches, soonest maturity first, and returns the rows IN THE ORDER GIVEN
 * with `debtAppliedCents` / `expectedCents` attached.
 *
 * Capacity is the tranche's GROSS credit; `heldCents` is never an operand
 * (the hold is already inside the payable this debt came from).
 *
 * Input order is preserved because callers aggregate and page over it; the
 * WALK order is recomputed here (`maturesAt` ASC, stable) so the debt lands on
 * the tranche that actually goes out first regardless of how the feed arrived.
 */
export function applyDebtNetting<TRow extends NettableMaturityRow>(
  rows: TRow[],
  debt: DebtPositions,
): NettedMaturityRow<TRow>[] {
  // Stable sort: the adapter's payeeId/currency tie-break is preserved within
  // a date.
  const walkOrder = [...rows].sort(
    (a, b) => a.maturesAt.getTime() - b.maturesAt.getTime(),
  );
  const debtAppliedByRow = new Map<TRow, number | null>();
  if (debt.resolved) {
    const remaining = new Map(debt.debtByCell);
    for (const row of walkOrder) {
      const key = payeeCurrencyCellKey(
        row.payeeId,
        normaliseLedgerCurrency(row.currency),
      );
      const owed = remaining.get(key) ?? 0;
      // Integer cents throughout.
      const applied = Math.min(owed, Math.max(0, row.creditCents));
      if (applied > 0) remaining.set(key, owed - applied);
      debtAppliedByRow.set(row, applied);
    }
  } else {
    for (const row of walkOrder) debtAppliedByRow.set(row, null);
  }

  return rows.map((row) => {
    const debtAppliedCents = debtAppliedByRow.get(row) ?? null;
    const expectedCents =
      debtAppliedCents === null
        ? null
        : Math.max(0, row.creditCents - debtAppliedCents);
    return { ...row, debtAppliedCents, expectedCents };
  });
}

/** Adds two nullable cents figures; null is contagious (unknown + n = unknown). */
export const addNullableCents = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;
