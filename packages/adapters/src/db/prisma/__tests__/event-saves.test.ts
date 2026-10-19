import { describe, expect, it, vi } from "vitest";

import {
  decodeSavedEventsCursor,
  encodeSavedEventsCursor,
  makeEventSavesRepo,
} from "../event-saves";
import type { PrismaClientOrTx } from "../types";

const HUMAN_ID = "human-1";
const NOW = new Date("2026-07-01T12:00:00.000Z");
const UPCOMING_STARTS_AT = new Date("2026-08-01T20:00:00.000Z");

type FakeRow = {
  id: string;
  eventId: string;
  humanId: string;
  createdAt: Date;
  event: { startsAt: Date; heroImage: { publicUrl: string } | null };
};

function makeRow(
  id: string,
  createdAt: Date,
  humanId = HUMAN_ID,
  heroImage: { publicUrl: string } | null = null,
): FakeRow {
  return {
    id,
    eventId: `event-${id}`,
    humanId,
    createdAt,
    event: { startsAt: UPCOMING_STARTS_AT, heroImage },
  };
}

/**
 * In-memory findMany honoring exactly the query shape `listForHuman` emits
 * (humanId + event.startsAt window + optional OR keyset, ordered createdAt
 * desc / id desc, take) so the keyset semantics — including the
 * deleted-boundary-row case — are exercised through the real adapter code.
 */
function makeListPrisma(rows: FakeRow[]) {
  const findMany = vi.fn(async (args: any) => {
    const { where, take } = args;
    let out = rows.filter((r) => r.humanId === where.humanId);

    const startsAt = where.event.startsAt;
    out = out.filter((r) =>
      "gte" in startsAt
        ? r.event.startsAt >= startsAt.gte
        : r.event.startsAt < startsAt.lt,
    );

    if (where.OR) {
      const [before, tie] = where.OR;
      out = out.filter(
        (r) =>
          r.createdAt.getTime() < before.createdAt.lt.getTime() ||
          (r.createdAt.getTime() === tie.createdAt.getTime() &&
            r.id < tie.id.lt),
      );
    }

    out = [...out].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

    return out.slice(0, take);
  });

  return {
    prisma: { eventSave: { findMany } } as unknown as PrismaClientOrTx,
    findMany,
  };
}

describe("saved-events cursor encoding", () => {
  it("round-trips createdAt + id", () => {
    const createdAt = new Date("2026-06-15T00:00:00.123Z");
    const encoded = encodeSavedEventsCursor(createdAt, "save-1");

    expect(encoded).toBe("2026-06-15T00:00:00.123Z|save-1");
    expect(decodeSavedEventsCursor(encoded)).toEqual({
      createdAt,
      id: "save-1",
    });
  });

  it.each([
    ["no separator", "not-a-cursor"],
    ["empty timestamp", "|save-1"],
    ["empty id", "2026-06-15T00:00:00.000Z|"],
    ["unparseable timestamp", "garbage|save-1"],
    ["legacy save-id cursor", "0d9c3a34-8f13-4e3e-9f6a-2b1d1a2b3c4d"],
  ])("decodes %s as null instead of throwing", (_label, cursor) => {
    expect(decodeSavedEventsCursor(cursor)).toBeNull();
  });
});

