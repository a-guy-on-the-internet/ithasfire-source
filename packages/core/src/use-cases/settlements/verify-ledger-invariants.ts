import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput, describeError } from "../../lib/io";
import {
  checkPlatformSolvency,
  checkPlatformSolvencyOutputSchema,
} from "./check-platform-solvency";

/**
 * The ledger reconciliation sweep (ledger-authoritative-settlement spec §9,
 * "live from day one") — the safety net for the counters and writes nothing
 * else checks.
 *
 * The original sin of the pre-cutover system was a stored number nothing ever
 * verified. The cutover kept exactly one mutable cached counter on the money
 * path — `PayeeLedgerBalance.ledgerPendingHoldCents`, which the payable query
 * SUBTRACTS from every transfer amount — and its decrement helpers clamp at 0
 * (`GREATEST(0, ·)`), which bounds drift but also MASKS it. This use case is
 * the thing that looks.
 *
 * Three invariants, ALL READ-ONLY (report, never repair — money repair stays
 * human, via the future ledger-admin MANUAL_ADJUSTMENT tool):
 *
 *   1. Rollup drift  — every cached (payee, currency) rollup counter equals
 *                      its recompute from the append-only entries.
 *   2. Conservation  — per (order, payee, currency):
 *                      Σ REFUND_DEBIT ≤ Σ SETTLEMENT_CREDIT,
 *                      Σ TRANSFER_REVERSAL_CREDIT ≤ Σ REFUND_DEBIT, and
 *                      Σ REFUND_DEBIT + Σ principal DISPUTE_DEBIT
 *                        − Σ debit-compensating DISPUTE_RELEASE
 *                        ≤ Σ SETTLEMENT_CREDIT
 *                      (dispute FEE entries are on top of the credit and
 *                      stay out of the comparison; reported for context),
 *                      and Σ CASH_SALE_DEBIT_REVERSAL ≤ Σ CASH_SALE_DEBIT
 *                      (a cash gate refund undoes at most its own debit).
 *   3. Completeness  — every finalized (SUCCEEDED / PART_REFUNDED),
 *                      grace-window-aged, ledger-era order with positive
 *                      per-payee OrderSplit sums has SETTLEMENT_CREDITs
 *                      summing to exactly those splits.
 *   4. Cancelled-event cash debits — every CASH_SALE_DEBIT whose order's
 *                      event is CANCELLED (and has been for the grace
 *                      window) has its CASH_SALE_DEBIT_REVERSAL. Cancelling
 *                      an event refunds its cash sales and reverses their
 *                      debits (owner ruling 2026-10-07); a debit left
 *                      standing is an organiser charged for money they gave
 *                      back, which the payout batch would net off. The door
 *                      sweep should have caught it — this is the alarm for
 *                      when it did not.
 *   5. Cancelled-event door card sales — no door (POS) card sale on a
 *                      CANCELLED event (same grace) is left open: SUCCEEDED
 *                      with a PaymentIntent and never refunded (it finalised
 *                      while the cancellation was refunding, after that
 *                      scan), or PENDING and never voided (its PaymentIntent
 *                      was paid; the door sweep keeps and quarantines it).
 *                      REPORT-ONLY: nothing here refunds anyone — a person
 *                      decides. Not strictly a ledger invariant, but money
 *                      the buyer is owed on a cancelled event, and this is
 *                      the daily read that sees it.
 *   6. Solvency      — the PLATFORM Stripe balance covers what we owe
 *                      (see check-platform-solvency.ts). The first five
 *                      check that the ledger agrees with ITSELF; this one
 *                      checks it against the actual pot, which nothing did
 *                      before. It rides this sweep rather than a new cron
 *                      deliberately: same cadence, same read-only posture,
 *                      no new manifest entry (Terraform-visible).
 *
 * Solvency is the ONLY check here with an external dependency, so it is
 * fully guarded: a Stripe (or repo) failure inside it is reported and
 * SWALLOWED, and the five ledger checks — which are independently
 * valuable and have already run and reported by then — still complete.
 *
 * Reporting discipline: ONE `reportError` per violated invariant CLASS per
 * run — grouped, never per-row (a per-row report on a thousand-cell drift
 * would flood Sentry and destroy the very signal this job exists to protect)
 * — plus a `logger.error` with the same payload (`logger.warn` is NOT
 * captured by Sentry; per the house convention warn would silently un-Sentry
 * this). Both are guarded so a throwing reporter/logger never changes the
 * sweep's behaviour.
 */

