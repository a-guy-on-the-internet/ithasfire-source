import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import {
  PROCESSOR_FEE_MAX_READ_FAILURES,
  PROCESSOR_FEE_RETRY_BACKOFF_MS,
} from "@th/types/repos/orders";

// ─────────────────────────────────────────────────────────────────────────────
// Read what Stripe ACTUALLY charged us to process each order, and stamp it.
//
// `Order.processorFeeCents` is the one input to platform revenue that cannot
// be derived from anything we already store. The rate schedule in
// `processing-cost-schedule.ts` is what we EXPECT Stripe to charge; the
// balance transaction is what it DID. Those differ per payment method, per
// card brand, per country, and on any Stripe pricing the account has
// negotiated — so a modelled figure is not a cheaper version of this number,
// it is a different number wearing its name.
//
// WHY A SWEEP AND NOT THE FINALIZE PATH. Two reasons, both fatal to doing it
// inline. The balance transaction is not reliably available the instant a
// charge succeeds, so a finalize-time read would sometimes find nothing and
// would have to either block or give up. And finalize already runs inside a
// transaction that writes the order, its splits and its ledger credits —
// putting a Stripe HTTP call in there is the shape of problem this codebase
// has already had once with the tax provider. A sweep also gets history for
// free: every order that predates the column is simply an unstamped row.
//
// FAILURE POSTURE: per order, never per run. One order whose intent Stripe no
// longer recognises must not stop the other 199 from being stamped, so each
// read is caught, recorded, counted and (see below) reported. A failed order
// keeps `processorFeeCents = NULL` — which is correct, because NULL means
// "not attributed" and suppresses the net rather than contributing a zero.
//
// BACKOFF AND PARKING. The claim query is oldest-first, and oldest-first with
// no failure memory has a failure mode of its own: a row Stripe can NEVER
// resolve (deleted test data, an intent on a different Stripe account, an
// intent that never produced a charge) would be retried every hour forever,
// occupy a page slot every hour forever, and fire one Sentry event per hour
// forever — and once `limit` such rows existed the sweep would never reach a
// newer order and coverage would freeze. So every failure is RECORDED on the
// row (`processorFeeReadFailures`, `processorFeeReadFailedAt`; bookkeeping,
// never money), the claim query skips a failed row for
// `PROCESSOR_FEE_RETRY_BACKOFF_MS`, and a row that reaches
// `PROCESSOR_FEE_MAX_READ_FAILURES` is PARKED: it drops out of the claim
// query until someone resets its counter by hand. Parked rows stay NULL, so
// they still read as "not attributed" downstream; they are counted in
// `parked` here so the backlog report can name them.
//
// REPORTING, NOT FLOODING. `reportError` fires on the FIRST failure of a row
// (a new problem) and again when the row is PARKED (a problem we have given
// up on) — never on the retries in between, which is the per-row-per-hour
// flood this exists to stop. `logger.error` still fires on every failure so
// the run log remains a complete record.
//
// WHAT THIS MUST NEVER DO: write a number it did not get from Stripe. Once
// stored, a modelled value is indistinguishable from a measured one, and the
// consumer has no way to tell that its "full coverage" is partly fiction.
// There is deliberately no fallback, no estimate and no default here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sweep's retry policy, re-exported from `@th/types` where the adapter
 * also reads them. See the doc on each constant for the reasoning.
 */
export { PROCESSOR_FEE_MAX_READ_FAILURES, PROCESSOR_FEE_RETRY_BACKOFF_MS };