describe("makeEventSavesRepo.listForHuman keyset pagination", () => {
  const s1 = makeRow("save-1", new Date("2026-06-10T00:00:00.000Z"));
  const s2 = makeRow("save-2", new Date("2026-06-11T00:00:00.000Z"));
  const s3 = makeRow("save-3", new Date("2026-06-12T00:00:00.000Z"));

  it("pages newest-first and encodes a value-based nextCursor", async () => {
    const { prisma } = makeListPrisma([s1, s2, s3]);
    const repo = makeEventSavesRepo(prisma);

    const page1 = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 2,
      now: NOW,
    });

    expect(page1.items.map((i) => i.id)).toEqual(["save-3", "save-2"]);
    expect(page1.nextCursor).toBe(
      encodeSavedEventsCursor(s2.createdAt, s2.id),
    );

    const page2 = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 2,
      cursor: page1.nextCursor,
      now: NOW,
    });

    expect(page2.items.map((i) => i.id)).toEqual(["save-1"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("still returns the remaining rows when the cursor's boundary row was unsaved", async () => {
    const rows = [s1, s2, s3];
    const { prisma } = makeListPrisma(rows);
    const repo = makeEventSavesRepo(prisma);

    const page1 = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 2,
      now: NOW,
    });
    expect(page1.nextCursor).not.toBeNull();

    // Unsave the boundary row (save-2) between page fetches — the list's
    // primary quick action. A Prisma row-cursor would now return [].
    rows.splice(rows.indexOf(s2), 1);

    const page2 = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 2,
      cursor: page1.nextCursor,
      now: NOW,
    });

    expect(page2.items.map((i) => i.id)).toEqual(["save-1"]);
  });

  it("breaks createdAt ties by id desc", async () => {
    const t = new Date("2026-06-11T00:00:00.000Z");
    const a = makeRow("save-a", t);
    const b = makeRow("save-b", t);
    const { prisma } = makeListPrisma([a, b]);
    const repo = makeEventSavesRepo(prisma);

    const page1 = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 1,
      now: NOW,
    });
    expect(page1.items.map((i) => i.id)).toEqual(["save-b"]);

    const page2 = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 1,
      cursor: page1.nextCursor,
      now: NOW,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["save-a"]);
  });

  it("flattens the joined hero Image into heroImageUrl (null when absent)", async () => {
    const withHero = makeRow(
      "save-hero",
      new Date("2026-06-13T00:00:00.000Z"),
      HUMAN_ID,
      { publicUrl: "https://img.test/hero.jpg" },
    );
    const { prisma, findMany } = makeListPrisma([withHero, s1]);
    const repo = makeEventSavesRepo(prisma);

    const page = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 10,
      now: NOW,
    });

    expect(page.items[0]?.event.heroImageUrl).toBe(
      "https://img.test/hero.jpg",
    );
    expect(page.items[1]?.event.heroImageUrl).toBeNull();
    // The raw joined relation is not leaked on the summary.
    expect(page.items[0]?.event).not.toHaveProperty("heroImage");
    // The select joins the Image relation for its stored publicUrl only —
    // same mechanism as the events adapter (events.ts heroImage select).
    const args = findMany.mock.calls[0]?.[0];
    expect(args.select.event.select.heroImage).toEqual({
      select: { publicUrl: true, key: true },
    });
  });

  it("treats a malformed cursor as no-cursor (first page) instead of throwing", async () => {
    const { prisma, findMany } = makeListPrisma([s1, s2, s3]);
    const repo = makeEventSavesRepo(prisma);

    const result = await repo.listForHuman({
      humanId: HUMAN_ID,
      scope: "upcoming",
      limit: 2,
      cursor: "definitely-not-a-cursor",
      now: NOW,
    });

    expect(result.items.map((i) => i.id)).toEqual(["save-3", "save-2"]);
    const args = findMany.mock.calls[0]?.[0];
    expect(args.where.OR).toBeUndefined();
  });
});

describe("makeEventSavesRepo.listHumanIdsForEvent keyset pagination", () => {
  function makeFanoutPrisma(rows: Array<{ eventId: string; humanId: string }>) {
    const findMany = vi.fn(async (args: any) => {
      const { where, take } = args;
      let out = rows.filter((r) => r.eventId === where.eventId);
      if (where.humanId?.gt) {
        out = out.filter((r) => r.humanId > where.humanId.gt);
      }
      out = [...out].sort((a, b) => (a.humanId < b.humanId ? -1 : 1));
      return out.slice(0, take).map((r) => ({ humanId: r.humanId }));
    });

    return {
      prisma: { eventSave: { findMany } } as unknown as PrismaClientOrTx,
    };
  }

  it("pages humanIds ascending with the last humanId as cursor", async () => {
    const { prisma } = makeFanoutPrisma([
      { eventId: "event-1", humanId: "human-a" },
      { eventId: "event-1", humanId: "human-b" },
      { eventId: "event-1", humanId: "human-c" },
      { eventId: "event-2", humanId: "human-z" },
    ]);
    const repo = makeEventSavesRepo(prisma);

    const page1 = await repo.listHumanIdsForEvent({
      eventId: "event-1",
      limit: 2,
    });
    expect(page1.items).toEqual(["human-a", "human-b"]);
    expect(page1.nextCursor).toBe("human-b");

    const page2 = await repo.listHumanIdsForEvent({
      eventId: "event-1",
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toEqual(["human-c"]);
    expect(page2.nextCursor).toBeNull();
  });
});
