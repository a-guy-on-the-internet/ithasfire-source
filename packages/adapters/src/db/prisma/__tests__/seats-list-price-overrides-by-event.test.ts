import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { makeSeatsRepo } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// listPriceOverridesByEvent: the organizer's override editor read.
//
// A stub, not a database (style of seats-price-overrides.test.ts): the point
// is the query this repo builds and the override mapping. It must scope to
// the event through SeatSection, select price_override, and keep a corrupt
// value as `{ invalid: true }` (never as "no override", never thrown), so the
// editor can flag the seat checkout refuses.
// ---------------------------------------------------------------------------

const EVENT_ID = "event-1";

function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const sql = call[0] as Prisma.Sql;
  return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
}

function row(id: string, priceOverride: unknown) {
  return {
    id,
    seatSectionId: "section-1",
    label: "A1",
    row: "A",
    number: 1,
    status: "AVAILABLE",
    price_override: priceOverride,
  };
}

describe("makeSeatsRepo.listPriceOverridesByEvent", () => {
  it("reads every seat of the event in one query, scoped through SeatSection", async () => {
    const $queryRaw = vi.fn(async () => []);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    await repo.listPriceOverridesByEvent({ eventId: EVENT_ID });

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf($queryRaw.mock.calls[0] as unknown[]);
    expect(text).toContain("s.price_override");
    expect(text).toContain('INNER JOIN "SeatSection" ss');
    expect(text).toContain('WHERE ss."eventId" =');
    expect(values).toEqual([EVENT_ID]);
    // A read, never a lock.
    expect(text).not.toContain("FOR UPDATE");
  });

  it("maps overrides leniently: none, the override with its reason, or the invalid marker", async () => {
    const $queryRaw = vi.fn(async () => [
      row("seat-a", { priceCents: 5000, reason: "piano side" }),
      row("seat-b", null),
      row("seat-c", { priceCents: 0 }),
      row("seat-d", { priceCents: "5000" }),
      row("seat-e", 5000),
      row("seat-f", { reason: "vip" }),
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const rows = await repo.listPriceOverridesByEvent({ eventId: EVENT_ID });

    expect(rows.map((r) => r.priceOverride)).toEqual([
      { priceCents: 5000, reason: "piano side" },
      null,
      { priceCents: 0, reason: null },
      { invalid: true },
      { invalid: true },
      { invalid: true },
    ]);
    expect(rows[0]).toEqual({
      id: "seat-a",
      seatSectionId: "section-1",
      status: "AVAILABLE",
      label: "A1",
      row: "A",
      number: 1,
      priceOverride: { priceCents: 5000, reason: "piano side" },
    });
  });
});
