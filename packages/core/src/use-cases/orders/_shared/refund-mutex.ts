import { randomUUID } from "node:crypto";

import { fail } from "@th/errors";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError } from "../../../lib/io";

/**
 * Per-order single-flight MUTEX for every refund-creating path.
 *
 * ## Why this exists (concurrent-refund double-pay)
 *
 * The refund paths each carry their own use-case idempotency record AND their
 * own Stripe idempotency keys, but the keys live in DISJOINT namespaces:
 *
 *   - buyer/staff/org full-order: `order:refund-full:${orderId}`
 *   - buyer/staff items: `order:refund-items:${orderId}:${actorHumanId}:...`
 *   - org items:         `order:org-refund-items:${orgId}:${orderId}:...`
 *   - event cancel:      `event:cancel:${actorHumanId}:${clientKey}:order:${orderId}`
 *   - resale claim:      `claim:review:${claimId}:approved:${resolution}`
 *
 * Stripe therefore dedupes NOTHING across paths, and the DB status gate
 * (`ORDER_ALREADY_REFUNDED` / item-status checks) only closes after the first
 * operation's transaction commits. Two concurrent refunds on the same order
 * (e.g. a buyer full-order refund racing an org item refund) could both pass
 * their pre-checks, both reverse transfers, and both refund the buyer —
 * over-refunding the buyer and over-reversing the payee.
 *
 * This helper closes that window: exactly one refund operation per order may
 * be between "first external call" and "DB commit" at a time. Callers MUST
 * acquire it BEFORE the first external side effect (transfer reversal) and
 * hold it through their final transaction commit — and should (re)load the
 * order's refund state INSIDE the held section so pre-checks can't act on a
 * snapshot taken before a competing commit.
 *
 * ## Semantics: mutex, NOT a dedupe record
 *
 * Sequential legitimate refunds on the same order (item 1 today, item 2
 * tomorrow; a retry after a transient Stripe failure) MUST be able to
 * re-acquire. So the key is ALWAYS released in a `finally` — on success and
 * on failure alike. Only a crashed holder keeps it, and then only until the
 * acquisition TTL ({@link ORDER_REFUND_MUTEX_TTL_SECONDS}) lapses.
 *
 * A holder that STALLS past the TTL is the honest residual: once the claim
 * expires a second operation can acquire and both are then in flight. That
 * window is narrowed, not closed, by the downstream money guards — Stripe's
 * charge-level cap only rejects refunds that would exceed the FULL charge
 * (two partial refunds of the same items within the charge total both
 * succeed), the transfer-capacity pre-flight caps at the TRANSFER's remaining
 * capacity (ledger-era transfers span whole payee cells, so a duplicate
 * within capacity passes), the legacy junction arm has no pre-flight at all,
 * and the read-failure fallback is uncapped. So: a duplicate within
 * charge/transfer capacity remains possible in the legacy arm and on
 * pre-flight read failure. What the OWNERSHIP TOKEN (below) removes is the
 * amplifier on top of that: an expired holder resuming and releasing the
 * NEWER holder's live lock, which would reopen the full double-refund race
 * for a THIRD operation while the second still runs.
 *
 * ## Release = owner-checked compare-and-delete (`release(key, ownerToken)`)
 *
 * Every acquire generates a per-acquire token (crypto.randomUUID) and passes
 * it to `begin`; the `finally` frees the key via
 * `IdempotencyPort.release(key, ownerToken)`, which deletes the claim ONLY if
 * it still carries this holder's token:
 *
 *   - Prisma (`packages/adapters/src/idempotency/prisma-adapter.ts`):
 *     `begin` stores the token in the otherwise-NULL `errorText` column of
 *     the in-progress row (no schema change); `release` is one conditional
 *     DELETE on key + status='in_progress' + errorText=token — atomic in
 *     Postgres. Re-acquisition after TTL lapse overwrites the token, so a
 *     stale holder's release matches nothing.
 *   - Redis (`packages/adapters/src/idempotency/redis-adapter.ts`):
 *     `begin` stores `in_progress:${token}` as the value; `release` is a Lua
 *     compare-and-del (GET==token → DEL, atomic server-side — a plain
 *     GET-then-DEL pair would have an expiry/re-SET window between the two
 *     calls).
 *
 * An UNCONDITIONAL release (the first cut used `fail(key, "released", 1)`)
 * is wrong precisely in the stalled-holder case: A stalls past the TTL, B
 * legitimately acquires and starts external refund work, A resumes and its
 * finally overwrites B's LIVE lock with a short-retention record, C acquires
 * a second later while B is still mid-refund — the exact race the mutex
 * exists to kill. Owner-checked release makes A's late release a no-op
 * (`release` returns false), and that false return is REPORTED as
 * `order_refund_mutex_lock_lost` — a distinct signal that this operation
 * overran its TTL and its work may have raced another holder's.
 *
 * A successful release deletes the record outright, so the key is
 * immediately re-acquirable (no residual lockout).
 *
 * ## Coverage
 *
 *   - `reconcile-stripe-full-refund.ts` IS wrapped (both the full and the
 *     partial arm) — it creates no Stripe refund, but BOTH of its debit
 *     writers compute Σ-prior-debits inside their own ReadCommitted tx, so a
 *     reconcile racing an in-flight internal refund (whose Stripe call is
 *     often what FIRED the webhook) could read priors pre-commit and
 *     over-debit append-only rows. It acquires non-blockingly: on conflict it
 *     throws `IDEMPOTENCY_LOCK_IN_PROGRESS` and the webhook's outer catch
 *     DLQs the event. Honest cost: DLQ replay is OPERATOR-DRIVEN, not
 *     automatic — a conflicted event sits in the DLQ until someone replays
 *     it (the reconcile side adds bounded in-process retries to make that
 *     rare). Reconciliation is deferred, never stalled in-process.
 *   - Ticket MOVES (gift/admin transfer, email invite, invite claim, resale
 *     listing) take this same mutex, keyed by the order that owns the
 *     ticket's current order item, with a short TTL
 *     (`_helpers/with-ticket-refund-lock.ts`; owner ruling 2026-10-05:
 *     nothing happens to a ticket while its refund is in flight). A move
 *     refuses with `TICKET_REFUND_IN_PROGRESS` while a refund holds the
 *     order; a refund arriving while a move holds it (milliseconds) gets
 *     `IDEMPOTENCY_LOCK_IN_PROGRESS` like any other refund-vs-refund race.
 *     The move releases only after its tx commits, so a refund that
 *     acquires afterwards reads the moved ticket inside its held section.
 *
 * ## Deliberately NOT wrapped
 *
 *   - POS cash refunds: no external money pipeline.
 *
 * ## Key namespace
 *
 * `refund-op:` is distinct from every use-case idempotency prefix listed
 * above, so acquiring/releasing the mutex can never clobber a use case's own
 * begin/commit/release record (refund-full-order's catch releases its OWN
 * key via `abandonClaim` with its own owner token; the owner-checked release
 * in this helper's `finally` touches only the mutex key, and only while it
 * still holds this acquire's token).
 *
 * PROCESS SCOPE: both adapters prefix keys with the composition root's
 * idempotency namespace (`api` in apps/api/src/lib/dep.ts, `jobs` in
 * apps/jobs/src/lib/container.ts), so the mutex only serializes callers that
 * share a namespace. Today every refund-creating path runs in the API process
 * (tRPC + the e2e routes reuse `app.deps.trpc.idempotency`), so this is one
 * lock. If a refund path ever moves into jobs, its container must reuse the
 * `api` idempotency namespace (or a shared one) or the mutex splits in two.
 */
