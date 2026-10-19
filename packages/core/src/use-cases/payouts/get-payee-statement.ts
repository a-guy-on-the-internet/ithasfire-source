import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import { offsetPaginationInputSchema } from "@th/ports/pagination";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PayeeLedgerEntryRecord } from "@th/types/repos/payee-ledger";

import { parseInput } from "../../lib/io";
import { resolveDisputeReleaseRelations } from "./_shared/dispute-release-relations";
import { ledgerEntryBalanceDeltaCents } from "./_shared/ledger-entry-delta";
import {
  nextPayoutRunFor,
  nextPayoutRunSchema,
} from "./_shared/next-payout-batch-run";
// The batch's OWN default, imported rather than retyped: a second literal
// here could drift and make the organiser's statement disagree with the job
// about whether tonight's run skips them.
import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../settlements/run-batch";

// ─────────────────────────────────────────────────────────────────────────────
// getPayeeStatement — the ORGANISER-facing "what am I owed, and when does it
// arrive" read model. The org-scoped, RBAC-gated sibling of
// `platform/list-payable-positions.ts` (staff) — one payee's slice of the
// SAME ledger reads, never a second implementation of them.
//
// WHY IT EXISTS. `/admin/<slug>/orders` → Settlements read the `Settlement`
// table, which the 2026-08-10 ledger cutover left with ZERO writers: credits
// go to `PayeeLedgerEntry` now (`settlements/create-credits-from-order.ts`).
// The tab therefore renders empty for every organiser and always will. This
// use case reads the ledger the money actually lives in.
//
// TWO NUMBERS, NEVER ONE. This is the single thing the file exists to
// protect, and conflating them ships the very bug it is fixing:
//
//   * BALANCE (`balanceCents`) — `payeeLedger.getBalance`'s
//     `ledgerBalanceCents`. EVERYTHING owed, matured or not. This is the
//     headline the organiser sees.
//   * PAYABLE (`payableCents`) — `payeeLedger.listPayableBalances(asOf)`.
//     The MATURED, unblocked cell: what tonight's batch would plan from.
//
// A credit for an event three weeks out is present in the first and absent
// from the second, and it is the organiser's money either way. The observed
// production case, 16 Sep 2026: balance 1064, payable 0, because both
// credits carry `availableAt = 20 Sep`. On 20 Sep the payable becomes 1064.
// The two ride SEPARATE fields, are never summed, and neither is derived
// from the other. The staff copy (`pstOwedPayableNow` / `pstOwedTotalOwed`)
// already draws this distinction; the organiser copy must use the same
// vocabulary.
//
// PAYABLE IS THE BATCH'S INPUT, NOT ITS OUTPUT. Between it and money leaving
// the platform `runPayoutBatch` still applies the payout MINIMUM (§2), the
// per-run PAYEE CAP, the ELIGIBILITY checks (§3) and transfer-time
// WITHHOLDING. Only the minimum is evaluable here without guessing, so only
// that one is reported (`belowMinimum`); the copy must not promise payment.
//
// UNKNOWN IS NEVER ZERO, AND NEVER "NOTHING". Two reads degrade rather than
// blanking a money page that already knows the balance:
//
//   * the FEE POLICY — a failed READ yields `payoutMinimumCents: null` +
//     `minimumResolved: false`, NOT the batch default. "No policy row" has a
//     defined answer (the default, which is what the batch itself falls back
//     to); "the read failed" has none, and measuring a payee against a
//     threshold nobody read is a false accusation dressed as a fact. Same
//     treatment, same reasoning, as `list-payable-positions.ts`.
//   * the MATURITY FORECAST — `nextArrivalAt: null` means "nothing
//     upcoming", a real and common state. A failed read must NOT be able to
//     say that, so it is reported as `arrivalResolved: false` with every
//     arrival figure null.
//
//   * the RUNNING BALANCE — every journal row carries `balanceAfterCents`,
//     the ledger balance immediately after that entry landed, so the page
//     reads like a bank statement. It is derived by walking the page from
//     the headline `balanceCents` backwards through each row's signed
//     effect (`_shared/ledger-entry-delta.ts`, a mirror of the adapter's
//     rollup arithmetic). Past the first page that walk must first cross the
//     `offset` NEWER rows, which is one extra read; if that read (or the
//     dispute-debit lookup a DISPUTE_RELEASE row needs) fails, EVERY row's
//     `balanceAfterCents` is null and `balanceAfterResolved: false` — a
//     running balance that is wrong from some row onward is worse than none.
//     Read shape: ONE newer-rows read plus O(distinct disputes among the
//     DISPUTE_RELEASE rows) `listDebitsForDispute` round-trips, chunked
//     `DISPUTE_DEBIT_LOOKUP_CONCURRENCY` at a time. Releases are rare, so
//     this is usually zero; the follow-up that makes it one query is a
//     port-level `listDebitsForDisputes(ids)`.
//
// All three swallows log at ERROR *and* call the guarded `deps.reportError?.()`
// (CLAUDE.md ReporterPort convention — `logger.warn` is not captured by
// Sentry). A throwing reporter can never change the result.
//
// The three reads the statement cannot be written without — the rollup
// balance, the payable cell and the journal page — are NOT best-effort. If
// any of them fails there is no honest statement to render, so the use case
// throws and the UI shows a retry.
//
// ONE CURRENCY PER STATEMENT: the payee's `defaultCurrency`. Every figure,
// the arrival tranche and the journal page are filtered to it, so nothing on
// the page can mix two currencies into one number.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget for the payable and maturity reads behind this view. Past this the
 * adapter surfaces SERVICE_UNAVAILABLE rather than hanging an interactive
 * admin page. Same 8s as the staff siblings
 * (`PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS`), for the same reasons.
 *
 * NOTE the port contract: a budgeted read MUST be issued on the TOP-LEVEL
 * repos, never inside `repos.tx(...)` — the adapter opens its own
 * transaction to scope `SET LOCAL statement_timeout` to the read and refuses
 * a TransactionClient. This use case takes no transaction at all (it writes
 * nothing), so that holds structurally.
 */
