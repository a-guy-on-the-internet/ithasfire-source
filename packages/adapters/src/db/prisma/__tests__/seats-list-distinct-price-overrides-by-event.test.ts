import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { makeSeatsRepo } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// listDistinctPriceOverridesByEvent: the publish gate's read of the stored
// overrides.
//
// A stub, not a database (style of seats-price-overrides.test.ts): the point
// is the query this repo builds and the override mapping. It must scope to
// the event through SeatSection, read only seats that carry an override
// (SQL NULL and JSON null dropped), collapse identical (section, override)
// pairs, never lock, and keep a corrupt value as `{ invalid: true }` (never
// "no override", never thrown) so publish can count it.
// ---------------------------------------------------------------------------

const EVENT_ID = "event-1";

function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const sql = call[0] as Prisma.Sql;
  return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
}

describe("makeSeatsRepo.listDistinctPriceOverridesByEvent", () => {
  it("reads distinct (section, override) pairs of the event in one unlocked query", async () => {
    const $queryRaw = vi.fn(async () => []);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    await repo.listDistinctPriceOverridesByEvent({ eventId: EVENT_ID });

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf($queryRaw.mock.calls[0] as unknown[]);
    expect(text).toContain('SELECT DISTINCT s."seatSectionId"');
    expect(text).toContain("s.price_override");
    expect(text).toContain('INNER JOIN "SeatSection" ss');
    expect(text).toContain('WHERE ss."eventId" =');
    // Drops SQL NULL and JSON null alike: the complement of the "no
    // override" predicate the auto-assign queries use.
    expect(text).toContain(
      "AND s.price_override IS NOT NULL AND s.price_override <> 'null'::jsonb",
    );
    expect(values).toEqual([EVENT_ID]);
    expect(text).not.toContain("FOR UPDATE");
    expect(text).not.toContain("FOR SHARE");
  });

  it("maps each stored value leniently: the override, or the invalid marker", async () => {
    const $queryRaw = vi.fn(async () => [
      { seatSectionId: "section-1", price_override: { priceCents: 5000, reason: "piano side" } },
      { seatSectionId: "section-1", price_override: { priceCents: 0 } },
      { seatSectionId: "section-2", price_override: { priceCents: "5000" } },
      { seatSectionId: "section-2", price_override: 5000 },
      { seatSectionId: "section-3", price_override: { reason: "vip" } },
      { seatSectionId: "section-3", price_override: { priceCents: -100 } },
    ]);
    const repo = makeSeatsRepo({ $queryRaw } as unknown as PrismaClientOrTx);

    const rows = await repo.listDistinctPriceOverridesByEvent({
      eventId: EVENT_ID,
    });

    expect(rows).toEqual([
      {
        seatSectionId: "section-1",
        priceOverride: { priceCents: 5000, reason: "piano side" },
      },
      { seatSectionId: "section-1", priceOverride: { priceCents: 0, reason: null } },
      { seatSectionId: "section-2", priceOverride: { invalid: true } },
      { seatSectionId: "section-2", priceOverride: { invalid: true } },
      { seatSectionId: "section-3", priceOverride: { invalid: true } },
      // Range is core's call (classifySeatOverride), as for the other reads.
      {
        seatSectionId: "section-3",
        priceOverride: { priceCents: -100, reason: null },
      },
    ]);
  });
});