export const ORDER_REFUND_MUTEX_TTL_SECONDS = 600;

export function buildOrderRefundMutexKey(orderId: string): string {
  return `refund-op:${orderId}`;
}

export type OrderRefundMutexDeps = {
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  /** Best-effort reporter for the release-failure / lock-lost swallows. */
  reportError?: ReporterPort | null;
};

/**
 * Runs `fn` while holding the per-order refund mutex.
 *
 * Throws `AppError("IDEMPOTENCY_LOCK_IN_PROGRESS")` when another refund
 * operation currently holds the order — callers surface "a refund for this
 * order is already in progress, retry shortly". The lock is freed in a
 * `finally` via owner-checked release (see the module doc).
 *
 * The release path NEVER throws into the caller — not on a failing release
 * call, not on a lost lock, and not on a throwing logger/reporter (guarded
 * here even though the composition roots wrap reporters in `safeReporter`;
 * this helper's contract must hold standalone). The caller's outcome —
 * success or the original error — is never masked by cleanup, and the
 * acquisition TTL guarantees an unreleased key self-expires.
 */
export async function withOrderRefundMutex<T>(
  deps: OrderRefundMutexDeps,
  orderId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const held = await tryAcquireOrderRefundMutex(
    deps,
    orderId,
    ORDER_REFUND_MUTEX_TTL_SECONDS,
  );
  if (!held) {
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS", {
      message: "order_refund_in_progress",
      meta: { orderId },
    });
  }

  try {
    return await fn();
  } finally {
    await held.release();
  }
}

