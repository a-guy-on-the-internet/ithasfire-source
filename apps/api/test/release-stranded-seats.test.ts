import { describe, expect, it, vi } from "vitest";

import { SEAT_OWNING_TICKET_STATUSES, ticketOwnsSeat } from "@th/types";
import type { TicketStatus } from "@th/types";

import {
  classifySeat,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  parseBatchSize,
  parseLimit,
  parseOptionalId,
  planFor,
  releaseStrandedSeat,
  TERMINAL_TICKET_STATUS_FILTER,
  type ClaimingTicket,
  type SeatBackfillTx,
  type SeatCandidate,
  type SeatReleasePlan,
  type SeatStatus,
} from "../src/scripts/backfill/plan-release-stranded-seats";

/**
 * Unit tests for the one-off backfill that releases seats stranded by the
 * pre-0c77c77c refund bug. NO DATABASE: the classifier is pure and the write
 * routine takes a structural `tx`, so everything here runs against an
 * in-memory world.
 *
 * The load-bearing assertion in this file is the ORDERING one — the ticket ->
 * seat link must be cleared BEFORE the seat is flipped to AVAILABLE. The fake
 * seat writer THROWS if a seat is freed while a ticket still claims it, so a
 * seats-first regression cannot be green here.
 */

const SEAT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SEAT_B = "bbbbbbbb-2222-4222-8222-222222222222";
const SEAT_C = "cccccccc-3333-4333-8333-333333333333";
const TICKET_A = "11111111-1111-4111-8111-111111111111";
const TICKET_B = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "99999999-1111-4111-8111-111111111111";
const EVENT_ID = "eeeeeeee-1111-4111-8111-111111111111";

function candidate(
  seatStatus: SeatStatus,
  tickets: ClaimingTicket[],
  seatId = SEAT_A,
): SeatCandidate {
  return {
    seatId,
    seatStatus,
    label: "C7",
    sectionName: "Orchestra",
    eventId: EVENT_ID,
    eventTitle: "A Show",
    tickets,
  };
}

function claim(
  status: TicketStatus,
  overrides: Partial<ClaimingTicket> = {},
): ClaimingTicket {
  return { id: TICKET_A, status, orderItemId: ITEM_A, ...overrides };
}

// ── The in-memory world ─────────────────────────────────────────────────────

type WorldSeat = { id: string; status: SeatStatus };
type WorldTicket = {
  id: string;
  status: TicketStatus;
  seatId: string | null;
  orderItemId: string | null;
};
type WorldItem = { id: string; meta: Record<string, unknown> };

function makeWorld(opts: {
  seats: WorldSeat[];
  tickets: WorldTicket[];
  items?: WorldItem[];
  /** Force the clear to write nothing, as if the row moved under us. */
  clearWritesNothing?: boolean;
  /** Force the seat flip to match nothing, as if the status moved. */
  flipMatchesNothing?: boolean;
}) {
  const seats = new Map(opts.seats.map((s) => [s.id, { ...s }]));
  const tickets = opts.tickets.map((t) => ({ ...t }));
  const items = new Map(
    (opts.items ?? []).map((i) => [i.id, { ...i, meta: { ...i.meta } }]),
  );
  const calls: string[] = [];

  const tx: SeatBackfillTx = {
    ticket: {
      updateMany: vi.fn(async ({ where, data }) => {
        calls.push("ticket.updateMany");
        if (opts.clearWritesNothing) return { count: 0 };
        let count = 0;
        for (const t of tickets) {
          if (!where.id.in.includes(t.id)) continue;
          if (t.seatId !== where.seatId) continue;
          // `notIn`: the row must NOT be in the seat-owning list.
          if (where.status.notIn.includes(t.status)) continue;
          t.seatId = data.seatId;
          count += 1;
        }
        return { count };
      }),
      count: vi.fn(async ({ where }) => {
        calls.push("ticket.count");
        return tickets.filter((t) => t.seatId === where.seatId).length;
      }),
    },
    seat: {
      updateMany: vi.fn(async ({ where, data }) => {
        calls.push("seat.updateMany");
        if (opts.flipMatchesNothing) return { count: 0 };
        const seat = seats.get(where.id);
        if (!seat || !where.status.in.includes(seat.status)) return { count: 0 };
        // THE INVARIANT. In Postgres this state is what turns the next buyer's
        // `tickets.create` into a P2002 AFTER their card is charged, so a
        // seats-first implementation must not be able to pass these tests.
        if (tickets.some((t) => t.seatId === where.id)) {
          throw new Error(
            `DOUBLE-SELL: seat ${where.id} freed while a ticket still claims it`,
          );
        }
        seat.status = data.status;
        return { count: 1 };
      }),
    },
  };

  const deps = {
    recordReleasedSeats: vi.fn(
      async (entries: ReadonlyArray<{ orderItemId: string; seatId: string }>) => {
        calls.push("recordReleasedSeats");
        for (const entry of entries) {
          const item = items.get(entry.orderItemId);
          if (item) item.meta = { ...item.meta, releasedSeatId: entry.seatId };
        }
      },
    ),
  };

  return { tx, deps, seats, tickets, items, calls };
}

