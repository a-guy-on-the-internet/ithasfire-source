import { useCallback } from "react";

import { useNetworkState } from "../features/network/use-network-state";
import {
  markRecentScanUndone,
  markTicketValidLocally,
  undoQueuedScanLocally,
} from "./local-db";
import { trpc } from "./../trpc";

/**
 * FR-006 — undoing one admission, in one place.
 *
 * Extracted from `recent-scans-strip.tsx` when FR-004 gave the express dwell a
 * rail `UNDO` (design §5): at 1.2s an operator cannot realistically read the
 * strip, find the right row and hit it, so the rail carries its own undo — and
 * a SECOND implementation of "which of the two undo paths applies?" is exactly
 * the kind of duplication that ships one of them wrong. The strip still owns its
 * countdown, its per-row notices and its 30s window; this owns the decision and
 * the writes.
 *
 * ## Two paths, and the difference matters
 *
 * A scan still sitting in `scan_queue` was never seen by the server. Undoing it
 * is purely LOCAL — cancel the queue row(s), revert the local status, mark the
 * row undone, all in one transaction (`undoQueuedScanLocally`). Firing
 * `tickets.revertTicketScan` for it would ask the server to un-do something it
 * never did, and offline it would just fail with a generic error buzz.
 *
 * A server-acknowledged scan is the opposite: only the server can revert it, so
 * offline the caller must REFUSE with an explanation rather than fail with an
 * error haptic. An offline-queued *revert* racing a queued *admit* is a genuine
 * correctness trap and is deliberately out of scope (FR-006b).
 *
 * The local cancel is attempted UNCONDITIONALLY and first: it writes nothing and
 * returns `requires_server` when there is no queue row, so it is safe to try
 * without trusting the row's cached `queueId` (which is provenance, not truth).
 */

export type UndoTarget = {
  scanId: string;
  eventId: string;
  ticketCode: string;
  /** Null for rows a bulk admit or an older build wrote. */
  ticketId: string | null;
  /** Cached pointer from `recent_scans`. Provenance only — see `local-db`. */
  queueId: string | null;
};

export type UndoOutcome =
  /** Reverted. The caller drops the row and fires the success cue. */
  | { kind: "undone" }
  /**
   * Could not be reverted, with an operator-readable reason.
   *
   * This is NOT an error to swallow: the branch it replaced was a bare
   * `return`, which reads to an operator as "it worked" while the server still
   * holds the admission.
   */
  | { kind: "refused"; message: string };

export function useScanUndo() {
  const network = useNetworkState();
  const revertMutation = trpc.tickets.revertTicketScan.useMutation();

  const undoScan = useCallback(
    async (scan: UndoTarget): Promise<UndoOutcome> => {
      const local = undoQueuedScanLocally({
        scanId: scan.scanId,
        eventId: scan.eventId,
        ticketCode: scan.ticketCode,
        queueId: scan.queueId,
      });
      if (local.kind === "cancelled_queued") return { kind: "undone" };

      // Server-acknowledged from here on.
      if (network === "offline") {
        return {
          kind: "refused",
          message:
            "This scan already reached the server. Reconnect to undo it.",
        };
      }
      if (!scan.ticketId) {
        return {
          kind: "refused",
          message:
            "This scan already reached the server and can't be undone from here. Find the ticket in Search.",
        };
      }

      try {
        await revertMutation.mutateAsync({ ticketId: scan.ticketId });
        markRecentScanUndone(scan.scanId);
        // Pass the row's TRUE casing: `markTicketValidLocally` collates NOCASE
        // now, but call sites should still not depend on that.
        markTicketValidLocally(scan.ticketCode);
        return { kind: "undone" };
      } catch (err) {
        return {
          kind: "refused",
          message:
            err instanceof Error ? err.message : "Undo failed. Try again.",
        };
      }
    },
    [network, revertMutation],
  );

  return { undoScan, pending: revertMutation.isPending };
}
