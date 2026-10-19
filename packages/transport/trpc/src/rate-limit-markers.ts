/**
 * Stable markers on TOO_MANY_REQUESTS messages, for callers that must tell
 * WHICH limiter refused them. Dependency-free so a web route can import it.
 *
 * {@link INVALID_ATTEMPTS_RATE_LIMITED} prefixes the message of
 * `chargeFailedAttempt` (guard.ts): that bucket only ever charges FAILED
 * attempts (e.g. an invalid opt-out token), so hitting it can never drop a
 * real request. The one-click opt-out route does not report it to Sentry;
 * any other 429 (the default floor) may have dropped a real opt-out and is
 * reported.
 */
export const INVALID_ATTEMPTS_RATE_LIMITED = "INVALID_ATTEMPTS_RATE_LIMITED";

/** True when a tRPC error message came from `chargeFailedAttempt`. */
export function isInvalidAttemptsRateLimited(message: unknown): boolean {
  return (
    typeof message === "string" &&
    message.startsWith(`${INVALID_ATTEMPTS_RATE_LIMITED}:`)
  );
}
