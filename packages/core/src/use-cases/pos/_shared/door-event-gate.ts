import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

/**
 * The door sells PUBLISHED events only (owner ruling 2026-10-07): not a draft,
 * not a cancelled event, not a completed or archived one. One rule for every
 * door entry point — the cash sale and comp (`recordCashSale`), the card sale
 * (`startPosSale`), the paid tax lookup before either
 * (`assertCanSellBeforeTaxLookup`), the reader dispatch
 * (`processPosSaleOnReader`) — and the till's listing (`listSellableItems`),
 * which shows nothing for an event the door cannot sell.
 *
 * Refuses EVENT_NOT_PUBLISHED (`meta.status`), the code checkout uses for
 * the same condition.
 */
export function assertDoorSellsEvent(event: { status: string }): void {
  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_PUBLISHED", {
      message: "door_sells_published_events_only",
      meta: { status: event.status },
    });
  }
}

/**
 * Share-lock the event row for the rest of a sale's transaction, BEFORE the
 * sale reads it. `cancelEvent` takes the same row FOR UPDATE before it flips
 * the status, so the two serialize: a sale that read PUBLISHED commits before
 * the cancellation can, and the cancellation's door phase then finds its
 * order; a sale that starts after the cancellation committed reads CANCELLED
 * and is refused. Without it a sale could read PUBLISHED, the cancellation
 * commit and settle the door, and the sale commit after both — a live order
 * on a cancelled event that nothing settles.
 *
 * Taken first in the transaction. Sales take no place advisory lock (their
 * tax stamp is written after commit), so this cannot invert the
 * `lockLocationsAtPlace` → `lockRows` order the events repo documents.
 */
export async function lockDoorEvent(
  tx: Pick<TxRepos, "events">,
  eventId: string,
): Promise<void> {
  await tx.events.lockRows({ ids: [eventId], mode: "share" });
}