/**
 * Mirrors what the CLI reads: seats whose claiming ticket is TERMINAL (the
 * Prisma `ticket: { is: { status: { notIn: SEAT_OWNING } } }` filter), then the
 * claiming tickets read separately by `seatId`.
 */
function candidatesFrom(world: ReturnType<typeof makeWorld>): SeatCandidate[] {
  return [...world.seats.values()]
    .filter((seat) => {
      const claims = world.tickets.filter((t) => t.seatId === seat.id);
      return claims.some((c) => !ticketOwnsSeat(c.status));
    })
    .map((seat) =>
      candidate(
        seat.status,
        world.tickets
          .filter((t) => t.seatId === seat.id)
          .map((t) => ({
            id: t.id,
            status: t.status,
            orderItemId: t.orderItemId,
          })),
        seat.id,
      ),
    );
}

// ── classifySeat ────────────────────────────────────────────────────────────

describe("classifySeat", () => {
  it("SOLD seat held only by a REFUNDED ticket is eligible, seat and link both", () => {
    const result = classifySeat(candidate("SOLD", [claim("REFUNDED")]));

    expect(result).toEqual({
      kind: "eligible",
      flipSeat: true,
      ticketIds: [TICKET_A],
      history: [{ orderItemId: ITEM_A, seatId: SEAT_A }],
    });
  });

  it("HELD seat held only by an INVALID ticket is eligible too", () => {
    const result = classifySeat(candidate("HELD", [claim("INVALID")]));

    expect(result).toMatchObject({ kind: "eligible", flipSeat: true });
  });

  it("REFUSES every seat-owning status — derived from the list, not retyped", () => {
    // If a status is ever moved into or out of SEAT_OWNING_TICKET_STATUSES,
    // this loop follows it. LISTED is the easy one to get wrong: it is still
    // the seller's pass until the resale settles.
    for (const status of SEAT_OWNING_TICKET_STATUSES) {
      const result = classifySeat(candidate("SOLD", [claim(status)]));

      expect(result).toMatchObject({
        kind: "refused-live-ticket",
        liveTicketIds: [TICKET_A],
      });
    }
  });

  it("REFUSES the whole seat when a live ticket sits next to a dead one", () => {
    // Impossible today (`Ticket.seatId` is @unique) — which is exactly why it
    // is refused rather than half-handled: reaching this state means something
    // about the row is not what the script assumes.
    const result = classifySeat(
      candidate("SOLD", [
        claim("REFUNDED"),
        claim("VALID", { id: TICKET_B, orderItemId: null }),
      ]),
    );

    expect(result).toMatchObject({
      kind: "refused-live-ticket",
      liveTicketIds: [TICKET_B],
    });
  });

  it("a SOLD seat with NO claiming ticket is ambiguous, never touched", () => {
    const result = classifySeat(candidate("SOLD", []));

    expect(result.kind).toBe("ambiguous");
  });

  it("an AVAILABLE seat with no claim is already-released (the second-run shape)", () => {
    expect(classifySeat(candidate("AVAILABLE", [])).kind).toBe(
      "already-released",
    );
  });

  it("an AVAILABLE seat still carrying a dead link is link-only — the post-charge P2002 state", () => {
    const result = classifySeat(candidate("AVAILABLE", [claim("REFUNDED")]));

    expect(result).toMatchObject({ kind: "eligible", flipSeat: false });
    expect(result).toHaveProperty("note", expect.stringContaining("P2002"));
  });

  it("never un-blocks a BLOCKED seat, but does clear the dead link", () => {
    const result = classifySeat(candidate("BLOCKED", [claim("REFUNDED")]));

    expect(result).toMatchObject({
      kind: "eligible",
      flipSeat: false,
      ticketIds: [TICKET_A],
    });
  });

  it("a ticket with no order item is still eligible; it simply keeps no history", () => {
    const result = classifySeat(
      candidate("SOLD", [claim("REFUNDED", { orderItemId: null })]),
    );

    expect(result).toMatchObject({
      kind: "eligible",
      flipSeat: true,
      history: [],
    });
  });

  it("the terminal filter is DERIVED from the owning triple, not retyped", () => {
    expect(TERMINAL_TICKET_STATUS_FILTER).toEqual([
      ...SEAT_OWNING_TICKET_STATUSES,
    ]);
  });
});

