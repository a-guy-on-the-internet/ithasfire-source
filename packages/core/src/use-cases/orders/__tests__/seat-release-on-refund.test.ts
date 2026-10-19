import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import { SEAT_OWNING_TICKET_STATUSES } from "@th/types";
import type { TicketStatus } from "@th/types";

import { holdSeatsForCheckout } from "../checkout-helpers";
import { markOrderTicketsRefunded } from "../mark-order-tickets-refunded";

/**
 * REGRESSION — "a refunded seated ticket locks its seat forever".
 *
 * `mintTickets` stamped the seat SOLD and the ticket's `seatId`; no refund
 * path ever set either back, and every seat-occupancy read matched on
 * `seatId` alone. Two independent locks, both of which had to go:
 *
 *   1. the `Seat` row stayed SOLD, and the only writes back to AVAILABLE are
 *      HELD-gated (`releaseSeats`, `releaseExpiredHolds`), so there was no
 *      path back at all;
 *   2. the dead REFUNDED ticket kept pointing at the seat, so even a
 *      hand-freed seat threw `seat_taken` — and, because `Ticket.seatId` is
 *      `@unique`, would have failed the next buyer's MINT after their card
 *      was charged.
 *
 * These tests drive the real `markOrderTicketsRefunded` → real
 * `holdSeatsForCheckout` against an in-memory seat/ticket world, so the seat
 * genuinely has to come back for the next checkout to succeed.
 */

const EVENT_ID = "e1111111-1111-4111-8111-111111111111";
const SECTION_ID = "e2222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "e3333333-3333-4333-8333-333333333333";
const ORDER_ID = "e4444444-4444-4444-8444-444444444444";
const SEAT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SEAT_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TICKET_A = "cccccccc-1111-4111-8111-111111111111";
const TICKET_B = "dddddddd-2222-4222-8222-222222222222";
const ITEM_A = "eeeeeeee-1111-4111-8111-111111111111";
const ITEM_B = "ffffffff-2222-4222-8222-222222222222";

const NOW = new Date("2026-09-10T00:00:00.000Z");

type SeatRow = {
  id: string;
  seatSectionId: string;
  status: "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";
  eventId: string;
  label: string;
  row: string;
  number: number;
};

type TicketRow = {
  id: string;
  orderId: string;
  status: TicketStatus;
  seatId: string | null;
  scannedAt: Date | null;
  orderItemId?: string | null;
};

type ItemRow = {
  id: string;
  kind: string;
  status: string;
  transferredAt: Date | null;
  /** Seat history, stamped by `recordReleasedSeats` as the link is cleared. */
  releasedSeatId?: string;
};

function seat(id: string, status: SeatRow["status"], label: string): SeatRow {
  return {
    id,
    seatSectionId: SECTION_ID,
    status,
    eventId: EVENT_ID,
    label,
    row: "A",
    number: Number(label.slice(1)),
  };
}

function ticket(
  id: string,
  status: TicketStatus,
  seatId: string | null,
): TicketRow {
  return { id, orderId: ORDER_ID, status, seatId, scannedAt: null };
}

/**
 * In-memory seats + tickets that behave like the Prisma adapter:
 *  - `releaseSeats` is HELD-gated (which is exactly why the refund paths
 *    cannot use it on a SOLD seat);
 *  - `findBySeatIds` returns OCCUPANTS only (live statuses), unless
 *    `unfilteredSeatLookup` models the old adapter / a legacy row.
 */