export const PAYEE_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * Deepest journal offset the statement will page to. The running balance on
 * a page past the first is seeded by reading and summing every NEWER row
 * (`limit: offset, offset: 0`) — O(offset) rows per request — so an
 * unbounded offset would let one call pull the whole journal. 1000 rows is
 * 40 pages at the 25-row default; a CSV export past that walks the raw
 * `listEntries` port instead of this view. Enforced in the INPUT schema so
 * the transport refuses it as BAD_REQUEST rather than clamping silently.
 */
export const PAYEE_STATEMENT_MAX_OFFSET = 1_000;

/**
 * Currency a statement is reported in when there is no Payee row to ask.
 * Only ever reached on the zeroed "never sold anything" statement, where
 * every figure is 0 and the label is cosmetic.
 */
const FALLBACK_STATEMENT_CURRENCY = "usd";

/** Mirrors the adapter's `normalizeCurrency`, so cells always match. */
const normaliseCurrency = (currency: string) => currency.trim().toLowerCase();

export type GetPayeeStatementDeps = {
  repos: Pick<Repos, "payeeLedger" | "payees" | "feePolicies">;
  authz: Pick<AuthZPort, "canFinanceOrg">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports the three best-effort swallows: the fee-policy read, the
   * maturity forecast and the running-balance seed. Guarded at every call
   * site — a throwing or missing reporter never changes the result.
   */
  reportError?: ReporterPort;
};

export const getPayeeStatementInputSchema = offsetPaginationInputSchema
  .extend({
    /** See `PAYEE_STATEMENT_MAX_OFFSET` for why this is bounded. */
    offset: z.number().int().min(0).max(PAYEE_STATEMENT_MAX_OFFSET).optional(),
    actorHumanId: z.string().uuid(),
    /**
     * Provide for an ORG-owned payee (the `/admin/<slug>` case, gated by
     * `canFinanceOrg`). OMIT for the actor's OWN human-owned payee — there
     * is no third option, and no way to ask for another human's statement.
     */
    orgId: z.string().uuid().optional(),
  })
  .strict();