// ── releaseStrandedSeat: the ordering ───────────────────────────────────────

function planOf(c: SeatCandidate): SeatReleasePlan {
  const classification = classifySeat(c);
  if (classification.kind !== "eligible") {
    throw new Error(`expected eligible, got ${classification.kind}`);
  }
  return planFor(c, classification);
}

describe("releaseStrandedSeat — ordering", () => {
  it("clears the ticket link BEFORE flipping the seat", async () => {
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "SOLD" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
      ],
      items: [{ id: ITEM_A, meta: { note: "keep me" } }],
    });

    const outcome = await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("SOLD", [claim("REFUNDED")])),
    );

    expect(outcome).toEqual({
      kind: "released",
      seatId: SEAT_A,
      ticketIds: [TICKET_A],
      flippedSeat: true,
    });
    // The assertion the reviewer asked for, stated two ways.
    expect(world.calls).toEqual([
      "recordReleasedSeats",
      "ticket.updateMany",
      "ticket.count",
      "seat.updateMany",
    ]);
    expect(world.calls.indexOf("ticket.updateMany")).toBeLessThan(
      world.calls.indexOf("seat.updateMany"),
    );
    expect(world.seats.get(SEAT_A)?.status).toBe("AVAILABLE");
    expect(world.tickets[0]?.seatId).toBeNull();
  });

  it("stamps the seat onto the order item and keeps the rest of its meta", async () => {
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "SOLD" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
      ],
      items: [{ id: ITEM_A, meta: { note: "keep me" } }],
    });

    await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("SOLD", [claim("REFUNDED")])),
    );

    // Same shape the forward path writes — the CLI injects the real
    // `makeOrderItemsRepo(tx).recordReleasedSeats`, so a backfilled row reads
    // back through `getOrgOrder` exactly like a refund written today.
    expect(world.items.get(ITEM_A)?.meta).toEqual({
      note: "keep me",
      releasedSeatId: SEAT_A,
    });
    // History is stamped BEFORE the link that carries it is destroyed.
    expect(world.calls.indexOf("recordReleasedSeats")).toBeLessThan(
      world.calls.indexOf("ticket.updateMany"),
    );
  });

  it("does NOT flip the seat when the clear wrote nothing", async () => {
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "SOLD" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
      ],
      clearWritesNothing: true,
    });

    const outcome = await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("SOLD", [claim("REFUNDED")])),
    );

    expect(outcome).toMatchObject({ kind: "refused", seatId: SEAT_A });
    expect(world.calls).not.toContain("seat.updateMany");
    // The half-done state is the PRE-FIX state: seat still SOLD, refusal
    // pre-charge. Safe, and a re-run re-examines it.
    expect(world.seats.get(SEAT_A)?.status).toBe("SOLD");
  });

  it("does NOT flip the seat when a ticket still claims it after the clear", async () => {
    // A second, unexpected claimant the plan did not name — the write-time
    // twin of the live-ticket refusal.
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "SOLD" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
        { id: TICKET_B, status: "VALID", seatId: SEAT_A, orderItemId: null },
      ],
    });

    const outcome = await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("SOLD", [claim("REFUNDED")])),
    );

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(outcome).toHaveProperty(
      "reason",
      expect.stringContaining("still claim this seat"),
    );
    expect(world.calls).not.toContain("seat.updateMany");
    expect(world.seats.get(SEAT_A)?.status).toBe("SOLD");
  });

  it("reports a refusal when the seat status moved under us", async () => {
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "SOLD" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
      ],
      flipMatchesNothing: true,
    });

    const outcome = await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("SOLD", [claim("REFUNDED")])),
    );

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(world.tickets[0]?.seatId).toBeNull();
  });

  it("a link-only plan never touches the seat table at all", async () => {
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "BLOCKED" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
      ],
    });

    const outcome = await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("BLOCKED", [claim("REFUNDED")])),
    );

    expect(outcome).toEqual({
      kind: "released",
      seatId: SEAT_A,
      ticketIds: [TICKET_A],
      flippedSeat: false,
    });
    expect(world.calls).not.toContain("seat.updateMany");
    expect(world.seats.get(SEAT_A)?.status).toBe("BLOCKED");
  });

  it("the clear is scoped to the seat AND to non-owning statuses", async () => {
    const world = makeWorld({
      seats: [{ id: SEAT_A, status: "SOLD" }],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
      ],
    });

    await releaseStrandedSeat(
      world.tx,
      world.deps,
      planOf(candidate("SOLD", [claim("REFUNDED")])),
    );

    expect(world.tx.ticket.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [TICKET_A] },
        seatId: SEAT_A,
        status: { notIn: [...SEAT_OWNING_TICKET_STATUSES] },
      },
      data: { seatId: null },
    });
    expect(world.tx.seat.updateMany).toHaveBeenCalledWith({
      where: { id: SEAT_A, status: { in: ["SOLD", "HELD"] } },
      data: { status: "AVAILABLE" },
    });
  });
});

