import type { TicketsRepo } from "@th/ports/repos/tickets";

import { heldSinceFor } from "./assert-ticket-type-capacity";

/**
 * All this loader needs to know about a tier. Structural rather than
 * `TicketTypeRecord` so callers can pass the lighter `EventTicketTypeSummary`
 * that `events.listTicketTypes` already returns, without a lookup round-trip.
 */
export type AvailabilityBearingTicketType = { id: string; capacity: number };

/**
 * The narrowest handle this needs. NOT `Repos`, and NOT a transaction handle —
 * this read takes no lock and belongs OUTSIDE `repos.tx()`.
 */
export type AvailabilityCountingRepos = {
  tickets: Pick<TicketsRepo, "countCapacityUsageForTicketTypes">;
};

/** What a buyer-facing listing surface needs to know about one tier's stock. */
export type TicketTypeAvailability = {
  /**
   * `capacity - issued - held`, clamped at 0. The SAME basis
   * `assertTicketTypeCapacity` refuses on, so the number shown and the number
   * enforced cannot disagree.
   */
  remainingCapacity: number;
  /** `remainingCapacity <= 0`. The one truthful "do not offer this" signal. */
  soldOut: boolean;
};

/**
 * READ-side availability for a set of tiers — the display twin of
 * `assertTicketTypeCapacity`.
 *
 * WHY THIS EXISTS. `TicketType.capacity` is the AUTHORED column and no write
 * path decrements it, so the clients' long-standing `capacity <= 0` sold-out
 * test was essentially never true: a fully-sold tier still rendered a live
 * quantity stepper, and the buyer discovered it was gone only when the
 * pre-charge gate refused them with the form already filled in. Correct, and a
 * poor experience. This computes the same arithmetic that gate does, so the
 * badge and the refusal agree.
 *
 * ── HOLDS ARE COUNTED. This is the load-bearing product decision. ────────────
 *
 * `remaining` here is `capacity - issued - HELD`, matching the pre-charge gate
 * exactly, and NOT the issued-only basis the POS listing uses
 * (`list-sellable-items.ts`). The two surfaces genuinely want different
 * answers:
 *
 *   - A DOOR operator can see the room, can retry in ten seconds, and is
 *     actively harmed by "sold out" on a half-empty venue because of a tap in
 *     progress. Issued-only is the truer "what could I sell" view there, and
 *     that file says so.
 *   - A REMOTE buyer can do none of that. For them, any basis WIDER than the
 *     gate's re-opens the exact bug this signal exists to close, just in a
 *     narrower window: the page offers the tier, they fill in the form, and
 *     checkout answers TICKET_TYPE_TEMPORARILY_HELD. Held units are money in
 *     flight; advertising them as available is over-promising inventory that
 *     is, right now, somebody else's.
 *
 * The cost of this choice is real and bounded: an abandoned cart hides its
 * units for at most `CAPACITY_HELD_WINDOW_SECONDS` from when it was opened
 * (cart TTL + 2 reaper periods = 80 minutes; the same `heldSince` checkout
 * counts with), and during those minutes a tier whose last units are held
 * reads "Sold out" rather than "held by another buyer". That over-states permanence, but it
 * does NOT over-state buyability, and it is the same answer checkout gives.
 * Fail closed is the house rule on money paths; a badge that promises stock
 * the next click refuses is the failure mode we are here to remove.
 *
 * NOT A GATE. This is a lock-free snapshot for display only. Nothing may write
 * on the strength of it — enforcement stays with `assertTicketTypeCapacity`
 * inside `repos.tx()`, where the advisory lock makes the count decisive.
 *
 * ONE round trip for all tiers, and ZERO when there are none.
 */
export async function loadTicketTypeAvailability(
  repos: AvailabilityCountingRepos,
  input: {
    ticketTypes: readonly AvailabilityBearingTicketType[];
    now: Date;
  },
): Promise<Map<string, TicketTypeAvailability>> {
  const byId = new Map<string, TicketTypeAvailability>();
  if (input.ticketTypes.length === 0) return byId;

  const usage = await repos.tickets.countCapacityUsageForTicketTypes({
    ticketTypeIds: input.ticketTypes.map((ticketType) => ticketType.id),
    // Same derivation the pre-charge gate uses, so the badge and the gate
    // agree; see `heldSinceFor`.
    heldSince: heldSinceFor(input.now),
  });

  const usageById = new Map(usage.map((row) => [row.ticketTypeId, row]));

  for (const ticketType of input.ticketTypes) {
    // A missing row is "no tickets, no holds" — the repo contract zero-fills,
    // and this mirrors it so a hand-written fake that omits a tier cannot make
    // a fully-available tier read as sold out.
    const row = usageById.get(ticketType.id);
    const remainingCapacity = Math.max(
      0,
      ticketType.capacity - (row?.issued ?? 0) - (row?.held ?? 0),
    );
    byId.set(ticketType.id, {
      remainingCapacity,
      soldOut: remainingCapacity <= 0,
    });
  }

  return byId;
}
