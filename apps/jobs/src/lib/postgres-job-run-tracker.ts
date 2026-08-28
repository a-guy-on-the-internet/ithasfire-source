import type { PrismaClient } from "@prisma/client";

import type { JobRunTracker, RunEntry } from "./job-run-tracker";

const MAX_PER_JOB = 50;
const MAX_LIMIT = 100;

type JobRunRow = {
  id: string;
  jobName: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  status: string;
  resultSummary: string | null;
  errorMessage: string | null;
  errorCode: string | null;
};

export class PostgresJobRunTracker implements JobRunTracker {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record a completed run. ONE insert — no transaction, no prune.
   *
   * This used to wrap INSERT + SELECT-overflow + DELETE in a `$transaction`,
   * so every job run cost BEGIN + 3 statements + COMMIT purely to hold history
   * at 50 rows. Measured 2026-08-25 in production over 7d, that made JobRun
   * bookkeeping ~90k queries/week — the SELECT/DELETE pair being roughly half
   * of it — which is the same workload that exhausted the Upstash quota on
   * 2026-07-28 and was moved here to escape it.
   *
   * Retention now happens on a schedule (`pruneRuns`, driven by
   * `jobs.prune-run-history`). Between sweeps the table overshoots by at most
   * one day of runs per job, which for a 15-minute-cron job is ~96 rows.
   */
  async record(entry: RunEntry): Promise<void> {
    await this.prisma.jobRun.create({
      data: {
        id: entry.id,
        jobName: entry.jobName,
        startedAt: new Date(entry.startedAt),
        finishedAt: new Date(entry.finishedAt),
        durationMs: entry.durationMs,
        status: entry.status,
        resultSummary: entry.resultSummary,
        errorMessage: entry.errorMessage,
        errorCode: entry.errorCode,
      },
    });
  }

  /**
   * Trim every job's history to `maxPerJob` in a single statement.
   *
   * A window function ranks each job's runs newest-first and deletes anything
   * past the cap, for ALL jobs at once — rather than the previous
   * select-ids-then-delete round-trip, per job, per write. Ordering matches
   * `runs()` and `latestAll()` (startedAt, createdAt, id — all descending) so
   * a sweep can never delete a row those reads would still surface.
   */
  async pruneRuns(maxPerJob: number = MAX_PER_JOB): Promise<number> {
    const cap = Math.max(0, Math.trunc(maxPerJob));
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "JobRun"
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id",
                 row_number() OVER (
                   PARTITION BY "jobName"
                   ORDER BY "startedAt" DESC, "createdAt" DESC, "id" DESC
                 ) AS rn
          FROM "JobRun"
        ) ranked
        WHERE ranked.rn > ${cap}
      )
    `;
    return Number(deleted);
  }

  async runs(jobName: string, limit = 25): Promise<RunEntry[]> {
    const take = clampLimit(limit);
    if (take === 0) return [];

    const rows = await this.prisma.jobRun.findMany({
      where: { jobName },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take,
    });

    return rows.map(toRunEntry);
  }

  async latestAll(): Promise<Map<string, RunEntry>> {
    const rows = await this.prisma.jobRun.findMany({
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    const latest = new Map<string, RunEntry>();

    for (const row of rows) {
      if (!latest.has(row.jobName)) {
        latest.set(row.jobName, toRunEntry(row));
      }
    }

    return latest;
  }

  async isEnabled(jobName: string): Promise<boolean> {
    const row = await this.prisma.jobState.findUnique({
      where: { jobName },
      select: { enabled: true },
    });

    return row?.enabled ?? true;
  }

  async setEnabled(jobName: string, enabled: boolean): Promise<void> {
    await this.prisma.jobState.upsert({
      where: { jobName },
      create: { jobName, enabled },
      update: { enabled },
    });
  }
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_LIMIT);
}

function toRunEntry(row: JobRunRow): RunEntry {
  return {
    id: row.id,
    jobName: row.jobName,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    durationMs: row.durationMs,
    status: parseStatus(row.status),
    ...(row.resultSummary === null ? {} : { resultSummary: row.resultSummary }),
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  };
}

function parseStatus(status: string): RunEntry["status"] {
  if (status === "success" || status === "error") return status;
  throw new Error(`invalid_job_run_status:${status}`);
}