function makeWorld(opts: {
  seats: SeatRow[];
  tickets: TicketRow[];
  items?: ItemRow[];
  unfilteredSeatLookup?: boolean;
}) {
  const seats = new Map(opts.seats.map((s) => [s.id, { ...s }]));
  const tickets = opts.tickets.map((t) => ({ ...t }));
  const items = (opts.items ?? []).map((i) => ({ ...i }));

  const tx = {
    orderItems: {
      listByOrderId: vi.fn(async () => items),
      // Seat history: the former seat is stamped onto the order item just
      // before the ticket's @unique `seatId` link is cleared.
      recordReleasedSeats: vi.fn(
        async (
          entries: ReadonlyArray<{ orderItemId: string; seatId: string }>,
        ) => {
          for (const entry of entries) {
            const item = items.find((i) => i.id === entry.orderItemId);
            if (item) item.releasedSeatId = entry.seatId;
          }
        },
      ),
    },
    seats: {
      releaseExpiredHolds: vi.fn(async () => 0),
      findByIdsForUpdate: vi.fn(async ({ seatIds }: { seatIds: string[] }) =>
        seatIds
          .map((id) => seats.get(id))
          .filter((s): s is SeatRow => s !== undefined),
      ),
      updateStatuses: vi.fn(
        async ({
          seatIds,
          status,
        }: {
          seatIds: string[];
          status: SeatRow["status"];
          updatedAt: Date;
        }) => {
          for (const id of seatIds) {
            const row = seats.get(id);
            if (row) row.status = status;
          }
        },
      ),
      // HELD-gated, exactly like the adapter.
      releaseSeats: vi.fn(async ({ seatIds }: { seatIds: string[] }) => {
        for (const id of seatIds) {
          const row = seats.get(id);
          if (row && row.status === "HELD") row.status = "AVAILABLE";
        }
      }),
    },
    tickets: {
      findBySeatIds: vi.fn(async (seatIds: string[]) =>
        tickets.filter(
          (t) =>
            t.seatId !== null &&
            seatIds.includes(t.seatId) &&
            (opts.unfilteredSeatLookup === true ||
              SEAT_OWNING_TICKET_STATUSES.includes(t.status)),
        ),
      ),
      listByOrderId: vi.fn(async (orderId: string) =>
        tickets.filter((t) => t.orderId === orderId),
      ),
      setStatus: vi.fn(
        async (
          ticketId: string,
          status: TicketStatus,
          options?: { scannedAt?: Date | null },
        ) => {
          const row = tickets.find((t) => t.id === ticketId);
          if (!row) return;
          row.status = status;
          if (options?.scannedAt !== undefined) {
            row.scannedAt = options.scannedAt;
          }
        },
      ),
      clearSeatAssignments: vi.fn(async (ticketIds: string[]) => {
        for (const row of tickets) {
          if (ticketIds.includes(row.id)) row.seatId = null;
        }
      }),
    },
    ticketTypes: { countActiveHolds: vi.fn(async () => 0) },
  } as unknown as TxRepos;

  return { tx, seats, tickets, items };
}

function holdParams(seatIds: string[]) {
  return {
    eventId: EVENT_ID,
    items: [{ ticketTypeId: TICKET_TYPE_ID, qty: seatIds.length, seatIds }],
    ticketTypeMap: new Map([
      [
        TICKET_TYPE_ID,
        {
          id: TICKET_TYPE_ID,
          priceCents: 1000,
          pricingMode: "FIXED",
          minimumCents: null,
          seatSectionId: SECTION_ID,
        },
      ],
    ]) as never,
    now: NOW,
    ttlSeconds: 900,
    // The seats carry no price override; the cart was priced with none.
    seatPrices: new Map(seatIds.map((id) => [id, null] as const)),
  };
}

