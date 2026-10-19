import { describe, expect, it, vi } from "vitest";

import { loadTicketTypeAvailability } from "../load-ticket-type-availability";
import { heldSinceFor } from "../assert-ticket-type-capacity";

const NOW = new Date("2026-08-17T18:00:00.000Z");

const TT_A = "aaaaaaa0-0000-4000-8000-000000000001";
const TT_B = "aaaaaaa0-0000-4000-8000-000000000002";

/**
 * A stand-in for the adapter's zero-fill contract: one entry per DISTINCT id,
 * never an omission.
 */
function reposWith(usage: Record<string, { issued?: number; held?: number }>) {
  const countCapacityUsageForTicketTypes = vi.fn(
    async ({ ticketTypeIds }: { ticketTypeIds: readonly string[] }) =>
      [...new Set(ticketTypeIds)].map((ticketTypeId) => ({
        ticketTypeId,
        issued: usage[ticketTypeId]?.issued ?? 0,
        held: usage[ticketTypeId]?.held ?? 0,
      })),
  );
  return { tickets: { countCapacityUsageForTicketTypes } };
}

describe("loadTicketTypeAvailability", () => {
  it("reports soldOut for a fully-issued tier", async () => {
    const repos = reposWith({ [TT_A]: { issued: 25 } });

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [{ id: TT_A, capacity: 25 }],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({ remainingCapacity: 0, soldOut: true });
  });

  it("reports the exact remaining count for a partially-sold tier", async () => {
    const repos = reposWith({ [TT_A]: { issued: 18 } });

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [{ id: TT_A, capacity: 50 }],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({ remainingCapacity: 32, soldOut: false });
  });

  // ── THE HOLDS DECISION ─────────────────────────────────────────────────────
  //
  // These two pin the product call: the buyer-facing surfaces use the SAME
  // basis as the pre-charge gate — `capacity - issued - HELD` — and NOT the
  // issued-only basis `pos/list-sellable-items.ts` deliberately uses. Under the
  // opposite choice the first would report 3 remaining and the second would not
  // be sold out, and in both cases checkout would still refuse the buyer with
  // TICKET_TYPE_TEMPORARILY_HELD after the form was filled in.

  it("subtracts other buyers' unexpired holds from the remaining count", async () => {
    const repos = reposWith({ [TT_A]: { issued: 5, held: 3 } });

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [{ id: TT_A, capacity: 10 }],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({ remainingCapacity: 2, soldOut: false });
  });

  it("reports soldOut when only HOLDS consume the last units", async () => {
    const repos = reposWith({ [TT_A]: { issued: 0, held: 4 } });

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [{ id: TT_A, capacity: 4 }],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({ remainingCapacity: 0, soldOut: true });
  });

  it("clamps at zero rather than reporting negative remaining capacity", async () => {
    const repos = reposWith({ [TT_A]: { issued: 12, held: 1 } });

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [{ id: TT_A, capacity: 10 }],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({ remainingCapacity: 0, soldOut: true });
  });

  it("treats a tier with zero rows as fully available", async () => {
    const repos = reposWith({});

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [{ id: TT_A, capacity: 120 }],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({
      remainingCapacity: 120,
      soldOut: false,
    });
  });

  // A repo (or fake) that omits a tier must not turn a fully-available tier
  // into a sold-out one — "absent" means "nothing issued, nothing held".
  it("treats an omitted row as zero usage, not as unknown", async () => {
    const repos = {
      tickets: {
        countCapacityUsageForTicketTypes: vi.fn(async () => [
          { ticketTypeId: TT_A, issued: 2, held: 0 },
        ]),
      },
    };

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [
        { id: TT_A, capacity: 10 },
        { id: TT_B, capacity: 10 },
      ],
      now: NOW,
    });

    expect(byId.get(TT_A)).toEqual({ remainingCapacity: 8, soldOut: false });
    expect(byId.get(TT_B)).toEqual({ remainingCapacity: 10, soldOut: false });
  });

  it("handles an empty tier list without touching the database", async () => {
    const repos = reposWith({});

    const byId = await loadTicketTypeAvailability(repos, {
      ticketTypes: [],
      now: NOW,
    });

    expect(byId.size).toBe(0);
    expect(
      repos.tickets.countCapacityUsageForTicketTypes,
    ).not.toHaveBeenCalled();
  });

  // The counter is asked for a WINDOW, not the caller's raw instant: `held`
  // keys on the order's own age, and `heldSinceFor` is the same derivation the
  // pre-charge gate uses. Asserting the derived value is what keeps the public
  // badge and the gate from answering differently.
  it("asks for every tier in ONE call, at the caller's instant", async () => {
    const repos = reposWith({});

    await loadTicketTypeAvailability(repos, {
      ticketTypes: [
        { id: TT_A, capacity: 10 },
        { id: TT_B, capacity: 20 },
      ],
      now: NOW,
    });

    expect(
      repos.tickets.countCapacityUsageForTicketTypes,
    ).toHaveBeenCalledTimes(1);
    expect(repos.tickets.countCapacityUsageForTicketTypes).toHaveBeenCalledWith(
      {
        ticketTypeIds: [TT_A, TT_B],
        heldSince: heldSinceFor(NOW),
      },
    );
  });
});
