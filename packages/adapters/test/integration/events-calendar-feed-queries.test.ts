import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventDatesRepo } from "../../src/db/prisma/event-dates";
import { makeEventsRepo } from "../../src/db/prisma/events";

/**
 * The public calendar feeds' reads (public-calendar-feeds.ts):
 *
 * - `listPublishedByPlace` / `listByOwner` with `statuses: ["CANCELLED"]`,
 *   `cancelledWhilePublished` and `dateOccurrenceStatuses: [SCHEDULED,
 *   CANCELLED]` admit a taken-down listing whose pinned `startsAt` is already
 *   past (only its CANCELLED nights are upcoming) and never a cancelled event
 *   that was never published;
 * - owner ruling 2026-10-17: `EventsRepo.cancel` records the status the row
 *   had (`cancelledFromStatus`), and `cancelledWhilePublished` admits a show
 *   cancelled while PUBLISHED, never one unpublished first or cancelled as a
 *   draft, nor a row cancelled before the column existed (NULL);
 * - every new option is off by default, so existing callers' rows are
 *   unchanged;
 * - `listByOwner({ startsAtOrder: "asc" })` keeps the NEAREST shows under the
 *   limit; the default stays newest-first.
 * - `matchDateOccurrencesOnly` + `dateOccurrenceStatuses: ["CANCELLED"]` find
 *   a live listing whose last upcoming night was called off (pin re-pinned
 *   to the past); `includeRunning` keeps a show still under way;
 *   `excludeBannedOwners` on `listByOwner` withholds a banned org's events.
 * - a cancel → restore of a night moves its `updatedAt` forward both times
 *   (the feed's SEQUENCE is derived from it).
 */