export const verifyLedgerInvariantsInputSchema = z
  .object({
    /**
     * Minutes after an order's last write before its missing credits count as
     * a completeness gap. Covers the post-transaction mint window: the
     * ticketing credit write happens AFTER the finalize transaction commits
     * (and webhook retries can stretch it), so a zero-grace sweep racing a
     * mid-flight finalize would flag orders that are about to be fine.
     */
    graceMinutes: z.number().int().min(0).max(24 * 60).default(30),
    /** Max sample rows carried per invariant class (ids + cents only). */
    sampleLimit: z.number().int().min(1).max(20).default(20),
  })
  .strict();

const rollupDriftSampleSchema = z
  .object({
    payeeId: z.string(),
    currency: z.string(),
    cachedLedgerBalanceCents: z.number(),
    expectedLedgerBalanceCents: z.number(),
    cachedPendingHoldCents: z.number(),
    expectedPendingHoldCents: z.number(),
    cachedReserveCents: z.number(),
    expectedReserveCents: z.number(),
    rollupRowMissing: z.boolean(),
    orphanRollupRow: z.boolean(),
  })
  .strict();

const conservationSampleSchema = z
  .object({
    orderId: z.string(),
    payeeId: z.string(),
    currency: z.string(),
    creditCents: z.number(),
    refundDebitCents: z.number(),
    transferReversalCreditCents: z.number(),
    disputeDebitCents: z.number(),
    disputeDebitReversalCents: z.number(),
    disputeFeeDebitCents: z.number(),
    cashSaleDebitCents: z.number(),
    cashSaleDebitReversalCents: z.number(),
  })
  .strict();

const cancelledEventCashDebitSampleSchema = z
  .object({
    orderId: z.string(),
    eventId: z.string(),
    payeeId: z.string(),
    currency: z.string(),
    cashSaleDebitCents: z.number(),
  })
  .strict();

const cancelledEventOpenDoorCardSaleSampleSchema = z
  .object({
    orderId: z.string(),
    eventId: z.string(),
    status: z.enum(["SUCCEEDED", "PENDING"]),
    paymentIntentId: z.string().nullable(),
    currency: z.string(),
    amountGrossCents: z.number(),
  })
  .strict();

const completenessSampleSchema = z
  .object({
    orderId: z.string(),
    payeeId: z.string(),
    currency: z.string(),
    expectedFromSplitsCents: z.number(),
    creditCents: z.number(),
  })
  .strict();

export const verifyLedgerInvariantsOutputSchema = z
  .object({
    /** (payee, currency) cells whose cached rollup disagrees with entries. */
    rollupDriftCount: z.number().int(),
    /** (order, payee, currency) cells violating refund conservation. */
    conservationViolationCount: z.number().int(),
    /** (order, payee) cells missing/mis-summing their SETTLEMENT_CREDITs. */
    completenessGapCount: z.number().int(),
    /** CASH_SALE_DEBITs on a CANCELLED event with no reversal. */
    cancelledEventCashDebitCount: z.number().int(),
    /** Door card sales left paid-unrefunded or unvoided on a CANCELLED event. */
    cancelledEventOpenDoorCardSaleCount: z.number().int(),
    /** Capped diagnostic rows per class (ids + cents; ≤ sampleLimit each). */
    samples: z
      .object({
        rollupDrift: z.array(rollupDriftSampleSchema),
        conservation: z.array(conservationSampleSchema),
        completeness: z.array(completenessSampleSchema),
        cancelledEventCashDebit: z.array(cancelledEventCashDebitSampleSchema),
        cancelledEventOpenDoorCardSale: z.array(
          cancelledEventOpenDoorCardSaleSampleSchema,
        ),
      })
      .strict(),
    /**
     * Platform solvency (available balance vs. total liability), or null when
     * no payment processor was wired OR the check itself faulted. Null means
     * "not measured", NEVER "healthy" — callers must not read absence as an
     * all-clear.
     */
    solvency: checkPlatformSolvencyOutputSchema.nullable(),
  })
  .strict();

export type VerifyLedgerInvariantsInput = z.infer<
  typeof verifyLedgerInvariantsInputSchema
>;
export type VerifyLedgerInvariantsOutput = z.infer<
  typeof verifyLedgerInvariantsOutputSchema
>;

export type VerifyLedgerInvariantsDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * Optional, and READ-ONLY when present: the solvency check calls
   * `getPlatformBalance()` and nothing else. Omit it and the sweep runs its
   * five ledger checks exactly as before, returning `solvency: null` —
   * so a composition root without Stripe configured degrades instead of
   * failing.
   */
  payments?: PaymentProcessorPort;
  logger?: LoggerPort;
  /**
   * Violations are REPORTED, never thrown — the sweep completing all five
   * checks matters more than any single finding — which makes every finding a
   * deliberate swallow: it MUST go through `reportError` (house convention;
   * `logger.warn` is not captured). Guarded so a throwing reporter never
   * changes behaviour.
   */
  reportError?: ReporterPort;
};