describe("a refunded seated ticket returns its seat", () => {
  it("frees the seat and drops the dead ticket's claim, so the seat sells again", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1")],
      tickets: [ticket(TICKET_A, "VALID", SEAT_A)],
    });

    // Before the refund the seat is genuinely occupied.
    await expect(
      holdSeatsForCheckout(w.tx, holdParams([SEAT_A])),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "seat_unavailable",
      seatId: SEAT_A,
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(released).toEqual([SEAT_A]);
    expect(w.seats.get(SEAT_A)!.status).toBe("AVAILABLE");
    // `Ticket.seatId` is @unique — a dead ticket still holding it makes the
    // NEXT buyer's mint fail with P2002 AFTER they are charged.
    expect(w.tickets.find((t) => t.id === TICKET_A)!.seatId).toBeNull();
    expect(w.tickets.find((t) => t.id === TICKET_A)!.status).toBe("REFUNDED");

    // End to end: the next buyer can now hold the same seat.
    const holds = await holdSeatsForCheckout(w.tx, holdParams([SEAT_A]));
    expect(holds.get(TICKET_TYPE_ID)?.seatIds).toEqual([SEAT_A]);
    expect(w.seats.get(SEAT_A)!.status).toBe("HELD");
  });

  it("does not use the HELD-gated releaseSeats, which would no-op on a SOLD seat", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1")],
      tickets: [ticket(TICKET_A, "VALID", SEAT_A)],
    });

    await markOrderTicketsRefunded(w.tx, ORDER_ID, { at: NOW });

    expect(w.tx.seats.releaseSeats).not.toHaveBeenCalled();
    expect(w.tx.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_A],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
  });

  it("a REFUNDED ticket row does not block its seat, even on a legacy unfiltered read", async () => {
    // Lock 2: the seat row was fixed by hand (or by an operator), but the dead
    // ticket from the refunded order still points at it. Modelled with the
    // PRE-FIX adapter read (no status filter) so this pins the in-memory
    // predicate in `holdSeatsForCheckout`, not just the SQL.
    //
    // ⚠️  READ THIS BEFORE WRITING THE BACKFILL. The state this test asserts on
    // — seat AVAILABLE/HELD while a terminal ticket still holds its `seatId` —
    // is a state today's code NEVER produces, and it is not a good one. It is
    // asserted because checkout must not be the thing that breaks in it, NOT
    // because it is safe to create.
    //
    // `Ticket.seatId` is @unique. In this state checkout passes and the
    // failure lands on `tickets.create` → P2002 → `seat_taken` AFTER the
    // card is charged, which is strictly worse than the dead-inventory bug.
    // `mintTickets` now refuses deliberately first (see its @unique
    // pre-flight), but that is a net, not a licence.
    //
    // ORDERING REQUIREMENT: the announced forward-only backfill (and any hand
    // repair of seat rows) MUST clear `Ticket.seatId` on REFUNDED/INVALID rows
    // BEFORE — or in the same statement as — flipping their seats to
    // AVAILABLE. Never seats-first. Forward-only today leaves the seat SOLD,
    // so checkout refuses pre-charge; seats-first converts that pre-charge
    // refusal into a post-charge failure.
    const w = makeWorld({
      seats: [seat(SEAT_A, "AVAILABLE", "A1")],
      tickets: [ticket(TICKET_A, "REFUNDED", SEAT_A)],
      unfilteredSeatLookup: true,
    });

    const holds = await holdSeatsForCheckout(w.tx, holdParams([SEAT_A]));

    expect(holds.get(TICKET_TYPE_ID)?.seatIds).toEqual([SEAT_A]);
  });

  it("CONTROL: a live ticket still blocks its seat — this must not over-open", async () => {
    // A VALID ticket on a seat somebody freed by hand is still an occupied
    // seat: the attendee holds a pass for it.
    const w = makeWorld({
      seats: [seat(SEAT_A, "AVAILABLE", "A1")],
      tickets: [ticket(TICKET_A, "VALID", SEAT_A)],
    });

    await expect(
      holdSeatsForCheckout(w.tx, holdParams([SEAT_A])),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "seat_taken",
      seatId: SEAT_A,
    });
  });

  it("CONTROL: a SCANNED ticket (attendee is sitting in it) still blocks", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "AVAILABLE", "A1")],
      tickets: [ticket(TICKET_A, "SCANNED", SEAT_A)],
    });

    await expect(
      holdSeatsForCheckout(w.tx, holdParams([SEAT_A])),
    ).rejects.toMatchObject({ code: "conflict", message: "seat_taken" });
  });

  it("CONTROL: a LISTED ticket (on resale, still owned) still blocks", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "AVAILABLE", "A1")],
      tickets: [ticket(TICKET_A, "LISTED", SEAT_A)],
    });

    await expect(
      holdSeatsForCheckout(w.tx, holdParams([SEAT_A])),
    ).rejects.toMatchObject({ code: "conflict", message: "seat_taken" });
  });

  it("leaves a LISTED ticket's seat alone when the listing is still live", async () => {
    // Default (`includeListed` false) = the refund paths' rule: a listed
    // ticket is ineligible upstream, is not voided here, and keeps its seat.
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1"), seat(SEAT_B, "SOLD", "A2")],
      tickets: [
        ticket(TICKET_A, "VALID", SEAT_A),
        ticket(TICKET_B, "LISTED", SEAT_B),
      ],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(released).toEqual([SEAT_A]);
    expect(w.seats.get(SEAT_B)!.status).toBe("SOLD");
    expect(w.tickets.find((t) => t.id === TICKET_B)!.seatId).toBe(SEAT_B);
  });

  it("frees a LISTED ticket's seat when the listing is being cancelled too (cancelEvent)", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_B, "SOLD", "A2")],
      tickets: [ticket(TICKET_B, "LISTED", SEAT_B)],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
    });

    expect(released).toEqual([SEAT_B]);
    expect(w.seats.get(SEAT_B)!.status).toBe("AVAILABLE");
  });

  it("touches no seat for an already-terminal ticket (nothing was voided)", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "AVAILABLE", "A1")],
      tickets: [ticket(TICKET_A, "REFUNDED", null)],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(released).toEqual([]);
    expect(w.tx.seats.updateStatuses).not.toHaveBeenCalled();
    expect(w.tx.tickets.clearSeatAssignments).not.toHaveBeenCalled();
  });

  it("frees a whole multi-seat order at once, deduped", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1"), seat(SEAT_B, "SOLD", "A2")],
      tickets: [
        ticket(TICKET_A, "VALID", SEAT_A),
        ticket(TICKET_B, "SCANNED", SEAT_B),
      ],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(new Set(released)).toEqual(new Set([SEAT_A, SEAT_B]));
    expect(w.tx.seats.updateStatuses).toHaveBeenCalledTimes(1);
    expect(w.seats.get(SEAT_A)!.status).toBe("AVAILABLE");
    expect(w.seats.get(SEAT_B)!.status).toBe("AVAILABLE");

    const holds = await holdSeatsForCheckout(
      w.tx,
      holdParams([SEAT_A, SEAT_B]),
    );
    expect(holds.get(TICKET_TYPE_ID)?.seatIds).toEqual([SEAT_A, SEAT_B]);
  });

  it("REGRESSION: a gifted ticket's seat never goes back on sale, so it cannot be double-sold", async () => {
    // A bought both seats and gave the second away; the claim stamped the
    // sender's ITEM `transferred` but moved only the ticket's owner, so
    // TICKET_B still carries A's orderId and still reads VALID. A's refund
    // pays back seat A only — B's pass, and B's seat, are not A's to give up.
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1"), seat(SEAT_B, "SOLD", "A2")],
      tickets: [
        { ...ticket(TICKET_A, "VALID", SEAT_A), orderItemId: ITEM_A },
        { ...ticket(TICKET_B, "VALID", SEAT_B), orderItemId: ITEM_B },
      ],
      items: [
        { id: ITEM_A, kind: "ticket", status: "active", transferredAt: null },
        {
          id: ITEM_B,
          kind: "ticket",
          status: "transferred",
          transferredAt: NOW,
        },
      ],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(released).toEqual([SEAT_A]);
    expect(w.tickets.find((t) => t.id === TICKET_B)!.status).toBe("VALID");
    expect(w.tickets.find((t) => t.id === TICKET_B)!.seatId).toBe(SEAT_B);
    expect(w.seats.get(SEAT_B)!.status).toBe("SOLD");

    // End to end: a third buyer cannot take the seat the recipient is holding.
    await expect(
      holdSeatsForCheckout(w.tx, holdParams([SEAT_B])),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "seat_unavailable",
      seatId: SEAT_B,
    });
  });

  it("stamps the former seat onto the order item before destroying the link", async () => {
    // `Ticket.seatId` MUST be cleared (it is @unique), which erases the only
    // record of which seat this order sold — the org's order detail would show
    // a refunded line with no seat at all. The item keeps it instead.
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1")],
      tickets: [{ ...ticket(TICKET_A, "VALID", SEAT_A), orderItemId: ITEM_A }],
      items: [
        { id: ITEM_A, kind: "ticket", status: "active", transferredAt: null },
      ],
    });

    await markOrderTicketsRefunded(w.tx, ORDER_ID, { at: NOW });

    expect(w.tickets.find((t) => t.id === TICKET_A)!.seatId).toBeNull();
    expect(w.items.find((i) => i.id === ITEM_A)!.releasedSeatId).toBe(SEAT_A);
    expect(w.tx.orderItems.recordReleasedSeats).toHaveBeenCalledWith([
      { orderItemId: ITEM_A, seatId: SEAT_A },
    ]);
  });

  it("keeps no seat history for a ticket with no order item, rather than failing", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_A, "SOLD", "A1")],
      tickets: [ticket(TICKET_A, "VALID", SEAT_A)],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(released).toEqual([SEAT_A]);
    expect(w.tx.orderItems.recordReleasedSeats).toHaveBeenCalledWith([]);
  });

  it("cancelEvent (voidTransferred) DOES take the gifted seat back — the show is gone", async () => {
    const w = makeWorld({
      seats: [seat(SEAT_B, "SOLD", "A2")],
      tickets: [
        { ...ticket(TICKET_B, "VALID", SEAT_B), orderItemId: ITEM_B },
      ],
      items: [
        {
          id: ITEM_B,
          kind: "ticket",
          status: "transferred",
          transferredAt: NOW,
        },
      ],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
      voidTransferred: true,
    });

    expect(released).toEqual([SEAT_B]);
    expect(w.seats.get(SEAT_B)!.status).toBe("AVAILABLE");
    expect(w.tickets.find((t) => t.id === TICKET_B)!.status).toBe("REFUNDED");
  });

  it("leaves GA tickets (no seat) alone", async () => {
    const w = makeWorld({
      seats: [],
      tickets: [ticket(TICKET_A, "VALID", null)],
    });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(w.tx, ORDER_ID, {
      at: NOW,
    });

    expect(released).toEqual([]);
    expect(w.tx.seats.updateStatuses).not.toHaveBeenCalled();
  });
});
