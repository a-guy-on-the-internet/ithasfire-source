import { useCallback, useEffect, useRef, useState } from "react";

import { useNetworkState } from "../features/network/use-network-state";
import { trpc } from "../trpc";
import {
  bumpQueuedScan,
  countDroppedScans,
  countQueuedScans,
  isScanQueued,
  listDueQueuedScans,
  recordDroppedScan,
  removeQueuedScan,
  enqueueScan as enqueueScanRow,
  type DroppedScanReason,
  type QueuedScan,
} from "./local-db";
import { reportScanIssue } from "./report";
// Classification is shared with the FR-001 offline-resolve fallback so both
// answer "was this a network failure?" identically.
import { classifyScanError } from "./scan-error-classification";
import { isRequestTimeout, withTimeout } from "./with-timeout";

const FLUSH_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 8;
/**
 * How long one queued admit waits for the server before the pass moves on. An
 * admit normally answers in well under a second; this is for the request that
 * never answers at all (see `with-timeout.ts`).
 */
const SEND_TIMEOUT_MS = 20_000;
/**
 * Unanswered sends in a row that end the pass. One may be a slow request; two
 * mean the connection is not answering, and the rest of the queue would wait
 * {@link SEND_TIMEOUT_MS} per row to find that out.
 */
const TIMEOUTS_THAT_END_A_PASS = 2;

// Exponential backoff for transient (retryable) failures. Indexed by the
// attempt count *after* the bump, so [0]=delay before retry #1, etc. The
// last value clamps further attempts to the same cap. Tuned to absorb a
// minutes-long server hiccup without flooding the network.
const TRANSIENT_BACKOFF_MS = [
  5_000, // 5s
  15_000, // 15s
  45_000, // 45s
  2 * 60_000, // 2m
  6 * 60_000, // 6m
  18 * 60_000, // 18m
  30 * 60_000, // 30m
  30 * 60_000, // 30m
] as const;

function backoffDelayMs(attemptsAfterBump: number): number {
  const i = Math.min(
    Math.max(attemptsAfterBump - 1, 0),
    TRANSIENT_BACKOFF_MS.length - 1,
  );
  return TRANSIENT_BACKOFF_MS[i] ?? TRANSIENT_BACKOFF_MS[0]!;
}

export function enqueueScan(args: {
  eventId: string;
  ticketCode: string;
  clientKey: string;
}) {
  return enqueueScanRow(args);
}

/**
 * FR-010 — a queued admit stops being retried. Persist it, report it, and only
 * THEN let the queue row go.
 *
 * ## What used to happen instead
 *
 * `removeQueuedScan(item.queueId); continue;` — a silent DELETE. The person was
 * admitted at the door (they saw the green state, the local counter moved, the
 * undo strip showed the row), and the server has no record of it. Nobody finds
 * out: not the operator on shift, not the organizer reconciling the door count,
 * not us. The old comment argued this was "consistent with how the queue has
 * always behaved at the gate", which is true and is the problem.
 *
 * ## Reporting
 *
 * Per CLAUDE.md this is a deliberate swallow, so it gains a REPORT, never a
 * bare warn. Tags and counts only — the ticket code is a bearer credential
 * (NFR-005) and never reaches Sentry from here. (The transport layer used to
 * leak it via query-string URLs on fetch failures; `lib/sentry-scrub.ts` closes
 * that separately. Do not add a second leak.)
 */
function dropTerminally(
  item: QueuedScan,
  reason: DroppedScanReason,
  lastError: string | null,
): void {
  try {
    recordDroppedScan({
      queueId: item.queueId,
      eventId: item.eventId,
      ticketCode: item.ticketCode,
      // The ORIGINAL key — the whole point of persisting the row is that a
      // retry can replay idempotently.
      clientKey: item.clientKey,
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      reason,
      lastError,
    });
  } catch (err) {
    // The local write failing must not wedge the queue behind a doomed row —
    // but it MUST be loud, because it means a drop just became invisible again.
    reportScanIssue(err, {
      branch: "queue_terminal_drop_persist_failed",
      eventId: item.eventId,
      tags: { dropReason: reason, queueId: item.queueId },
      extra: { attempts: item.attempts },
    });
    removeQueuedScan(item.queueId);
  }

  reportScanIssue(lastError ? new Error(lastError) : null, {
    branch: "queue_terminal_drop",
    eventId: item.eventId,
    tags: {
      dropReason: reason,
      /**
       * FR-010's acceptance line says "event/ticket tags". The ticket code is a
       * BEARER CREDENTIAL (NFR-005) and never goes to Sentry — `queueId` is the
       * non-credential correlator that joins this issue to the local
       * `dropped_scans` row and to the `clientKey` the server saw, which is
       * every join that wording was reaching for. The spec's acceptance text
       * was updated to match. Do not "fix" this by adding the code.
       */
      queueId: item.queueId,
    },
    extra: {
      attempts: item.attempts,
      // How long this admit sat unrecorded. A drop 40 minutes after the door
      // reads very differently from one 8 seconds after it.
      queuedForMs: Date.now() - item.enqueuedAt,
      reason,
    },
  });
}

