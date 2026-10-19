import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

/**
 * `listPublishedOccurrencesByPlace` answers "which NIGHTS is this room taken",
 * which is not the same question as "which events are at this place".
 *
 * A recurring listing is ONE `Event` row whose `startsAt` is pinned to its
 * first upcoming date, with the real occurrences in `EventDate`. Booking
 * availability used to read the event-shaped lister and so saw a weekly
 * residency as a single booked night — offering performers slots on nights the
 * room was already gone. These tests pin the three rules that fix that:
 * expanded rows win, the pinned mirror is not re-emitted, and an event with no
 * rows still falls back to its own instant.
 *
 * The `spaceIds` filter (venue-hierarchy FR-005) pins a fourth: a venue with a
 * main stage and a back bar is not busy everywhere because one 40-cap room is
 * taken — but an event with NO space has unknown placement and must survive
 * every filter, or the query frees a room that is in fact gone.
 */

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-10-01T00:00:00.000Z");

const STAGE = "space-stage";

type EventRow = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  spaceId?: string | null;
  dates: Array<{ id: string; startsAt: Date; endsAt: Date | null }>;
};

function makePrisma(rows: EventRow[] = []) {
  const findMany = vi.fn(async () =>
    rows.map((r) => ({ spaceId: null, ...r })),
  );
  const prisma = {
    event: { findMany, count: vi.fn(async () => rows.length) },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

const baseInput = { placeId: "place-a", from: FROM, to: TO };

describe("makeEventsRepo.listPublishedOccurrencesByPlace", () => {
  it("gates on PUBLISHED + PUBLIC", async () => {
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where).toMatchObject({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      placeId: "place-a",
    });
  });

  it("matches on the occurrence window, not only on Event.startsAt", async () => {
    // The load-bearing clause. A residency pins `Event.startsAt` to its first
    // upcoming date, so any window more than a week out would miss the event
    // entirely if the filter were a plain `startsAt` range.
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.OR).toEqual([
      { startsAt: { gte: FROM, lte: TO } },
      { dates: { some: { status: "SCHEDULED", startsAt: { gte: FROM, lte: TO } } } },
    ]);
  });

  it("only ever hydrates SCHEDULED dates inside the window", async () => {
    // A CANCELLED night frees the room. Blocking it would cost the venue real
    // inventory, so the exclusion lives in the query rather than downstream.
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.select.dates.where).toEqual({
      status: "SCHEDULED",
      startsAt: { gte: FROM, lte: TO },
    });
  });

  it("expands a recurring listing into one occurrence per night", async () => {
    const { prisma } = makePrisma([
      {
        id: "residency",
        title: "Tuesday Night Residency",
        // Pinned to the first upcoming date, mirroring date-1.
        startsAt: new Date("2026-08-04T23:00:00.000Z"),
        endsAt: new Date("2026-08-05T04:00:00.000Z"),
        dates: [
          {
            id: "d1",
            startsAt: new Date("2026-08-04T23:00:00.000Z"),
            endsAt: new Date("2026-08-05T04:00:00.000Z"),
          },
          {
            id: "d2",
            startsAt: new Date("2026-08-11T23:00:00.000Z"),
            endsAt: new Date("2026-08-12T04:00:00.000Z"),
          },
          {
            id: "d3",
            startsAt: new Date("2026-08-18T23:00:00.000Z"),
            endsAt: new Date("2026-08-19T04:00:00.000Z"),
          },
        ],
      },
    ]);

    const out =
      await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    // Three nights from ONE event row — and exactly three, not four: the
    // pinned `Event.startsAt` mirrors d1 and must not be emitted again.
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.eventDateId)).toEqual(["d1", "d2", "d3"]);
    expect(new Set(out.map((o) => o.eventId))).toEqual(new Set(["residency"]));
    expect(out.every((o) => o.title === "Tuesday Night Residency")).toBe(true);
  });

  it("falls back to Event.startsAt for a single-date event", async () => {
    // Single-date events have no EventDate rows at all; the fallback is what
    // keeps ordinary shows in the room's diary.
    const { prisma } = makePrisma([
      {
        id: "one-off",
        title: "Sunset Boulevard",
        startsAt: new Date("2026-08-14T19:00:00.000Z"),
        endsAt: new Date("2026-08-14T21:30:00.000Z"),
        dates: [],
      },
    ]);

    const out =
      await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    expect(out).toEqual([
      {
        eventId: "one-off",
        eventDateId: null,
        title: "Sunset Boulevard",
        startsAt: new Date("2026-08-14T19:00:00.000Z"),
        endsAt: new Date("2026-08-14T21:30:00.000Z"),
        spaceId: null,
      },
    ]);
  });

  it("drops an event whose only match was a date outside the window", async () => {
    // The OR can match an event on a date row while its pinned instant sits
    // outside the range. If the hydrated set comes back empty, falling back to
    // that out-of-range instant would book a night the caller never asked for.
    const { prisma } = makePrisma([
      {
        id: "far-future",
        title: "Next Spring",
        startsAt: new Date("2027-03-01T19:00:00.000Z"),
        endsAt: new Date("2027-03-01T22:00:00.000Z"),
        dates: [],
      },
    ]);

    const out =
      await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    expect(out).toEqual([]);
  });

  it("returns occurrences in chronological order across events", async () => {
    // Events are ordered by their pinned instant, which says nothing about
    // where an expanded date falls relative to another event's — so the
    // flattened set has to be re-sorted or the caller sees interleaved nights.
    const { prisma } = makePrisma([
      {
        id: "residency",
        title: "Residency",
        startsAt: new Date("2026-08-04T23:00:00.000Z"),
        endsAt: null,
        dates: [
          {
            id: "d1",
            startsAt: new Date("2026-08-04T23:00:00.000Z"),
            endsAt: null,
          },
          {
            id: "d2",
            startsAt: new Date("2026-08-25T23:00:00.000Z"),
            endsAt: null,
          },
        ],
      },
      {
        id: "one-off",
        title: "One Off",
        startsAt: new Date("2026-08-14T19:00:00.000Z"),
        endsAt: null,
        dates: [],
      },
    ]);

    const out =
      await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    expect(out.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-08-04T23:00:00.000Z",
      "2026-08-14T19:00:00.000Z",
      "2026-08-25T23:00:00.000Z",
    ]);
  });

  it("caps returned occurrences at the requested limit", async () => {
    const { prisma } = makePrisma([
      {
        id: "residency",
        title: "Residency",
        startsAt: new Date("2026-08-04T23:00:00.000Z"),
        endsAt: null,
        dates: Array.from({ length: 5 }, (_, i) => ({
          id: `d${i}`,
          startsAt: new Date(`2026-08-0${i + 1}T23:00:00.000Z`),
          endsAt: null,
        })),
      },
    ]);

    const out = await makeEventsRepo(prisma).listPublishedOccurrencesByPlace({
      ...baseInput,
      limit: 3,
    });

    expect(out).toHaveLength(3);
  });

  // ── Space narrowing (venue-hierarchy FR-005) ───────────────────────────────

  it("does not filter by space when spaceIds is omitted", async () => {
    // The whole place's diary — the pre-hierarchy behaviour every existing
    // caller depends on. No AND clause at all, not an empty one.
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.AND).toBeUndefined();
  });

  it("keeps NULL-space events inside the space filter", async () => {
    // The load-bearing clause of the whole feature. An event that names no
    // space has UNKNOWN placement, not "no placement" — a bare
    // `spaceId: { in: [...] }` would drop every pre-hierarchy event and report
    // rooms as free on nights they are booked.
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedOccurrencesByPlace({
      ...baseInput,
      spaceIds: [STAGE],
    });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.AND).toEqual([
      { OR: [{ spaceId: { in: [STAGE] } }, { spaceId: null }] },
    ]);
    // The window OR is untouched — the two must be ANDed, never merged into
    // one OR ("in range OR in a space" is not the question being asked).
    expect(args.where.OR).toHaveLength(2);
  });

  it("treats an EMPTY spaceIds array as a real filter, not an omission", async () => {
    // A calendar with no spaces joined. `in: []` matches nothing, so only the
    // null-space occurrences survive — which is the caller's problem to reason
    // about, but it must not silently widen to the whole place.
    const { prisma, findMany } = makePrisma();
    await makeEventsRepo(prisma).listPublishedOccurrencesByPlace({
      ...baseInput,
      spaceIds: [],
    });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.AND).toEqual([
      { OR: [{ spaceId: { in: [] } }, { spaceId: null }] },
    ]);
  });

  it("selects spaceId and carries it onto every occurrence shape", async () => {
    // Both emit paths: expanded EventDate rows inherit the EVENT's space (a
    // date has none of its own), and the single-date fallback carries its own.
    const { prisma, findMany } = makePrisma([
      {
        id: "residency",
        title: "Residency",
        startsAt: new Date("2026-08-04T23:00:00.000Z"),
        endsAt: null,
        spaceId: STAGE,
        dates: [
          { id: "d1", startsAt: new Date("2026-08-04T23:00:00.000Z"), endsAt: null },
          { id: "d2", startsAt: new Date("2026-08-11T23:00:00.000Z"), endsAt: null },
        ],
      },
      {
        id: "one-off",
        title: "One Off",
        startsAt: new Date("2026-08-14T19:00:00.000Z"),
        endsAt: null,
        spaceId: "space-back-bar",
        dates: [],
      },
    ]);

    const out =
      await makeEventsRepo(prisma).listPublishedOccurrencesByPlace(baseInput);

    expect((findMany.mock.calls[0]![0] as any).select.spaceId).toBe(true);
    expect(out.map((o) => [o.eventDateId, o.spaceId])).toEqual([
      ["d1", STAGE],
      ["d2", STAGE],
      [null, "space-back-bar"],
    ]);
  });
});
