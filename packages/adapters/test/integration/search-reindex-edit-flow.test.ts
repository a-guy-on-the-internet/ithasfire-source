import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { drainSearchReindexPending } from "@th/core/use-cases/search/drain-search-reindex-pending";
import { updateEventAccessControls } from "@th/core/use-cases/events/update-event-access-controls";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../../src/db/prisma-repos";
import { MultiIndexPostgresAdapter } from "../../src/search/multi-index-postgres-adapter";

/**
 * The edit-triggered search reindex end to end on real Postgres, through the
 * real Prisma repos and the real `SearchDocument` index:
 *
 *  1. an edit (PRIVATE → PUBLIC, a loosening that used to wait for the nightly
 *     run) commits a `SearchReindexPending` mark with it, and the immediate
 *     post-commit reindex writes the document and clears the mark;
 *  2. PLANTED FAILURE: the immediate reindex fails (search backend down), the
 *     mark stays, and `drainSearchReindexPending` — what the scheduled
 *     `search.drain-reindex-pending` job runs — refreshes and clears it.
 *
 * Set SHOW_EVIDENCE=1 to print the table states the assertions check.
 */
const T = new Date("2026-09-30T12:00:00.000Z");
const clock = { now: () => T };
const show = (label: string, value: unknown) => {
  // eslint-disable-next-line no-console
  if (process.env.SHOW_EVIDENCE) console.log(`[evidence] ${label}`, value);
};

describe("edit-triggered search reindex – real Postgres flow", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;
  let actorId: string;
  let orgId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const actor = await prisma.human.create({
        data: { name: "Owner", status: "ACTIVE" },
      });
      actorId = actor.id;
      const org = await prisma.organization.create({
        data: { name: "Reindex Org", slug: `reindex-org-${Date.now()}` },
      });
      orgId = org.id;
      await prisma.orgMember.create({
        data: { orgId, humanId: actorId, role: "OWNER" },
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("search-reindex-edit-flow setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  }, 120_000);

  async function privatePublishedEvent(title: string) {
    return prisma!.event.create({
      data: {
        title,
        orgId,
        status: "PUBLISHED",
        visibility: "PRIVATE",
        startsAt: new Date("2026-12-01T01:00:00.000Z"),
        endsAt: new Date("2026-12-01T04:00:00.000Z"),
        publishedAt: T,
        locationMode: "EXACT",
        addressText: "1604 8th Ave S, Nashville, TN 37203",
        lat: 36.1395,
        lng: -86.7825,
      },
    });
  }

  const pendingRow = (eventId: string) =>
    prisma!.searchReindexPending.findUnique({
      where: {
        entityType_entityId: { entityType: "event", entityId: eventId },
      },
    });
  const doc = (eventId: string) =>
    prisma!.searchDocument.findUnique({ where: { id: `event_${eventId}` } });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("edit → mark commits with it → the immediate reindex writes the document and clears the mark", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const event = await privatePublishedEvent("Loosened Show");
    const repos = createPrismaRepos(prisma);
    const search = new MultiIndexPostgresAdapter({ prisma });
    const reportError = vi.fn();

    // Hold the immediate reindex at its first step so the committed mark is
    // observable before it is cleared.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gatedSearch: MultiSearchPort = Object.assign(
      Object.create(search) as MultiSearchPort,
      {
        ensureIndexes: async () => {
          await gate;
          return search.ensureIndexes();
        },
      },
    );

    await updateEventAccessControls(
      { repos, clock, search: gatedSearch, reportError },
      { actorHumanId: actorId, eventId: event.id, visibility: "PUBLIC" },
    );

    const marked = await pendingRow(event.id);
    show("after commit, before the immediate reindex", marked);
    expect(marked).toMatchObject({ entityType: "event", attempts: 0 });

    release();
    await vi.waitFor(
      async () => expect(await pendingRow(event.id)).toBeNull(),
      {
        timeout: 15_000,
      },
    );
    const written = await doc(event.id);
    show("after the immediate reindex", {
      pending: await pendingRow(event.id),
      document: {
        id: written?.id,
        title: written?.title,
        isPublic: written?.isPublic,
      },
    });
    expect(written).toMatchObject({ title: "Loosened Show", isPublic: true });
    expect(reportError).not.toHaveBeenCalled();
  });

  test("PLANTED FAILURE: immediate reindex fails → mark stays → the drain refreshes and clears it", async ({
    skip,
  }) => {
    if (!prisma) return skip();
    const event = await privatePublishedEvent("Outage Show");
    const repos = createPrismaRepos(prisma);
    const search = new MultiIndexPostgresAdapter({ prisma });
    const reportError = vi.fn();
    const downSearch: MultiSearchPort = Object.assign(
      Object.create(search) as MultiSearchPort,
      {
        ensureIndexes: async () => ({
          ok: false as const,
          error: new Error("search backend down"),
        }),
      },
    );

    await updateEventAccessControls(
      { repos, clock, search: downSearch, reportError },
      { actorHumanId: actorId, eventId: event.id, visibility: "PUBLIC" },
    );
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled(), {
      timeout: 15_000,
    });

    const stuck = await pendingRow(event.id);
    show("after the failed immediate reindex", {
      pending: stuck,
      document: await doc(event.id),
    });
    expect(stuck).not.toBeNull();
    expect(await doc(event.id)).toBeNull();

    // What `search.drain-reindex-pending` runs, minutes later.
    const out = await drainSearchReindexPending(
      { repos, search, clock, reportError: vi.fn() },
      {},
    );
    const written = await doc(event.id);
    show("drain result", {
      out,
      pending: await pendingRow(event.id),
      document: { id: written?.id, isPublic: written?.isPublic },
    });
    expect(out).toMatchObject({ failed: 0, reschedule: "not_needed" });
    expect(out.cleared).toBeGreaterThanOrEqual(1);
    expect(await pendingRow(event.id)).toBeNull();
    expect(written).toMatchObject({ title: "Outage Show", isPublic: true });
  });
});
