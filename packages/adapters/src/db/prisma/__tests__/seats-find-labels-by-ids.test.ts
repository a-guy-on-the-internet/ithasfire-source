import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { makeSeatsRepo } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// findLabelsByIds: the embed confirmation prints where each ticket sits.
//
// A stub, not a database (style of seats-list-price-overrides-by-event.test.ts):
// the point is the query. It must scope to the event through SeatSection,
// read the section's name, and NEVER lock: a read path must not wait on (or
// block) checkout, the door or mint the way `findByIdsForUpdate` does.
// ---------------------------------------------------------------------------

const EVENT_ID = "event-1";

function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const sql = call[0] as Prisma.Sql;
  return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
}

describe("makeSeatsRepo.findLabelsByIds", () => {
  it("reads the named seats of the event with their section name, in one query, without a lock", async () => {
    const $queryRaw = vi.fn(async () => [
      {
        id: "seat-a",
        label: "A2",
        row: "A",
        number: 2,
        seatSectionId: "section-1",
        sectionName: "Balcony Left",
      },
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const out = await repo.findLabelsByIds({
      seatIds: ["seat-a", "seat-b", "seat-a"],
      eventId: EVENT_ID,
    });

    expect(out).toEqual([
      {
        id: "seat-a",
        label: "A2",
        row: "A",
        number: 2,
        seatSectionId: "section-1",
        sectionName: "Balcony Left",
      },
    ]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf($queryRaw.mock.calls[0] as unknown[]);
    expect(text).toContain('ss.name as "sectionName"');
    expect(text).toContain('s."row", s."number", s."seatSectionId"');
    expect(text).toContain('INNER JOIN "SeatSection" ss');
    expect(text).toContain('ss."eventId" =');
    // Duplicates collapse; the event id is bound, never interpolated.
    expect(values).toEqual(["seat-a", "seat-b", EVENT_ID]);
    expect(text).not.toContain("FOR UPDATE");
    expect(text).not.toContain("FOR NO KEY UPDATE");
  });

  it("no ids: no query", async () => {
    const $queryRaw = vi.fn();
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    await expect(
      repo.findLabelsByIds({ seatIds: [], eventId: EVENT_ID }),
    ).resolves.toEqual([]);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