// ── A whole pass, then a second one ─────────────────────────────────────────

async function runPass(world: ReturnType<typeof makeWorld>) {
  const stats = { examined: 0, eligible: 0, rewritten: 0, refused: 0, ambiguous: 0 };
  for (const c of candidatesFrom(world)) {
    stats.examined += 1;
    const classification = classifySeat(c);
    if (classification.kind === "refused-live-ticket") {
      stats.refused += 1;
      continue;
    }
    if (classification.kind === "ambiguous") {
      stats.ambiguous += 1;
      continue;
    }
    if (classification.kind === "already-released") continue;
    stats.eligible += 1;
    const outcome = await releaseStrandedSeat(
      world.tx,
      world.deps,
      planFor(c, classification),
    );
    if (outcome.kind === "released") stats.rewritten += 1;
    else stats.refused += 1;
  }
  return stats;
}

describe("a full pass", () => {
  it("frees the stranded seat, leaves the live one, and is a no-op the second time", async () => {
    const world = makeWorld({
      seats: [
        { id: SEAT_A, status: "SOLD" }, // stranded by a refund
        { id: SEAT_B, status: "SOLD" }, // a live pass — must survive
        { id: SEAT_C, status: "SOLD" }, // no claiming ticket at all
      ],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
        { id: TICKET_B, status: "VALID", seatId: SEAT_B, orderItemId: null },
      ],
      items: [{ id: ITEM_A, meta: {} }],
    });

    const first = await runPass(world);

    expect(first).toEqual({
      // SEAT_B never enters the candidate set (the SQL filter drops it) and
      // SEAT_C has no claiming ticket, so neither is examined.
      examined: 1,
      eligible: 1,
      rewritten: 1,
      refused: 0,
      ambiguous: 0,
    });
    expect(world.seats.get(SEAT_A)?.status).toBe("AVAILABLE");
    expect(world.seats.get(SEAT_B)?.status).toBe("SOLD");
    expect(world.seats.get(SEAT_C)?.status).toBe("SOLD");
    expect(world.tickets.find((t) => t.id === TICKET_B)?.seatId).toBe(SEAT_B);

    world.calls.length = 0;
    const second = await runPass(world);

    expect(second).toEqual({
      examined: 0,
      eligible: 0,
      rewritten: 0,
      refused: 0,
      ambiguous: 0,
    });
    // Idempotent in the strongest sense: the second run issues no writes.
    expect(world.calls).toEqual([]);
  });

  it("is safe to interrupt: an untouched seat is still eligible on the next run", async () => {
    const world = makeWorld({
      seats: [
        { id: SEAT_A, status: "SOLD" },
        { id: SEAT_B, status: "SOLD" },
      ],
      tickets: [
        {
          id: TICKET_A,
          status: "REFUNDED",
          seatId: SEAT_A,
          orderItemId: ITEM_A,
        },
        { id: TICKET_B, status: "REFUNDED", seatId: SEAT_B, orderItemId: null },
      ],
      items: [{ id: ITEM_A, meta: {} }],
    });

    // Pretend the process died after the first seat's batch committed.
    const [firstCandidate] = candidatesFrom(world);
    await releaseStrandedSeat(world.tx, world.deps, planOf(firstCandidate!));

    const resumed = await runPass(world);

    expect(resumed).toMatchObject({ examined: 1, rewritten: 1 });
    expect(world.seats.get(SEAT_A)?.status).toBe("AVAILABLE");
    expect(world.seats.get(SEAT_B)?.status).toBe("AVAILABLE");
  });
});

