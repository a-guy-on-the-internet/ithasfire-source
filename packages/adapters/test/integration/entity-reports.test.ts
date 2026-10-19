import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEntityReportsRepo } from "../../src/db/prisma/entity-reports";

// EntityReport carries plain-string human/subject ids (no FK — house style),
// so no Human/Place fixtures are needed; obviously-fake namespaced ids per
// test run keep rows identifiable and cleanable.
const RUN_NS = `er-it-${Date.now()}`;
const REPORTER = `${RUN_NS}-reporter`;
const OTHER_REPORTER = `${RUN_NS}-reporter-2`;
const REVIEWER = `${RUN_NS}-reviewer`;
const SUBJECT = `${RUN_NS}-place-1`;

describe("Prisma adapters integration – entity-reports", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("entity-reports integration setup failed:", error);
    }
  }, 300_000);

  // listPaged/countPending read the whole table (no reporter scoping), so
  // every test starts from a clean slate of this run's rows — a crashed test
  // can't pollute the next one's queue assertions.
  beforeEach(async () => {
    if (!prisma) return;
    await prisma.entityReport.deleteMany({
      where: { reporterHumanId: { startsWith: RUN_NS } },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.entityReport.deleteMany({
        where: { reporterHumanId: { startsWith: RUN_NS } },
      });
      await prisma.$disconnect();
    }
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("create inserts a PENDING row with defaults; getById round-trips", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);

    const created = await repo.create({
      subjectType: "PLACE",
      subjectId: SUBJECT,
      reporterHumanId: REPORTER,
      reason: "CLOSED_OR_GONE",
    });

    expect(created.status).toBe("PENDING");
    expect(created.details).toBeNull();
    expect(created.subjectSnapshot).toBeNull();
    expect(created.reviewedByHumanId).toBeNull();
    expect(created.reviewedAt).toBeNull();
    expect(created.reviewNote).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const fetched = await repo.getById(created.id);
    expect(fetched).toEqual(created);

    // getById miss → null, not a throw.
    expect(
      await repo.getById("00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  }, 60_000);

  test("duplicate PENDING (same reporter+subject) throws report_already_open via the real partial index", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);

    await repo.create({
      subjectType: "PLACE",
      subjectId: SUBJECT,
      reporterHumanId: REPORTER,
      reason: "SPAM",
    });

    // Second create bypasses any pre-check — the DB partial unique index is
    // the race backstop and the adapter must map its P2002.
    await expect(
      repo.create({
        subjectType: "PLACE",
        subjectId: SUBJECT,
        reporterHumanId: REPORTER,
        reason: "INAPPROPRIATE",
      }),
    ).rejects.toMatchObject({
      code: "report_already_open",
      message: "report_already_open",
    });

    // A DIFFERENT reporter on the same subject is fine (index keys on the
    // pair), as is the same reporter on a different subject.
    await expect(
      repo.create({
        subjectType: "PLACE",
        subjectId: SUBJECT,
        reporterHumanId: OTHER_REPORTER,
        reason: "SPAM",
      }),
    ).resolves.toMatchObject({ status: "PENDING" });
  }, 60_000);

  test("same reporter+subject succeeds again once the first report is resolved (predicate only guards PENDING)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);

    const first = await repo.create({
      subjectType: "HUMAN",
      subjectId: `${RUN_NS}-human-1`,
      reporterHumanId: REPORTER,
      reason: "IMPERSONATION",
    });
    const claimed = await repo.claimPendingForReview({
      id: first.id,
      status: "RESOLVED",
      reviewedByHumanId: REVIEWER,
      reviewedAt: new Date("2026-08-17T12:00:00.000Z"),
    });
    expect(claimed?.status).toBe("RESOLVED");

    const second = await repo.create({
      subjectType: "HUMAN",
      subjectId: `${RUN_NS}-human-1`,
      reporterHumanId: REPORTER,
      reason: "IMPERSONATION",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("PENDING");
  }, 60_000);

  test("findPendingByReporterAndSubject: hit on PENDING, miss on reviewed / other subject / other reporter", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);

    const created = await repo.create({
      subjectType: "ORGANIZATION",
      subjectId: `${RUN_NS}-org-1`,
      reporterHumanId: REPORTER,
      reason: "INCORRECT_INFO",
      details: "wrong address",
    });

    const hit = await repo.findPendingByReporterAndSubject({
      reporterHumanId: REPORTER,
      subjectType: "ORGANIZATION",
      subjectId: `${RUN_NS}-org-1`,
    });
    expect(hit?.id).toBe(created.id);
    expect(hit?.details).toBe("wrong address");

    // Misses: other reporter, other subject id, other subject type.
    expect(
      await repo.findPendingByReporterAndSubject({
        reporterHumanId: OTHER_REPORTER,
        subjectType: "ORGANIZATION",
        subjectId: `${RUN_NS}-org-1`,
      }),
    ).toBeNull();
    expect(
      await repo.findPendingByReporterAndSubject({
        reporterHumanId: REPORTER,
        subjectType: "ORGANIZATION",
        subjectId: `${RUN_NS}-org-2`,
      }),
    ).toBeNull();
    expect(
      await repo.findPendingByReporterAndSubject({
        reporterHumanId: REPORTER,
        subjectType: "PLACE",
        subjectId: `${RUN_NS}-org-1`,
      }),
    ).toBeNull();

    // Once reviewed, the pre-check no longer matches.
    await repo.claimPendingForReview({
      id: created.id,
      status: "DISMISSED",
      reviewedByHumanId: REVIEWER,
      reviewedAt: new Date("2026-08-17T12:30:00.000Z"),
    });
    expect(
      await repo.findPendingByReporterAndSubject({
        reporterHumanId: REPORTER,
        subjectType: "ORGANIZATION",
        subjectId: `${RUN_NS}-org-1`,
      }),
    ).toBeNull();
  }, 60_000);

  test("listPaged: default excludes reviewed rows, newest-first, cursor walks without overlap; subjectType filter; countPending agrees", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);

    // Seed with explicit createdAt so newest-first ordering is deterministic
    // (repo.create can't set timestamps; the list test is about querying).
    const mkCreatedAt = (i: number) =>
      new Date(`2026-08-10T10:0${i}:00.000Z`);
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await prisma.entityReport.create({
        data: {
          subjectType: i % 2 === 0 ? "PLACE" : "HUMAN",
          subjectId: `${RUN_NS}-subject-${i}`,
          reporterHumanId: `${RUN_NS}-lister-${i}`,
          reason: "SPAM",
          createdAt: mkCreatedAt(i),
        },
      });
      seeded.push(row.id);
    }
    // One reviewed row that the default queue must NEVER include.
    const reviewed = await prisma.entityReport.create({
      data: {
        subjectType: "PLACE",
        subjectId: `${RUN_NS}-subject-reviewed`,
        reporterHumanId: `${RUN_NS}-lister-reviewed`,
        reason: "SPAM",
        status: "RESOLVED",
        reviewedByHumanId: REVIEWER,
        reviewedAt: new Date("2026-08-17T13:00:00.000Z"),
        createdAt: new Date("2026-08-10T10:09:00.000Z"),
      },
    });

    // Cursor walk: pages of 2 → 2, 2, 1; no overlap, no skips, newest first.
    const page1 = await repo.listPaged({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1]!.id);
    const page2 = await repo.listPaged({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
    const page3 = await repo.listPaged({ limit: 2, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const walked = [...page1.items, ...page2.items, ...page3.items];
    // Default row set = the 5 PENDING rows, reviewed row excluded.
    expect(new Set(walked.map((r) => r.id))).toEqual(new Set(seeded));
    expect(walked.map((r) => r.id)).not.toContain(reviewed.id);
    // Newest first across the whole walk.
    expect(walked.map((r) => r.createdAt.toISOString())).toEqual(
      [4, 3, 2, 1, 0].map((i) => mkCreatedAt(i).toISOString()),
    );
    for (const item of walked) {
      expect(item.status).toBe("PENDING");
    }

    // subjectType filter narrows to one kind.
    const placesOnly = await repo.listPaged({ subjectType: "PLACE", limit: 10 });
    expect(placesOnly.items).toHaveLength(3);
    expect(placesOnly.items.every((r) => r.subjectType === "PLACE")).toBe(true);

    // Explicit status browses reviewed history.
    const resolved = await repo.listPaged({ status: "RESOLVED", limit: 10 });
    expect(resolved.items.map((r) => r.id)).toEqual([reviewed.id]);

    // countPending agrees with listPaged's default row set, with and without
    // the subjectType narrowing.
    expect(await repo.countPending()).toBe(5);
    expect(await repo.countPending({ subjectType: "PLACE" })).toBe(3);
    expect(await repo.countPending({ subjectType: "ORGANIZATION" })).toBe(0);
  }, 60_000);

  test("claimPendingForReview: CAS wins once, loser and missing id see null", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);

    const created = await repo.create({
      subjectType: "PLACE",
      subjectId: SUBJECT,
      reporterHumanId: REPORTER,
      reason: "DUPLICATE",
    });

    const reviewedAt = new Date("2026-08-17T14:00:00.000Z");
    const won = await repo.claimPendingForReview({
      id: created.id,
      status: "RESOLVED",
      reviewedByHumanId: REVIEWER,
      reviewedAt,
      reviewNote: "merged into canonical listing",
    });
    expect(won).not.toBeNull();
    expect(won?.status).toBe("RESOLVED");
    expect(won?.reviewedByHumanId).toBe(REVIEWER);
    expect(won?.reviewedAt?.toISOString()).toBe(reviewedAt.toISOString());
    expect(won?.reviewNote).toBe("merged into canonical listing");

    // Second claim on the same row (any verdict) loses the CAS → null, and
    // the winning verdict is untouched.
    const lost = await repo.claimPendingForReview({
      id: created.id,
      status: "DISMISSED",
      reviewedByHumanId: `${RUN_NS}-reviewer-2`,
      reviewedAt: new Date("2026-08-17T14:00:01.000Z"),
    });
    expect(lost).toBeNull();
    const after = await repo.getById(created.id);
    expect(after?.status).toBe("RESOLVED");
    expect(after?.reviewedByHumanId).toBe(REVIEWER);

    // Missing id → null, not a throw.
    expect(
      await repo.claimPendingForReview({
        id: "00000000-0000-4000-8000-000000000001",
        status: "DISMISSED",
        reviewedByHumanId: REVIEWER,
        reviewedAt,
      }),
    ).toBeNull();
  }, 60_000);
  test("ARRIVAL_AREA: the snapshot round-trips as stored; the subject type filters the queue", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeEntityReportsRepo(prisma);
    const snapshot = {
      type: "ARRIVAL_AREA" as const,
      kind: "PARKING" as const,
      label: "Back lot",
      cost: "PAID" as const,
      priceText: "$5",
      note: null,
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [-86.7291, 36.1862],
            [-86.7287, 36.1862],
            [-86.7287, 36.1866],
            [-86.7291, 36.1862],
          ] as [number, number][],
        ],
      },
      placeId: `${RUN_NS}-place-9`,
      eventId: null,
      seenOnEventId: `${RUN_NS}-event-9`,
    };

    const created = await repo.create({
      subjectType: "ARRIVAL_AREA",
      subjectId: `${RUN_NS}-area-1`,
      reporterHumanId: REPORTER,
      reason: "INCORRECT_INFO",
      subjectSnapshot: snapshot,
    });
    expect(created.subjectType).toBe("ARRIVAL_AREA");
    expect(created.subjectSnapshot).toEqual(snapshot);
    expect(await repo.getById(created.id)).toEqual(created);

    const page = await repo.listPaged({ subjectType: "ARRIVAL_AREA" });
    expect(page.items.map((r) => r.id)).toEqual([created.id]);
    expect(await repo.countPending({ subjectType: "ARRIVAL_AREA" })).toBe(1);
  }, 60_000);
});
