/**
 * Tax Jobs
 *
 * - tax.fill-location-rate: look up and cache the tax rate of ONE venue row
 *   (Place / SavedLocation) a listing found without one, then mark the
 *   venue's unstamped upcoming events for the search drain so their cards get
 *   an all-in total (core `tax/fill-location-tax-rate.ts`).
 *
 * NOT a cron job: it runs only when a listing queued it through
 * `repos.taxRateFills` (Cloud Tasks, on the search-drain queue's scheduler),
 * deduplicated per venue per 30-minute slot. It has its own Cloud Tasks queue
 * (`infra/terraform/tax-rate-fill.tf`: max 5 concurrent, 4 attempts).
 */
import { defineJob } from "../lib/define-job";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import type { ReporterPort } from "@th/ports/reporter";
import {
  fillLocationTaxRate,
  fillLocationTaxRateInputSchema,
} from "@th/core/use-cases/tax/fill-location-tax-rate";

// A ZipTax rate-limit spell fails every attempt of every queued venue (~2,400
// events/hour unthrottled), so failures are reported at most once per window
// per tag set. One throttled wrapper per underlying reporter, created once per
// process (same shape as the quote path's `quoteTaxReporters` in events.ts).
const FILL_FAILURE_REPORT_THROTTLE_MS = 10 * 60_000;
const throttledReporters = new WeakMap<ReporterPort, ReporterPort>();

function throttledFor(reportError: ReporterPort): ReporterPort {
  let throttled = throttledReporters.get(reportError);
  if (!throttled) {
    throttled = createThrottledReporter(
      reportError,
      FILL_FAILURE_REPORT_THROTTLE_MS,
    );
    throttledReporters.set(reportError, throttled);
  }
  return throttled;
}

export const fillLocationTaxRateJob = defineJob({
  // = TAX_RATE_FILL_JOB (core tax/tax-rate-fill-queue.ts); a literal so
  // validate-manifest can read it. tax.test.ts pins the two together.
  name: "tax.fill-location-rate",
  description:
    "Look up and cache the tax rate of one venue a listing found without one, then mark its upcoming events for the search drain so their cards show an all-in price. Queued by listings through the delayed scheduler (Cloud Tasks); never on a timer.",
  input: fillLocationTaxRateInputSchema,
  handler: async ({ input, ctx }) => {
    try {
      const result = await fillLocationTaxRate(
        {
          repos: ctx.repos,
          taxRateLookup: ctx.taxRateLookup,
          clock: ctx.clock,
          logger: ctx.logger,
          reportError: ctx.reportError,
          // No `search`: the events are MARKED and the search drain (which
          // the marks schedule) re-indexes them. This job has its own queue
          // (infra/terraform/tax-rate-fill.tf), so it stays short and does
          // not wait behind the drain.
        },
        input,
      );
      return { success: true, result };
    } catch (err) {
      // A FAILED provider lookup (or a repo fault). THROWN so app.ts answers
      // non-2xx and Cloud Tasks retries the task; reported here because jobs
      // has no pino → Sentry integration.
      try {
        throttledFor(ctx.reportError)(err, {
          tags: { job: "tax.fill-location-rate" },
          extra: { target: input.target },
        });
      } catch {
        // Best-effort: a throwing reporter must not change the outcome.
      }
      throw err;
    }
  },
});

export const taxJobs = [fillLocationTaxRateJob];