/** A held per-order refund mutex. `release` never throws (see below). */
export type HeldOrderRefundMutex = {
  release: () => Promise<void>;
};

/**
 * Non-throwing acquire of the per-order refund mutex, for callers that are
 * not refunds but must exclude them (ticket moves:
 * `_helpers/with-ticket-refund-lock.ts`). Returns null when another holder
 * has the order; otherwise a handle whose `release` is the same
 * owner-checked, never-throwing release {@link withOrderRefundMutex} uses.
 * The caller MUST call `release` in a `finally`.
 */
export async function tryAcquireOrderRefundMutex(
  deps: OrderRefundMutexDeps,
  orderId: string,
  ttlSeconds: number,
): Promise<HeldOrderRefundMutex | null> {
  return tryAcquireOwnedMutex(
    deps,
    buildOrderRefundMutexKey(orderId),
    ttlSeconds,
    {
      releaseFailed: "order_refund_mutex_release_failed",
      lockLost: "order_refund_mutex_lock_lost",
      useCase: "withOrderRefundMutex",
      extra: { orderId },
    },
  );
}

/** What a mutex's release swallows are logged and reported as. */
export type OwnedMutexLabels = {
  releaseFailed: string;
  lockLost: string;
  /** Sentry `useCase` tag. */
  useCase: string;
  /** Sentry `extra` (the key is added). */
  extra: Record<string, unknown>;
};

/**
 * Generic owner-tokened mutex on an IdempotencyPort key: the acquire/release
 * discipline this module documents, for keys other than `refund-op:` (the
 * event-cancel mutex, `events/_shared/event-cancel-mutex.ts`). Returns null
 * when the key is held; the handle's `release` is owner-checked and never
 * throws.
 */
export async function tryAcquireOwnedMutex(
  deps: OrderRefundMutexDeps,
  key: string,
  ttlSeconds: number,
  labels: OwnedMutexLabels,
): Promise<HeldOrderRefundMutex | null> {
  const ownerToken = randomUUID();

  const acquired = await deps.idempotency.begin(key, ttlSeconds, ownerToken);
  if (!acquired) {
    return null;
  }
  return {
    release: () => releaseOwnedMutexBestEffort(deps, key, ownerToken, labels),
  };
}

/**
 * Owner-checked release that can never throw into the caller.
 *
 * Outcomes:
 *   - released → silence (the normal case).
 *   - `release` returned false → this holder LOST the lock mid-flight (its
 *     TTL lapsed and another operation re-acquired, or the record was
 *     replaced). The record is untouched by contract; report
 *     `order_refund_mutex_lock_lost` — the just-finished work may have raced
 *     the new holder's, which is worth a human look.
 *   - `release` threw (backend down) → report; the TTL is the backstop.
 */
async function releaseOwnedMutexBestEffort(
  deps: OrderRefundMutexDeps,
  key: string,
  ownerToken: string,
  labels: OwnedMutexLabels,
): Promise<void> {
  const extra = { ...labels.extra, key };
  let released: boolean;
  try {
    released = await deps.idempotency.release(key, ownerToken);
  } catch (releaseError) {
    swallowAndReport(
      deps,
      labels.releaseFailed,
      releaseError,
      extra,
      labels.useCase,
    );
    return;
  }

  if (!released) {
    swallowAndReport(
      deps,
      labels.lockLost,
      new Error(labels.lockLost),
      extra,
      labels.useCase,
    );
  }
}

/**
 * logger.error + reportError (Sentry convention: warn is not captured), each
 * individually guarded so a throwing logger or reporter can never surface a
 * completed refund as an error. Belt-and-suspenders with the composition
 * roots' `safeReporter` — deliberate, so the guarantee holds standalone.
 */
function swallowAndReport(
  deps: OrderRefundMutexDeps,
  message: string,
  error: unknown,
  extra: Record<string, unknown>,
  useCase: string,
): void {
  try {
    deps.logger?.error(message, { ...extra, error: describeError(error) });
  } catch {
    // Intentionally empty — cleanup reporting must never throw.
  }
  try {
    deps.reportError?.(error, {
      tags: { useCase },
      extra,
    });
  } catch {
    // Intentionally empty — cleanup reporting must never throw.
  }
}
