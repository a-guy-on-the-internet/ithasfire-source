import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { makeSeatsRepo } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// The seat reads checkout prices from (seat-price-overrides spec FR-003):
//
//   findPriceOverridesByIds — the UNLOCKED pre-read the cart is priced from.
//                             Must not lock: it runs before the capacity lock,
//                             which must precede every Seat lock.
//   findByIdsForUpdate      — the LOCKED re-read. Must carry price_override,
//                             or checkout compares every seat against "none"
//                             and the binding check is a no-op.
//   reserveForHold          — auto-assignment. Must never hand out a seat
//                             with an override: the buyer never saw it.
//
// A stub, not a database: the point is the query this repo builds, and these
// assertions fail the moment a predicate or column is dropped. The real-SQL
// counterpart is seats-price-overrides.integration.test.ts.
// ---------------------------------------------------------------------------

const EVENT_ID = "event-1";
const SECTION_ID = "section-1";

function sqlText(call: unknown[]): string {
  return (call[0] as Prisma.Sql).sql.replace(/\s+/g, " ");
}

function seatRow(id: string, priceOverride: unknown) {
  return {
    id,
    seatSectionId: SECTION_ID,
    label: id,
    row: "A",
    number: 1,
    status: "AVAILABLE",
    eventId: EVENT_ID,
    price_override: priceOverride,
  };
}

