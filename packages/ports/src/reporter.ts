/**
 * Error-reporting port.
 *
 * A minimal, vendor-agnostic hook that lets `core` use cases (and any other
 * layer) report a caught-and-swallowed operational failure to an error tracker
 * without importing the tracker SDK or an adapter. It structurally matches
 * `Sentry.captureException` and the adapters' `ReportExceptionFn`, so an API/
 * jobs call site can wire `Sentry.captureException` straight in.
 *
 * Reporting is always BEST-EFFORT: the port returns `void`, callers invoke it
 * optionally (`deps.reportError?.(...)`), and a throwing implementation must
 * never change caller behaviour.
 */
export type ReporterPort = (
  error: unknown,
  context?: {
    tags?: Record<string, string | undefined>;
    extra?: Record<string, unknown>;
  },
) => void;

/**
 * Wraps a reporter so it can NEVER throw into its caller.
 *
 * The "best-effort" contract above was, until now, enforced nowhere: the
 * composition roots wired `Sentry.captureException` raw, and most call sites
 * invoke it as a bare `deps.reportError?.(err, …)` inside a catch. A reporter
 * that threw therefore propagated out of the swallow branch and became the
 * caller's failure — verified end-to-end on the checkout path, where a
 * throwing reporter surfaced to the buyer as `dependency_failed`. The reporting
 * of a swallowed error must never be able to manufacture a NEW one.
 *
 * Guarding at the BOUNDARY rather than at each call site is deliberate: it
 * makes the contract structurally true for every present and future consumer,
 * instead of depending on ~20 call sites each remembering to wrap. Call sites
 * may still use a guarded helper for defence in depth; both are cheap.
 *
 * Deliberately swallows silently — there is no second reporter to report a
 * reporter failure to, and a `console` write here would fire on every request
 * during an error-tracker outage.
 */
export function safeReporter(inner: ReporterPort): ReporterPort {
  return (error, context) => {
    try {
      inner(error, context);
    } catch {
      // Intentionally empty — see the doc comment.
    }
  };
}
