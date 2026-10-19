import { DateTime } from "luxon";
import { z } from "zod";

import {
  PAYOUT_BATCH_CRON_SOURCE,
  PAYOUT_BATCH_TIMEZONE,
} from "./payout-batch-cycle";

// ─────────────────────────────────────────────────────────────────────────────
// WHEN THE NEXT PAYOUT BATCH RUNS — so the payouts page can name the date
// instead of saying "next nightly run".
//
// NOT A CRON PARSER. `payout-batch-cycle.ts` records the batch's cron as a
// string to COMPARE, never a schedule to parse, and this module keeps that
// ruling: it knows exactly one schedule — daily at local midnight — and
// refuses to answer for any other. If the batch is rescheduled, the drift
// guard in `apps/jobs/src/scripts/validate-manifest.ts` forces an edit to
// `PAYOUT_BATCH_CRON_SOURCE` and names this file. From then on the helpers
// below return null (the page falls back to its dateless caption, never a
// wrong date) and the pin in `__tests__/next-payout-batch-run.test.ts` fails.
//
// NEVER A MODULE-LEVEL THROW: `@th/core` re-exports this folder, so a throw at
// import would take down every process that loads core — the API, MCP and
// the jobs app that runs the payout batch itself.
// ─────────────────────────────────────────────────────────────────────────────

/** The one schedule this module knows how to answer for. */
const DAILY_AT_LOCAL_MIDNIGHT = "0 0 * * *";

/**
 * Throws unless the recorded cron is the daily-midnight schedule this module
 * was written for. Called by the test pin only — never at import, never in a
 * request path (see the header).
 */
export function assertDailyMidnightCron(cron: string): void {
  if (cron !== DAILY_AT_LOCAL_MIDNIGHT) {
    throw new Error(
      `next-payout-batch-run: PAYOUT_BATCH_CRON_SOURCE is "${cron}", but this ` +
        `helper only knows "${DAILY_AT_LOCAL_MIDNIGHT}" (daily at local midnight). ` +
        `The payout batch was rescheduled: update next-payout-batch-run.ts ` +
        `together with _shared/payout-batch-cycle.ts.`,
    );
  }
}

export type NextPayoutBatchRun = {
  /** The instant the batch next fires: strictly after `asOf`. */
  runAt: Date;
  /**
   * The batch-zone calendar date (YYYY-MM-DD) of the EVENING before
   * `runAt` — the date people mean by "tonight's run". A run at
   * 2026-10-13T00:00 Central has night "2026-10-12".
   *
   * Just after midnight Central this already names the FOLLOWING night,
   * even while that midnight's run may still be in flight. That only ever
   * under-promises: money the in-flight run sends arrives sooner than the
   * page said (the same one-directional margin as `payout-batch-cycle.ts`).
   */
  night: string;
};

/**
 * The next instant strictly after `asOf` at which the payout batch fires:
 * the next midnight in `PAYOUT_BATCH_TIMEZONE`. At exactly midnight the run
 * firing now is not "next"; the answer is the following midnight.
 *
 * DST-safe: America/Chicago changes clocks at 02:00, so every local day has a
 * midnight, and Luxon's `plus({ days: 1 })` is calendar-aware (the fall-back
 * night is 25 hours long, the spring-forward night 23).
 */
export function nextPayoutBatchRun(
  asOf: Date,
  cron: string = PAYOUT_BATCH_CRON_SOURCE,
): NextPayoutBatchRun | null {
  // Any schedule but daily-at-midnight: say nothing rather than a wrong date.
  if (cron !== DAILY_AT_LOCAL_MIDNIGHT) return null;
  const local = DateTime.fromJSDate(asOf, { zone: PAYOUT_BATCH_TIMEZONE });
  if (!local.isValid) {
    throw new Error(
      `next-payout-batch-run: invalid asOf (${String(local.invalidReason)})`,
    );
  }
  // The start of today is at or before `asOf`, so a day later is strictly
  // after it. The night is today's local date: the evening the run closes.
  const today = local.startOf("day");
  return {
    runAt: today.plus({ days: 1 }).toJSDate(),
    night: today.toISODate()!,
  };
}

/**
 * The wire shape the payout read models report: `runAt` as an ISO instant,
 * `night` as the batch-zone calendar date. Shared so the org overview and the
 * payee statement can never describe the next run differently.
 */
export const nextPayoutRunSchema = z
  .object({
    runAt: z.string().datetime(),
    night: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type NextPayoutRun = z.infer<typeof nextPayoutRunSchema>;

/**
 * {@link nextPayoutBatchRun}, serialised for an output schema. Null when the
 * batch's recorded schedule is not one this module can answer for.
 */
export function nextPayoutRunFor(
  asOf: Date,
  cron: string = PAYOUT_BATCH_CRON_SOURCE,
): NextPayoutRun | null {
  const next = nextPayoutBatchRun(asOf, cron);
  if (!next) return null;
  return { runAt: next.runAt.toISOString(), night: next.night };
}