// ── Argument handling ───────────────────────────────────────────────────────

describe("argument parsing", () => {
  it("--limit refuses anything that is not a positive integer", () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit("25")).toBe(25);
    for (const bad of ["", "0", "-5", "12.5", "abc", " "]) {
      expect(() => parseLimit(bad)).toThrow(/--limit must be a positive integer/);
    }
  });

  it("--batch-size defaults, and is bounded so a batch cannot be an unbounded transaction", () => {
    expect(parseBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
    expect(parseBatchSize("10")).toBe(10);
    expect(parseBatchSize(String(MAX_BATCH_SIZE))).toBe(MAX_BATCH_SIZE);
    expect(() => parseBatchSize(String(MAX_BATCH_SIZE + 1))).toThrow(
      /must be <= 500/,
    );
    for (const bad of ["", "0", "-1", "3.5", "lots"]) {
      expect(() => parseBatchSize(bad)).toThrow(
        /--batch-size must be a positive integer/,
      );
    }
  });

  it("an empty --event-id is refused rather than silently widening the run", () => {
    expect(parseOptionalId(undefined, "--event-id")).toBeUndefined();
    expect(parseOptionalId(` ${EVENT_ID} `, "--event-id")).toBe(EVENT_ID);
    expect(() => parseOptionalId("", "--event-id")).toThrow(
      /--event-id needs a value/,
    );
    expect(() => parseOptionalId("   ", "--event-id")).toThrow(
      /--event-id needs a value/,
    );
  });
});
