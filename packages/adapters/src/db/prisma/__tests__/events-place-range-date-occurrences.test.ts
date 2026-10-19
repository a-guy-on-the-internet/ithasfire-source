import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

/**
 * `includeDateOccurrences` on the range reads the venue calendar and the
 * owner's dashboard calendar use (event-calendar-redesign FR-003).
 *
 * A recurring community listing is ONE `Event` whose `startsAt` mirrors its
 * first upcoming `EventDate`; every later night lives only in `EventDate`.
 * A plain `startsAt` window therefore never admits the event for a window a
 * month out, and the calendar paints nothing on nights the room is in fact
 * taken. With the flag, an event ALSO matches on a SCHEDULED row inside the
 * window. Two rules pinned here:
 *   - OFF (the default) leaves the WHERE byte-identical for existing callers;
 *   - ON adds the `dates.some` clause and never widens to CANCELLED rows.
 */

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-31T00:00:00.000Z");

function makePrisma() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma = { event: { findMany, count } } as unknown as PrismaClientOrTx;
  return { prisma, findMany, count };
}

describe("makeEventsRepo.listAllByPlace — includeDateOccurrences", () => {
  it("OFF: the pre-existing overlap window on the event's own span, unchanged", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listAllByPlace({ placeId: "place-a", from: FROM, to: TO });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      placeId: "place-a",
      status: { in: ["DRAFT", "PUBLISHED", "COMPLETED", "CANCELLED"] },
      startsAt: { lte: TO },
      endsAt: { gte: FROM },
    });
    expect(where.OR).toBeUndefined();
  });

  it("ON: ORs the span overlap with a SCHEDULED EventDate inside the window", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listAllByPlace({
      placeId: "place-a",
      from: FROM,
      to: TO,
      statuses: ["PUBLISHED"],
      includeDateOccurrences: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      placeId: "place-a",
      status: { in: ["PUBLISHED"] },
      OR: [
        { startsAt: { lte: TO }, endsAt: { gte: FROM } },
        { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } } } },
      ],
    });
  });
});

describe("makeEventsRepo.listByCalendar — includeDateOccurrences", () => {
  it("OFF: the plain startsAt window on Event.calendarId, byte-identical for existing callers", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listByCalendar({
      calendarId: "cal-a",
      from: FROM,
      to: TO,
      publishedOnly: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      calendarId: "cal-a",
      startsAt: { gte: FROM, lte: TO },
      status: "PUBLISHED",
      visibility: "PUBLIC",
    });
    expect(where.OR).toBeUndefined();
  });

  it("ON: keeps the calendarId + PUBLISHED/PUBLIC gate and ORs in the SCHEDULED EventDate window", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listByCalendar({
      calendarId: "cal-a",
      from: FROM,
      to: TO,
      publishedOnly: true,
      includeDateOccurrences: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      calendarId: "cal-a",
      status: "PUBLISHED",
      visibility: "PUBLIC",
      OR: [
        { startsAt: { gte: FROM, lte: TO } },
        { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } } } },
      ],
    });
  });
});

describe("makeEventsRepo.listPublishedByPlace — includeDateOccurrences", () => {
  it("OFF: the plain startsAt window, byte-identical for existing callers", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      placeId: "place-a",
      from: FROM,
      to: TO,
      status: "upcoming",
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: "place-a",
      startsAt: { gte: FROM, lte: TO },
    });
    // The count rides the same where — the total must describe the same set.
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("ON: keeps the PUBLISHED + PUBLIC gate and ORs in the SCHEDULED EventDate window; the count uses the same where", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listPublishedByPlace({
      placeId: "place-a",
      from: FROM,
      to: TO,
      status: "upcoming",
      includeDateOccurrences: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: "place-a",
      OR: [
        { startsAt: { gte: FROM, lte: TO } },
        { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } } } },
      ],
    });
    expect(count).toHaveBeenCalledWith({ where });
  });
});

/**
 * The owner read is different from the place reads in one way: its top-level
 * `OR` key is already owned by the text search, and its `AND` key by the
 * category "both" arm. The widened window therefore has to nest as a
 * conjunct under `AND` — a top-level `OR` would be overwritten by (or would
 * overwrite) the search arms.
 */
describe("makeEventsRepo.listByOwner — includeDateOccurrences", () => {
  it("OFF: the plain startsAt window, byte-identical for existing callers; count shares the where", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-a",
      dateRange: { from: FROM, to: TO },
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      orgId: "org-a",
      startsAt: { gte: FROM, lte: TO },
    });
    expect(where.OR).toBeUndefined();
    expect(where.AND).toBeUndefined();
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("ON: replaces the bare startsAt key with an AND-nested OR over the pin and a SCHEDULED EventDate; count shares the where", async () => {
    const { prisma, findMany, count } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ownerType: "HUMAN",
      ownerId: "human-a",
      status: ["PUBLISHED"],
      dateRange: { from: FROM, to: TO },
      includeDateOccurrences: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where).toEqual({
      humanId: "human-a",
      status: { in: ["PUBLISHED"] },
      AND: [
        {
          OR: [
            { startsAt: { gte: FROM, lte: TO } },
            { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } } } },
          ],
        },
      ],
    });
    expect(where.startsAt).toBeUndefined();
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("ON with a half-open range widens the same single bound on both arms", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ownerType: "HUMAN",
      ownerId: "human-a",
      dateRange: { from: FROM },
      includeDateOccurrences: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    expect(where.AND).toEqual([
      {
        OR: [
          { startsAt: { gte: FROM } },
          { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM } } } },
        ],
      },
    ]);
  });

  it("ON without a bounded dateRange is a no-op: nothing to widen, no AND emitted", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makeEventsRepo(prisma);
    await repo.listByOwner({ ownerType: "HUMAN", ownerId: "human-a", includeDateOccurrences: true });
    await repo.listByOwner({ ownerType: "HUMAN", ownerId: "human-a", dateRange: {}, includeDateOccurrences: true });

    expect((findMany.mock.calls[0]![0] as any).where).toEqual({ humanId: "human-a" });
    expect((findMany.mock.calls[1]![0] as any).where).toEqual({ humanId: "human-a" });
  });

  it("ON composes with the text search (top-level OR) and the category 'both' arm (AND) without clobbering either", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: "org-a",
      query: "launch",
      dateRange: { from: FROM, to: TO },
      categoryIds: ["cat-1"],
      includeUncategorised: true,
      includeDateOccurrences: true,
    });

    const where = (findMany.mock.calls[0]![0] as any).where;
    // Text search still owns the top-level OR, exactly three arms.
    expect(where.OR).toHaveLength(3);
    expect(JSON.stringify(where.OR)).not.toContain("dates");
    // Category arm keeps its pre-existing slot; the window arm follows it.
    expect(where.AND).toEqual([
      { OR: [{ categoryId: { in: ["cat-1"] } }, { categoryId: null }] },
      {
        OR: [
          { startsAt: { gte: FROM, lte: TO } },
          { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } } } },
        ],
      },
    ]);
    expect(where.startsAt).toBeUndefined();
    expect(where.categoryId).toBeUndefined();
  });
});