export type GetPayeeStatementInput = z.infer<typeof getPayeeStatementInputSchema>;

export const payeeStatementEntrySchema = z
  .object({
    id: z.string(),
    /**
     * The ledger entry type, verbatim. Every consumer must BRANCH on it and
     * never sum blindly: `amountCents` is stored POSITIVE on every type and
     * the type carries the direction (SETTLEMENT_CREDIT / DISPUTE_RELEASE /
     * TRANSFER_REVERSAL_CREDIT / CASH_SALE_DEBIT_REVERSAL add; REFUND_DEBIT /
     * DISPUTE_DEBIT / CASH_SALE_DEBIT / PAYOUT subtract; DISPUTE_HOLD and the RESERVE_* pair move their own rollup
     * buckets and never the balance).
     */
    type: z.enum([
      "SETTLEMENT_CREDIT",
      "REFUND_DEBIT",
      "DISPUTE_HOLD",
      "DISPUTE_DEBIT",
      "DISPUTE_RELEASE",
      "PAYOUT",
      "RESERVE_HOLD",
      "RESERVE_RELEASE",
      "MANUAL_ADJUSTMENT",
      "TRANSFER_REVERSAL_CREDIT",
      "CASH_SALE_DEBIT",
      "CASH_SALE_DEBIT_REVERSAL",
    ]),
    /** POSITIVE integer cents. Direction lives in `type`; see above. */
    amountCents: z.number().int(),
    currency: z.string(),
    description: z.string(),
    createdAt: z.date(),
    /**
     * When the entry starts counting toward the PAYABLE. Null = immediately,
     * which is every type except SETTLEMENT_CREDIT ("credits wait, debits
     * never do"). A credit whose `availableAt` is in the future is inside
     * `balanceCents` and outside `payableCents` — the row-level form of the
     * distinction this whole statement is built around.
     */
    availableAt: z.date().nullable(),
    /** The order the entry came from, when it has one. */
    orderId: z.string().nullable(),
    /**
     * The ledger BALANCE (`balanceCents`' sense — everything owed, matured
     * or not) immediately AFTER this entry was applied. Rows are newest
     * first, so the first row of the first page equals the headline
     * `balanceCents`, and each older row is the one above it minus that
     * row's signed effect. Holds and reserve rows repeat the value above
     * them (they move their own buckets, never the balance).
     *
     * NULL means UNKNOWN, never zero: the seed read for this page failed
     * (`balanceAfterResolved: false`), and then EVERY row on the page is
     * null — a running balance that goes wrong from one row onward is worse
     * than none.
     */
    balanceAfterCents: z.number().int().nullable(),
  })
  .strict();

export type PayeeStatementEntry = z.infer<typeof payeeStatementEntrySchema>;