describe("makeSeatsRepo.findByIdsForUpdate", () => {
  it("selects price_override under FOR UPDATE and maps it onto every row", async () => {
    const $queryRaw = vi.fn(async () => [
      seatRow("seat-a", { priceCents: 5000, reason: "piano side" }),
      seatRow("seat-b", null),
      seatRow("seat-c", { priceCents: 0 }),
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const rows = await repo.findByIdsForUpdate({
      seatIds: ["seat-a", "seat-b", "seat-c"],
      eventId: EVENT_ID,
    });

    const sql = sqlText($queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain("s.price_override");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain('ss."eventId" =');
    expect(rows.map((r) => r.priceOverride)).toEqual([
      { priceCents: 5000, reason: "piano side" },
      null,
      { priceCents: 0, reason: null },
    ]);
  });
});

describe("a corrupt override is REPORTED by the checkout reads, never read as none and never thrown", () => {
  // `reserveForHold` / `pickContiguousAvailable` treat every non-null value
  // as overridden and skip it, so reading a corrupt value as "none" would
  // charge the tier price for a seat auto-assign considers overridden. But
  // mint (after the charge), the ticket email and the resale listing lock
  // seats through `findByIdsForUpdate` too, so the adapter must not throw:
  // it returns `{ invalid: true }` and checkout refuses it in core.
  it.each([
    ["a string amount", { priceCents: "5000" }],
    ["no amount", { reason: "vip" }],
    ["a bare number", 5000],
    ["a string", "5000"],
  ])("findByIdsForUpdate returns the seat with an invalid marker for %s", async (_l, raw) => {
    const $queryRaw = vi.fn(async () => [seatRow("seat-bad", raw)]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const rows = await repo.findByIdsForUpdate({
      seatIds: ["seat-bad"],
      eventId: EVENT_ID,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "seat-bad",
      status: "AVAILABLE",
      priceOverride: { invalid: true },
    });
  });

  it("findPriceOverridesByIds reports it the same way", async () => {
    const $queryRaw = vi.fn(async () => [
      { id: "seat-bad", price_override: { priceCents: "5000" } },
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);
    expect(
      await repo.findPriceOverridesByIds({ seatIds: ["seat-bad"], eventId: EVENT_ID }),
    ).toEqual([{ id: "seat-bad", priceOverride: { invalid: true } }]);
  });

  it("range is core's: a negative number passes through for seatOverrideCents to refuse", async () => {
    const $queryRaw = vi.fn(async () => [
      { id: "seat-neg", price_override: { priceCents: -5 } },
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);
    expect(
      await repo.findPriceOverridesByIds({ seatIds: ["seat-neg"], eventId: EVENT_ID }),
    ).toEqual([{ id: "seat-neg", priceOverride: { priceCents: -5, reason: null } }]);
  });

  it("the display read stays lenient, so one bad row cannot blank a seat map", async () => {
    const $queryRaw = vi.fn(async () => [seatRow("seat-bad", { priceCents: "5000" })]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);
    const rows = await repo.listByEvent({ eventId: EVENT_ID });
    expect(rows[0]!.priceOverride).toBeNull();
  });
});

describe("makeSeatsRepo.findPriceOverridesByIds", () => {
  it("reads price_override scoped to the event WITHOUT a lock", async () => {
    const $queryRaw = vi.fn(async () => [
      {
        id: "seat-a",
        seatSectionId: "section-1",
        price_override: { priceCents: 5000 },
      },
      { id: "seat-b", seatSectionId: "section-2", price_override: null },
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const rows = await repo.findPriceOverridesByIds({
      seatIds: ["seat-a", "seat-b", "seat-a"],
      eventId: EVENT_ID,
    });

    const call = $queryRaw.mock.calls[0] as unknown[];
    const sql = sqlText(call);
    expect(sql).toContain("s.price_override");
    expect(sql).toContain('ss."eventId" =');
    expect(sql).not.toContain("FOR UPDATE");
    expect((call[0] as Prisma.Sql).values).toEqual([
      "seat-a",
      "seat-b",
      EVENT_ID,
    ]);
    // The section rides along: the promo preview prices a seat at its
    // override only in the section its tier sells.
    expect(sql).toContain('s."seatSectionId"');
    expect(rows).toEqual([
      {
        id: "seat-a",
        seatSectionId: "section-1",
        priceOverride: { priceCents: 5000, reason: null },
      },
      { id: "seat-b", seatSectionId: "section-2", priceOverride: null },
    ]);
  });

  it("skips the query for an empty request", async () => {
    const $queryRaw = vi.fn();
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);
    expect(
      await repo.findPriceOverridesByIds({ seatIds: [], eventId: EVENT_ID }),
    ).toEqual([]);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("makeSeatsRepo.reserveForHold", () => {
  it("never auto-assigns a seat that carries a price override", async () => {
    const $queryRaw = vi.fn(async () => [seatRow("seat-b", null)]);
    const prisma = {
      $queryRaw,
      seatSection: {
        findUnique: vi.fn(async () => ({
          id: SECTION_ID,
          eventId: EVENT_ID,
          type: "RESERVED",
          capacity: null,
        })),
      },
      seat: { updateMany: vi.fn(async () => ({ count: 1 })) },
    } as unknown as PrismaClientOrTx;

    const held = await makeSeatsRepo(prisma).reserveForHold({
      seatSectionId: SECTION_ID,
      eventId: EVENT_ID,
      qty: 1,
      heldAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const sql = sqlText($queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain(
      "AND (s.price_override IS NULL OR s.price_override = 'null'::jsonb)",
    );
    expect(sql).toContain("FOR UPDATE");
    expect(held.map((s) => s.id)).toEqual(["seat-b"]);
  });
});

describe("makeSeatsRepo.pickContiguousAvailable (the door)", () => {
  function makePrisma(rows: unknown[]) {
    const $queryRaw = vi.fn(async () => rows);
    const prisma = {
      $queryRaw,
      seatSection: {
        findUnique: vi.fn(async () => ({ id: SECTION_ID, eventId: EVENT_ID })),
      },
    } as unknown as PrismaClientOrTx;
    return { prisma, $queryRaw };
  }

  it("never picks a seat that carries a price override, and keeps FOR UPDATE and the row order", async () => {
    const { prisma, $queryRaw } = makePrisma([seatRow("seat-b", null)]);

    const picked = await makeSeatsRepo(prisma).pickContiguousAvailable({
      seatSectionId: SECTION_ID,
      eventId: EVENT_ID,
      qty: 1,
    });

    const sql = sqlText($queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain(
      "AND (s.price_override IS NULL OR s.price_override = 'null'::jsonb)",
    );
    expect(sql).toContain(
      'ORDER BY s.row NULLS LAST, s.number ASC, s."createdAt" ASC FOR UPDATE',
    );
    expect(picked.map((s) => s.id)).toEqual(["seat-b"]);
  });

  it("a short pick still comes back empty", async () => {
    const { prisma } = makePrisma([seatRow("seat-b", null)]);
    expect(
      await makeSeatsRepo(prisma).pickContiguousAvailable({
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        qty: 2,
      }),
    ).toEqual([]);
  });
});

describe("makeSeatsRepo.updatePriceOverrides (the organizer's write)", () => {
  function makePrisma(count: number) {
    const $executeRaw = vi.fn(async () => count);
    const prisma = { $executeRaw } as unknown as PrismaClientOrTx;
    return { prisma, $executeRaw };
  }

  // A SOLD seat keeps the price it was charged; a HELD seat belongs to a live
  // checkout priced with the current override. The predicate rides the UPDATE
  // itself, for a set AND a clear.
  it.each([
    ["a set", { priceCents: 5000, reason: "piano side" }],
    ["a clear", null],
  ] as const)(
    "%s touches only AVAILABLE and BLOCKED seats of the event",
    async (_label, priceOverride) => {
      const { prisma, $executeRaw } = makePrisma(2);

      const updated = await makeSeatsRepo(prisma).updatePriceOverrides({
        seatIds: ["seat-a", "seat-b", "seat-a"],
        eventId: EVENT_ID,
        priceOverride,
      });

      expect(updated).toBe(2);
      expect($executeRaw).toHaveBeenCalledTimes(1);
      const call = $executeRaw.mock.calls[0] as unknown[];
      const sql = sqlText(call);
      expect(sql).toContain("AND s.status IN ('AVAILABLE', 'BLOCKED')");
      expect(sql).toContain('AND ss."eventId" = ');
      const values = (call[0] as Prisma.Sql).values;
      expect(values).toContain(EVENT_ID);
      // Duplicate ids collapse before the statement.
      expect(values.filter((v) => v === "seat-a")).toHaveLength(1);
      expect(sql).toContain(
        priceOverride ? "SET price_override = " : "SET price_override = NULL",
      );
    },
  );

  it("skips the statement for an empty request", async () => {
    const { prisma, $executeRaw } = makePrisma(0);
    expect(
      await makeSeatsRepo(prisma).updatePriceOverrides({
        seatIds: [],
        eventId: EVENT_ID,
        priceOverride: null,
      }),
    ).toBe(0);
    expect($executeRaw).not.toHaveBeenCalled();
  });
});

describe("makeSeatsRepo.lockSeatsForPriceOverrideWrite (never waits on a row lock)", () => {
  const row = (id: string, status = "AVAILABLE") => ({
    id,
    seatSectionId: SECTION_ID,
    status,
  });

  it("locks Seat rows only, in id order, skipping rows another transaction holds", async () => {
    const $queryRaw = vi
      .fn()
      .mockResolvedValueOnce([row("seat-a"), row("seat-c", "SOLD")])
      .mockResolvedValueOnce([row("seat-b", "HELD")]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const seats = await repo.lockSeatsForPriceOverrideWrite({
      seatIds: ["seat-a", "seat-b", "seat-c", "seat-gone", "seat-a"],
      eventId: EVENT_ID,
    });

    const lockCall = $queryRaw.mock.calls[0] as unknown[];
    const lockSql = sqlText(lockCall);
    expect(lockSql).toContain("ORDER BY s.id FOR NO KEY UPDATE OF s SKIP LOCKED");
    expect(lockSql).toContain('WHERE ss."eventId" = ');
    expect((lockCall[0] as Prisma.Sql).values).toEqual([
      EVENT_ID,
      "seat-a",
      "seat-b",
      "seat-c",
      "seat-gone",
    ]);

    // The busy read asks only for the ids the lock did not return, unlocked.
    const busyCall = $queryRaw.mock.calls[1] as unknown[];
    const busySql = sqlText(busyCall);
    expect(busySql).not.toMatch(/FOR (NO KEY )?UPDATE|FOR SHARE|FOR KEY SHARE/);
    expect(busySql).toContain('WHERE ss."eventId" = ');
    expect((busyCall[0] as Prisma.Sql).values).toEqual([
      EVENT_ID,
      "seat-b",
      "seat-gone",
    ]);

    expect(seats).toEqual([
      { id: "seat-a", seatSectionId: SECTION_ID, status: "AVAILABLE", busy: false },
      { id: "seat-c", seatSectionId: SECTION_ID, status: "SOLD", busy: false },
      { id: "seat-b", seatSectionId: SECTION_ID, status: "HELD", busy: true },
    ]);
  });

  it("skips the busy read when every seat was locked, and both reads for an empty request", async () => {
    const $queryRaw = vi.fn().mockResolvedValueOnce([row("seat-a")]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    await repo.lockSeatsForPriceOverrideWrite({
      seatIds: ["seat-a"],
      eventId: EVENT_ID,
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);

    expect(
      await repo.lockSeatsForPriceOverrideWrite({ seatIds: [], eventId: EVENT_ID }),
    ).toEqual([]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});
