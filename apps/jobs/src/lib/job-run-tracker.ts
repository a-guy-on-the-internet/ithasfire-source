import type Redis from "ioredis";

// ─────────────────────────────────────────────────────────────────────────────
// Job Run Tracker — Redis-backed run history for every job execution.
//
// Uses sorted sets keyed by job name, scored by timestamp.
// Each member is a JSON-encoded RunEntry.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunEntry {
  id: string;
  jobName: string;
  startedAt: string; // ISO
  finishedAt: string; // ISO
  durationMs: number;
  status: "success" | "error";
  /** Compact summary from the handler result (first 500 chars). */
  resultSummary?: string;
  errorMessage?: string;
  errorCode?: string;
}

export interface JobRunTracker {
  /** Record a completed run. Trims to maxPerJob entries. */
  record(entry: RunEntry): Promise<void>;

  /** Get the last N runs for a given job. */
  runs(jobName: string, limit?: number): Promise<RunEntry[]>;

  /** Get the most recent run for every known job. */
  latestAll(): Promise<Map<string, RunEntry>>;

  /** Get enabled/disabled flag. Missing key = enabled. */
  isEnabled(jobName: string): Promise<boolean>;

  /** Set enabled/disabled flag. */
  setEnabled(jobName: string, enabled: boolean): Promise<void>;

  /**
   * Trim run history to the retention cap, across all jobs. Returns rows
   * removed.
   *
   * Exists so `record()` does NOT have to prune on every write. Trimming
   * per-write is O(writes); trimming on a schedule is O(1/day), and the table
   * only ever overshoots by one day of runs (~96 rows for a 15-minute-cron job) in
   * between — trivial.
   *
   * Measured 2026-08-25, production, 7d: prune-on-write made `record()` cost
   * BEGIN + INSERT + SELECT-overflow + DELETE + COMMIT per run, and the
   * SELECT/DELETE pair alone was ~45k of the ~90k weekly JobRun queries. That
   * is the same bookkeeping that exhausted the Redis quota on 2026-07-28,
   * simply relocated to Postgres by the fix for it.
   *
   * Backends that trim natively (Redis `ZREMRANGEBYRANK` on write) return 0.
   */
  pruneRuns(maxPerJob?: number): Promise<number>;
}

const KEY_PREFIX = "th:jobs:runs:";
const ENABLED_KEY = "th:jobs:enabled";
const MAX_PER_JOB = 50;

export function createJobRunTracker(redis: Redis): JobRunTracker {
  function runsKey(jobName: string) {
    return `${KEY_PREFIX}${jobName}`;
  }

  return {
    async record(entry) {
      const key = runsKey(entry.jobName);
      const score = new Date(entry.startedAt).getTime();
      const member = JSON.stringify(entry);

      await redis
        .multi()
        .zadd(key, score, member)
        // Keep only the most recent MAX_PER_JOB entries
        .zremrangebyrank(key, 0, -(MAX_PER_JOB + 1))
        .exec();
    },

    async runs(jobName, limit = 25) {
      const key = runsKey(jobName);
      // Most recent first
      const raw = await redis.zrevrange(key, 0, limit - 1);
      return raw.map((r) => JSON.parse(r) as RunEntry);
    },

    async latestAll() {
      const pattern = `${KEY_PREFIX}*`;
      const result = new Map<string, RunEntry>();
      let cursor = "0";

      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100,
        );
        cursor = next;

        for (const key of keys) {
          const [latest] = await redis.zrevrange(key, 0, 0);
          if (latest) {
            const entry = JSON.parse(latest) as RunEntry;
            result.set(entry.jobName, entry);
          }
        }
      } while (cursor !== "0");

      return result;
    },

    async isEnabled(jobName) {
      const val = await redis.hget(ENABLED_KEY, jobName);
      // null / "1" = enabled, "0" = disabled
      return val !== "0";
    },

    /**
     * No-op: the Redis backend trims on write. `record()` issues
     * ZADD + ZREMRANGEBYRANK in one MULTI, so a sorted set can never exceed
     * MAX_PER_JOB and there is nothing left to sweep.
     *
     * Implemented rather than omitted so every backend answers "who trims
     * this?" explicitly — the Postgres backend silently did not, and that cost
     * ~45k queries/week.
     */
    async pruneRuns() {
      return 0;
    },

    async setEnabled(jobName, enabled) {
      if (enabled) {
        await redis.hdel(ENABLED_KEY, jobName);
      } else {
        await redis.hset(ENABLED_KEY, jobName, "0");
      }
    },
  };
}
