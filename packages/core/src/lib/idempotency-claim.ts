import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError } from "./io";

// ─────────────────────────────────────────────────────────────────────────────
// abandonClaim — what to do with an idempotency claim when the work under it
// threw. THE canonical explanation; call sites carry a one-line pointer here.
//
// Why `fail()` is wrong for a transient error, precisely:
//
//   * The Stripe webhook route returns 200 for EVERY verified event — handler
//     failures are captured to the DLQ and acknowledged (webhook.ts, "The ONE
//     failure sink"). Stripe therefore NEVER retries an event we failed on.
//     The operator's DLQ replay (`platform.replayWebhookDlqItem`) is the ONLY
//     retry path there is.
//   * `fail()` writes a `failed:` marker the Redis adapter keeps for 15
//     minutes. `begin()` is SET NX and `get()` returns null for failed
//     records, so for those 15 minutes the replay is refused with
//     IDEMPOTENCY_LOCK_IN_PROGRESS. Observed live (2026-09-01): both replays
//     of a dispute event failed at 19:54Z on a marker left by a transient DB
//     error and only succeeded once it expired at 20:06Z — a 12-minute
//     outage of the one retry mechanism, caused by the retry mechanism.
//
// So: on a transient failure (DB blip, Stripe timeout, a bug the replay
// itself fixes) RELEASE the claim — owner-checked compare-and-delete, the
// same primitive the refund and evidence mutexes use — so the replay can
// begin at once. Keep `fail()` ONLY for deterministic rejections (boundary
// parse failures): retrying the same input reproduces the rejection, so the
// marker legitimately short-circuits it and the replay error says so.
//
// Callers MUST pass the `ownerToken` they gave `begin()`: an owner-less
// release could free a NEWER holder's live claim after a stall past TTL.
// Every swallow here is logger.error + reportError (warn is not captured by
// Sentry — CLAUDE.md), individually guarded like refund-mutex's
// `swallowAndReport`, so cleanup reporting can never throw into a caller
// that is already unwinding.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when retrying the same input would fail the same way. Structural
 * (`issues` array) rather than `instanceof ZodError`, mirroring the webhook's
 * parse-failure detection, so a second zod copy in the graph cannot turn a
 * deterministic rejection into a "transient" release.
 */
export function isDeterministicRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; issues?: unknown };
  return record.code === "invalid_input" || Array.isArray(record.issues);
}

export type ClaimAbandonOutcome =
  | "failed"
  | "released"
  | "lost"
  | "release_error";

export type AbandonClaimContext = {
  /** Tagged on the Sentry event so lost locks group per use case. */
  useCase: string;
  logger?: LoggerPort | null;
  reportError?: ReporterPort | null;
};

export async function abandonClaim(
  idempotency: Pick<IdempotencyPort, "fail" | "release">,
  key: string,
  ownerToken: string,
  error: unknown,
  context: AbandonClaimContext,
): Promise<ClaimAbandonOutcome> {
  if (isDeterministicRejection(error)) {
    await idempotency.fail(key, describeError(error));
    return "failed";
  }
  try {
    const released = await idempotency.release(key, ownerToken);
    if (released) return "released";
    // The claim expired and someone else holds it, or commit/fail replaced
    // it: nothing of ours is left to free. The record stays untouched. Loud,
    // because it means the work under this claim may have raced another
    // holder — the same signal the refund mutex raises.
    swallowAndReport(
      context,
      "idempotency_claim_lost_on_abandon",
      new Error("idempotency_claim_lost_on_abandon"),
      { key },
    );
    return "lost";
  } catch (releaseError) {
    // The claim's TTL is the backstop for a release that cannot reach the
    // store — still strictly better than a 15-minute `failed:` marker.
    swallowAndReport(context, "idempotency_claim_release_failed", releaseError, {
      key,
    });
    return "release_error";
  }
}

function swallowAndReport(
  context: AbandonClaimContext,
  message: string,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    context.logger?.error(message, { ...extra, error: describeError(error) });
  } catch {
    // Intentionally empty — cleanup reporting must never throw.
  }
  try {
    context.reportError?.(error, {
      tags: { useCase: context.useCase, stage: message },
      extra,
    });
  } catch {
    // Intentionally empty — cleanup reporting must never throw.
  }
}
