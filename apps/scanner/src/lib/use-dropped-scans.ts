import { useCallback, useEffect, useState } from "react";

import { trpc } from "../trpc";
import {
  retryDroppedScans,
  type RetryDroppedScansOutcome,
} from "./dropped-scan-retry";
import {
  listDroppedScans,
  removeDroppedScan,
  type DroppedScan,
} from "./local-db";
import { reportScanIssue } from "./report";
import { classifyScanError } from "./scan-error-classification";

/**
 * FR-010 — the failed-sync list, its retry, and its dismissal.
 *
 * ## Retry-ALL, not per-row
 *
 * The design's open question leaned retry-all and this follows it, for a reason
 * beyond "failed rows are rare": per-row retry asks a door operator to triage a
 * queue, and the only correct triage is "all of them". A row is here precisely
 * because it is not recoverable automatically, so there is no row an operator
 * would rationally choose to leave behind. One button, one decision.
 *
 * (Rows still clear INDIVIDUALLY as they succeed — a retry-all where one row
 * fails must not strand the nine that worked.)
 *
 * ## But a row must also be CLEARABLE without a success
 *
 * `removeDroppedScan` used to be reachable only through a successful replay, so
 * a row the server rejected with `BAD_REQUEST` / `FORBIDDEN` re-failed on every
 * RETRY ALL, forever. That row sat behind a `⚠ N FAILED` chip which outranks
 * every other chip in the strip's collapse ladder — because it means "someone
 * got in and the server does not know". A chip that can never go back to zero
 * destroys the meaning of the one signal FR-010 exists to create: after the
 * first permanent rejection an operator learns to ignore it, and the next real
 * drop is invisible again.
 *
 * So {@link useDroppedScans} exposes {@link DroppedScansApi.dismiss}. It is
 * deliberately NOT a silent delete: dismissing writes a Sentry event, because
 * the row is the only record that an admission never reached the server and
 * throwing it away without a trace is the original bug wearing a button.
 *
 * ## Idempotency is the whole acceptance criterion
 *
 * Retry replays `tickets.scanTicket` with the row's **original `clientKey`**.
 * The server's idempotency key is (eventId, ticketCode, clientKey), so replaying
 * an admit the server DID record collapses to a REPLAY instead of a second
 * admission. Minting a fresh key here — the obvious thing to do, since every
 * other call site generates one — would make the retry a distinct admission and
 * turn a visibility feature into a double-admit generator.
 *
 * ## No new procedures, no widened authz (NFR-005)
 *
 * This is the existing `tickets.scanTicket`, gated by ORG_SCAN_ROLES exactly as
 * the live scan path is.
 *
 * ## What reaches Sentry (NFR-005 vs FR-010's acceptance text)
 *
 * FR-010's acceptance line says "event/ticket tags". The implementation tags
 * the EVENT and the `queueId`, and deliberately omits the ticket code: a code
 * is a bearer credential, and `lib/sentry-scrub.ts` exists precisely to strip
 * them back out of the transport layer's own URLs. `queueId` is a non-credential
 * correlator that joins a Sentry issue to a local row and to the `clientKey`
 * the server saw, which is every join the acceptance criterion was reaching for.
 * Do not "fix" this by adding the code back.
 */

export type RetryAllOutcome = RetryDroppedScansOutcome;

export type DroppedScansApi = {
  rows: DroppedScan[];
  count: number;
  retrying: boolean;
  refresh: () => void;
  retryAll: () => Promise<RetryAllOutcome>;
  /** Clear ONE row the server will never accept. Reports before deleting. */
  dismiss: (row: DroppedScan) => void;
};

