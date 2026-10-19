import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { refundCashSale } from "./refund-cash-sale";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-04-26T20:30:00Z");

function makeTx(opts: {
  order?: any | null;
  membership?: { role: "ADMIN" | "OWNER" | "EDITOR" | "SCANNER" } | null;
  tickets?: Array<any>;
}) {
  const ledger = createFakePayeeLedgerRepo();
  // A real order row always carries its fee, tax and items. These fixtures
  // describe cash orders recorded BEFORE the door was priced (fee 0, tax 0,
  // no buyer totals), so the amount handed back is their gross — what the
  // operator typed then. Priced cash orders are covered in
  // `__tests__/door-cash-parity.test.ts`.
  const order =
    opts.order == null
      ? null
      : { feesPlatformCents: 0, taxAmountCents: 0, items: [], ...opts.order };
  const tx = {
    orders: {
      getById: vi.fn(async () => order),
      // The claim: SUCCEEDED → REFUNDED once (compare-and-set).
      markRefundedIfSucceeded: vi.fn(async () => {
        if (!order || order.status !== "SUCCEEDED") return false;
        order.status = "REFUNDED";
        return true;
      }),
    },
    events: {
      getById: vi.fn(async () => ({ id: EVENT_ID, orgId: ORG_ID })),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR, role: "ADMIN" as const }
          : opts.membership,
      ),
    },
    orderItems: {
      // Seat history: the former seat is stamped onto the order item just
      // before the ticket's @unique `seatId` link is cleared.
      recordReleasedSeats: vi.fn(async () => {}),
    },
    tickets: {
      listByOrderId: vi.fn(async () => opts.tickets ?? []),
      setStatus: vi.fn(async () => {}),
      clearSeatAssignments: vi.fn(async () => {}),
    },
    // A cash sale can be seated too — the door's refund has to put the seat
    // back or it is dead inventory for the rest of the night.
    seats: {
      updateStatuses: vi.fn(async () => {}),
      releaseSeats: vi.fn(async () => {}),
    },
    audit: { log: vi.fn(async () => {}) },
    promos: { releaseHoldsForOrder: vi.fn(async () => {}) },
    feeWaivers: { release: vi.fn(async () => ({ releasedTickets: 0 })) },
    payeeLedger: ledger.repo,
    /** The in-memory ledger behind `payeeLedger` (not a repo method). */
    _ledger: ledger,
  };
  return tx;
}

function makeDeps(tx: ReturnType<typeof makeTx>) {
  const repos = {
    tx: vi.fn(async (fn: any) => fn(tx)),
  } as unknown as Repos;
  const clock: ClockPort = { now: () => NOW };
  return { repos, clock };
}