export async function verifyLedgerInvariants(
  deps: VerifyLedgerInvariantsDeps,
  rawInput: unknown,
): Promise<VerifyLedgerInvariantsOutput> {
  const input = parseInput(verifyLedgerInvariantsInputSchema, rawInput);

  const now = deps.clock.now();
  const finalizedBefore = new Date(
    now.getTime() - input.graceMinutes * 60_000,
  );

  // Sequential on purpose: five full-table aggregates in parallel would
  // stack on the same connection pool the payout batch and API share, for a
  // job with no latency requirement.
  const rollup = await deps.repos.payeeLedger.listRollupDrift(
    input.sampleLimit,
  );
  const conservation =
    await deps.repos.payeeLedger.listConservationViolations(input.sampleLimit);
  const completeness = await deps.repos.payeeLedger.listCompletenessGaps(
    finalizedBefore,
    input.sampleLimit,
  );
  // Same grace cutoff, applied to the event's last change: a cancellation
  // whose door phase is still running (or that the next sweep will finish)
  // is not a violation yet.
  const cancelledCash =
    await deps.repos.payeeLedger.listUnreversedCashSaleDebitsOnCancelledEvents(
      finalizedBefore,
      input.sampleLimit,
    );
  // Same grace again: a cancellation whose door phase is still running is
  // not a violation yet.
  const openDoorCard =
    await deps.repos.orders.listOpenDoorCardSalesOnCancelledEvents(
      finalizedBefore,
      input.sampleLimit,
    );

  // One grouped report per violated invariant class — never per-row.
  reportViolations(deps, "rollup_drift", rollup.total, rollup.rows);
  reportViolations(
    deps,
    "conservation",
    conservation.total,
    conservation.rows,
  );
  reportViolations(
    deps,
    "completeness",
    completeness.total,
    completeness.rows,
  );
  reportViolations(
    deps,
    "cancelled_event_cash_debit",
    cancelledCash.total,
    cancelledCash.rows,
  );
  reportViolations(
    deps,
    "cancelled_event_open_door_card_sale",
    openDoorCard.total,
    openDoorCard.rows,
  );

  // AFTER the ledger invariants have run and reported, on purpose: the
  // solvency check is the only one with an external dependency, and nothing
  // it can do — including a bug in its own guard — may cost us the ledger
  // findings above.
  const solvency = await runSolvencyCheck(deps);

  return verifyLedgerInvariantsOutputSchema.parse({
    rollupDriftCount: rollup.total,
    conservationViolationCount: conservation.total,
    completenessGapCount: completeness.total,
    cancelledEventCashDebitCount: cancelledCash.total,
    cancelledEventOpenDoorCardSaleCount: openDoorCard.total,
    samples: {
      rollupDrift: rollup.rows,
      conservation: conservation.rows,
      completeness: completeness.rows,
      cancelledEventCashDebit: cancelledCash.rows,
      cancelledEventOpenDoorCardSale: openDoorCard.rows,
    },
    solvency,
  });
}

/**
 * The solvency leg, belt-and-braces guarded. `checkPlatformSolvency` already
 * swallows and reports its own dependency failures; this catch is the outer
 * net for anything it could not anticipate (a throwing port stub, a schema
 * parse failure). Either way the sweep returns its five ledger checks.
 */
async function runSolvencyCheck(
  deps: VerifyLedgerInvariantsDeps,
): Promise<z.infer<typeof checkPlatformSolvencyOutputSchema> | null> {
  if (!deps.payments) return null;
  try {
    return await checkPlatformSolvency(
      {
        repos: deps.repos,
        payments: deps.payments,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {},
    );
  } catch (err) {
    try {
      deps.logger?.error("verifyLedgerInvariants.solvencyCheckFailed", {
        error: describeError(err),
      });
    } catch {
      /* a throwing logger must not stop the sweep */
    }
    try {
      deps.reportError?.(err, {
        tags: { job: "settlements.verify-ledger", invariant: "solvency" },
      });
    } catch {
      /* best-effort reporting only — see ReporterPort */
    }
    return null;
  }
}

function reportViolations(
  deps: VerifyLedgerInvariantsDeps,
  invariant:
    | "rollup_drift"
    | "conservation"
    | "completeness"
    | "cancelled_event_cash_debit"
    | "cancelled_event_open_door_card_sale",
  count: number,
  samples: unknown[],
): void {
  if (count <= 0) return;
  const payload = { invariant, count, samples };
  try {
    deps.logger?.error("verifyLedgerInvariants.violation", payload);
  } catch {
    /* a throwing logger must not stop the sweep */
  }
  try {
    deps.reportError?.(new Error("ledger_invariant_violation"), {
      tags: { job: "settlements.verify-ledger", invariant },
      extra: { counts: { [invariant]: count }, samples },
    });
  } catch {
    /* best-effort reporting only — see ReporterPort */
  }
}
