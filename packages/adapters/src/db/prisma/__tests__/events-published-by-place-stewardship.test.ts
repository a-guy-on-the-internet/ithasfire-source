import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

/**
 * `stewardship` / `excludeVenueConfirmationWithdrawn` on
 * `listPublishedByPlace` (community-listings-at-claimed-venues).
 *
 * WHY THESE ARE QUERY PREDICATES AND NOT POST-FILTERS, which is the only thing
 * worth pinning here: `limit` becomes a SQL `take`. A caller that asks for 100
 * rows and then keeps the COMMUNITY ones has bought "the listings among the
 * 100 soonest events at this venue", not "100 listings" — and at a venue
 * programming its own room five nights a week the soonest 100 are almost all
 * OWNED, so the listings fall off the end while the page still looks full.
 * Hence: in the `where`, above the `take`.
 *
 * Pure unit test against a mocked Prisma client (the pattern in
 * `events-place-range-date-occurrences.test.ts`) — no container, no database.
 */

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2027-09-05T00:00:00.000Z");

function makePrisma() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma = { event: { findMany, count } } as unknown as PrismaClientOrTx;
  return { prisma, findMany, count };
}

const baseInput = {
  placeId: "place-a",
  from: FROM,
  to: TO,
  status: "upcoming" as const,
};

describe("makeEventsRepo.listPublishedByPlace — stewardship", () => {
  it("OMITTED: the WHERE is byte-identical for every existing caller", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace(baseInput);

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: "place-a",
      startsAt: { gte: FROM, lte: TO },
    });
    expect(where.stewardship).toBeUndefined();
    expect(where.venueConfirmationWithdrawnAt).toBeUndefined();
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("COMMUNITY lands in the WHERE the take truncates, not after it", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...baseInput,
      stewardship: "COMMUNITY",
      limit: 40,
    });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where).toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: "place-a",
      stewardship: "COMMUNITY",
      startsAt: { gte: FROM, lte: TO },
    });
    // The predicate and the truncation must be in the SAME query, or the
    // budget buys the wrong rows.
    expect(args.take).toBe(40);
    expect(count).toHaveBeenCalledWith({ where: args.where });
  });

  it("OWNED works too — the param is a filter, not a community special case", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...baseInput,
      stewardship: "OWNED",
    });

    expect((findMany.mock.calls[0]![0] as any).where.stewardship).toBe("OWNED");
  });

  it("excludeVenueConfirmationWithdrawn adds the null check; omitted adds nothing", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);

    await repo.listPublishedByPlace({
      ...baseInput,
      excludeVenueConfirmationWithdrawn: true,
    });
    await repo.listPublishedByPlace({
      ...baseInput,
      excludeVenueConfirmationWithdrawn: false,
    });

    expect(
      (findMany.mock.calls[0]![0] as any).where.venueConfirmationWithdrawnAt,
    ).toBeNull();
    // Explicit `false` must behave exactly like omitted — a caller threading a
    // boolean through must not accidentally opt in.
    expect(
      (findMany.mock.calls[1]![0] as any).where,
    ).not.toHaveProperty("venueConfirmationWithdrawnAt");
  });

  it("both filters compose with each other and with includeDateOccurrences", async () => {
    // This is the exact shape `setPlaceCommunityListingAcceptance` issues.
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...baseInput,
      stewardship: "COMMUNITY",
      excludeVenueConfirmationWithdrawn: true,
      includeDateOccurrences: true,
      limit: 100,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: "place-a",
      stewardship: "COMMUNITY",
      venueConfirmationWithdrawnAt: null,
      OR: [
        { startsAt: { gte: FROM, lte: TO } },
        {
          dates: {
            some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } },
          },
        },
      ],
    });
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("does not collide with venueConfirmedFor's AND fragment", async () => {
    // `excludeVenueConfirmationWithdrawn` is a TOP-LEVEL key and
    // `venueConfirmedFor` builds an `AND` array; one must not clobber the
    // other.
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      ...baseInput,
      stewardship: "COMMUNITY",
      excludeVenueConfirmationWithdrawn: true,
      venueConfirmedFor: { orgIds: ["org-a"], humanIds: [] },
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where.venueConfirmationWithdrawnAt).toBeNull();
    expect(where.stewardship).toBe("COMMUNITY");
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND.length).toBeGreaterThan(0);
  });
});
