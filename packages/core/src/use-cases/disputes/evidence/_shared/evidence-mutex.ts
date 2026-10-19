import { randomUUID } from "node:crypto";

import { fail } from "@th/errors";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError } from "../../../../lib/io";

/**
 * Per-DISPUTE single-flight mutex for every path that mutates the evidence
 * package: submit, draft edit, approve, and force re-assemble.
 *
 * Why dispute-scoped and not version-scoped: a version-keyed lock lets a
 * second operator force-reassemble to v2, approve and submit under a FREE
 * key while v1's submit is still in its Stripe round-trip — two genuine
 * processor submissions. And an edit that takes no lock at all can land
 * between v1's pre-flight read and its terminal write, so Stripe receives
 * the old fields while the local row is stamped SUBMITTED over the new
 * ones. One key per dispute, held from BEFORE the first read through the
 * final commit, closes both; the version still lives in the PROCESSOR
 * idempotency key so a retry of the same package replays there.
 *
 * Semantics mirror `orders/_shared/refund-mutex.ts`: a per-acquire
 * `ownerToken` (the idempotency port requires it for mutex use), release in
 * a `finally` via owner-checked compare-and-delete, a lost lock or failing
 * release is reported and never thrown into the caller, and the TTL is the
 * backstop for a crashed holder. Contention is NON-blocking: the loser gets
 * `DISPUTE_EVIDENCE_STATE_INVALID` ("a change to this package is in
 * flight") — the desk retries in seconds, nothing waits on Stripe.
 *
 * Namespace `dispute-evidence-op:` is disjoint from the processor key
 * (`dispute-evidence:<id>:<version>:update`, which is Stripe-side only).
 *
 * TTL arithmetic: submit makes TWO Stripe calls under the lock
 * (`disputes.retrieve`, `disputes.update`). The Stripe client is built with
 * an explicit `timeout: 60_000` and `maxNetworkRetries: 1` (stripe-adapter
 * constructor), so one call is at most 60 s × (1 + 1 retry) = 120 s and the
 * two together ≤ 240 s. 300 s covers that with headroom for the local reads
 * and the commit; a crashed holder therefore blocks the desk for at most
 * five minutes. (The SDK DEFAULT is 80 s × 2 retries-worth = 240 s per call,
 * i.e. ~320 s+ for two — which is why the client options are pinned
 * explicitly rather than assumed.)
 */
export const DISPUTE_EVIDENCE_MUTEX_TTL_SECONDS = 300;

export function buildDisputeEvidenceMutexKey(disputeId: string): string {
  return `dispute-evidence-op:${disputeId}`;
}

export type DisputeEvidenceMutexDeps = {
  idempotency: Pick<IdempotencyPort, "begin" | "release">;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

export async function withDisputeEvidenceMutex<T>(
  deps: DisputeEvidenceMutexDeps,
  disputeId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = buildDisputeEvidenceMutexKey(disputeId);
  const ownerToken = randomUUID();

  const acquired = await deps.idempotency.begin(
    key,
    DISPUTE_EVIDENCE_MUTEX_TTL_SECONDS,
    ownerToken,
  );
  if (!acquired) {
    throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
      message: "a change to this dispute's evidence package is in flight",
      meta: { disputeId, inFlight: true },
    });
  }

  try {
    return await fn();
  } finally {
    await releaseBestEffort(deps, key, disputeId, ownerToken);
  }
}

async function releaseBestEffort(
  deps: DisputeEvidenceMutexDeps,
  key: string,
  disputeId: string,
  ownerToken: string,
): Promise<void> {
  let released: boolean;
  try {
    released = await deps.idempotency.release(key, ownerToken);
  } catch (err) {
    swallowAndReport(deps, "dispute_evidence_mutex_release_failed", err, {
      disputeId,
      key,
    });
    return;
  }
  if (!released) {
    swallowAndReport(
      deps,
      "dispute_evidence_mutex_lock_lost",
      new Error("dispute_evidence_mutex_lock_lost"),
      { disputeId, key },
    );
  }
}

function swallowAndReport(
  deps: DisputeEvidenceMutexDeps,
  message: string,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.logger?.error(message, { ...extra, error: describeError(error) });
  } catch {
    // Cleanup reporting must never throw.
  }
  try {
    deps.reportError?.(error, {
      tags: { useCase: "withDisputeEvidenceMutex" },
      extra,
    });
  } catch {
    // Cleanup reporting must never throw.
  }
}
