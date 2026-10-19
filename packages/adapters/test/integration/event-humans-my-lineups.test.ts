import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventHumansRepo } from "../../src/db/prisma/event-humans";

// The person's OWN lineup view (`/my-lineups`, owner ruling "option A",
// 2026-09-30) + the (eventId, humanId) lookup attach/leave use.

const NOW = new Date("2026-07-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("Prisma adapters integration – event-humans my-lineups", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let me: string;
  let stranger: string;
  let orgId: string;
  const ids: Record<string, string> = {};
  const rows: Record<string, string> = {};

  const makeEvent = (data: {
    title: string;
    startsAt: Date;
    status?: string;
    visibility?: string;
    orgId?: string | null;
    humanId?: string | null;
    slug?: string | null;
  }) =>
    prisma!.event
      .create({
        data: {
          title: data.title,
          startsAt: data.startsAt,
          endsAt: new Date(data.startsAt.getTime() + 3 * HOUR),
          status: (data.status ?? "PUBLISHED") as any,
          visibility: (data.visibility ?? "PUBLIC") as any,
          orgId: data.orgId ?? null,
          humanId: data.humanId ?? null,
          slug: data.slug ?? null,
          timezone: "America/Chicago",
        },
      })
      .then((e) => e.id);

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      me = (await prisma.human.create({ data: { name: "The Sundowners", status: "ACTIVE" } })).id;
      stranger = (await prisma.human.create({ data: { name: "Someone Else", status: "ACTIVE" } })).id;
      const owner = await prisma.human.create({ data: { name: "Sam Rivera", status: "ACTIVE" } });
      orgId = (await prisma.organization.create({ data: { name: "Acme Presents", slug: "acme-presents" } as any })).id;

      ids.soon = await makeEvent({ title: "Soon", startsAt: new Date("2026-07-05T01:00:00.000Z"), orgId, slug: "soon" });
      ids.draft = await makeEvent({ title: "Draft", startsAt: new Date("2026-07-10T01:00:00.000Z"), status: "DRAFT", humanId: owner.id, slug: "draft-slug" });
      ids.privateLater = await makeEvent({ title: "Private later", startsAt: new Date("2026-08-01T01:00:00.000Z"), visibility: "PRIVATE", orgId });
      // Tie on startsAt with `soon` — the id breaks it.
      ids.soonTwin = await makeEvent({ title: "Soon twin", startsAt: new Date("2026-07-05T01:00:00.000Z"), status: "CANCELLED" });
      // Started 1h ago, ends in 2h: not over → upcoming.
      ids.inProgress = await makeEvent({ title: "In progress", startsAt: new Date(NOW.getTime() - HOUR) });
      ids.pastRecent = await makeEvent({ title: "Past recent", startsAt: new Date("2026-06-20T01:00:00.000Z"), status: "COMPLETED" });
      ids.pastOld = await makeEvent({ title: "Past old", startsAt: new Date("2026-05-01T01:00:00.000Z") });
      ids.notMine = await makeEvent({ title: "Not mine", startsAt: new Date("2026-07-06T01:00:00.000Z") });

      for (const key of ["soon", "draft", "privateLater", "soonTwin", "inProgress", "pastRecent", "pastOld"]) {
        rows[key] = (
          await prisma.eventHuman.create({
            data: { eventId: ids[key]!, humanId: me, role: key === "draft" ? "OTHER" : "PERFORMER", customRoleLabel: key === "draft" ? "Stage manager" : null },
          })
        ).id;
      }
      await prisma.eventHuman.create({ data: { eventId: ids.notMine!, humanId: stranger, role: "PERFORMER" } });
      // A free-text row on one of my events must never show up for me.
      await prisma.eventHuman.create({ data: { eventId: ids.soon!, externalName: "Free Text", role: "PERFORMER" } });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-humans my-lineups setup failed:", error);
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

  test("upcoming: every status/visibility of MY rows, soonest first, id tiebreak, joined names", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventHumansRepo(prisma);
    const out = await repo.listLineupsByHuman({ humanId: me, when: "upcoming", now: NOW, after: null, limit: 20 });

    const [a, b] = [rows.soon!, rows.soonTwin!].sort();
    expect(out.map((r) => r.eventHumanId)).toEqual([
      rows.inProgress,
      a,
      b,
      rows.draft,
      rows.privateLater,
    ]);
    const draft = out.find((r) => r.eventHumanId === rows.draft)!;
    expect(draft).toMatchObject({
      eventId: ids.draft,
      eventTitle: "Draft",
      status: "DRAFT",
      role: "OTHER",
      customRoleLabel: "Stage manager",
      timezone: "America/Chicago",
      slug: "draft-slug",
      orgName: null,
      ownerHumanName: "Sam Rivera",
      ownerOrgId: null,
    });
    expect(draft.ownerHumanId).toEqual(expect.any(String));
    expect(out.find((r) => r.eventHumanId === rows.soon)).toMatchObject({
      orgName: "Acme Presents",
      ownerHumanName: null,
      ownerOrgId: orgId,
      ownerHumanId: null,
    });
    expect(out.find((r) => r.eventHumanId === rows.privateLater)).toMatchObject({ visibility: "PRIVATE" });
  }, 60_000);

  test("past: ended only, most recent first", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventHumansRepo(prisma);
    const out = await repo.listLineupsByHuman({ humanId: me, when: "past", now: NOW, after: null, limit: 20 });
    expect(out.map((r) => r.eventHumanId)).toEqual([rows.pastRecent, rows.pastOld]);
  }, 60_000);

  test("keyset pages never drop or repeat a row, including across a startsAt tie", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventHumansRepo(prisma);
    const seen: string[] = [];
    let after: { startsAt: Date; eventHumanId: string } | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page = await repo.listLineupsByHuman({ humanId: me, when: "upcoming", now: NOW, after, limit: 2 });
      seen.push(...page.map((r) => r.eventHumanId));
      if (page.length < 2) break;
      const last = page[page.length - 1]!;
      after = { startsAt: last.startsAt, eventHumanId: last.eventHumanId };
    }
    const full = await repo.listLineupsByHuman({ humanId: me, when: "upcoming", now: NOW, after: null, limit: 20 });
    expect(seen).toEqual(full.map((r) => r.eventHumanId));

    const pastPage1 = await repo.listLineupsByHuman({ humanId: me, when: "past", now: NOW, after: null, limit: 1 });
    const pastPage2 = await repo.listLineupsByHuman({
      humanId: me,
      when: "past",
      now: NOW,
      after: { startsAt: pastPage1[0]!.startsAt, eventHumanId: pastPage1[0]!.eventHumanId },
      limit: 1,
    });
    expect([...pastPage1, ...pastPage2].map((r) => r.eventHumanId)).toEqual([rows.pastRecent, rows.pastOld]);
  }, 60_000);

  test("getByEventAndHuman finds exactly the (event, human) row, else null", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventHumansRepo(prisma);
    expect((await repo.getByEventAndHuman({ eventId: ids.soon!, humanId: me }))?.id).toBe(rows.soon);
    expect(await repo.getByEventAndHuman({ eventId: ids.notMine!, humanId: me })).toBeNull();
    expect(await repo.getByEventAndHuman({ eventId: ids.soon!, humanId: stranger })).toBeNull();
  }, 60_000);

  test("attach honours a caller-chosen id on CREATE, and returns the existing row on a re-attach", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventHumansRepo(prisma);
    const chosen = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
    const created = await repo.attach({ id: chosen, eventId: ids.notMine!, humanId: me, role: "DJ" });
    expect(created.id).toBe(chosen);
    const again = await repo.attach({
      id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
      eventId: ids.notMine!,
      humanId: me,
      role: "DJ",
    });
    expect(again.id).toBe(chosen);
    await repo.detach(chosen);
  }, 60_000);
});
