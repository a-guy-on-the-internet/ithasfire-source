import type { ReporterPort } from "@th/ports/reporter";

/**
 * Wraps a `ReporterPort` so a sustained outage produces periodic breadcrumbs
 * in Sentry instead of either (a) one event per failed request — which would
 * spam the project into oblivion during a multi-hour/day outage — or (b)
 * silence after the first event, which is nearly as bad: nobody gets paged
 * that the outage is still ongoing.
 *
 * Throttling is keyed on the call's `tags` (expected to be low-cardinality,
 * per the `ReporterPort` convention — see `packages/ports/src/reporter.ts`),
 * so distinct fail-open branches reported through one shared instance (e.g.
 * `get` / `set` / `init` in `rate-limit-storage.ts`) each get their own
 * window rather than one silencing the others.
 *
 * In-memory only — resets on process restart. That's fine here: the
 * contract is "don't spam one event per request during an outage", not
 * "exactly once ever across the fleet".
 */
export function createThrottledReporter(
  reportError: ReporterPort | undefined,
  windowMs: number,
): ReporterPort {
  const lastReportedAtByKey = new Map<string, number>();

  return (error, context) => {
    if (!reportError) return;

    const key = JSON.stringify(context?.tags ?? {});
    const now = Date.now();
    const lastReportedAt = lastReportedAtByKey.get(key);

    if (lastReportedAt !== undefined && now - lastReportedAt < windowMs) {
      return;
    }

    lastReportedAtByKey.set(key, now);
    reportError(error, context);
  };
}