export const getPayeeStatementOutputSchema = z
  .object({
    /**
     * Null when the subject has NO Payee row — a legitimate state (they have
     * never sold anything), reported as a zeroed statement rather than an
     * error. Every figure below reads 0 and `entries` is empty.
     */
    payeeId: z.string().nullable(),
    /** The payee's `defaultCurrency`. EVERY figure below is in it. */
    currency: z.string(),
    /**
     * THE HEADLINE. `PayeeLedgerBalance.ledgerBalanceCents` — everything
     * owed, matured or not. NEVER derived from `payableCents`; see the file
     * header.
     */
    balanceCents: z.number().int(),
    /**
     * The MATURED, unblocked cell the payout batch plans from
     * (`listPayableBalances`). NOT a promise of payment, and NOT the
     * balance.
     *
     * SIGNED, as the ledger returns it. A NEGATIVE value is a debt position:
     * the batch sends nothing and the debt is recouped from the next credits
     * to mature. Clamping it to 0 here would hide a carried-forward debt
     * from the one person who needs to know about it, so the clamp stays
     * with the batch and the UI must label a negative for what it is.
     */
    payableCents: z.number().int(),
    /** Cents held against open disputes. Owed to someone; not yet to anyone. */
    pendingHoldCents: z.number().int(),
    /**
     * Outstanding rolling reserve — DEFERRED payout withheld from past
     * transfers. Never part of `balanceCents` (those cents never entered it),
     * so it is reported alongside and never subtracted.
     */
    reserveCents: z.number().int(),
    /**
     * The NEXT date immature credit becomes payable — the earliest tranche
     * from `listUpcomingMaturities` in this currency.
     *
     * NULL means NOTHING IS UPCOMING, and only that. A failed forecast read
     * is reported as `arrivalResolved: false` (with this null too), so the
     * UI can tell "nothing coming" from "could not check" instead of
     * printing the former when it means the latter.
     */
    nextArrivalAt: z.date().nullable(),
    /**
     * GROSS unblocked SETTLEMENT_CREDIT cents maturing on `nextArrivalAt`.
     * Null exactly when `nextArrivalAt` is null. Forecasts MATURITY, not
     * PAYMENT: the batch's minimum, cap, eligibility checks and withholding
     * all apply on the night, and a refund landing first shrinks it.
     */
    nextArrivalCents: z.number().int().nullable(),
    /**
     * False when the maturity read FAILED. Every arrival figure is then
     * null and the UI must say "could not check" rather than "nothing
     * upcoming".
     */
    arrivalResolved: z.boolean(),
    /**
     * The GLOBAL fee policy's `payoutMinimumCents`, or the batch's own
     * default when NO policy row exists. NULL when the policy READ FAILED —
     * a different thing entirely from "no policy exists", which has a
     * defined answer.
     */
    payoutMinimumCents: z.number().int().nonnegative().nullable(),
    /** False when the fee-policy read failed; then `payoutMinimumCents` and
     * `belowMinimum` are both null. */
    minimumResolved: z.boolean(),
    /**
     * The payable is below the batch's minimum, so tonight's run skips this
     * payee and carries the money forward (`run-batch.ts` §2). NULL =
     * UNKNOWN (the policy read failed), never "no".
     */
    belowMinimum: z.boolean().nullable(),
    /** This page of the journal, `createdAt` DESC then `id` DESC. */
    entries: z.array(payeeStatementEntrySchema),
    /**
     * Offset paging WITHOUT a total, on purpose. The ledger port exposes no
     * count over this filter set, and inventing one by summing a page would
     * be a fabricated number on a money view. `hasMore` is measured by
     * asking for one row more than `limit` and discarding it, so it is
     * exact; a CSV export walks `nextOffset` until it is null.
     *
     * `nextOffset` is ALSO null when the next page would start past
     * `PAYEE_STATEMENT_MAX_OFFSET`, even with `hasMore: true`: the cursor is
     * capped where the input is, so the UI is never handed a "Load more"
     * that the schema will refuse. `hasMore && nextOffset === null` reads
     * "more exists, but not through this view".
     */
    hasMore: z.boolean(),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .max(PAYEE_STATEMENT_MAX_OFFSET)
      .nullable(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    /**
     * False when the running balance could not be seeded for this page —
     * the read of the `offset` newer rows, or the dispute-debit lookup a
     * DISPUTE_RELEASE row needs, failed. Every `entries[].balanceAfterCents`
     * is then null and the UI must show "—", never 0. Always true on the
     * first page (`offset: 0`), where no seed read is needed.
     */
    balanceAfterResolved: z.boolean(),
    /** When the payout batch next runs, from `asOf`: the instant, and the
     * Central calendar date of the evening it closes ("tonight's run").
     * Null when the batch's recorded schedule is not daily-at-midnight. */
    nextPayoutRun: nextPayoutRunSchema.nullable(),
    /** The clock every figure above was evaluated at. */
    asOf: z.date(),
  })
  .strict();

export type GetPayeeStatementOutput = z.infer<
  typeof getPayeeStatementOutputSchema
>;

/**
 * Guarded report — a broken reporter must never turn a degraded panel into a
 * failed one. Mirrors the swallow discipline in `list-payable-positions.ts`.
 */
function report(
  deps: GetPayeeStatementDeps,
  err: unknown,
  step: string,
  extra?: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(err, {
      tags: { useCase: "getPayeeStatement", step },
      extra,
    });
  } catch {
    // Reporting is fire-and-forget.
  }
}