export function useDroppedScans(eventId?: string | null): DroppedScansApi {
  const [rows, setRows] = useState<DroppedScan[]>([]);
  const [retrying, setRetrying] = useState(false);
  const scanMutation = trpc.tickets.scanTicket.useMutation();

  const refresh = useCallback(() => {
    try {
      setRows(listDroppedScans(eventId ?? undefined));
    } catch (err) {
      // NFR-006: this was a bare `catch { setRows([]) }`. `FailedSyncPanel`
      // returns null on an empty list, so a SQLite read failure made the whole
      // failed-sync panel VANISH — silently, with no report — which is the
      // exact invisible-loss failure mode FR-010 exists to end. The degrade
      // stays (a local read failure must not blank a settings screen; the
      // strip's count is the redundant signal) but it is no longer silent.
      reportScanIssue(err, {
        branch: "dropped_scans_read_failed",
        eventId: eventId ?? "all",
      });
      setRows([]);
    }
  }, [eventId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const dismiss = useCallback(
    (row: DroppedScan) => {
      // Report FIRST. If the delete throws we have still recorded that an
      // operator decided this admission would never be reconciled.
      reportScanIssue(
        row.lastError ? new Error(row.lastError) : null,
        {
          branch: "dropped_scan_dismissed",
          eventId: row.eventId,
          tags: {
            dropReason: row.reason,
            queueId: row.queueId ?? "unknown",
          },
          extra: {
            attempts: row.attempts,
            // How long this admission sat unreconciled before someone gave up
            // on it. A dismissal 30 seconds after the door and one the next
            // morning are different events.
            unreconciledForMs: Date.now() - row.enqueuedAt,
          },
        },
      );
      try {
        removeDroppedScan(row.dropId);
      } catch (err) {
        reportScanIssue(err, {
          branch: "dropped_scan_dismiss_failed",
          eventId: row.eventId,
          // Same `?? "unknown"` as the report above: `queueId` is nullable and
          // the tag is the correlator that joins this issue to the local row,
          // so it must always be present — an absent tag and a null one are
          // indistinguishable once in Sentry.
          tags: { queueId: row.queueId ?? "unknown" },
        });
      }
      refresh();
    },
    [refresh],
  );

  const retryAll = useCallback(async (): Promise<RetryAllOutcome> => {
    let pending: DroppedScan[];
    try {
      pending = listDroppedScans(eventId ?? undefined);
    } catch (err) {
      // Same swallow, same rule. Reported rather than thrown into an onPress.
      reportScanIssue(err, {
        branch: "dropped_scans_read_failed",
        eventId: eventId ?? "all",
        tags: { phase: "retry_all" },
      });
      return { attempted: 0, succeeded: 0, remaining: 0 };
    }
    if (pending.length === 0) {
      refresh();
      return { attempted: 0, succeeded: 0, remaining: 0 };
    }

    setRetrying(true);
    try {
      // The loop, the serial ordering and the original-key replay live in
      // `dropped-scan-retry.ts` (pure, node-tested) — the acceptance criterion
      // is "replays with the ORIGINAL clientKey", and that is only assertable
      // where the mutation's arguments can be observed.
      return await retryDroppedScans({
        rows: pending,
        scan: (args) => scanMutation.mutateAsync(args),
        remove: removeDroppedScan,
        report: (error, row) => {
          reportScanIssue(error, {
            branch: "dropped_scan_retry_failed",
            eventId: row.eventId,
            tags: {
              dropReason: row.reason,
              errorKind: classifyScanError(error),
              // Non-credential correlator — see the module docblock.
              queueId: row.queueId ?? "unknown",
            },
            extra: { attempts: row.attempts },
          });
        },
        reportRemoveFailed: (error, row) => {
          // The SERVER accepted this replay; the local delete is what failed.
          // Separate branch and no `errorKind` — tagging it `network` (which
          // is what the shared `report` did when `remove` lived inside the same
          // try) points the next reader at the wrong layer entirely.
          reportScanIssue(error, {
            branch: "dropped_scan_clear_failed_after_replay",
            eventId: row.eventId,
            tags: { queueId: row.queueId ?? "unknown" },
          });
        },
      });
    } finally {
      setRetrying(false);
      refresh();
    }
  }, [eventId, refresh, scanMutation]);

  return { rows, count: rows.length, retrying, refresh, retryAll, dismiss };
}
