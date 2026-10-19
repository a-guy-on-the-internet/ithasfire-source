import { describe, expect, it, vi } from "vitest";

import { deleteTicketType } from "../delete-ticket-type";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_TYPE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-09T00:00:00.000Z");

// Human-owned DRAFT event: the owner path authorizes without an authz mock.
const event = {
  id: EVENT_ID,
  orgId: null,
  humanId: ACTOR_ID,
  status: "DRAFT",
} as EventRecord;

function makeContext(counts: { allRows: number; placesHeld: number }) {
  const tickets = {
    getTicketTypeById: vi.fn(async () => ({
      id: TICKET_TYPE_ID,
      eventId: EVENT_ID,
      name: "GA",
    })),
    // Every row, any status (the adapter's `ticket.count({ ticketTypeId })`).
    countIssuedForTicketType: vi.fn(async () => counts.allRows),
    // Only VALID | SCANNED | LISTED. The delete guard must NOT read this.
    countCapacityConsumingForTicketType: vi.fn(async () => counts.placesHeld),
    deleteTicketType: vi.fn(async () => undefined),
  };
  const txRepos = {
    tickets,
    events: { getById: vi.fn(async () => event) },
    audit: { log: vi.fn(async () => undefined) },
  } as unknown as TxRepos;
  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;
  return { deps: { repos, clock: { now: () => NOW } }, tickets };
}

const input = { actorHumanId: ACTOR_ID, ticketTypeId: TICKET_TYPE_ID };

describe("deleteTicketType — the sales guard counts history, not capacity", () => {
  // Refunds restock (spec 2026-10-09, FR-004). A refunded ticket gives its
  // place back, but its order and finance rows still point at the type, so
  // the type must not be deleted.
  it("refuses a type whose only tickets are refunded", async () => {
    const { deps, tickets } = makeContext({ allRows: 2, placesHeld: 0 });

    await expect(deleteTicketType(deps, input)).rejects.toMatchObject({
      code: "TICKET_TYPE_HAS_SALES",
    });
    expect(tickets.countIssuedForTicketType).toHaveBeenCalledWith(
      TICKET_TYPE_ID,
    );
    expect(tickets.countCapacityConsumingForTicketType).not.toHaveBeenCalled();
    expect(tickets.deleteTicketType).not.toHaveBeenCalled();
  });

  it("deletes a type that never issued a ticket", async () => {
    const { deps, tickets } = makeContext({ allRows: 0, placesHeld: 0 });

    await expect(deleteTicketType(deps, input)).resolves.toEqual({
      ticketTypeId: TICKET_TYPE_ID,
      deleted: true,
    });
    expect(tickets.deleteTicketType).toHaveBeenCalledWith(TICKET_TYPE_ID);
  });
});