describe("Prisma adapters integration – calendar feed queries", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const NOW = new Date("2026-09-01T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const TO = new Date(NOW.getTime() + 90 * DAY);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const org = await prisma.organization.create({
        data: { name: "Feed Org", slug: "feed-org" },
      });
      ids.org = org.id;
      const place = await prisma.place.create({
        data: { name: "The Room", address: "1 Room St", status: "ACTIVE" },
      });
      ids.place = place.id;

      const make = async (
        key: string,
        data: {
          status: "PUBLISHED" | "CANCELLED" | "DRAFT";
          inDays: number;
          published?: boolean;
          visibility?: "PUBLIC" | "PRIVATE";
        },
      ) => {
        const startsAt = new Date(NOW.getTime() + data.inDays * DAY);
        const ev = await prisma!.event.create({
          data: {
            title: key,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
            status: data.status,
            visibility: data.visibility ?? "PUBLIC",
            placeId: ids.place!,
            orgId: ids.org!,
            publishedAt: data.published === false ? null : new Date(NOW.getTime() - 30 * DAY),
            // What EventsRepo.cancel would have recorded for this fixture.
            ...(data.status === "CANCELLED"
              ? { cancelledFromStatus: data.published === false ? "DRAFT" : "PUBLISHED" }
              : {}),
          },
        });
        ids[key] = ev.id;
        return ev.id;
      };

      await make("live", { status: "PUBLISHED", inDays: 3 });
      await make("cancelledSingle", { status: "CANCELLED", inDays: 5 });
      await make("cancelledNeverPublished", { status: "CANCELLED", inDays: 6, published: false });
      await make("cancelledPrivate", { status: "CANCELLED", inDays: 7, visibility: "PRIVATE" });
      await make("cancelledPast", { status: "CANCELLED", inDays: -3 });
      // Taken down: pin stays on a past night, remaining nights CANCELLED.
      const takenDown = await make("takenDown", { status: "CANCELLED", inDays: -2 });
      await prisma.eventDate.createMany({
        data: [
          { eventId: takenDown, ordinal: 0, startsAt: new Date(NOW.getTime() - 2 * DAY), status: "SCHEDULED" },
          { eventId: takenDown, ordinal: 1, startsAt: new Date(NOW.getTime() + 5 * DAY), status: "CANCELLED" },
          { eventId: takenDown, ordinal: 2, startsAt: new Date(NOW.getTime() + 12 * DAY), status: "CANCELLED" },
        ],
      });
      // Second org: the review-round-2 shapes, kept off org 1's ordering tests.
      const org2 = await prisma.organization.create({
        data: { name: "Feed Org 2", slug: "feed-org-2" },
      });
      ids.org2 = org2.id;
      const lastNightOff = await prisma.event.create({
        data: {
          title: "lastNightOff",
          // repinEventStartsAt pinned it to the call-off moment.
          startsAt: new Date(NOW.getTime() - DAY),
          endsAt: new Date(NOW.getTime() - DAY + 3 * 60 * 60 * 1000),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          placeId: ids.place!,
          orgId: org2.id,
          publishedAt: new Date(NOW.getTime() - 30 * DAY),
        },
      });
      ids.lastNightOff = lastNightOff.id;
      await prisma.eventDate.createMany({
        data: [
          { eventId: lastNightOff.id, ordinal: 0, startsAt: new Date(NOW.getTime() - 8 * DAY), status: "SCHEDULED" },
          { eventId: lastNightOff.id, ordinal: 1, startsAt: new Date(NOW.getTime() + 6 * DAY), status: "CANCELLED" },
        ],
      });
      const exhibition = await prisma.event.create({
        data: {
          title: "exhibition",
          startsAt: new Date(NOW.getTime() - 60 * DAY),
          endsAt: new Date(NOW.getTime() + 40 * DAY),
          status: "PUBLISHED",
          visibility: "PUBLIC",
          orgId: org2.id,
          publishedAt: new Date(NOW.getTime() - 90 * DAY),
        },
      });
      ids.exhibition = exhibition.id;
      // Banned org: its sole OWNER is BANNED.
      const bannedHuman = await prisma.human.create({ data: { name: "Banned", status: "BANNED" } });
      const bannedOrg = await prisma.organization.create({
        data: { name: "Banned Org", slug: "banned-org-feed" },
      });
      ids.bannedOrg = bannedOrg.id;
      await prisma.orgMember.create({
        data: { orgId: bannedOrg.id, humanId: bannedHuman.id, role: "OWNER" },
      });
      for (const status of ["PUBLISHED", "CANCELLED"] as const) {
        const startsAt = new Date(NOW.getTime() + 4 * DAY);
        await prisma.event.create({
          data: {
            title: `banned-${status}`,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
            status,
            visibility: "PUBLIC",
            orgId: bannedOrg.id,
            publishedAt: new Date(NOW.getTime() - 30 * DAY),
            ...(status === "CANCELLED" ? { cancelledFromStatus: "PUBLISHED" as const } : {}),
          },
        });
      }

      // Owner ruling 2026-10-17: driven through the real repo writes, on a
      // place and org of their own so the assertions above stay put.
      const repo = makeEventsRepo(prisma);
      const org3 = await prisma.organization.create({
        data: { name: "Feed Org 3", slug: "feed-org-3" },
      });
      ids.org3 = org3.id;
      const host = await prisma.human.create({ data: { name: "Feed Host" } });
      ids.host = host.id;
      const place2 = await prisma.place.create({
        data: { name: "The Other Room", address: "2 Room St", status: "ACTIVE" },
      });
      ids.place2 = place2.id;
      const make2 = async (
        key: string,
        owner: { orgId: string } | { humanId: string },
        status: "PUBLISHED" | "DRAFT" | "CANCELLED",
        published: boolean,
      ) => {
        const startsAt = new Date(NOW.getTime() + 9 * DAY);
        const ev = await prisma!.event.create({
          data: {
            title: key,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
            status,
            visibility: "PUBLIC",
            placeId: ids.place2!,
            ...owner,
            publishedAt: published ? new Date(NOW.getTime() - 30 * DAY) : null,
          },
        });
        ids[key] = ev.id;
        return ev.id;
      };
      for (const [suffix, owner] of [
        ["Org", { orgId: org3.id }],
        ["Human", { humanId: host.id }],
      ] as const) {
        // Published, then cancelled while live.
        const live = await make2(`cancelledLive${suffix}`, owner, "PUBLISHED", true);
        await repo.cancel({ eventId: live });
        // Published, unpublished (publishedAt kept), edited, then cancelled.
        const unpub = await make2(`unpublishedThenCancelled${suffix}`, owner, "PUBLISHED", true);
        await repo.unpublish({ eventId: unpub });
        await prisma.event.update({
          where: { id: unpub },
          data: { title: `renamedWhilePrivate${suffix}`, addressText: "12 Secret Lane" },
        });
        await repo.cancel({ eventId: unpub });
        // Never published, cancelled as a draft.
        const draft = await make2(`draftCancelled${suffix}`, owner, "DRAFT", false);
        await repo.cancel({ eventId: draft });
      }
      // Cancelled before the column existed (NULL): excluded, published or not.
      await make2("legacyCancelled", { orgId: org3.id }, "CANCELLED", true);
      await make2("legacyNeverPublished", { orgId: org3.id }, "CANCELLED", false);

      // A future-dated batch to exercise sort order + limit on listByOwner.
      for (let i = 0; i < 5; i++) {
        await make(`far${i}`, { status: "PUBLISHED", inDays: 20 + i });
      }
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("calendar feed queries setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("listPublishedByPlace cancelled read: previously-published PUBLIC cancelled shows, incl. a taken-down listing with a past pin", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const page = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: NOW,
      to: TO,
      status: "upcoming",
      limit: 50,
      includeDateOccurrences: true,
      statuses: ["CANCELLED"],
      cancelledWhilePublished: true,
      dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
    });
    expect(new Set(page.items.map((e) => e.id))).toEqual(
      new Set([ids.cancelledSingle, ids.takenDown]),
    );
  }, 60_000);

  test("listPublishedByPlace without the new options: unchanged (PUBLISHED only; a CANCELLED night does not admit)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const page = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: NOW,
      to: TO,
      status: "upcoming",
      limit: 50,
      includeDateOccurrences: true,
    });
    expect(page.items.map((e) => e.title)).toEqual([
      "live",
      "far0",
      "far1",
      "far2",
      "far3",
      "far4",
    ]);
    // Status CANCELLED without the date-status widening: the taken-down
    // listing's past pin and CANCELLED nights do not admit it.
    const narrow = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: NOW,
      to: TO,
      status: "upcoming",
      includeDateOccurrences: true,
      statuses: ["CANCELLED"],
    });
    expect(narrow.items.map((e) => e.title).sort()).toEqual([
      "cancelledNeverPublished",
      "cancelledSingle",
    ]);
  }, 60_000);

  test("listByOwner cancelled read mirrors the place read", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const page = await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: ids.org!,
      status: ["CANCELLED"],
      visibility: ["PUBLIC"],
      cancelledWhilePublished: true,
      includeDateOccurrences: true,
      dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
      dateRange: { from: NOW },
      startsAtOrder: "asc",
      limit: 50,
    });
    expect(page.items.map((e) => e.id)).toEqual([ids.takenDown, ids.cancelledSingle]);
  }, 60_000);

  test("EventsRepo.cancel records the status the row had; a second cancel keeps it", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const fromStatus = async (key: string) =>
      (await prisma!.event.findUniqueOrThrow({ where: { id: ids[key]! } })).cancelledFromStatus;
    expect(await fromStatus("cancelledLiveOrg")).toBe("PUBLISHED");
    expect(await fromStatus("unpublishedThenCancelledOrg")).toBe("DRAFT");
    expect(await fromStatus("draftCancelledOrg")).toBe("DRAFT");
    expect(await fromStatus("legacyCancelled")).toBeNull();
    const repo = makeEventsRepo(prisma);
    const again = await repo.cancel({ eventId: ids.cancelledLiveOrg! });
    expect(again.status).toBe("CANCELLED");
    expect(again.cancelledFromStatus).toBe("PUBLISHED");
    // publishedAt survives unpublish: the reason the old rule leaked.
    const unpub = await repo.getById(ids.unpublishedThenCancelledOrg!);
    expect(unpub?.publishedAt).not.toBeNull();
    expect(unpub?.cancelledFromStatus).toBe("DRAFT");
  }, 60_000);

  test("lockRows + cancel inside one transaction (the cancelEvent shape) records PUBLISHED; a rolled-back cancel records nothing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    // An owner of its own, so these rows reach no other test's read.
    const txOwner = await prisma.human.create({ data: { name: "Tx Owner" } });
    const make = async (title: string) =>
      (
        await prisma!.event.create({
          data: {
            title,
            startsAt: new Date(NOW.getTime() + 11 * DAY),
            endsAt: new Date(NOW.getTime() + 11 * DAY + 3 * 60 * 60 * 1000),
            status: "PUBLISHED",
            visibility: "PUBLIC",
            humanId: txOwner.id,
            publishedAt: new Date(NOW.getTime() - 30 * DAY),
          },
        })
      ).id;
    const committed = await make("txCommitted");
    const cancelled = await prisma.$transaction(async (tx) => {
      const repo = makeEventsRepo(tx);
      await repo.lockRows({ ids: [committed], mode: "update" });
      return repo.cancel({ eventId: committed });
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledFromStatus).toBe("PUBLISHED");
    const row = await prisma.event.findUniqueOrThrow({ where: { id: committed } });
    expect([row.status, row.cancelledFromStatus]).toEqual(["CANCELLED", "PUBLISHED"]);

    // The stamp and the flip commit together: a rollback leaves neither.
    const rolledBack = await make("txRolledBack");
    await expect(
      prisma.$transaction(async (tx) => {
        const repo = makeEventsRepo(tx);
        await repo.lockRows({ ids: [rolledBack], mode: "update" });
        await repo.cancel({ eventId: rolledBack });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const after = await prisma.event.findUniqueOrThrow({ where: { id: rolledBack } });
    expect([after.status, after.cancelledFromStatus]).toEqual(["PUBLISHED", null]);
  }, 60_000);

  test("cancelledWhilePublished: only shows cancelled while PUBLISHED (place, org and human reads); NULL is excluded", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const place = await repo.listPublishedByPlace({
      placeId: ids.place2!,
      from: NOW,
      to: TO,
      status: "upcoming",
      limit: 50,
      includeDateOccurrences: true,
      statuses: ["CANCELLED"],
      cancelledWhilePublished: true,
      dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
    });
    expect(place.items.map((e) => e.title).sort()).toEqual([
      "cancelledLiveHuman",
      "cancelledLiveOrg",
    ]);
    const owner = (ownerType: "ORGANIZATION" | "HUMAN", ownerId: string) =>
      repo.listByOwner({
        ownerType,
        ownerId,
        status: ["CANCELLED"],
        visibility: ["PUBLIC"],
        cancelledWhilePublished: true,
        includeDateOccurrences: true,
        dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
        dateRange: { from: NOW },
        startsAtOrder: "asc",
        limit: 50,
      });
    expect((await owner("ORGANIZATION", ids.org3!)).items.map((e) => e.title)).toEqual([
      "cancelledLiveOrg",
    ]);
    expect((await owner("HUMAN", ids.host!)).items.map((e) => e.title)).toEqual([
      "cancelledLiveHuman",
    ]);
    // Without the option every CANCELLED row comes back (no filter).
    const all = await repo.listPublishedByPlace({
      placeId: ids.place2!,
      from: NOW,
      to: TO,
      status: "upcoming",
      limit: 50,
      statuses: ["CANCELLED"],
    });
    expect(all.items).toHaveLength(8);
  }, 60_000);

  test("listByOwner startsAtOrder asc keeps the nearest under the limit; default stays newest-first", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const base = {
      ownerType: "ORGANIZATION" as const,
      ownerId: ids.org!,
      status: ["PUBLISHED" as const],
      visibility: ["PUBLIC" as const],
      dateRange: { from: new Date(NOW.getTime() - 30 * DAY) },
      limit: 3,
    };
    const asc = await repo.listByOwner({ ...base, startsAtOrder: "asc" });
    expect(asc.items.map((e) => e.title)).toEqual(["live", "far0", "far1"]);
    const dflt = await repo.listByOwner(base);
    expect(dflt.items.map((e) => e.title)).toEqual(["far4", "far3", "far2"]);
  }, 60_000);

  test("matchDateOccurrencesOnly + CANCELLED nights: finds the live listing whose last night was called off, nothing else", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const place = await repo.listPublishedByPlace({
      placeId: ids.place!,
      from: NOW,
      to: TO,
      status: "upcoming",
      limit: 50,
      includeDateOccurrences: true,
      matchDateOccurrencesOnly: true,
      dateOccurrenceStatuses: ["CANCELLED"],
    });
    // PUBLISHED only (default statuses): the taken-down CANCELLED listing,
    // whose nights are also CANCELLED, is the other read's job.
    expect(place.items.map((e) => e.id)).toEqual([ids.lastNightOff]);
    const owner = await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: ids.org2!,
      status: ["PUBLISHED"],
      visibility: ["PUBLIC"],
      includeDateOccurrences: true,
      matchDateOccurrencesOnly: true,
      dateOccurrenceStatuses: ["CANCELLED"],
      dateRange: { from: NOW },
    });
    expect(owner.items.map((e) => e.id)).toEqual([ids.lastNightOff]);
  }, 60_000);

  test("includeRunning keeps a show under way at `from`; omitted, it is dropped (unchanged)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const base = {
      ownerType: "ORGANIZATION" as const,
      ownerId: ids.org2!,
      status: ["PUBLISHED" as const],
      visibility: ["PUBLIC" as const],
      dateRange: { from: new Date(NOW.getTime() - 30 * DAY) },
      startsAtOrder: "asc" as const,
    };
    const without = await repo.listByOwner(base);
    expect(without.items.map((e) => e.title)).toEqual(["lastNightOff"]);
    const withRunning = await repo.listByOwner({ ...base, includeRunning: true });
    expect(withRunning.items.map((e) => e.title)).toEqual(["exhibition", "lastNightOff"]);
    // Also composes with the EventDate arm the feed turns on.
    const both = await repo.listByOwner({ ...base, includeRunning: true, includeDateOccurrences: true });
    expect(both.items.map((e) => e.title)).toEqual(["exhibition", "lastNightOff"]);
  }, 60_000);

  test("listByOwner excludeBannedOwners withholds a banned org's events; omitted, they stay (unchanged)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEventsRepo(prisma);
    const base = {
      ownerType: "ORGANIZATION" as const,
      ownerId: ids.bannedOrg!,
      status: ["PUBLISHED" as const, "CANCELLED" as const],
      visibility: ["PUBLIC" as const],
    };
    const kept = await repo.listByOwner(base);
    expect(kept.items.map((e) => e.title).sort()).toEqual(["banned-CANCELLED", "banned-PUBLISHED"]);
    const withheld = await repo.listByOwner({ ...base, excludeBannedOwners: true });
    expect(withheld.items).toEqual([]);
    // An unbanned owner is untouched by the flag.
    const live = await repo.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: ids.org!,
      status: ["PUBLISHED"],
      excludeBannedOwners: true,
      limit: 1,
      startsAtOrder: "asc",
    });
    expect(live.items.map((e) => e.title)).toEqual(["live"]);
  }, 60_000);

  test("cancel → restore of a night moves its updatedAt forward each time", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const dates = makeEventDatesRepo(prisma);
    const row = await prisma.eventDate.create({
      data: { eventId: ids.live!, ordinal: 9, startsAt: new Date(NOW.getTime() + 9 * DAY) },
    });
    const sleep = () => new Promise((r) => setTimeout(r, 20));
    await sleep();
    await dates.markStatusIf({ id: row.id, expectStatus: "SCHEDULED", status: "CANCELLED" });
    const afterCancel = await prisma.eventDate.findUniqueOrThrow({ where: { id: row.id } });
    await sleep();
    await dates.markStatusIf({ id: row.id, expectStatus: "CANCELLED", status: "SCHEDULED" });
    const afterRestore = await prisma.eventDate.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterCancel.status).toBe("CANCELLED");
    expect(afterRestore.status).toBe("SCHEDULED");
    expect(afterCancel.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
    expect(afterRestore.updatedAt.getTime()).toBeGreaterThan(afterCancel.updatedAt.getTime());
    await prisma.eventDate.delete({ where: { id: row.id } });
  }, 60_000);
});