describe("refundCashSale", () => {
  it("flips Order + Tickets to REFUNDED and writes an audit row (no money moves)", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 6000,
      occurredAt: new Date("2026-04-26T20:25:00Z"), // 5 min ago
    };
    const tickets = [
      {
        id: "00000000-0000-4000-8000-00000000a001",
        code: "C1",
        status: "SCANNED",
      },
      {
        id: "00000000-0000-4000-8000-00000000a002",
        code: "C2",
        status: "SCANNED",
      },
    ];
    const tx = makeTx({ order, tickets });
    const { repos, clock } = makeDeps(tx);

    const result = await refundCashSale(
      { repos, clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.refundedTicketCount).toBe(2);
    expect(result.amountReturnedCents).toBe(6000);

    expect(tx.tickets.setStatus).toHaveBeenCalledTimes(2);
    const firstTicket = tickets[0];
    expect(firstTicket).toBeDefined();
    expect(tx.tickets.setStatus).toHaveBeenCalledWith(
      (firstTicket as any).id,
      "REFUNDED",
      { scannedAt: null },
    );
    expect(tx.orders.markRefundedIfSucceeded).toHaveBeenCalledWith(ORDER_ID);
    // Promo holds released — same call the online refund path makes.
    expect(tx.promos.releaseHoldsForOrder).toHaveBeenCalledWith(ORDER_ID);
    // Fee-waiver allowance comes back with the sale (a no-op when none).
    expect(tx.feeWaivers.release).toHaveBeenCalledWith(ORDER_ID);
    // A pre-pricing cash order wrote no CASH_SALE_DEBIT, so there is nothing
    // to reverse and the ledger is untouched.
    expect(tx._ledger.entries).toHaveLength(0);

    const auditArg = (tx.audit.log.mock.calls as any[])[0]?.[0] as any;
    expect(auditArg.action).toBe("pos_cash_refund");
    expect(auditArg.data.channel).toBe("CASH");
    expect(auditArg.data.moneyMoved).toBe(false);
    expect(auditArg.data.actorHumanId).toBe(ACTOR);
  });

  // Owner ruling 2026-10-10: a refund of a scanned-in ticket means the person
  // left. The void clears `scannedAt`, so the audit row is the only record
  // that the ticket had admitted someone.
  describe("leftOnRefund on the audit row", () => {
    const TICKET_IN = "00000000-0000-4000-8000-00000000a011";
    const TICKET_OUT = "00000000-0000-4000-8000-00000000a012";
    const cashOrder = () => ({
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 6000,
      occurredAt: new Date("2026-04-26T20:25:00Z"), // 5 min ago
    });
    /**
     * Make the fake write what the real one writes, ON THE ROW THE READ
     * RETURNED: a list taken after the void then finds no SCANNED ticket.
     */
    const voidInPlace = (tx: ReturnType<typeof makeTx>, rows: Array<any>) => {
      tx.tickets.setStatus.mockImplementation((async (
        id: string,
        status: string,
      ) => {
        const row = rows.find((t) => t.id === id);
        if (row) {
          row.status = status;
          row.scannedAt = null;
        }
      }) as any);
    };

    it("lists exactly the scanned ticket with its admit time", async () => {
      const tickets = [
        {
          id: TICKET_IN,
          code: "C1",
          status: "SCANNED",
          scannedAt: new Date("2026-04-26T20:26:30.000Z"),
        },
        { id: TICKET_OUT, code: "C2", status: "VALID", scannedAt: null },
      ];
      const tx = makeTx({ order: cashOrder(), tickets });
      voidInPlace(tx, tickets);
      const { repos, clock } = makeDeps(tx);

      const result = await refundCashSale(
        { repos, clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      );

      expect(result.refundedTicketCount).toBe(2);
      expect(tickets.map((t) => t.status)).toEqual(["REFUNDED", "REFUNDED"]);
      const auditArg = (tx.audit.log.mock.calls as any[])[0]?.[0] as any;
      expect(auditArg.action).toBe("pos_cash_refund");
      expect(auditArg.data.leftOnRefund).toEqual([
        { ticketId: TICKET_IN, admittedAt: "2026-04-26T20:26:30.000Z" },
      ]);
    });

    it("writes no leftOnRefund key when no refunded ticket had been scanned", async () => {
      const tickets = [
        { id: TICKET_IN, code: "C1", status: "VALID", scannedAt: null },
        { id: TICKET_OUT, code: "C2", status: "VALID", scannedAt: null },
      ];
      const tx = makeTx({ order: cashOrder(), tickets });
      voidInPlace(tx, tickets);
      const { repos, clock } = makeDeps(tx);

      await refundCashSale(
        { repos, clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      );

      const auditArg = (tx.audit.log.mock.calls as any[])[0]?.[0] as any;
      expect(auditArg.action).toBe("pos_cash_refund");
      expect(auditArg.data).not.toHaveProperty("leftOnRefund");
    });
  });

  it("refunds a fully-comped ($0) sale: revokes the tickets, moves no money", async () => {
    // Comps are recorded with amountCollectedCents: 0 (and a 100%-discount
    // promo lands in the same place). The refund still has real work to do —
    // the tickets were auto-admitted at sale time, so refunding must yank
    // that admission — but the money side is a $0.00 no-op.
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 0,
      occurredAt: new Date("2026-04-26T20:25:00Z"), // 5 min ago
    };
    const tickets = [
      {
        id: "00000000-0000-4000-8000-00000000a003",
        code: "COMP1",
        status: "SCANNED",
      },
    ];
    const tx = makeTx({ order, tickets });
    const { repos, clock } = makeDeps(tx);

    const result = await refundCashSale(
      { repos, clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.amountReturnedCents).toBe(0);
    expect(result.refundedTicketCount).toBe(1);

    // The admission is revoked even though no money moves.
    expect(tx.tickets.setStatus).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-00000000a003",
      "REFUNDED",
      { scannedAt: null },
    );
    expect(tx.orders.markRefundedIfSucceeded).toHaveBeenCalledWith(ORDER_ID);

    const auditArg = (tx.audit.log.mock.calls as any[])[0]?.[0] as any;
    expect(auditArg.data.amountReturnedCents).toBe(0);
    expect(auditArg.data.moneyMoved).toBe(false);
  });

  it("rejects refund outside the 15-minute gate window", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 3000,
      occurredAt: new Date("2026-04-26T20:00:00Z"), // 30 min ago
    };
    const tx = makeTx({ order });
    const { repos, clock } = makeDeps(tx);

    await expect(
      refundCashSale(
        { repos, clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "gate_refund_window_expired",
    });

    expect(tx.tickets.setStatus).not.toHaveBeenCalled();
    expect(tx.orders.markRefundedIfSucceeded).not.toHaveBeenCalled();
  });

  it("rejects POS card orders (use refundPosSale)", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "POS",
      amountGrossCents: 3000,
      occurredAt: NOW,
    };
    const tx = makeTx({ order });
    const { repos, clock } = makeDeps(tx);

    await expect(
      refundCashSale(
        { repos, clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_A_CASH_ORDER" });
  });

  it("requires ORG_EDIT_ROLES — SCANNER alone is rejected", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 0,
      occurredAt: NOW,
    };
    const tx = makeTx({ order, membership: { role: "SCANNER" } });
    const { repos, clock } = makeDeps(tx);

    await expect(
      refundCashSale(
        { repos, clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("is idempotent — re-refunding an already-REFUNDED CASH order returns the same shape", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "REFUNDED",
      paymentChannel: "CASH",
      amountGrossCents: 3000,
      occurredAt: NOW,
    };
    const tickets = [{ id: "t1", code: "C1", status: "REFUNDED" }];
    const tx = makeTx({ order, tickets });
    const { repos, clock } = makeDeps(tx);

    const result = await refundCashSale(
      { repos, clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.refundedTicketCount).toBe(1);
    expect(result.amountReturnedCents).toBe(3000);
    expect(tx.tickets.setStatus).not.toHaveBeenCalled();
    expect(tx.orders.markRefundedIfSucceeded).not.toHaveBeenCalled();
  });

  it("rejects refund of a non-SUCCEEDED order (e.g. PENDING)", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "PENDING",
      paymentChannel: "CASH",
      amountGrossCents: 3000,
      occurredAt: NOW,
    };
    const tx = makeTx({ order });
    const { repos, clock } = makeDeps(tx);

    await expect(
      refundCashSale(
        { repos, clock },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "order_not_refundable",
    });
  });

  // ── Reserved seats ────────────────────────────────────────────────────────

  it("returns the seats of the tickets it revokes", async () => {
    const SEAT_1 = "00000000-0000-4000-8000-00000000b001";
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 6000,
      occurredAt: new Date("2026-04-26T20:25:00Z"),
    };
    const tickets = [
      {
        id: "00000000-0000-4000-8000-00000000a010",
        code: "S1",
        status: "SCANNED",
        seatId: SEAT_1,
      },
      {
        id: "00000000-0000-4000-8000-00000000a011",
        code: "G1",
        status: "VALID",
        seatId: null,
      },
    ];
    const tx = makeTx({ order, tickets });
    const { repos, clock } = makeDeps(tx);

    await refundCashSale(
      { repos, clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(tx.tickets.clearSeatAssignments).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-00000000a010",
    ]);
    // SOLD seat → the HELD-gated `releaseSeats` would no-op; the unguarded
    // write is correct because these ids come from tickets voided in this tx.
    expect(tx.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_1],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    expect(tx.seats.releaseSeats).not.toHaveBeenCalled();

    const auditArg = (tx.audit.log.mock.calls as any[])[0]?.[0] as any;
    expect(auditArg.data.releasedSeatIds).toEqual([SEAT_1]);
  });

  it("touches no seat for a GA-only cash sale", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 3000,
      occurredAt: new Date("2026-04-26T20:25:00Z"),
    };
    const tickets = [
      {
        id: "00000000-0000-4000-8000-00000000a012",
        code: "G2",
        status: "VALID",
        seatId: null,
      },
    ];
    const tx = makeTx({ order, tickets });
    const { repos, clock } = makeDeps(tx);

    await refundCashSale(
      { repos, clock },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(tx.seats.updateStatuses).not.toHaveBeenCalled();
    expect(tx.tickets.clearSeatAssignments).not.toHaveBeenCalled();
  });
});
