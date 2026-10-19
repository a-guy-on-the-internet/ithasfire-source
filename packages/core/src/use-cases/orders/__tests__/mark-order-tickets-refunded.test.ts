import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import { markOrderTicketsRefunded } from "../mark-order-tickets-refunded";

const ORDER_ID = "30000000-0000-4000-8000-000000000001";
const VALID_TICKET = "30000000-0000-4000-8000-000000000011";
const SCANNED_TICKET = "30000000-0000-4000-8000-000000000012";
const LISTED_TICKET = "30000000-0000-4000-8000-000000000013";
const INVALID_TICKET = "30000000-0000-4000-8000-000000000014";
const REFUNDED_TICKET = "30000000-0000-4000-8000-000000000015";

const GIFTED_TICKET = "30000000-0000-4000-8000-000000000016";

const VALID_SEAT = "30000000-0000-4000-8000-0000000000a1";
const SCANNED_SEAT = "30000000-0000-4000-8000-0000000000a2";
const LISTED_SEAT = "30000000-0000-4000-8000-0000000000a3";
const REFUNDED_SEAT = "30000000-0000-4000-8000-0000000000a5";
const GIFTED_SEAT = "30000000-0000-4000-8000-0000000000a6";

/** The order item behind the ticket the buyer gave away. */
const GIFTED_ITEM = "30000000-0000-4000-8000-0000000000b6";
const VALID_ITEM = "30000000-0000-4000-8000-0000000000b1";

const NOW = new Date("2026-09-10T00:00:00.000Z");

function makeTx(opts?: { withGift?: boolean }) {
  const withGift = opts?.withGift === true;
  const setStatus = vi.fn(async () => undefined);
  const clearSeatAssignments = vi.fn(async () => undefined);
  const updateStatuses = vi.fn(async () => undefined);
  const releaseSeats = vi.fn(async () => undefined);
  // Seat history: the former seat is stamped onto the order item just before
  // the ticket's @unique `seatId` link is cleared.
  const recordReleasedSeats = vi.fn(async () => undefined);
  const listItems = vi.fn(async () => [
    {
      id: VALID_ITEM,
      kind: "ticket",
      status: "refunded",
      transferredAt: null,
    },
    // A gift: the ITEM left "active" when the recipient claimed it, and the
    // refund quote calls it `already_transferred` — no money came back for it.
    {
      id: GIFTED_ITEM,
      kind: "ticket",
      status: withGift ? "transferred" : "active",
      transferredAt: withGift ? NOW : null,
    },
  ]);
  const tx = {
    tickets: {
      listByOrderId: vi.fn(async () => [
        {
          id: VALID_TICKET,
          status: "VALID",
          scannedAt: null,
          seatId: VALID_SEAT,
          orderItemId: VALID_ITEM,
        },
        {
          id: SCANNED_TICKET,
          status: "SCANNED",
          scannedAt: new Date(),
          seatId: SCANNED_SEAT,
        },
        {
          id: LISTED_TICKET,
          status: "LISTED",
          scannedAt: null,
          seatId: LISTED_SEAT,
        },
        { id: INVALID_TICKET, status: "INVALID", scannedAt: null, seatId: null },
        {
          id: REFUNDED_TICKET,
          status: "REFUNDED",
          scannedAt: null,
          // A legacy row from before the fix: refunded, yet still holding its
          // seat. It must not be re-processed here.
          seatId: REFUNDED_SEAT,
        },
        // Gifted away: the transfer moved only `ownerHumanId`, so this row
        // still carries the sender's `orderId` and still reads VALID.
        ...(withGift
          ? [
              {
                id: GIFTED_TICKET,
                status: "VALID",
                scannedAt: null,
                seatId: GIFTED_SEAT,
                orderItemId: GIFTED_ITEM,
              },
            ]
          : []),
      ]),
      setStatus,
      clearSeatAssignments,
    },
    orderItems: { listByOrderId: listItems, recordReleasedSeats },
    seats: { updateStatuses, releaseSeats },
  } as unknown as TxRepos;
  return {
    tx,
    setStatus,
    clearSeatAssignments,
    updateStatuses,
    releaseSeats,
    listItems,
    recordReleasedSeats,
  };
}