export const backfillProcessorFeesInputSchema = z
  .object({
    /**
     * Orders to attempt per run. Each one is a Stripe round trip, so this is
     * a rate budget as much as a batch size.
     */
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const backfillProcessorFeesOutputSchema = z
  .object({
    /** Orders the claim query returned. */
    considered: z.number().int().nonnegative(),
    /** Orders stamped with a real Stripe figure by THIS run. */
    stamped: z.number().int().nonnegative(),
    /**
     * Orders whose row was already stamped by the time we wrote — a
     * concurrent run won the race. Normal, not an error.
     */
    alreadyStamped: z.number().int().nonnegative(),
    /**
     * Orders whose fee could not be read THIS run. They stay NULL, are backed
     * off, and are retried once the backoff window passes; a number that
     * stays high across runs is the signal to look.
     */
    failed: z.number().int().nonnegative(),
    /**
     * Orders that reached `PROCESSOR_FEE_MAX_READ_FAILURES` THIS run and will
     * not be claimed again until their counter is reset by hand. A subset of
     * `failed`. They stay NULL and still read as "not attributed"; this count
     * is how the backlog report knows the gap is permanent, not pending.
     */
    parked: z.number().int().nonnegative(),
    /** Cents stamped this run, per currency. Never summed across currencies. */
    stampedCentsByCurrency: z.array(
      z.object({ currency: z.string(), feeCents: z.number().int() }),
    ),
    /**
     * Age of the oldest order still awaiting a read, for backlog reporting.
     * The head of the claim page — so a backed-off or parked row older than
     * this is not represented here.
     */
    oldestUnstampedAt: z.date().nullable(),
  })
  .strict();

export type BackfillProcessorFeesInput = z.infer<
  typeof backfillProcessorFeesInputSchema
>;
export type BackfillProcessorFeesOutput = z.infer<
  typeof backfillProcessorFeesOutputSchema
>;

export type BackfillProcessorFeesDeps = {
  repos: Pick<Repos, "orders">;
  payments: Pick<PaymentProcessorPort, "getProcessingFeeForPaymentIntent">;
  /** The sweep's `now` — the backoff window is measured from it. */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Required by the repo convention for any swallow site: this use case
   * catches per-order failures and carries on. Fires on a row's FIRST
   * failure and when it is PARKED — not on every retry.
   */
  reportError?: ReporterPort;
};

export async function backfillProcessorFees(
  deps: BackfillProcessorFeesDeps,
  rawInput: unknown,
): Promise<BackfillProcessorFeesOutput> {
  const input = backfillProcessorFeesInputSchema.parse(rawInput);
  const logger = deps.logger?.child({ useCase: "backfillProcessorFees" });
  const now = deps.clock.now();

  const pending = await deps.repos.orders.listOrdersMissingProcessorFee({
    limit: input.limit,
    now,
    retryBackoffMs: PROCESSOR_FEE_RETRY_BACKOFF_MS,
    maxFailures: PROCESSOR_FEE_MAX_READ_FAILURES,
  });

  let stamped = 0;
  let alreadyStamped = 0;
  let failed = 0;
  let parked = 0;
  const byCurrency = new Map<string, number>();

  /**
   * One failure of one row: record it, then decide whether it is worth a
   * Sentry event. Returns nothing the loop needs — the counters are closed
   * over — but every refusal branch must go through here so the two rules
   * (always record, report only first-and-parked) cannot drift apart.
   */
  const recordFailure = async (
    orderId: string,
    err: unknown,
    step: "readStripeFee" | "currencyMismatch",
  ): Promise<void> => {
    failed += 1;
    // Guarded to unstamped rows: 0 means a concurrent run stamped the fee
    // between our claim and our failure, and a stamped row is never marked
    // failed — nor counted as parked, whatever its counter says.
    const failures = await deps.repos.orders.recordProcessorFeeReadFailure({
      orderId,
      failedAt: now,
    });
    const isFirst = failures === 1;
    // The EXACT transition, not ">=": two runs (hourly cron + a manual
    // trigger) can both claim a row sitting at cap−1, and the atomic
    // increment hands one of them cap and the other cap+1. Only the one that
    // crossed the line parks and reports it; the other just failed.
    const isParked = failures === PROCESSOR_FEE_MAX_READ_FAILURES;
    if (isParked) parked += 1;
    if (!isFirst && !isParked) return;
    try {
      deps.reportError?.(err, {
        tags: {
          useCase: "backfillProcessorFees",
          step,
          ...(isParked ? { parked: "true" } : {}),
        },
        extra: { orderId, failures, parked: isParked },
      });
    } catch {
      // Reporting is fire-and-forget; a throwing reporter must never turn a
      // degraded run into a failed one.
    }
  };

  for (const order of pending) {
    let feeCents: number;
    let feeCurrency: string;
    try {
      const fee = await deps.payments.getProcessingFeeForPaymentIntent({
        paymentIntentId: order.stripePaymentIntentId,
      });
      feeCents = fee.feeCents;
      feeCurrency = (fee.currency ?? order.currency).toLowerCase();
    } catch (err) {
      // Swallow PER ORDER and carry on — see the failure-posture note above.
      // The row stays NULL, which reads as "not attributed" downstream, so a
      // failure here degrades the consumer to a partial cost with honest
      // coverage rather than to a wrong net.
      logger?.error("backfill_processor_fee_read_failed", {
        orderId: order.id,
        priorFailures: order.processorFeeReadFailures,
        err,
      });
      await recordFailure(order.id, err, "readStripeFee");
      continue;
    }

    // A fee denominated in a different currency than the order cannot be
    // stored in the order's own cents field without inventing an FX rate.
    // Refuse rather than convert: an unstamped row is honest, a converted one
    // is a guess that reads as a measurement. Recorded like a read failure:
    // it is just as permanent, and would flood just as hard.
    if (feeCurrency !== order.currency) {
      logger?.error("backfill_processor_fee_currency_mismatch", {
        orderId: order.id,
        orderCurrency: order.currency,
        feeCurrency,
        priorFailures: order.processorFeeReadFailures,
      });
      await recordFailure(
        order.id,
        new Error(
          `Processor fee currency ${feeCurrency} does not match order currency ${order.currency}`,
        ),
        "currencyMismatch",
      );
      continue;
    }

    const didStamp = await deps.repos.orders.stampProcessorFee({
      orderId: order.id,
      feeCents,
    });
    if (didStamp) {
      stamped += 1;
      byCurrency.set(
        order.currency,
        (byCurrency.get(order.currency) ?? 0) + feeCents,
      );
    } else {
      alreadyStamped += 1;
    }
  }

  // The claim query is oldest-first, so the head of this page IS the oldest
  // claimable order — no second query needed to report backlog age. Backed-
  // off and parked rows are not in the page, so an older one of those is
  // deliberately not represented: this is the age of what the sweep can
  // still act on.
  const oldestUnstampedAt = pending.length > 0 ? pending[0]!.occurredAt : null;

  const result: BackfillProcessorFeesOutput = {
    considered: pending.length,
    stamped,
    alreadyStamped,
    failed,
    parked,
    stampedCentsByCurrency: [...byCurrency.entries()]
      .map(([currency, feeCents]) => ({ currency, feeCents }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    oldestUnstampedAt,
  };

  logger?.info("backfill_processor_fees.completed", result);
  return result;
}
