import { describe, expect, it, vi } from "vitest";

import { makeTicketsRepo } from "../tickets";
import type { PrismaClientOrTx } from "../types";

const createPrisma = () => {
  const findMany = vi.fn();
  const count = vi.fn();
  const findUnique = vi.fn();
  const updateMany = vi.fn();
  const $queryRaw = vi.fn();

  const prisma = {
    ticket: {
      findMany,
      count,
      findUnique,
      updateMany,
    },
    $queryRaw,
  } as unknown as PrismaClientOrTx;

  return { prisma, findMany, count, findUnique, updateMany, $queryRaw };
};

const ticketRow = (overrides: Record<string, unknown> = {}) => ({
  id: "ticket-1",
  eventId: "event-1",
  ticketTypeId: null,
  ownerHumanId: "human-1",
  orderId: null,
  orderItemId: null,
  seatId: null,
  code: "tk_0123456789abcdef01234567",
  status: "VALID",
  issuedAt: new Date("2026-01-01T00:00:00.000Z"),
  scannedAt: null,
  ...overrides,
});

describe("makeTicketsRepo activeTicketHolderHumanIds", () => {
  it("returns distinct owner humanIds of ACTIVE tickets (VALID | SCANNED | LISTED)", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findMany.mockResolvedValue([
      { ownerHumanId: "human-a" },
      { ownerHumanId: "human-b" },
    ]);

    const result = await repo.activeTicketHolderHumanIds("event-1");

    expect(findMany).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        status: { in: ["VALID", "SCANNED", "LISTED"] },
      },
      select: { ownerHumanId: true },
      distinct: ["ownerHumanId"],
    });
    expect(result).toEqual(["human-a", "human-b"]);
  });

  it("returns an empty list when the event has no active tickets", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findMany.mockResolvedValue([]);

    await expect(repo.activeTicketHolderHumanIds("event-1")).resolves.toEqual(
      [],
    );
  });
});

describe("makeTicketsRepo listEventIdsWithActiveTicket", () => {
  it("one query for the batch, same ACTIVE set as hasActiveTicketForEvent, de-duplicated ids", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findMany.mockResolvedValue([{ eventId: "event-1" }]);

    const result = await repo.listEventIdsWithActiveTicket("human-1", [
      "event-1",
      "event-2",
      "event-1",
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        eventId: { in: ["event-1", "event-2"] },
        ownerHumanId: "human-1",
        status: { in: ["VALID", "SCANNED", "LISTED"] },
      },
      select: { eventId: true },
      distinct: ["eventId"],
    });
    expect(result).toEqual(["event-1"]);
  });

  it("an empty batch reads nothing", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);

    await expect(repo.listEventIdsWithActiveTicket("human-1", [])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getByCode — exact-first, case-insensitive fallback
//
// Regression guard for the P0 scan outage: `Ticket.code` is a plain
// case-sensitive unique column and real codes are lowercase
// (`tk_<hex>`), so any case mangling on the way in guarantees a miss.
// ─────────────────────────────────────────────────────────────────────────────

describe("makeTicketsRepo getByCode", () => {
  const REAL_CODE = "tk_0123456789abcdef01234567";

  it("resolves a real lowercase `tk_` code via the exact unique-index fast path", async () => {
    const { prisma, findUnique, $queryRaw } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findUnique.mockResolvedValue(ticketRow({ code: REAL_CODE }));

    const result = await repo.getByCode(REAL_CODE);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: REAL_CODE } }),
    );
    // Fast path must not pay for the fallback query.
    expect($queryRaw).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "ticket-1", code: REAL_CODE });
  });

  it("resolves a hyphenated seed code via the exact fast path", async () => {
    const { prisma, findUnique, $queryRaw } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findUnique.mockResolvedValue(ticketRow({ code: "SEED-E01-001-1" }));

    const result = await repo.getByCode("SEED-E01-001-1");

    expect($queryRaw).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: "SEED-E01-001-1" });
  });

  it("falls back to a case-insensitive full-string match when the exact lookup misses", async () => {
    const { prisma, findUnique, $queryRaw } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    // Operator typed the code in upper case; the stored row is lowercase.
    findUnique
      .mockResolvedValueOnce(null) // exact miss
      .mockResolvedValueOnce(ticketRow({ code: REAL_CODE })); // re-read by id
    $queryRaw.mockResolvedValue([{ id: "ticket-1" }]);

    const result = await repo.getByCode(REAL_CODE.toUpperCase());

    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: "ticket-1", code: REAL_CODE });
    // The re-read goes by primary key, not by the (wrong-case) code.
    expect(findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: "ticket-1" } }),
    );
  });

  it("binds the code as a parameter and compares full strings — never LIKE/ILIKE or a prefix", async () => {
    const { prisma, findUnique, $queryRaw } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    $queryRaw.mockResolvedValue([]);

    await repo.getByCode(REAL_CODE.toUpperCase());

    const [strings, ...values] = $queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    // Parameterised, never interpolated.
    expect(values).toEqual([REAL_CODE.toUpperCase(), REAL_CODE.toUpperCase()]);
    expect(sql).not.toContain(REAL_CODE.toUpperCase());
    // Full-string equality only. ILIKE would treat the `_` in `tk_` as a
    // single-character wildcard, letting `tk_abc…` match `tkXabc…`.
    expect(sql).toMatch(/lower\("code"\)\s*=\s*lower\(/);
    expect(sql).not.toMatch(/LIKE/i);
    expect(sql).not.toContain("%");
    // Deterministic when two rows fold together: binary-exact wins.
    expect(sql).toMatch(/ORDER BY\s*\("code"\s*=/);
    expect(sql).toMatch(/LIMIT 1/);
  });

  it("returns null when neither the exact nor the case-insensitive lookup matches", async () => {
    const { prisma, findUnique, $queryRaw } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findUnique.mockResolvedValue(null);
    $queryRaw.mockResolvedValue([]);

    await expect(repo.getByCode("tk_nosuchticketcodeatall")).resolves.toBeNull();
  });
});