function flippedIds(setStatus: ReturnType<typeof vi.fn>): string[] {
  return setStatus.mock.calls.map((call) => call[0] as string).sort();
}

describe("markOrderTicketsRefunded", () => {
  it("default: flips only VALID and SCANNED tickets — a LISTED ticket is left alone (refund paths treat it as ineligible upstream)", async () => {
    const { tx, setStatus } = makeTx();

    await markOrderTicketsRefunded(tx, ORDER_ID, { at: NOW });

    expect(flippedIds(setStatus)).toEqual([SCANNED_TICKET, VALID_TICKET].sort());
    for (const call of setStatus.mock.calls) {
      expect(call[1]).toBe("REFUNDED");
      expect(call[2]).toEqual({ scannedAt: null });
    }
  });

  it("includeListed: also flips a LISTED ticket (cancel-event path, where the listing is cancelled in the same tx)", async () => {
    const { tx, setStatus } = makeTx();

    await markOrderTicketsRefunded(tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
    });

    expect(flippedIds(setStatus)).toEqual(
      [SCANNED_TICKET, VALID_TICKET, LISTED_TICKET].sort(),
    );
    expect(setStatus).toHaveBeenCalledWith(LISTED_TICKET, "REFUNDED", {
      scannedAt: null,
    });
  });

  it("never flips INVALID or already-REFUNDED tickets in either mode", async () => {
    const a = makeTx();
    const b = makeTx();

    await markOrderTicketsRefunded(a.tx, ORDER_ID, { at: NOW });
    await markOrderTicketsRefunded(b.tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
    });

    for (const { setStatus } of [a, b]) {
      expect(flippedIds(setStatus)).not.toContain(INVALID_TICKET);
      expect(flippedIds(setStatus)).not.toContain(REFUNDED_TICKET);
    }
  });

  it("includeListed: false is byte-for-byte the default", async () => {
    const { tx, setStatus } = makeTx();

    await markOrderTicketsRefunded(tx, ORDER_ID, {
      at: NOW,
      includeListed: false,
    });

    expect(flippedIds(setStatus)).toEqual([SCANNED_TICKET, VALID_TICKET].sort());
  });

  // ── Reserved seats ────────────────────────────────────────────────────────

  it("returns the seats of exactly the tickets it flipped", async () => {
    const h = makeTx();

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(h.tx, ORDER_ID, {
      at: NOW,
    });

    // The LISTED ticket keeps its seat (not flipped), and the legacy REFUNDED
    // row is not re-processed — only what THIS call voided comes back.
    expect(released).toEqual([VALID_SEAT, SCANNED_SEAT]);
    expect(h.clearSeatAssignments).toHaveBeenCalledWith([
      VALID_TICKET,
      SCANNED_TICKET,
    ]);
    expect(h.updateStatuses).toHaveBeenCalledWith({
      seatIds: [VALID_SEAT, SCANNED_SEAT],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    // `releaseSeats` is HELD-gated and these seats are SOLD — using it here
    // would silently no-op and leave the seat locked forever.
    expect(h.releaseSeats).not.toHaveBeenCalled();
  });

  it("includeListed: the LISTED ticket's seat comes back too", async () => {
    const h = makeTx();

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(h.tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
    });

    expect(released).toEqual([VALID_SEAT, SCANNED_SEAT, LISTED_SEAT]);
  });

  // ── Gifted (transferred) tickets ──────────────────────────────────────────

  it("REGRESSION: leaves a gifted ticket — and its seat — completely alone", async () => {
    // The recipient's pass still carries the SENDER's orderId, so it comes
    // back from `listByOrderId` reading VALID. The sender is not refunded for
    // it (`already_transferred`), so killing it takes the recipient's ticket
    // for nothing — and freeing its seat re-sells a seat two people now have
    // a claim on, with the org paid twice.
    const h = makeTx({ withGift: true });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(h.tx, ORDER_ID, {
      at: NOW,
    });

    expect(flippedIds(h.setStatus)).not.toContain(GIFTED_TICKET);
    expect(released).not.toContain(GIFTED_SEAT);
    expect(h.clearSeatAssignments).toHaveBeenCalledWith([
      VALID_TICKET,
      SCANNED_TICKET,
    ]);
    expect(h.updateStatuses).toHaveBeenCalledWith({
      seatIds: [VALID_SEAT, SCANNED_SEAT],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
  });

  it("voidTransferred: cancelEvent DOES kill the gifted ticket and take its seat back — whole house", async () => {
    const h = makeTx({ withGift: true });

    const { releasedSeatIds: released } = await markOrderTicketsRefunded(h.tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
      voidTransferred: true,
    });

    expect(flippedIds(h.setStatus)).toContain(GIFTED_TICKET);
    expect(released).toContain(GIFTED_SEAT);
    // The whole-house path does not even ask which items were transferred.
    expect(h.listItems).not.toHaveBeenCalled();
  });

  it("does not re-read the items of an order with no tickets at all", async () => {
    const tx = {
      tickets: {
        listByOrderId: vi.fn(async () => []),
        setStatus: vi.fn(async () => undefined),
        clearSeatAssignments: vi.fn(async () => undefined),
      },
      orderItems: {
        listByOrderId: vi.fn(async () => []),
        recordReleasedSeats: vi.fn(async () => undefined),
      },
      seats: {
        updateStatuses: vi.fn(async () => undefined),
        releaseSeats: vi.fn(async () => undefined),
      },
    } as unknown as TxRepos;

    expect(await markOrderTicketsRefunded(tx, ORDER_ID, { at: NOW })).toEqual({
      releasedSeatIds: [],
      leftOnRefund: [],
    });
    expect(tx.orderItems.listByOrderId).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-10: a refund of a scanned-in ticket means the person
  // left. The void clears `scannedAt`, so the caller's audit row is the only
  // record; this is the list it writes.
  it("returns the voided tickets that were SCANNED, with their admit time, as leftOnRefund", async () => {
    const admittedAt = new Date("2026-10-09T23:41:07.000Z");
    const rows = [
      { id: VALID_TICKET, status: "VALID", scannedAt: null as Date | null },
      { id: SCANNED_TICKET, status: "SCANNED", scannedAt: admittedAt as Date | null },
      // LISTED and already-dead tickets never admitted anyone on this pass.
      { id: LISTED_TICKET, status: "LISTED", scannedAt: null as Date | null },
      { id: REFUNDED_TICKET, status: "REFUNDED", scannedAt: null as Date | null },
    ];
    const tx = {
      tickets: {
        listByOrderId: vi.fn(async () => rows),
        // Writes ON THE ROW THE READ RETURNED, as an in-memory repo would: a
        // list taken after the void finds no SCANNED ticket and no time.
        setStatus: vi.fn(async (id: string, status: string) => {
          const row = rows.find((t) => t.id === id);
          if (row) {
            row.status = status;
            row.scannedAt = null;
          }
        }),
        clearSeatAssignments: vi.fn(async () => undefined),
      },
      orderItems: {
        listByOrderId: vi.fn(async () => []),
        recordReleasedSeats: vi.fn(async () => undefined),
      },
      seats: {
        updateStatuses: vi.fn(async () => undefined),
        releaseSeats: vi.fn(async () => undefined),
      },
    } as unknown as TxRepos;

    const { leftOnRefund } = await markOrderTicketsRefunded(tx, ORDER_ID, {
      at: NOW,
      includeListed: true,
    });

    expect(rows.find((t) => t.id === SCANNED_TICKET)?.status).toBe("REFUNDED");
    expect(leftOnRefund).toEqual([
      { ticketId: SCANNED_TICKET, admittedAt: "2026-10-09T23:41:07.000Z" },
    ]);
  });

  it("returns an empty leftOnRefund when nothing voided had been scanned", async () => {
    const tx = {
      tickets: {
        listByOrderId: vi.fn(async () => [
          { id: VALID_TICKET, status: "VALID", scannedAt: null },
        ]),
        setStatus: vi.fn(async () => undefined),
        clearSeatAssignments: vi.fn(async () => undefined),
      },
      orderItems: {
        listByOrderId: vi.fn(async () => []),
        recordReleasedSeats: vi.fn(async () => undefined),
      },
      seats: {
        updateStatuses: vi.fn(async () => undefined),
        releaseSeats: vi.fn(async () => undefined),
      },
    } as unknown as TxRepos;

    const { leftOnRefund } = await markOrderTicketsRefunded(tx, ORDER_ID, {
      at: NOW,
    });

    expect(leftOnRefund).toEqual([]);
  });
});
