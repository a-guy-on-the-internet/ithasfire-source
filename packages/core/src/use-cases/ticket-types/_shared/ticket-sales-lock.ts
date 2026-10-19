import type { EventsRepo } from "@th/ports/repos/events";

/**
 * The "tickets have been sold" lock on an event's ticket types.
 *
 * ONE measure, read by BOTH sides of the lock:
 *
 * - the admin ticket editor, which locks itself when `getEventForEdit`'s
 *   `ticketsSold` is above zero (that use case reads the count through
 *   {@link countEventTicketsSold}), and
 * - `upsertTicketType` / `updateTicketType`, which refuse the same edits with
 *   `TICKET_TYPE_LOCKED_BY_SALES` (via {@link eventHasTicketSales}).
 *
 * Keeping one function means the server can never refuse an edit the editor
 * offers, or allow one it hides. The count is `events.getPopularityStats`:
 * SUM(qty) of `active` `ticket` order items on SUCCEEDED orders, across the
 * WHOLE EVENT. Comp orders are SUCCEEDED `ticket` lines (`createCompOrder`),
 * so a comp counts as a sale here.
 *
 * This is deliberately NOT `tickets.countIssuedForTicketType`, the per-type
 * count `deleteTicketType` uses for `TICKET_TYPE_HAS_SALES`.
 *
 * Capacity is outside the lock on the server: `updateTicketType` still accepts
 * a capacity-only edit after sales (the owner is reconsidering capacity rules).
 */
export type TicketSalesLockRepos = {
  events: Pick<EventsRepo, "getPopularityStats">;
};

export async function countEventTicketsSold(
  repos: TicketSalesLockRepos,
  eventId: string,
): Promise<number> {
  const [stats] = await repos.events.getPopularityStats([eventId]);
  return stats?.ticketsSold ?? 0;
}

export async function eventHasTicketSales(
  repos: TicketSalesLockRepos,
  eventId: string,
): Promise<boolean> {
  return (await countEventTicketsSold(repos, eventId)) > 0;
}