/**
 * Drains the local scan queue against the server whenever the device is
 * online. Runs on app boot, periodically, and on network state recovery.
 *
 * Failure handling: a permanent rejection on one row never blocks later
 * rows; a transient failure is parked behind exponential backoff but
 * other due items keep flushing. Only a hard network failure aborts the
 * current pass — the next interval picks back up. A send with no answer after
 * {@link SEND_TIMEOUT_MS} is aborted and treated as transient: the row is
 * parked, and the pass (and every later one) carries on.
 *
 * `userId` is who the queue is draining for. A pass stops, without another
 * send or local write, once that person is no longer the one signed in.
 */
export function useScanQueue(enabled: boolean, userId: string | null = null) {
  const network = useNetworkState();
  /**
   * The plain tRPC client, not `useMutation()`.
   *
   * `useMutation()` returns a NEW object on every render, and every
   * `mutateAsync` call re-renders this hook. With that object in `flush`'s
   * dependency list, `flush` was a new function on each render, so both
   * effect below re-ran on each render and each started another pass over
   * the same rows: send → re-render → two more sends → re-render. Against an
   * unreachable API that never stopped, and "Maximum update depth exceeded"
   * blanked the app (10-13, on the door phone; `use-scan-queue-render-loop.test.ts`).
   *
   * The client is one object for the life of the provider, a send through it
   * re-renders nothing, and it takes an `AbortSignal` per call, which a
   * mutation hook does not. It also leaves out the query client's
   * `mutations.retry: 1`: each attempt is one request, and the retrying is
   * this queue's own attempts and backoff.
   */
  const { client } = trpc.useUtils();
  /**
   * Who the queue is draining for, as of the latest render. Assigned during
   * render, not in an effect: a pass that wakes from a send in the same commit
   * that signed the person out must read THIS render's answer.
   */
  const ownerRef = useRef({ enabled, userId });
  ownerRef.current = { enabled, userId };
  /**
   * The pass in progress, or null. One pass at a time: the mount flush, the
   * interval and the back-online flush can all land together, and two passes
   * reading the same due rows send each of them twice. A pass that is skipped
   * loses nothing: the rows are still in the queue for the next interval.
   */
  const passRef = useRef<object | null>(null);
  const [queueDepth, setQueueDepth] = useState(0);
  /** FR-010 — rows that will never reach the server without a manual retry. */
  const [failedCount, setFailedCount] = useState(0);

  /**
   * GLOBAL on purpose, and deliberately different from the scan screen's strip.
   *
   * These two counters feed Home's banner, which routes to Settings' failed-sync
   * list — and that list is global, because a drop from last night's show is
   * still an unrecorded admission somebody has to reconcile. The scan screen's
   * strip is the opposite case: it sits beside `scanned / total` for ONE event
   * and its chip means "actionable at this door, tonight", so it scopes to
   * `eventId` (`unified-scan-screen.tsx`). Do not "unify" them.
   */
  const refreshDepth = useCallback(() => {
    setQueueDepth(countQueuedScans());
    setFailedCount(countDroppedScans());
  }, []);

  // Signed out, or someone else signed in: the pass in progress is no longer
  // the queue's. It stops at its next check, and the next person's first
  // flush does not wait behind it.
  useEffect(() => {
    return () => {
      passRef.current = null;
    };
  }, [enabled, userId]);

  const flush = useCallback(async () => {
    if (!enabled) return;
    if (network !== "online") return;
    if (passRef.current) return;

    const now = Date.now();
    const items = listDueQueuedScans(now);
    if (items.length === 0) {
      refreshDepth();
      return;
    }

    const pass = {};
    passRef.current = pass;
    /** Still this pass's turn, for the person it started for. */
    const stillOurs = () =>
      passRef.current === pass &&
      ownerRef.current.enabled &&
      ownerRef.current.userId === userId;
    let timeoutsInARow = 0;
    try {
      for (const item of items) {
        // `items` was read once, before the first send. Each row is checked
        // again here and after its send, before anything is sent or written:
        //   - the person signed out or changed: stop. Nothing more goes out
        //     under whoever's sign-in is current, and nothing is written into
        //     their database;
        //   - the row is gone (the sign-out purge ran, or the admit was
        //     undone): skip it. Writing a drop for it would put its ticket
        //     code back on the device after the purge.
        if (!stillOurs()) return;
        if (!isScanQueued(item.queueId)) continue;
        if (item.attempts >= MAX_ATTEMPTS) {
          // FR-010: was a silent DELETE. See `dropTerminally`.
          dropTerminally(item, "max_attempts", item.lastError);
          continue;
        }
        let sent = false;
        try {
          await withTimeout(
            (signal) =>
              client.tickets.scanTicket.mutate(
                {
                  eventId: item.eventId,
                  ticketCode: item.ticketCode,
                  clientKey: item.clientKey,
                },
                { signal },
              ),
            SEND_TIMEOUT_MS,
          );
          sent = true;
        } catch (err) {
          if (!stillOurs()) return;
          if (!isScanQueued(item.queueId)) continue;
          const message = err instanceof Error ? err.message : "scan_failed";
          const timedOut = isRequestTimeout(err);
          timeoutsInARow = timedOut ? timeoutsInARow + 1 : 0;
          // One send with no answer in time says nothing about the next row:
          // park this one and keep going, as for a 5xx. A second in a row
          // says the connection is not answering: end the pass, as for a
          // network failure.
          const kind = !timedOut
            ? classifyScanError(err)
            : timeoutsInARow >= TIMEOUTS_THAT_END_A_PASS
              ? "network"
              : "transient";
          if (kind === "permanent") {
            // Hard reject from the server — never going to succeed on its own.
            // Still dropped so the next scan in line isn't stuck behind a doomed
            // row, but NO LONGER silently: this is the same "admitted at the
            // door, unrecorded on the server" outcome as an attempts
            // exhaustion, and a rejection classified as permanent can be a
            // misclassification (an expired session, a role change mid-shift).
            // Making it visible + retryable is strictly better than deleting it.
            dropTerminally(item, "permanent_error", message);
            continue;
          }
          if (kind === "network") {
            // Connection to the server is down. Don't burn the rest of
            // the queue on guaranteed-to-fail attempts; let the next
            // interval / online transition retry from the top. A pass
            // ended by timeouts parks its row with a backoff: on half-open
            // wifi the next pass would time out on it again, and without
            // one each pass would spend an attempt.
            bumpQueuedScan(
              item.queueId,
              message,
              timedOut ? Date.now() + backoffDelayMs(item.attempts + 1) : Date.now(),
            );
            break;
          }
          // Transient server error — back this one row off, keep draining
          // others. nextAttemptAt is computed from post-bump count.
          bumpQueuedScan(
            item.queueId,
            message,
            Date.now() + backoffDelayMs(item.attempts + 1),
          );
        }
        if (sent) {
          // Outside the send's `try`: a local write that fails here is not a
          // refusal of the admit, and must not be classified as one.
          timeoutsInARow = 0;
          if (!stillOurs()) return;
          removeQueuedScan(item.queueId);
        }
      }
    } finally {
      // Only this pass's own claim: an abandoned pass must not release the
      // one that started after it.
      if (passRef.current === pass) passRef.current = null;
    }
    refreshDepth();
  }, [enabled, network, client, refreshDepth, userId]);

  // Flush now and then periodically. `flush` changes with `network`, so this
  // also flushes at once on the transition back to online. A second effect
  // that flushed on `network` sent every due row twice at mount.
  useEffect(() => {
    if (!enabled) return;
    refreshDepth();
    // A pass that throws (a local write failing) would otherwise be an
    // unhandled rejection that nobody sees.
    const run = () => {
      flush().catch((err: unknown) => {
        reportScanIssue(err, { branch: "queue_flush_failed", eventId: "none" });
      });
    };
    run();
    const id = setInterval(run, FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, flush, refreshDepth]);

  return { queueDepth, failedCount, flush, refreshDepth };
}
