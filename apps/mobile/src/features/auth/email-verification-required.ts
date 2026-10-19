/**
 * The B2 own-orders gate (owner ruling 2026-10-16): an account whose email is
 * not verified sees none of the orders or tickets attached to that address
 * until it proves the inbox. The server refuses with tRPC FORBIDDEN and the
 * message `email_verification_required` (`requireVerifiedEmail` in
 * packages/transport/trpc/src/verified-email.ts). `data.code` is the generic
 * FORBIDDEN, so the MESSAGE is what identifies it.
 *
 * A retry cannot fix that refusal, so every screen that calls a gated
 * procedure swaps its error state for `EmailVerificationPrompt`. Detection
 * lives here and only here. Mirrors apps/web/src/lib/email-verification-required.ts.
 */

const EMAIL_VERIFICATION_REQUIRED = "email_verification_required";

const readCode = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

/**
 * True when `error` is the server's "verify your email first" refusal: a
 * `TRPCClientError` (its message, `shape.message`, or a future structured
 * `data.appCode`), or the raw `{ code, message }` shape a use case throws.
 */
export function isEmailVerificationRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    message?: unknown;
    data?: { appCode?: unknown } | null;
    shape?: { message?: unknown } | null;
  };
  return [e.message, e.data?.appCode, e.shape?.message].some(
    (candidate) => readCode(candidate) === EMAIL_VERIFICATION_REQUIRED,
  );
}

/**
 * The dev tRPC logger's `enabled` filter: log every operation except the gate
 * refusal coming back. That refusal is the expected answer for an unverified
 * account (the screen shows the verify prompt), and the logger reports error
 * results through `console.error`, which opens a red LogBox toast over the tab
 * bar. Web does the same in its logger (apps/web/src/trpc.ts).
 */
export const shouldLogTrpcOperation = (op: {
  direction: "up" | "down";
  result?: unknown;
}): boolean =>
  !(op.direction === "down" && isEmailVerificationRequired(op.result));

/**
 * React Query `retry` for a gated read: never retry the gate (it answers the
 * same until the inbox is proven), otherwise retry up to `max` times.
 */
export const retryUnlessVerificationRequired =
  (max: number) =>
  (failureCount: number, error: unknown): boolean =>
    !isEmailVerificationRequired(error) && failureCount < max;

/**
 * Whether a screen keeps showing the verify prompt.
 *
 * A refetch of a failed query with no data (app foreground, pull to refresh)
 * puts it back to `pending` and clears `error`, so a prompt driven straight
 * off `isEmailVerificationRequired(query.error)` unmounts mid-refetch and
 * takes a half-typed code with it. The latch holds once the gate is seen and
 * lets go when the query next answers with anything else: success (verified
 * here or elsewhere), or a different error, which the screen's own error
 * state then shows with its retry instead of a spinner that never ends.
 */
export const nextVerificationLatch = (
  latched: boolean,
  query: { gated: boolean; answered: boolean },
): boolean => {
  if (query.gated) return true;
  if (query.answered) return false;
  return latched;
};
