import { useCallback, useEffect, useState } from "react";

import { useNetworkState } from "../features/network/use-network-state";
import { trpc } from "../trpc";
import {
  bumpQueuedScan,
  countDroppedScans,
  countQueuedScans,
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

const FLUSH_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 8;

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
 * current pass — the next interval picks back up.
 */
export function useScanQueue(enabled: boolean) {
  const network = useNetworkState();
  const scanMutation = trpc.tickets.scanTicket.useMutation();
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

  const flush = useCallback(async () => {
    if (!enabled) return;
    if (network !== "online") return;

    const now = Date.now();
    const items = listDueQueuedScans(now);
    if (items.length === 0) {
      refreshDepth();
      return;
    }

    for (const item of items) {
      if (item.attempts >= MAX_ATTEMPTS) {
        // FR-010: was a silent DELETE. See `dropTerminally`.
        dropTerminally(item, "max_attempts", item.lastError);
        continue;
      }
      try {
        await scanMutation.mutateAsync({
          eventId: item.eventId,
          ticketCode: item.ticketCode,
          clientKey: item.clientKey,
        });
        removeQueuedScan(item.queueId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "scan_failed";
        const kind = classifyScanError(err);
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
          // interval / online transition retry from the top.
          bumpQueuedScan(item.queueId, message, Date.now());
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
    }
    refreshDepth();
  }, [enabled, network, scanMutation, refreshDepth]);

  // Periodic flush.
  useEffect(() => {
    if (!enabled) return;
    refreshDepth();
    void flush();
    const id = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, flush, refreshDepth]);

  // Flush immediately on transition back to online.
  useEffect(() => {
    if (network === "online") void flush();
  }, [network, flush]);

  return { queueDepth, failedCount, flush, refreshDepth };
}