/** The zeroed statement for a subject with no Payee row. */
function emptyStatement(params: {
  asOf: Date;
  limit: number;
  offset: number;
  payoutMinimumCents: number | null;
  minimumResolved: boolean;
}): GetPayeeStatementOutput {
  return {
    payeeId: null,
    currency: FALLBACK_STATEMENT_CURRENCY,
    balanceCents: 0,
    payableCents: 0,
    pendingHoldCents: 0,
    reserveCents: 0,
    nextArrivalAt: null,
    nextArrivalCents: null,
    // Nothing to forecast rather than a forecast that failed: with no payee
    // there is no read to degrade, so this is resolved-and-empty.
    arrivalResolved: true,
    payoutMinimumCents: params.payoutMinimumCents,
    minimumResolved: params.minimumResolved,
    // No payable at all, so "is it below the minimum" has no meaning here.
    belowMinimum: null,
    entries: [],
    hasMore: false,
    nextOffset: null,
    limit: params.limit,
    offset: params.offset,
    // Nothing to seed — no rows, no read, nothing failed.
    balanceAfterResolved: true,
    nextPayoutRun: nextPayoutRunFor(params.asOf),
    asOf: params.asOf,
  };
}

// `DISPUTE_DEBIT_LOOKUP_CONCURRENCY` and `resolveDisputeReleaseRelations`
// live in `_shared/dispute-release-relations.ts`: the ledger CSV export
// resolves the same releases, and two copies of that lookup could disagree
// about a row's sign. Re-exported so existing importers keep their path.
export { DISPUTE_DEBIT_LOOKUP_CONCURRENCY } from "./_shared/dispute-release-relations";

