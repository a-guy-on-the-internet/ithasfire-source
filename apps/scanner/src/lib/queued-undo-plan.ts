/**
 * FR-006a — which `scan_queue` rows a local undo must cancel.
 *
 * PURE, and extracted from `local-db.ts` for exactly one reason: that module
 * imports `expo-sqlite`, so nothing inside it can be asserted in node. The
 * headline behaviour of FR-006a — "an admit the server never saw is cancelled
 * with no network" — therefore shipped with zero automated coverage. This is
 * the decision half; `undoQueuedScanLocally` is the (transactional) I/O half.
 *
 * ## Why it cancels ALL matching rows, not the linked one
 *
 * One ticket code can hold TWO queue rows — an individual admit and a bulk
 * "admit all N from this order" for the same person. Cancelling only the row
 * linked to the recent-scan being undone leaves the survivor to re-admit the
 * ticket on the next flush, minutes later: a successful-looking undo that
 * silently un-does itself, which is worse than an undo that refuses.
 *
 * "Undo this admission" means there is no pending admission left for that
 * code on this event. Duplicate rows are idempotent REPLAYs of the same
 * admission, so cancelling all of them removes exactly one admission.
 *
 * ## Why an empty candidate set writes NOTHING
 *
 * Absence of a queue row means the server has it (or is about to). Reverting
 * that locally would be a lie the next manifest sync overwrites — so the plan
 * says `requires_server` and the caller must go online. The caller must not
 * mark the scan undone, must not revert the ticket status, must not touch a
 * thing.
 */

export type QueuedUndoRow = {
  queueId: string;
  /** Epoch ms. Only used to make the cancel order deterministic (FIFO). */
  enqueuedAt: number;
};

export type QueuedUndoPlan =
  /** Cancel these queue rows, then revert locally. No network needed. */
  | { kind: "cancel"; queueIds: string[] }
  /** The scan is (or may be) on the server. Write nothing. */
  | { kind: "requires_server" };

export function planQueuedUndo(args: {
  /**
   * Every `scan_queue` row matching this recent scan's (event, code). The
   * caller supplies them; this module never touches storage.
   */
  rows: readonly QueuedUndoRow[];
}): QueuedUndoPlan {
  const seen = new Set<string>();
  const queueIds = [...args.rows]
    // FIFO matches the flusher's own order, so the rows we cancel are the
    // rows it would have sent next.
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    .map((r) => r.queueId)
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  if (queueIds.length === 0) return { kind: "requires_server" };
  return { kind: "cancel", queueIds };
}
