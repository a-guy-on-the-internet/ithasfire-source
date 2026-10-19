import type { IdempotencyPort } from "@th/ports/idempotency";

import type { OpenCallNoticeKind } from "../notify-open-call-notices";

// ─────────────────────────────────────────────────────────────────────────────
// Per-notice failure counter (owner ruling 2026-10-07). A notice that has
// FAILED OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES times is "dead":
//   - deleteEvent stops waiting on it (the delete proceeds and each dead
//     notice is reported as `open_call.notice_undeliverable_on_delete`);
//   - the hourly reconcile stops re-sending it (reported once, when it
//     crosses the threshold), so a dead address neither burns the send cap
//     nor fails the run every hour.
//
// Stored in the SAME ledger store as the notices (IdempotencyPort `commit`
// of `{ count }`, read back with `get`): both adapters upsert on commit, so
// no port change. The `open-call-notice-failures:` prefix cannot collide
// with the notice keys (`open-call-notice:`) or the reconcile cursors
// (`open-call-sweep:`).
//
// Read-then-write, NOT atomic: two concurrent failures of one row can count
// once. That only costs one extra attempt before the row is dead; the
// notifier's per-recipient claim still prevents any double send.
// ─────────────────────────────────────────────────────────────────────────────

/** Failed attempts after which a notice stops blocking deletes and retries. */
export const OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES = 3;

/**
 * Twice the 14-day reconcile window, refreshed on each failure: a row the
 * reconcile can still see always keeps its count.
 *
 * deleteEvent scans with no age limit. Once the counter expires, a dead row
 * counts as owed again in a delete: it gets one more send and can cause up to
 * 2 refusals before it dies again. Each attempt makes progress, so a delete
 * never blocks forever.
 */
export const OPEN_CALL_NOTICE_FAILURES_KEEP_SEC = 28 * 24 * 60 * 60;

export function openCallNoticeFailuresKey(kind: OpenCallNoticeKind, submissionId: string): string {
  return `open-call-notice-failures:${kind}:${submissionId}`;
}

/** Failed attempts recorded for this notice (0 when none). Throws if the store does. */
export async function readOpenCallNoticeFailures(
  idempotency: IdempotencyPort,
  kind: OpenCallNoticeKind,
  submissionId: string,
): Promise<number> {
  const raw = await idempotency.get<{ count?: unknown }>(openCallNoticeFailuresKey(kind, submissionId));
  const count = raw?.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

/** Records one failed attempt; returns the new count. Throws if the store does. */
export async function recordOpenCallNoticeFailure(
  idempotency: IdempotencyPort,
  kind: OpenCallNoticeKind,
  submissionId: string,
): Promise<number> {
  const count = (await readOpenCallNoticeFailures(idempotency, kind, submissionId)) + 1;
  await idempotency.commit(
    openCallNoticeFailuresKey(kind, submissionId),
    { count },
    OPEN_CALL_NOTICE_FAILURES_KEEP_SEC,
  );
  return count;
}

export function isOpenCallNoticeDead(failures: number): boolean {
  return failures >= OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES;
}
