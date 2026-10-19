import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { revertTicketScan } from "../revert-ticket-scan";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const SCANNED_AT = new Date("2026-10-09T20:00:00.000Z");
const NOW = new Date("2026-10-09T20:00:30.000Z"); // inside the 60 s undo window

function makeDeps(setStatusResult: boolean) {
  const tickets = {
    getById: vi.fn(async () => ({
      id: TICKET_ID,
      eventId: EVENT_ID,
      status: "SCANNED",
      scannedAt: SCANNED_AT,
    })),
    // The adapter's compare-and-swap answer: `false` = the ticket was no
    // longer SCANNED when the write ran.
    setStatus: vi.fn(async () => setStatusResult),
  };
  const txRepos = {
    tickets,
    events: { getById: vi.fn(async () => ({ id: EVENT_ID, orgId: ORG_ID })) },
    authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
  } as unknown as TxRepos;
  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;
  return { deps: { repos, clock: { now: () => NOW } }, tickets };
}

const input = { actorHumanId: ACTOR_ID, ticketId: TICKET_ID };

describe("revertTicketScan", () => {
  it("reverts SCANNED → VALID, guarded on SCANNED", async () => {
    const { deps, tickets } = makeDeps(true);

    await expect(revertTicketScan(deps, input)).resolves.toEqual({
      ticketId: TICKET_ID,
      reverted: true,
    });
    expect(tickets.setStatus).toHaveBeenCalledWith(TICKET_ID, "VALID", {
      scannedAt: null,
      expectedStatus: "SCANNED",
    });
  });

  // Refunds restock (spec 2026-10-09): a refund that lands between the read
  // and the write makes the ticket REFUNDED, which is terminal. The revert
  // must lose, not drag it back to VALID and retake its capacity place.
  it("refuses when the ticket left SCANNED before the write", async () => {
    const { deps } = makeDeps(false);

    await expect(revertTicketScan(deps, input)).rejects.toMatchObject({
      code: "TICKET_NOT_SCANNED",
    });
  });
});