describe("makeTicketsRepo listScansByTicketIds", () => {
  it("returns [] without querying for an empty id list", async () => {
    const scanFindMany = vi.fn();
    const prisma = { ticketScan: { findMany: scanFindMany } } as unknown as PrismaClientOrTx;
    const repo = makeTicketsRepo(prisma);
    expect(await repo.listScansByTicketIds([])).toEqual([]);
    expect(scanFindMany).not.toHaveBeenCalled();
  });

  it("fetches every ticket's scans in ONE query, ordered scannedAt ASC, id ASC", async () => {
    const scanFindMany = vi.fn().mockResolvedValue([
      {
        id: "scan-1",
        ticketId: "ticket-1",
        eventId: "event-1",
        actorHumanId: "human-9",
        outcome: "ACCEPTED",
        message: null,
        scannedAt: new Date("2026-01-01T00:00:00.000Z"),
        lat: null,
        lng: null,
        actor: { name: "Door" },
      },
    ]);
    const prisma = { ticketScan: { findMany: scanFindMany } } as unknown as PrismaClientOrTx;
    const repo = makeTicketsRepo(prisma);

    const result = await repo.listScansByTicketIds(["ticket-1", "ticket-2"]);

    expect(scanFindMany).toHaveBeenCalledTimes(1);
    expect(scanFindMany.mock.calls[0]![0]).toMatchObject({
      where: { ticketId: { in: ["ticket-1", "ticket-2"] } },
      orderBy: [{ scannedAt: "asc" }, { id: "asc" }],
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: "scan-1",
        ticketId: "ticket-1",
        actorName: "Door",
        outcome: "ACCEPTED",
        locationLat: null,
      }),
    ]);
  });
});
describe("makeTicketsRepo seat occupancy", () => {
  // Reading seat occupancy without a status filter is what made every refunded
  // reserved seat permanently unsellable: the dead row threw `seat_taken` at
  // the next buyer forever. Voided tickets now give the `seatId` up, so a
  // terminal row still holding one is pre-fix history or a backfill artefact —
  // and the filter is what keeps it from re-locking the seat.
  it("findBySeatIds returns only tickets that still OWN the seat", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findMany.mockResolvedValue([ticketRow({ seatId: "seat-1" })]);

    await repo.findBySeatIds(["seat-1", "seat-2"]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seatId: { in: ["seat-1", "seat-2"] },
          status: { in: ["VALID", "SCANNED", "LISTED"] },
        },
      }),
    );
  });

  it("findBySeatIds short-circuits on an empty list", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);

    await expect(repo.findBySeatIds([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("findBySeatIdsIncludingTerminal returns EVERY row, dead ones included", async () => {
    // The unfiltered twin, for mint's @unique pre-flight only. A REFUNDED row
    // still pointing at a seat cannot block a sale, but it DOES make
    // `ticket.create` throw P2002 after the buyer is charged — mint has to see
    // it to refuse first.
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    findMany.mockResolvedValue([
      ticketRow({ seatId: "seat-1", status: "REFUNDED" }),
    ]);

    const rows = await repo.findBySeatIdsIncludingTerminal([
      "seat-1",
      "seat-2",
    ]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { seatId: { in: ["seat-1", "seat-2"] } },
      }),
    );
    // No status filter, ever — that is the entire point of this method.
    const call = findMany.mock.calls[0]![0] as { where: { status?: unknown } };
    expect(call.where.status).toBeUndefined();
    expect(rows.map((r) => r.status)).toEqual(["REFUNDED"]);
  });

  it("findBySeatIdsIncludingTerminal short-circuits on an empty list", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);

    await expect(repo.findBySeatIdsIncludingTerminal([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("clearSeatAssignments drops the seat link of voided tickets", async () => {
    // `Ticket.seatId` is @unique: while a dead ticket holds it, the next
    // buyer's MINT fails with P2002 — after their card has been charged.
    const { prisma, updateMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);
    updateMany.mockResolvedValue({ count: 2 });

    await repo.clearSeatAssignments(["ticket-1", "ticket-2"]);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["ticket-1", "ticket-2"] } },
      data: { seatId: null },
    });
  });

  it("clearSeatAssignments short-circuits on an empty list", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makeTicketsRepo(prisma);

    await repo.clearSeatAssignments([]);

    expect(updateMany).not.toHaveBeenCalled();
  });
});