export async function getPayeeStatement(
  deps: GetPayeeStatementDeps,
  rawInput: unknown,
): Promise<GetPayeeStatementOutput> {
  const logger = deps.logger?.child({ useCase: "getPayeeStatement" });
  const input = parseInput(getPayeeStatementInputSchema, rawInput);

  // ── RBAC FIRST, before a single ledger read ──────────────────────────────
  // The org path is gated by `canFinanceOrg`, exactly as the sibling money
  // reads (`orders.getOwnerPayoutSummary`, `settlements.listForOrg`) are.
  // The human path needs no probe because the subject IS the actor: the
  // input carries no human id, so there is no way to name someone else's
  // payee. (Prior art for getting this wrong: the claims desk shipped with
  // list/get/review all ungated.)
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
  const budget = { statementTimeoutMs: PAYEE_STATEMENT_TIMEOUT_MS };
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);

  // BEST-EFFORT, and issued before the payee lookup so even the zeroed
  // statement can name the threshold. A policy outage must not blank a page
  // whose whole job is to show what the organiser is owed.
  const policyResult = await deps.repos.feePolicies
    .resolveEffective({ scopeType: "GLOBAL", scopeId: null, at: asOf })
    .then(
      (policy) => ({ ok: true as const, policy }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  const minimumResolved = policyResult.ok;
  if (!policyResult.ok) {
    logger?.error("payee_statement_fee_policy_lookup_failed", {
      err: policyResult.err,
    });
    report(deps, policyResult.err, "resolveFeePolicy");
  }
  // No policy ROW is a defined answer (the batch falls back to its own
  // default, so this page must too). A failed READ is not.
  const payoutMinimumCents = policyResult.ok
    ? (policyResult.policy?.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS)
    : null;

  const subject = input.orgId
    ? ({ type: "ORGANIZATION", id: input.orgId } as const)
    : ({ type: "HUMAN", id: input.actorHumanId } as const);

  const payeeRef = await deps.repos.payees.getBySubject(subject);
  // NOT an error. A subject with no Payee row has simply never sold
  // anything — the overwhelmingly common state for a new org — and an
  // organiser opening their statement deserves an honest zero, not a 404.
  if (!payeeRef) {
    return emptyStatement({
      asOf,
      limit,
      offset,
      payoutMinimumCents,
      minimumResolved,
    });
  }

  const payee = await deps.repos.payees.getById(payeeRef.id);
  if (!payee) {
    // The row vanished between the two reads. Treated as "no payee" rather
    // than thrown: the statement is still true (nothing is owed that we can
    // see), and a race must not 500 an organiser's money page.
    logger?.error("payee_statement_payee_row_missing", {
      payeeId: payeeRef.id,
    });
    return emptyStatement({
      asOf,
      limit,
      offset,
      payoutMinimumCents,
      minimumResolved,
    });
  }

  const currency = normaliseCurrency(payee.defaultCurrency);

  // ── The three reads the statement cannot be written without ──────────────
  // Deliberately NOT best-effort: with any of them missing there is no
  // honest statement to render, so the whole read fails and the UI retries.
  // One row over `limit` is fetched purely to measure `hasMore` exactly.
  const [balance, payableCells, entryRows] = await Promise.all([
    deps.repos.payeeLedger.getBalance(payeeRef.id, currency),
    deps.repos.payeeLedger.listPayableBalances(asOf, [payeeRef.id], budget),
    deps.repos.payeeLedger.listEntries(payeeRef.id, {
      currency,
      limit: limit + 1,
      offset,
    }),
  ]);

  // Fold per normalised currency BEFORE picking the cell: two raw casings of
  // one currency must read as one cell, never as a missing one.
  const payableByCurrency = new Map<string, number>();
  for (const cell of payableCells) {
    const key = normaliseCurrency(cell.currency);
    payableByCurrency.set(key, (payableByCurrency.get(key) ?? 0) + cell.payableCents);
  }
  // An ABSENT cell is a true zero: the payable is an aggregate over entries,
  // so no cell means no matured, unblocked entries — not an unknown.
  const payableCents = payableByCurrency.get(currency) ?? 0;

  // ── The maturity forecast: BEST-EFFORT ───────────────────────────────────
  // `nextArrivalAt: null` is a real answer ("nothing upcoming"), so a failed
  // read must never be able to produce it. Degrades to
  // `arrivalResolved: false` with the figures null.
  let arrivalResolved = true;
  let nextArrivalAt: Date | null = null;
  let nextArrivalCents: number | null = null;
  try {
    const maturities = await deps.repos.payeeLedger.listUpcomingMaturities(
      asOf,
      [payeeRef.id],
      budget,
    );
    // Same currency as every other figure on the statement. A tranche in
    // another currency announced next to a balance in this one would put two
    // currencies' cents under one heading. The adapter orders `maturesAt`
    // ASC, but the earliest is picked EXPLICITLY so the contract changing
    // underneath cannot silently reorder the answer.
    let earliest: { maturesAt: Date; creditCents: number } | null = null;
    for (const tranche of maturities) {
      if (normaliseCurrency(tranche.currency) !== currency) continue;
      if (!earliest || tranche.maturesAt.getTime() < earliest.maturesAt.getTime()) {
        earliest = {
          maturesAt: tranche.maturesAt,
          creditCents: tranche.creditCents,
        };
      }
    }
    nextArrivalAt = earliest?.maturesAt ?? null;
    nextArrivalCents = earliest?.creditCents ?? null;
  } catch (err) {
    arrivalResolved = false;
    nextArrivalAt = null;
    nextArrivalCents = null;
    logger?.error("payee_statement_maturity_lookup_failed", {
      err,
      payeeId: payeeRef.id,
    });
    report(deps, err, "listUpcomingMaturities", { payeeId: payeeRef.id });
  }

  const hasMore = entryRows.length > limit;
  const pageRows = hasMore ? entryRows.slice(0, limit) : entryRows;

  // ── The running balance: BEST-EFFORT ──────────────────────────────────────
  // `balanceAfterCents` on row N is the ledger balance after row N landed.
  // The page is newest-first, so the walk starts at the headline balance and
  // subtracts each row's signed effect as it descends. On a page past the
  // first, the starting point is the headline MINUS the effect of every row
  // NEWER than the page — those are the `offset` rows before it under the
  // same filter, read once here. That read (and the dispute-debit lookup a
  // DISPUTE_RELEASE row needs to know its sign) is the only thing that can
  // fail; when it does, every row is null rather than a column that is right
  // until the row where it stopped being right.
  //
  // Known imprecision, accepted: the headline balance, the page and the
  // newer-rows read are three separate statements, so an entry landing
  // between them shifts the seed by that entry. The same is true of every
  // offset-paged list on the platform; a money page that flickers by one row
  // on refresh is honest, one that fabricates a total is not.
  let balanceAfterResolved = true;
  let balanceAfterById = new Map<string, number>();
  let seedStep: "newerEntries" | "disputeDebits" = "newerEntries";
  try {
    const newerRows =
      offset > 0
        ? await deps.repos.payeeLedger.listEntries(payeeRef.id, {
            currency,
            limit: offset,
            offset: 0,
          })
        : [];
    seedStep = "disputeDebits";
    const relatedTypeById = await resolveDisputeReleaseRelations(
      deps.repos.payeeLedger,
      [...newerRows, ...pageRows],
    );
    const deltaOf = (row: PayeeLedgerEntryRecord) =>
      ledgerEntryBalanceDeltaCents({
        type: row.type,
        amountCents: row.amountCents,
        idempotencyKey: row.idempotencyKey,
        relatedEntryType: row.relatedEntryId
          ? (relatedTypeById.get(row.relatedEntryId) ?? null)
          : null,
      });

    let running = balance.ledgerBalanceCents;
    for (const row of newerRows) running -= deltaOf(row);
    const walked = new Map<string, number>();
    for (const row of pageRows) {
      walked.set(row.id, running);
      running -= deltaOf(row);
    }
    balanceAfterById = walked;
  } catch (err) {
    balanceAfterResolved = false;
    balanceAfterById = new Map();
    logger?.error("payee_statement_running_balance_seed_failed", {
      err,
      payeeId: payeeRef.id,
      step: seedStep,
      offset,
    });
    report(deps, err, seedStep, { payeeId: payeeRef.id, offset });
  }

  // The cursor is capped, not the caller: `PAYEE_STATEMENT_MAX_OFFSET` is
  // enforced on the INPUT, so advertising a `nextOffset` past it would hand
  // the UI a "Load more" that is a guaranteed 400. `hasMore` stays truthful
  // — more rows exist — and a null cursor is how the page says "but not
  // through this view" (the export path walks the raw port instead).
  const candidateNextOffset = offset + pageRows.length;
  const nextOffset =
    hasMore && candidateNextOffset <= PAYEE_STATEMENT_MAX_OFFSET
      ? candidateNextOffset
      : null;

  return {
    payeeId: payeeRef.id,
    currency,
    balanceCents: balance.ledgerBalanceCents,
    payableCents,
    pendingHoldCents: balance.pendingHoldCents,
    reserveCents: balance.reserveCents,
    nextArrivalAt,
    nextArrivalCents,
    arrivalResolved,
    payoutMinimumCents,
    minimumResolved,
    belowMinimum:
      payoutMinimumCents === null ? null : payableCents < payoutMinimumCents,
    entries: pageRows.map((row) => ({
      id: row.id,
      type: row.type,
      amountCents: row.amountCents,
      currency: row.currency,
      description: row.description,
      createdAt: row.createdAt,
      availableAt: row.availableAt,
      orderId: row.orderId,
      // Unknown is null, never 0 — see the field's doc.
      balanceAfterCents: balanceAfterById.get(row.id) ?? null,
    })),
    hasMore,
    nextOffset,
    limit,
    offset,
    balanceAfterResolved,
    nextPayoutRun: nextPayoutRunFor(asOf),
    asOf,
  };
}
