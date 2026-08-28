/**
 * FR-010 — replaying terminal drops, as a pure(-ish) function.
 *
 * PURE by dependency injection: no `expo-sqlite`, no tRPC, no React. That split
 * exists for one assertion — **the retry replays with the row's ORIGINAL
 * `clientKey`** — which is FR-010's literal acceptance criterion and is
 * invisible to any test that cannot see the arguments the mutation receives.
 *
 * ## Why the original key is not a detail
 *
 * The server's idempotency key is `(eventId, ticketCode, clientKey)`
 * (`packages/core/src/use-cases/tickets/scan-ticket.ts`). A drop row exists
 * precisely because we do NOT know whether the server recorded the admit — the
 * queue gave up mid-uncertainty. Replaying with the original key means:
 *
 *   - the server DID record it → REPLAY, no second admission, row cleared;
 *   - the server never saw it → ACCEPTED, the admission is finally recorded.
 *
 * Minting a fresh key (which every other call site in this app does, and which
 * is therefore the obvious thing to write here) collapses that distinction and
 * turns a visibility feature into a double-admit generator.
 */

/** Structural mirror of `local-db`'s `DroppedScan`, so this module stays pure. */
export type RetryableDrop = {
  dropId: string;
  /**
   * The `scan_queue` row this came from. A non-credential correlator — it is
   * what reaches Sentry in place of the ticket code (NFR-005).
   */
  queueId: string | null;
  eventId: string;
  ticketCode: string;
  clientKey: string;
  attempts: number;
  reason: string;
};

export type RetryDroppedScansOutcome = {
  attempted: number;
  succeeded: number;
  /** Rows still on the device after the pass. */
  remaining: number;
};

export type RetryDroppedScansDeps = {
  rows: readonly RetryableDrop[];
  /** The EXISTING `tickets.scanTicket` mutation. No new procedure (NFR-005). */
  scan: (args: {
    eventId: string;
    ticketCode: string;
    clientKey: string;
  }) => Promise<unknown>;
  /** Clear one row. Called per success, never in bulk. */
  remove: (dropId: string) => void;
  /** Report a failed replay. Never throws (see `report.ts`). */
  report: (error: unknown, row: RetryableDrop) => void;
  /**
   * Report a LOCAL failure to clear a row the server DID accept. Optional so
   * existing callers keep compiling; see the `remove` branch below for why it
   * is a separate channel from {@link RetryDroppedScansDeps.report}.
   */
  reportRemoveFailed?: (error: unknown, row: RetryableDrop) => void;
};

/**
 * Replay every dropped scan, serially.
 *
 * Serial and not `Promise.all`: these are admissions, and a burst of them at a
 * door on venue wifi is how a retry becomes a second outage. The row count is
 * small by construction.
 *
 * Rows clear INDIVIDUALLY as they succeed — one failure must not strand the
 * nine that worked, and a row that fails stays visible and retryable rather
 * than disappearing with a reassuring toast.
 */
export async function retryDroppedScans(
  deps: RetryDroppedScansDeps,
): Promise<RetryDroppedScansOutcome> {
  let succeeded = 0;

  for (const row of deps.rows) {
    try {
      await deps.scan({
        eventId: row.eventId,
        ticketCode: row.ticketCode,
        // ⚠️ THE acceptance criterion. Do not regenerate.
        clientKey: row.clientKey,
      });
    } catch (error) {
      deps.report(error, row);
      continue;
    }

    /**
     * The server accepted the replay. `remove` is a LOCAL SQLite delete, and it
     * sits outside the try above on purpose: inside it, a local write failure
     * after a successful server replay was reported as
     * `dropped_scan_retry_failed` with `errorKind: "network"` — a Sentry tag
     * that says the network failed when the network worked and the disk did
     * not. The behaviour was always safe (the row stays, the next retry replays
     * the same key idempotently); the record was a lie, and the next person
     * reading it would have gone looking at the wrong layer.
     */
    try {
      deps.remove(row.dropId);
    } catch (error) {
      deps.reportRemoveFailed?.(error, row);
    }
    succeeded += 1;
  }

  return {
    attempted: deps.rows.length,
    succeeded,
    remaining: deps.rows.length - succeeded,
  };
}
