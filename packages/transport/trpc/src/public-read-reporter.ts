import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import type { ReporterPort } from "@th/ports/reporter";

/**
 * A public read fires per page view, so a swallow branch inside one reports
 * through a THROTTLED reporter: one report per window per process, not one per
 * view (same reasoning as the quote-tax reporter in routers/events.ts and
 * `QuoteTaxRateLookupDeps.reportError`).
 *
 * Memoized per base reporter so the throttle window survives across requests;
 * `createThrottledReporter(...)` built per request would never throttle.
 */
const PUBLIC_READ_REPORT_THROTTLE_MS = 5 * 60_000;
const publicReadReporters = new WeakMap<ReporterPort, ReporterPort>();

export function throttledPublicReadReporter(
  reportError: ReporterPort | null | undefined,
): ReporterPort | undefined {
  if (!reportError) return undefined;
  let throttled = publicReadReporters.get(reportError);
  if (!throttled) {
    throttled = createThrottledReporter(
      reportError,
      PUBLIC_READ_REPORT_THROTTLE_MS,
    );
    publicReadReporters.set(reportError, throttled);
  }
  return throttled;
}
