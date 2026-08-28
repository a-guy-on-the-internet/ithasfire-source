import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers/index";

import type { RunEntry } from "../job-run-tracker";
import { PostgresJobRunTracker } from "../postgres-job-run-tracker";

/**
 * HAND-COPIED SCHEMA — must track `packages/db/prisma/platform.prisma`.
 *
 * This suite builds its tables from this literal instead of running
 * `prisma migrate deploy`, so a column added to `JobRun`/`JobState` upstream is
 * invisible here until someone edits this string. It does NOT fail loudly at
 * the schema level either: the generated Prisma client SELECTs every column it
 * knows about, so the first symptom is every query on the table dying with
 * P2022 `The column (not available) does not exist in the current database` —
 * pointing at the query, not at this literal. (Exactly what happened when
 * `JobState.cursor` was added.)
 *
 * If you add a column upstream, add it here too.
 */
const JOB_TRACKER_TABLE_SQL = `
CREATE TABLE "JobRun" (
  "id" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "resultSummary" TEXT,
  "errorMessage" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobRun_status_check" CHECK ("status" IN ('success', 'error'))
);

CREATE INDEX "JobRun_jobName_startedAt_idx" ON "JobRun"("jobName", "startedAt");
CREATE INDEX "JobRun_startedAt_idx" ON "JobRun"("startedAt");

CREATE TABLE "JobState" (
  "jobName" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  -- Cross-run resume point for jobs that page through a table
  -- (storage.sweep-orphaned-uploads). Unused by the tracker itself, but the
  -- generated Prisma client SELECTs every column, so omitting it here fails
  -- every jobState query with P2022 "column does not exist".
  "cursor" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "JobState_pkey" PRIMARY KEY ("jobName")
);
`;

describe("PostgresJobRunTracker", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let tracker: PostgresJobRunTracker | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(JOB_TRACKER_TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    tracker = new PostgresJobRunTracker(prisma);
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "JobRun", "JobState"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  test("record and runs return newest runs first with a limit", async () => {
    const subject = requireTracker(tracker);

    await subject.record(makeRun("rollup", 1));
    await subject.record(
      makeRun("rollup", 3, {
        status: "error",
        errorMessage: "boom",
        errorCode: "E_JOB",
      }),
    );
    await subject.record(makeRun("rollup", 2));

    const runs = await subject.runs("rollup", 2);
    expect(runs.map((run) => run.id)).toEqual(["rollup-3", "rollup-2"]);
    expect(runs[0]).toMatchObject({
      status: "error",
      errorMessage: "boom",
      errorCode: "E_JOB",
    });
  });

  test("latestAll returns the newest run per job", async () => {
    const subject = requireTracker(tracker);

    await subject.record(makeRun("alpha", 1));
    await subject.record(makeRun("alpha", 2));
    await subject.record(makeRun("beta", 1));

    const latest = await subject.latestAll();
    expect([...latest.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(latest.get("alpha")?.id).toBe("alpha-2");
    expect(latest.get("beta")?.id).toBe("beta-1");
  });

  test("isEnabled defaults to true and setEnabled persists toggles", async () => {
    const subject = requireTracker(tracker);

    await expect(subject.isEnabled("nightly-rollup")).resolves.toBe(true);
    await subject.setEnabled("nightly-rollup", false);
    await expect(subject.isEnabled("nightly-rollup")).resolves.toBe(false);
    await subject.setEnabled("nightly-rollup", true);
    await expect(subject.isEnabled("nightly-rollup")).resolves.toBe(true);
    await expect(prisma!.jobState.count()).resolves.toBe(1);
  });

  // Was "record trims run history to fifty rows per job". `record()` no longer
  // trims — that cost a SELECT + DELETE on EVERY job run (~45k queries/week in
  // production). The retention guarantee is unchanged, it is just delivered by
  // the scheduled `pruneRuns` sweep instead of by every write.
  test("record + the scheduled sweep keep fifty rows per job", async () => {
    const subject = requireTracker(tracker);

    for (let index = 0; index < 55; index += 1) {
      await subject.record(makeRun("trimmed", index));
    }

    await expect(subject.pruneRuns()).resolves.toBe(5);

    const runs = await subject.runs("trimmed", 100);
    expect(runs).toHaveLength(50);
    expect(runs[0]?.id).toBe("trimmed-54");
    expect(runs.at(-1)?.id).toBe("trimmed-5");
  });

  test("database rejects invalid run statuses", async () => {
    await expect(
      pool!.query(`
        INSERT INTO "JobRun" (
          "id",
          "jobName",
          "startedAt",
          "finishedAt",
          "durationMs",
          "status"
        ) VALUES (
          'invalid-status',
          'invalid.job',
          '2026-05-13T12:00:00.000Z',
          '2026-05-13T12:00:01.000Z',
          1000,
          'paused'
        )
      `),
    ).rejects.toThrow(/JobRun_status_check/);
  });

  describe("pruneRuns", () => {
    // record() no longer prunes, so retention correctness lives entirely here.
    test("trims every job to the cap, keeping the newest rows", async () => {
      const subject = requireTracker(tracker);

      for (let i = 1; i <= 6; i++) await subject.record(makeRun("job-a", i));
      for (let i = 1; i <= 4; i++) await subject.record(makeRun("job-b", i));

      // Cap 2 per job: 4 removed from job-a, 2 from job-b — one statement,
      // all jobs at once.
      await expect(subject.pruneRuns(2)).resolves.toBe(6);

      expect((await subject.runs("job-a", 50)).map((r) => r.id)).toEqual([
        "job-a-6",
        "job-a-5",
      ]);
      expect((await subject.runs("job-b", 50)).map((r) => r.id)).toEqual([
        "job-b-4",
        "job-b-3",
      ]);
    });

    test("is a no-op when nothing exceeds the cap", async () => {
      const subject = requireTracker(tracker);
      await subject.record(makeRun("job-c", 1));

      await expect(subject.pruneRuns(50)).resolves.toBe(0);
      expect((await subject.runs("job-c", 10)).length).toBe(1);
    });

    test("record() no longer prunes — history accumulates until swept", async () => {
      // The point of the change: a write is ONE insert. If record() still
      // pruned, this would silently cap at MAX_PER_JOB (50).
      const subject = requireTracker(tracker);
      for (let i = 1; i <= 55; i++) await subject.record(makeRun("job-d", i));

      expect((await subject.runs("job-d", 100)).length).toBe(55);
    });
  });
});

function requireTracker(
  tracker: PostgresJobRunTracker | undefined,
): PostgresJobRunTracker {
  if (!tracker) throw new Error("Postgres job run tracker was not initialized");
  return tracker;
}

function makeRun(
  jobName: string,
  minute: number,
  overrides: Partial<RunEntry> = {},
): RunEntry {
  const startedAt = new Date(Date.UTC(2026, 4, 13, 12, minute, 0));
  const finishedAt = new Date(startedAt.getTime() + 1_000);

  return {
    id: `${jobName}-${minute}`,
    jobName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: 1_000,
    status: "success",
    resultSummary: `completed ${minute}`,
    ...overrides,
  };
}
